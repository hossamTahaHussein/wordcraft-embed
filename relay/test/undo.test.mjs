import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Room } from '../room.mjs';
import { createStore } from '../store.mjs';
import { member, op, room } from './helpers.mjs';

const undo = (client, seq, target, kind = 'undo') => op(client, seq, { kind, cmd: `collab.${kind}`, params: { target } });

test('an editor may undo and redo its own edits', async () => {
  const { r, a, done } = await room();
  r.message('a', op('a', 1));
  r.message('a', undo('a', 2, 1));
  r.message('a', undo('a', 3, 2, 'redo'));
  await r.flush();
  assert.deepEqual(a.all('Op').map((o) => o.kind), ['cmd', 'undo', 'redo']);
  assert.equal(a.last('Refused'), undefined);
  await done();
});

test('an undo whose target is not a revision there is is refused', async () => {
  const { r, a, done } = await room();
  r.message('a', op('a', 1));
  for (const [seq, target] of [[2, 0], [3, -1], [4, 1.5], [5, '1'], [6, 99], [7, undefined]]) r.message('a', undo('a', seq, target));
  await r.flush();
  assert.deepEqual(a.all('Refused').map((x) => x.seq), [2, 3, 4, 5, 6, 7]);
  assert.equal(r.rev, 1);
  await done();
});

test("nobody, editors included, may undo someone else's edit", async () => {
  const { r, a, done } = await room();
  const b = member('b');
  r.join(b);
  r.message('a', op('a', 1));
  r.message('b', undo('b', 1, 1));
  await r.flush();
  assert.equal(b.last('Refused').seq, 1);
  assert.match(b.last('Refused').reason, /your own/);
  assert.equal(r.rev, 1);
  await done();
});

test('the same person in another tab may undo their edit', async () => {
  const { r, done } = await room();
  const a2 = member('a2', { sub: 'a' });
  r.join(a2);
  r.message('a', op('a', 1));
  r.message('a2', undo('a2', 1, 1));
  await r.flush();
  assert.equal(r.rev, 2);
  await done();
});

test('a commenter may undo its own comment, not an edit of others', async () => {
  const { r, done } = await room();
  const c = member('c', { role: 'comment' });
  r.join(c);
  r.message('a', op('a', 1));
  r.message('c', op('c', 1, { cmd: 'review.newComment' }));
  r.message('c', undo('c', 2, 2));
  r.message('c', undo('c', 3, 1));
  await r.flush();
  assert.equal(r.rev, 3);
  assert.deepEqual(c.all('Refused').map((x) => x.seq), [3]);
  await done();
});

