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

// Role changes: what an undo may touch follows the role the person has now, not the one they
// had when they made the edit.
const tracked = (client, seq, fields = {}) => op(client, seq, { cmd: 'text.insert', ctx: { track: true }, ...fields });

test('someone who edited and now only comments may undo only their comments', async () => {
  const { r, done } = await room();
  r.message('a', op('a', 1)); // a real edit
  r.message('a', op('a', 2, { cmd: 'review.newComment' }));
  r.message('a', tracked('a', 3)); // a tracked edit
  const c = member('a-now', { sub: 'a', role: 'comment' });
  r.join(c);
  r.message('a-now', undo('a-now', 1, 1));
  r.message('a-now', undo('a-now', 2, 3));
  r.message('a-now', undo('a-now', 3, 2)); // the comment: allowed (rev 4)
  r.message('a-now', undo('a-now', 4, 4, 'redo')); // redo of that undo: still only a comment (rev 5)
  r.message('a-now', op('a-now', 5, { kind: 'undo', cmd: 'collab.undo', params: { target: 2, more: [1] } }));
  await r.flush();
  assert.equal(r.rev, 5);
  assert.deepEqual(c.all('Refused').map((x) => [x.seq, x.reason]), [
    [1, 'You can only comment on this document'],
    [2, 'You can only comment on this document'],
    [5, 'You can only comment on this document'],
  ]);
  await done();
});

test('someone who edited and now only suggests may undo comments and tracked edits, not real ones', async () => {
  const { r, done } = await room();
  r.message('a', op('a', 1)); // a real edit
  r.message('a', tracked('a', 2)); // tracked, a suggest command
  r.message('a', op('a', 3, { cmd: 'review.newComment' }));
  r.message('a', op('a', 4, { cmd: 'table.insert', ctx: { track: true } })); // tracked but not a suggest command
  r.message('a', op('a', 5, { kind: 'undo', cmd: 'collab.undo', params: { target: 1 } })); // an undo of a real edit
  const s = member('a-now', { sub: 'a', role: 'suggest' });
  r.join(s);
  r.message('a-now', undo('a-now', 1, 1));
  r.message('a-now', undo('a-now', 2, 2)); // rev 6
  r.message('a-now', undo('a-now', 3, 3)); // rev 7
  r.message('a-now', undo('a-now', 4, 4));
  r.message('a-now', undo('a-now', 5, 5, 'redo'));
  r.message('a-now', undo('a-now', 6, 6, 'redo')); // rev 8
  await r.flush();
  assert.equal(r.rev, 8);
  assert.deepEqual(s.all('Refused').map((x) => [x.seq, x.reason]), [
    [1, 'You can only suggest changes in this document'],
    [4, 'You can only suggest changes in this document'],
    [5, 'You can only suggest changes in this document'],
  ]);
  await done();
});

test('what each edit needs to be undone is remembered across snapshots and restarts', async () => {
  const { r, c, dir, done } = await room({ limits: { snapshotEvery: 1000 } });
  r.message('a', op('a', 1));
  r.message('a', op('a', 2, { cmd: 'review.newComment' }));
  r.message('a', op('a', 3));
  r.message('a', op('a', 4, { cmd: 'review.newComment' }));
  await r.flush();
  r.snapshotFrom = 'a'; // as if asked
  r.message('a', { t: 'Snapshot', rev: 2, doc: '{"v":2}' });
  await r.flush();
  const again = new Room({ id: 'doc-1', store: createStore(dir, { flushMs: 0 }), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  await again.load();
  assert.ok(again.log.every((o) => !('needs' in o) && !('sub' in o)), 'replicas are not sent it');
  const cm = member('a-now', { sub: 'a', role: 'comment' });
  again.join(cm);
  again.message('a-now', undo('a-now', 1, 1)); // before the snapshot: an edit
  again.message('a-now', undo('a-now', 2, 2)); // before the snapshot: a comment
  again.message('a-now', undo('a-now', 3, 3)); // after it: an edit
  again.message('a-now', undo('a-now', 4, 4)); // after it: a comment
  await again.flush();
  assert.deepEqual(cm.all('Refused').map((x) => x.seq), [1, 3]);
  assert.equal(again.rev, 6);
  await done();
  rmSync(dir, { recursive: true, force: true });
});

test('edits stored before this was remembered: editors may undo them, nobody else', async () => {
  const { r, c, dir, store, done } = await room();
  // As an older relay stored them: who made each edit, nothing about what it was.
  await store.writeSnapshot('doc-1', { rev: 1, doc: '{"v":1}', seen: { a: 1 }, history: [], authors: { 1: 'a' } }, [
    { t: 'Op', client: 'a', seq: 2, base: 1, kind: 'cmd', cmd: 'review.newComment', params: {}, sel: { story: 'body', anchor: 0, head: 0 }, ctx: {}, rev: 2, user: 'A', sub: 'a' },
  ]);
  await r.flush();
  const again = new Room({ id: 'doc-1', store: createStore(dir, { flushMs: 0 }), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  await again.load();
  const cm = member('a-c', { sub: 'a', role: 'comment' });
  const ed = member('a-e', { sub: 'a', role: 'edit' });
  again.join(ed);
  again.join(cm);
  again.message('a-c', undo('a-c', 1, 1));
  again.message('a-c', undo('a-c', 2, 2));
  await again.flush();
  assert.deepEqual(cm.all('Refused').map((x) => x.seq), [1, 2]);
  again.message('a-e', undo('a-e', 1, 1));
  again.message('a-e', undo('a-e', 2, 2));
  await again.flush();
  assert.equal(ed.last('Refused'), undefined);
  assert.equal(again.rev, 4);
  await done();
  rmSync(dir, { recursive: true, force: true });
});
