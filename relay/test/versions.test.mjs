import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

test('a version answered at a later revision (others edited since the save) is kept at that revision', async () => {
  const { r, a, b, dir, done } = await editing();
  r.message('a', op('a', 1));
  await r.flush();
  r.message('a', { t: 'Saved', rev: 1 });
  assert.equal(a.last('VersionRequest').rev, 1);
  r.message('b', op('b', 1));
  await r.flush();
  r.message('a', { t: 'Version', rev: 3, doc: '{}' });
  await settle(r);
  assert.equal(existsSync(join(versionsDir(dir), '3.json')), false, 'never past what the relay has');
  r.message('a', { t: 'Version', rev: 2, doc: '{"v":2}' });
  await settle(r);
  const v = JSON.parse(readFileSync(join(versionsDir(dir), '2.json'), 'utf8'));
  assert.deepEqual([v.rev, v.doc, v.users], [2, '{"v":2}', ['A', 'B']]);
  await done();
});

/** a and b edit, then a snapshot takes their edits out of the log (snapshotEvery 2). */
async function editedThenSnapshot(opts = {}) {
  const t = await room({ start: START, limits: { snapshotEvery: 2 }, ...opts });
  const b = member('b');
  t.r.join(b);
  t.r.message('a', op('a', 1));
  t.r.message('b', op('b', 1));
  await t.r.flush();
  assert.ok(t.a.last('SnapshotRequest'), 'the holder is asked for a snapshot');
  t.r.message('a', { t: 'Snapshot', rev: 2, doc: '{"v":2}' });
  assert.equal(t.r.log.length, 0, 'their edits are only in the snapshot now');
  // A save reported by b: meta is written again, and asks for no version.
  t.r.message('b', { t: 'Saved', rev: 2 });
  await settle(t.r);
  return { ...t, b };
}

/** x joins `r` (loaded again), edits and saves: the version's users. */
async function nextVersionUsers(r, dir) {
  const x = member('x', { sub: 'a', user: 'A' });
  r.join(x);
  r.message('x', op('x', 1));
  await r.flush();
  r.message('x', { t: 'Saved', rev: 3 });
  assert.equal(x.last('VersionRequest').rev, 3);
  r.message('x', { t: 'Version', rev: 3, doc: '{"v":3}' });
  await settle(r);
  return JSON.parse(readFileSync(join(versionsDir(dir), '3.json'), 'utf8')).users;
}

test('who edited before a snapshot is still in the next version after a relay restart', async () => {
  const { c, dir } = await editedThenSnapshot();
  const again = new Room({ id: 'doc-1', store: createStore(dir, { flushMs: 0 }), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  await again.load();
  assert.deepEqual(await nextVersionUsers(again, dir), ['A', 'B']);
  rmSync(dir, { recursive: true, force: true });
});

test('who edited before a snapshot is still in the next version after the room is let go and loaded again', async () => {
  const idle = [];
  const { r, b, c, dir, store } = await editedThenSnapshot({ onIdle: (x) => idle.push(x) });
  r.leave('a');
  r.leave('b', b);
  await settle(r);
  c.advance(10 * MIN);
  assert.deepEqual(idle, [r]);
  const again = new Room({ id: 'doc-1', store, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  await again.load();
  assert.deepEqual(await nextVersionUsers(again, dir), ['A', 'B']);
  rmSync(dir, { recursive: true, force: true });
});

test('who edited before the newest version is not carried into the next one after a restart', async () => {
  const { r, a, c, dir } = await editedThenSnapshot();
  // The version at 2 takes A and B; the snapshot's names are now spent.
  r.message('a', op('a', 2));
  await r.flush();
  r.message('a', { t: 'Snapshot', rev: 3, doc: '{"v":3}' });
  r.leave('b');
  assert.equal(await saveVersion(r, a, 3), true);
  assert.deepEqual(JSON.parse(readFileSync(join(versionsDir(dir), '3.json'), 'utf8')).users, ['A', 'B']);
  const again = new Room({ id: 'doc-1', store: createStore(dir, { flushMs: 0 }), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  await again.load();
  const z = member('z', { user: 'Z' });
  again.join(z);
  again.message('z', op('z', 1));
  await again.flush();
  again.message('z', { t: 'Saved', rev: 4 });
  again.message('z', { t: 'Version', rev: 4, doc: '{"v":4}' });
  await settle(again);
  assert.deepEqual(JSON.parse(readFileSync(join(versionsDir(dir), '4.json'), 'utf8')).users, ['Z']);
  rmSync(dir, { recursive: true, force: true });
});

test('a meta.json from before it kept who edited still loads', async () => {
  const { r, c, dir } = await room({ start: START });
  r.message('a', op('a', 1));
  await r.flush();
  r.message('a', { t: 'Saved', rev: 1 });
  r.message('a', { t: 'Version', rev: 1, doc: '{"v":1}' });
  r.message('a', op('a', 2));
  await settle(r);
  const meta = join(dirname(versionsDir(dir)), 'meta.json');
  writeFileSync(meta, JSON.stringify({ savedRev: 1, lastSaved: new Date(START).toISOString() }));
  const again = new Room({ id: 'doc-1', store: createStore(dir, { flushMs: 0 }), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  await again.load();
  assert.equal(again.savedRev, 1);
  assert.deepEqual(again.editedSince, [[2, 'A']]);
  rmSync(dir, { recursive: true, force: true });
});

test('who edited is kept on disk compactly, at most maxEditedKept entries', async () => {
  const { r, a, c, dir } = await room({ start: START, limits: { snapshotEvery: 10, maxEditedKept: 6 } });
  const b = member('b');
  r.join(b);
  // Runs: A A A, then A B alternating, then C.
  const seq = { a: 0, b: 0 };
  const by = ['a', 'a', 'a', 'a', 'b', 'a', 'b', 'a', 'b'];
  for (const x of by) r.message(x, op(x, ++seq[x]));
  const cc = member('c');
  r.join(cc);
  r.message('c', op('c', 1));
  await r.flush();
  assert.ok(r.log.length === 10 && a.last('SnapshotRequest'));
  r.message('a', { t: 'Snapshot', rev: 10, doc: '{"v":10}' });
  await settle(r);
  const meta = JSON.parse(readFileSync(join(dirname(versionsDir(dir)), 'meta.json'), 'utf8'));
  assert.ok(meta.editedSince.length <= 6, JSON.stringify(meta.editedSince));
  const again = new Room({ id: 'doc-1', store: createStore(dir, { flushMs: 0 }), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  await again.load();
  assert.deepEqual([...new Set(again.editedSince.map(([, name]) => name))].sort(), ['A', 'B', 'C']);
  rmSync(dir, { recursive: true, force: true });
});
