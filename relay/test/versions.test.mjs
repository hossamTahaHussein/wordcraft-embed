import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Room, thinVersions } from '../room.mjs';
import { createStore } from '../store.mjs';
import { member, op, room, tick } from './helpers.mjs';

const MIN = 60_000;
const START = Date.parse('2026-10-29T09:00:00Z');
const versionsDir = (dir) => join(dir, createHash('sha256').update('doc-1').digest('hex').slice(0, 32), 'versions');

/** Wait for the store's queued writes and reads. */
const settle = async (r) => {
  await r.flush();
  await tick(20);
};

/** A room where `a` (the holder) and `b` are editing. */
async function editing() {
  const t = await room({ start: START });
  const b = member('b');
  t.r.join(b);
  return { ...t, b };
}

/** a saves `rev`, is asked for a version and answers. */
async function saveVersion(r, a, rev, doc = `{"v":${rev}}`) {
  const before = a.all('VersionRequest').length;
  r.message('a', { t: 'Saved', rev });
  if (a.all('VersionRequest').length === before) return false;
  assert.deepEqual(a.last('VersionRequest'), { t: 'VersionRequest', rev });
  r.message('a', { t: 'Version', rev, doc });
  await settle(r);
  return true;
}

test('the first save becomes a version, stored with who edited', async () => {
  const { r, a, b, dir, done } = await editing();
  r.message('a', op('a', 1));
  r.message('b', op('b', 1));
  await r.flush();
  assert.equal(await saveVersion(r, a, 2), true);
  assert.equal(b.last('VersionRequest'), undefined, 'only the holder is asked');
  const v = JSON.parse(readFileSync(join(versionsDir(dir), '2.json'), 'utf8'));
  assert.deepEqual(v, { rev: 2, at: new Date(START).toISOString(), users: ['A', 'B'], doc: '{"v":2}' });
  await done();
});

test('another version only 10 minutes after the newest, or when the holder is the last editor', async () => {
  const { r, a, b, c, done } = await editing();
  r.message('a', op('a', 1));
  await r.flush();
  await saveVersion(r, a, 1);
  c.advance(9 * MIN);
  r.message('a', op('a', 2));
  await r.flush();
  assert.equal(await saveVersion(r, a, 2), false, 'only 9 minutes later, with b still here');
  c.advance(1 * MIN);
  r.message('b', op('b', 1));
  await r.flush();
  assert.equal(await saveVersion(r, a, 3), true, '10 minutes later');
  r.message('a', op('a', 3));
  await r.flush();
  r.leave('b', b);
  assert.equal(await saveVersion(r, a, 4), true, 'nobody else is editing: the session is ending');
  r.message('a', { t: 'Versions' });
  assert.deepEqual(
    a.last('VersionList').versions.map((v) => [v.rev, v.users]),
    [
      [4, ['A']],
      [3, ['A', 'B']],
      [1, ['A']],
    ],
  );
  await done();
});

test('a viewer still here does not count as an editor', async () => {
  const { r, a, done } = await room({ start: START });
  r.join(member('v', { role: 'view' }));
  r.message('a', op('a', 1));
  await r.flush();
  await saveVersion(r, a, 1);
  r.message('a', op('a', 2));
  await r.flush();
  assert.equal(await saveVersion(r, a, 2), true);
  await done();
});

test('a save reported by another editor asks for no version', async () => {
  const { r, a, b, done } = await editing();
  r.message('a', op('a', 1));
  await r.flush();
  r.message('b', { t: 'Saved', rev: 1 });
  assert.equal(a.last('VersionRequest'), undefined);
  assert.equal(b.last('VersionRequest'), undefined);
  await done();
});

test('a Version nobody asked for, or for another revision, is ignored', async () => {
  const { r, a, b, dir, done } = await editing();
  r.message('a', op('a', 1));
  await r.flush();
  r.message('b', { t: 'Version', rev: 1, doc: '{}' });
  r.message('a', { t: 'Saved', rev: 1 });
  r.message('b', { t: 'Version', rev: 1, doc: '{"evil":1}' });
  r.message('a', { t: 'Version', rev: 0, doc: '{}' });
  await settle(r);
  assert.equal(existsSync(join(versionsDir(dir), '1.json')), false);
  r.message('a', { t: 'Version', rev: 1, doc: '{"v":1}' });
  await settle(r);
  assert.equal(JSON.parse(readFileSync(join(versionsDir(dir), '1.json'), 'utf8')).doc, '{"v":1}');
  await done();
});