test('who made an edit is remembered across snapshots and restarts', async () => {
  const { r, a, c, dir, done } = await room({ limits: { snapshotEvery: 2 } });
  const b = member('b');
  r.join(b);
  r.message('a', op('a', 1));
  r.message('b', op('b', 1));
  r.message('a', op('a', 2));
  await r.flush();
  r.message('a', { t: 'Snapshot', rev: 2, doc: '{"v":2}' });
  await r.flush();
  const again = new Room({ id: 'doc-1', store: createStore(dir, { flushMs: 0 }), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  await again.load();
  const a2 = member('a');
  const b2 = member('b');
  again.join(a2);
  again.join(b2);
  again.message('a', undo('a', 3, 1)); // before the snapshot
  again.message('b', undo('b', 2, 3)); // after it: a's
  again.message('a', undo('a', 4, 3)); // after it
  await again.flush();
  assert.equal(a2.last('Refused'), undefined);
  assert.equal(b2.last('Refused').seq, 2);
  assert.equal(again.rev, 5);
  assert.equal(a.closed, null);
  await done();
  rmSync(dir, { recursive: true, force: true });
});

test('an undo of a run of typing names every edit in it, all of them the sender\'s', async () => {
  const { r, a, done } = await room();
  const b = member('b');
  r.join(b);
  r.message('a', op('a', 1));
  r.message('a', op('a', 2));
  r.message('b', op('b', 1));
  r.message('a', op('a', 3, { kind: 'undo', cmd: 'collab.undo', params: { target: 2, more: [1] } }));
  r.message('a', op('a', 4, { kind: 'undo', cmd: 'collab.undo', params: { target: 2, more: ['x'] } }));
  r.message('b', op('b', 2, { kind: 'undo', cmd: 'collab.undo', params: { target: 3, more: [1] } }));
  await r.flush();
  assert.deepEqual(a.all('Op').map((o) => o.kind), ['cmd', 'cmd', 'cmd', 'undo'], 'both are Ann\'s: sequenced');
  assert.equal(a.last('Refused').reason, 'There is no such change to undo');
  assert.equal(b.last('Refused').reason, 'You can only undo your own changes');
  await done();
});

test('a fresh resync asks the holder for a snapshot and resyncs from it', async () => {
  const { r, a, done } = await room();
  const late = member('late');
  r.join(late);
  r.message('a', op('a', 1));
  r.message('a', op('a', 2, { kind: 'undo', cmd: 'collab.undo', params: { target: 1 } }));
  r.message('late', { t: 'ResyncRequest', have: 1, fresh: true });
  await r.flush();
  assert.equal(a.last('SnapshotRequest').t, 'SnapshotRequest', 'the holder is asked');
  assert.equal(late.all('Resync').length, 0, 'it waits for the fresh one');
  r.message('a', { t: 'Snapshot', rev: 2, doc: '{"v":2}', history: [] });
  await r.flush();
  const resync = late.last('Resync');
  assert.equal(resync.rev, 2);
  assert.equal(resync.snapshot, '{"v":2}');
  await done();
});

test('a holder that needs a fresh snapshot gets one from another editor', async () => {
  const { r, a, done } = await room();
  const b = member('b');
  r.join(b);
  r.message('a', op('a', 1));
  r.message('a', op('a', 2, { kind: 'undo', cmd: 'collab.undo', params: { target: 1 } }));
  await r.flush();
  r.message('a', { t: 'ResyncRequest', have: 2, fresh: true });
  assert.equal(a.all('Resync').length, 0, 'not the stored snapshot, from before the undo');
  assert.equal(a.all('SnapshotRequest').length, 0);
  assert.equal(b.all('SnapshotRequest').length, 1, 'another editor is asked');
  r.message('b', { t: 'Snapshot', rev: 2, doc: '{"v":2}', history: [] });
  await r.flush();
  assert.equal(a.last('Resync').rev, 2);
  await done();
});

test('a fresh snapshot nobody sends falls back to the stored one', async () => {
  const { r, c, done } = await room();
  const late = member('late');
  r.join(late);
  r.message('a', op('a', 1));
  r.message('a', op('a', 2, { kind: 'undo', cmd: 'collab.undo', params: { target: 1 } }));
  await r.flush();
  r.message('late', { t: 'ResyncRequest', have: 0, fresh: true });
  assert.equal(late.all('Resync').length, 0);
  c.advance(15_000);
  assert.equal(late.last('Resync').rev, 0, 'the stored snapshot and the log after it');
  await done();
});

test('fresh resyncs are rate limited, and only honoured after an undo or redo', async () => {
  const { r, a, done } = await room();
  const vic = member('vic', { role: 'view' });
  r.join(vic);
  r.message('a', op('a', 1));
  await r.flush();
  r.message('vic', { t: 'ResyncRequest', have: 0, fresh: true });
  assert.equal(a.all('SnapshotRequest').length, 0, 'no undo: a plain resync');
  assert.equal(vic.all('Resync').length, 1);
  r.message('a', op('a', 2, { kind: 'undo', cmd: 'collab.undo', params: { target: 1 } }));
  await r.flush();
  for (let i = 0; i < 5; i++) r.message('vic', { t: 'ResyncRequest', have: 0, fresh: true });
  assert.ok(a.all('SnapshotRequest').length <= 1, `at most one upload: ${a.all('SnapshotRequest').length}`);
  await done();
});
