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