test('anyone may list and preview versions; a version that is gone previews as null', async () => {
  const { r, a, done } = await room({ start: START });
  r.message('a', op('a', 1));
  await r.flush();
  await saveVersion(r, a, 1);
  const v = member('v', { role: 'view' });
  r.join(v);
  r.message('v', { t: 'Versions' });
  assert.deepEqual(v.last('VersionList'), { t: 'VersionList', versions: [{ rev: 1, at: new Date(START).toISOString(), users: ['A'] }] });
  r.message('v', { t: 'GetVersion', rev: 1 });
  r.message('v', { t: 'GetVersion', rev: 7 });
  await settle(r);
  assert.deepEqual(v.all('VersionDoc'), [
    { t: 'VersionDoc', rev: 1, doc: '{"v":1}' },
    { t: 'VersionDoc', rev: 7, doc: null },
  ]);
  await done();
});

test('versions survive a relay restart', async () => {
  const { r, a, c, dir } = await room({ start: START });
  r.message('a', op('a', 1));
  await r.flush();
  await saveVersion(r, a, 1);
  const again = new Room({ id: 'doc-1', store: createStore(dir, { flushMs: 0 }), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  await again.load();
  const x = member('x');
  again.join(x);
  again.message('x', { t: 'Versions' });
  assert.deepEqual(x.last('VersionList').versions.map((v) => v.rev), [1]);
  await again.flush();
  rmSync(dir, { recursive: true, force: true });
});

test('versions are thinned: all from the last 24 h, then the newest per day, at most 100', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const list = [];
  let rev = 0;
  // 10 days ago to 2 days ago: 12 a day, every 2 hours; then 60 in the last 24 hours.
  for (let d = 10; d >= 2; d--) for (let h = 0; h < 24; h += 2) list.push({ rev: ++rev, at: new Date(now - d * 86_400_000 + h * 3_600_000).toISOString(), users: [] });
  for (let i = 59; i >= 0; i--) list.push({ rev: ++rev, at: new Date(now - i * 20 * MIN).toISOString(), users: [] });
  assert.equal(list.length, 168);
  const kept = thinVersions(list, now);
  const recent = kept.filter((v) => Date.parse(v.at) >= now - 86_400_000);
  assert.equal(recent.length, 60);
  const days = kept.filter((v) => Date.parse(v.at) < now - 86_400_000).map((v) => v.at.slice(0, 10));
  assert.equal(new Set(days).size, days.length, 'one per day');
  assert.equal(days.length, 9, 'days 10 to 2 ago');
  assert.deepEqual(kept.map((v) => v.rev), [...kept.map((v) => v.rev)].sort((x, y) => x - y));
  // Each day keeps its newest.
  const oct20 = list.filter((v) => v.at.startsWith('2026-10-20')).at(-1);
  assert.ok(kept.includes(oct20));
  const day = list.slice(-50);
  assert.deepEqual(thinVersions(day, now), day, 'all from the last 24 hours are kept');
  const tooRecent = Array.from({ length: 130 }, (_, i) => ({ rev: i + 1, at: new Date(now - (130 - i) * MIN).toISOString(), users: [] }));
  assert.deepEqual(thinVersions(tooRecent, now).map((v) => v.rev), tooRecent.slice(30).map((v) => v.rev), 'at most 100, the newest');
});

test('thinning removes the files of dropped versions', async () => {
  const { r, a, c, dir, done } = await room({ start: START });
  for (let i = 1; i <= 102; i++) {
    r.message('a', op('a', i));
    await r.flush();
    await saveVersion(r, a, i);
    c.advance(30 * 60 * 1000 + 1);
  }
  r.message('a', { t: 'Versions' });
  const list = a.last('VersionList').versions;
  assert.deepEqual(list, thinVersions([...list].reverse(), c.now() - 30 * 60 * 1000 - 1).reverse(), 'already thinned');
  assert.ok(list.length < 102);
  for (let rev = 1; rev <= 102; rev++) {
    assert.equal(existsSync(join(versionsDir(dir), `${rev}.json`)), list.some((v) => v.rev === rev), `version ${rev}`);
  }
  await done();
});
