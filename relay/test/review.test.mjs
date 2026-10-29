// Regression tests for the final review's relay findings (C1, I2–I5, I7–I9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Room } from '../room.mjs';
import { createStore } from '../store.mjs';

function member(client, sub = client) {
  const m = { client, sub, user: client.toUpperCase(), role: 'edit', got: [], closed: null };
  m.send = (msg) => m.got.push(msg);
  m.close = (code, reason) => (m.closed = { code, reason });
  m.last = (t) => m.got.filter((x) => x.t === t).at(-1);
  m.all = (t) => m.got.filter((x) => x.t === t);
  return m;
}

function op(client, seq, text = 'x', base = 0) {
  return { t: 'Op', client, seq, base, kind: 'cmd', cmd: 'text.insert', params: { text }, sel: { story: 'body', anchor: 0, head: 0 }, ctx: {} };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function room(flushMs = 20, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-review-'));
  const r = new Room({ id: 'doc', store: createStore(dir, { flushMs }), ...opts });
  await r.load();
  const a = member('a');
  r.join(a);
  r.message('a', { t: 'Snapshot', rev: 0, doc: '{}' });
  return { r, a, dir, done: async () => { await r.flush(); rmSync(dir, { recursive: true, force: true }); } };
}

test('C1: an op appended just before a snapshot is still broadcast, and so are later ones', async () => {
  const { r, a, done } = await room(30, { limits: { snapshotEvery: 2 } });
  r.message('a', op('a', 1));
  r.message('a', op('a', 2)); // triggers a SnapshotRequest to a (the holder)
  r.message('a', { t: 'Snapshot', rev: 2, doc: '{"v":2}' });
  r.message('a', op('a', 3));
  await tick(150);
  assert.deepEqual(a.all('Op').map((o) => o.rev), [1, 2, 3]);
  await done();
});

test('I2: the relay drops a replica edit it already sequenced (same or older seq)', async () => {
  const { r, a, done } = await room(0);
  r.message('a', op('a', 1, 'X'));
  r.message('a', op('a', 1, 'X'));
  r.message('a', op('a', 2, 'Y'));
  await r.flush();
  assert.deepEqual(r.log.map((o) => o.seq), [1, 2]);
  await done();
});

test('I3: Welcome and Resync carry only ops already on disk', async () => {
  const { r, a, done } = await room(50);
  r.message('a', op('a', 1));
  const b = member('b');
  r.join(b);
  assert.deepEqual(b.last('Welcome').ops, [], 'the op is not durable yet');
  await r.flush();
  await tick();
  assert.deepEqual(b.all('Op').map((o) => o.rev), [1], 'it arrives once, as a broadcast');
  r.message('a', { t: 'ResyncRequest', have: 0 });
  assert.equal(a.last('Resync').ops.length, 1);
  await done();
});

test('I4: an old connection closing after a reconnect does not remove the new one', async () => {
  const { r, a, done } = await room(0);
  const again = member('a');
  r.join(again);
  assert.equal(a.closed?.code, 4000, 'the old connection is closed as replaced');
  r.leave('a', a);
  r.message('a', op('a', 1));
  await r.flush();
  assert.equal(again.last('Op')?.rev, 1);
  await done();
});

test('I4: a client id already used by another user is refused', async () => {
  const { r, done } = await room(0);
  const thief = member('a', 'someone-else');
  r.join(thief);
  assert.equal(thief.closed?.code, 4400);
  await done();
});

test('I5: malformed ops are refused, not sequenced', async () => {
  const { r, a, done } = await room(0);
  for (const bad of [
    { ...op('a', 1), sel: 'x' },
    { ...op('a', 1), seq: -1 },
    { ...op('a', 1), seq: 1.5 },
    { ...op('a', 1), kind: 'nuke' },
    { ...op('a', 1), cmd: 7 },
    { ...op('a', 1), ctx: null },
    { ...op('a', 1), sel: { story: 'body', anchor: -2, head: 0 } },
    { ...op('a', 1), base: 99 },
  ]) {
    r.message('a', bad);
  }
  await r.flush();
  assert.equal(r.log.length, 0);
  await done();
});

test('I7: unsaved revisions survive the last person leaving and a restart: the next joiner saves', async () => {
  const { r, a, dir } = await room(0);
  r.message('a', op('a', 1));
  await r.flush();
  r.leave('a', a);
  const again = new Room({ id: 'doc', store: createStore(dir, { flushMs: 0 }), limits: { idleSaveMs: 10 } });
  await again.load();
  const b = member('b');
  again.join(b);
  await tick(50);
  assert.ok(b.last('Save'), 'the new holder is asked to save the unsaved revision');
  again.message('b', { t: 'Saved', rev: 1 });
  await again.flush();
  const third = new Room({ id: 'doc', store: createStore(dir, { flushMs: 0 }), limits: { idleSaveMs: 10 } });
  await third.load();
  const c = member('c');
  third.join(c);
  await tick(50);
  assert.equal(c.last('Save'), undefined, 'saved revisions are remembered');
  rmSync(dir, { recursive: true, force: true });
});

test('I8: a torn last line is cut off on load, so later appends are not lost', async () => {
  const { r, a, dir } = await room(0);
  r.message('a', op('a', 1));
  await r.flush();
  const roomDir = join(dir, readdirSync(dir)[0]);
  appendFileSync(join(roomDir, 'ops.jsonl'), '{"t":"Op","rev":2,"cli'); // crash mid-write
  const again = new Room({ id: 'doc', store: createStore(dir, { flushMs: 0 }) });
  await again.load();
  assert.equal(again.rev, 1);
  const b = member('b');
  again.join(b);
  again.message('b', op('b', 1));
  await again.flush();
  const third = new Room({ id: 'doc', store: createStore(dir, { flushMs: 0 }) });
  await third.load();
  assert.equal(third.rev, 2, readFileSync(join(roomDir, 'ops.jsonl'), 'utf8'));
  rmSync(dir, { recursive: true, force: true });
});

test('I9: votes only for real checkpoints, one per user', async () => {
  const { r, a, done } = await room(0);
  for (let i = 1; i <= 50; i++) r.message('a', op('a', i));
  for (let i = 0; i < 100; i++) r.message('a', { t: 'Hash', rev: 1000 - i, h: 'x' });
  assert.equal(r.votes.size, 0, 'future or off-checkpoint revisions are ignored');
  // A second connection of the same user doesn't get a second vote.
  const twin = member('a2', 'a');
  r.join(twin);
  r.message('a', { t: 'Hash', rev: 50, h: 'good' });
  r.message('a2', { t: 'Hash', rev: 50, h: 'evil' });
  const b = member('b');
  r.join(b);
  r.message('b', { t: 'Hash', rev: 50, h: 'good' });
  assert.equal(b.last('Resync'), undefined);
  await done();
});

test('I9: a snapshot is accepted only from the member asked, once', async () => {
  const { r, a, done } = await room(0, { limits: { snapshotEvery: 2 } });
  const b = member('b');
  r.join(b);
  r.message('b', op('b', 1));
  r.message('b', { t: 'Snapshot', rev: 1, doc: '{"evil":1}' });
  assert.equal(r.snapshot.rev, 0, 'unrequested snapshot ignored');
  r.message('b', op('b', 2));
  await r.flush();
  assert.ok(a.last('SnapshotRequest'));
  r.message('b', { t: 'Snapshot', rev: 2, doc: '{"evil":2}' });
  assert.equal(r.snapshot.rev, 0, 'only the asked member may answer');
  r.message('a', { t: 'Snapshot', rev: 2, doc: '{"v":2}', history: [] });
  assert.equal(r.snapshot.rev, 2);
  await done();
});

test('I9: resync requests are rate limited', async () => {
  const { r, a, done } = await room(0);
  for (let i = 0; i < 20; i++) r.message('a', { t: 'ResyncRequest', have: 0 });
  assert.ok(a.all('Resync').length <= 2, `${a.all('Resync').length} resyncs`);
  await done();
});

test('C2: snapshots keep the change history the holder sent, for joiners', async () => {
  const { r, a, done } = await room(0, { limits: { snapshotEvery: 1 } });
  r.message('a', op('a', 1));
  await r.flush();
  const history = [{ rev: 1, spans: [{ story: 'body', start: 0, oldEnd: 0, newEnd: 1 }] }];
  r.message('a', { t: 'Snapshot', rev: 1, doc: '{"v":1}', history });
  const b = member('b');
  r.join(b);
  assert.deepEqual(b.last('Welcome').history, history);
  await done();
});
