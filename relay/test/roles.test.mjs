import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { member, op, room } from './helpers.mjs';

test('comment-commands.json lists exactly the comment commands', () => {
  const list = JSON.parse(readFileSync(new URL('../comment-commands.json', import.meta.url), 'utf8'));
  assert.deepEqual(list, ['review.newComment', 'review.reply', 'review.editComment', 'review.deleteComment', 'review.resolveComment']);
});

test('Welcome carries the role from the token', async () => {
  const { r, a, done } = await room();
  assert.equal(a.got[0].role, 'edit');
  const v = member('v', { role: 'view' });
  const c = member('c', { role: 'comment' });
  r.join(v);
  r.join(c);
  assert.equal(v.last('Welcome').role, 'view');
  assert.equal(c.last('Welcome').role, 'comment');
  await done();
});

test('a viewer may send no ops: Refused to the sender only, not sequenced', async () => {
  const { r, a, done } = await room();
  const v = member('v', { role: 'view' });
  r.join(v);
  r.message('v', op('v', 1));
  await r.flush();
  assert.deepEqual(v.last('Refused'), { t: 'Refused', seq: 1, reason: 'You can only view this document' });
  assert.equal(r.rev, 0);
  assert.equal(a.last('Refused'), undefined);
  assert.equal(a.last('Op'), undefined);
  await done();
});

test('a commenter may run only the comment commands', async () => {
  const { r, a, done } = await room();
  const c = member('c', { role: 'comment' });
  r.join(c);
  r.message('c', op('c', 1, { cmd: 'review.newComment', params: { text: 'hi' } }));
  r.message('c', op('c', 2, { cmd: 'text.insert' }));
  r.message('c', op('c', 3, { kind: 'restore', cmd: 'collab.restore', params: { version: 1 } }));
  await r.flush();
  assert.deepEqual(a.all('Op').map((o) => o.cmd), ['review.newComment']);
  assert.deepEqual(c.all('Refused'), [
    { t: 'Refused', seq: 2, reason: 'You can only comment on this document' },
    { t: 'Refused', seq: 3, reason: 'You can only comment on this document' },
  ]);
  await done();
});

test('a refused op does not block the next one from the same replica', async () => {
  const { r, a, done } = await room();
  const c = member('c', { role: 'comment' });
  r.join(c);
  r.message('c', op('c', 1, { cmd: 'text.insert' }));
  r.message('c', op('c', 2, { cmd: 'review.resolveComment' }));
  await r.flush();
  assert.deepEqual(a.all('Op').map((o) => o.seq), [2]);
  await done();
});

test('viewers and commenters still send presence and hashes', async () => {
  const { r, a, done } = await room({ limits: { hashEvery: 1 } });
  const v = member('v', { role: 'view' });
  r.join(v);
  r.message('v', { t: 'Presence', sel: { story: 'body', anchor: 1, head: 1 }, rev: 0 });
  assert.equal(a.last('Presence').client, 'v');
  r.message('a', op('a', 1));
  await r.flush();
  r.message('a', { t: 'Hash', rev: 1, h: 'good' });
  r.message('v', { t: 'Hash', rev: 1, h: 'bad' });
  assert.ok(v.last('Resync'), 'the viewer disagreed with the holder and starts again');
  await done();
});

test('only editors hold the autosave lease', async () => {
  const { r, a, c, done } = await room({ first: null });
  const v = member('v', { role: 'view' });
  const e = member('e');
  r.join(v);
  assert.equal(v.got.length, 0, 'a viewer never opens the document; it waits for an editor');
  r.join(e);
  assert.deepEqual([e.got[0].t, e.got[0].snapshot], ['Welcome', null]);
  r.message('e', { t: 'Snapshot', rev: 0, doc: '{}' });
  assert.equal(v.last('Welcome').snapshot, '{}');
  r.message('e', op('e', 1));
  c.advance(2000);
  assert.ok(e.types().includes('Save'));
  assert.equal(v.types().includes('Save'), false);
  assert.equal(a, null);
  await done();
});

test('a viewer that leaves no editor makes nobody the holder', async () => {
  const { r, a, c, done } = await room();
  const v = member('v', { role: 'view' });
  r.join(v);
  r.message('a', op('a', 1));
  await r.flush();
  r.leave('a', a);
  c.advance(10000);
  assert.equal(v.types().includes('Save'), false);
  await done();
});

test('Saved from a viewer is ignored', async () => {
  const { r, done } = await room();
  const v = member('v', { role: 'view' });
  r.join(v);
  r.message('a', op('a', 1));
  await r.flush();
  r.message('v', { t: 'Saved', rev: 1 });
  assert.equal(r.savedRev, 0);
  await done();
});

test('the holder is asked for snapshots even when a commenter joined first', async () => {
  const { r, a, done } = await room({ limits: { snapshotEvery: 2 } });
  r.leave('a', a);
  const c = member('c', { role: 'comment' });
  const e = member('e');
  r.join(c);
  r.join(e);
  r.message('e', op('e', 1));
  r.message('e', op('e', 2));
  await r.flush();
  assert.ok(e.types().includes('SnapshotRequest'));
  assert.equal(c.types().includes('SnapshotRequest'), false);
  await done();
});
