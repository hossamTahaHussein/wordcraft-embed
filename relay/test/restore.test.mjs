import { test } from 'node:test';
import assert from 'node:assert/strict';
import { member, op, room, tick } from './helpers.mjs';

const restore = (client, seq, version) => op(client, seq, { kind: 'restore', cmd: 'collab.restore', params: { version } });

/** A room with a version at revision 1 holding '{"v":1}'. */
async function withVersion(opts = {}) {
  const seen = [];
  const t = await room({ start: Date.parse('2026-10-29T09:00:00Z'), events: (type, d) => seen.push([type, d]), ...opts });
  t.r.message('a', op('a', 1));
  await t.r.flush();
  t.r.message('a', { t: 'Saved', rev: 1 });
  t.r.message('a', { t: 'Version', rev: 1, doc: '{"v":1}' });
  await t.r.flush();
  await tick(10);
  return { ...t, seen };
}

async function until(cond) {
  for (let i = 0; i < 200 && !cond(); i++) await tick(5);
}

test("an editor's restore carries the version's document to everyone", async () => {
  const { r, a, seen, done } = await withVersion();
  const b = member('b');
  r.join(b);
  r.message('a', restore('a', 2, 1));
  await until(() => b.last('Op')?.kind === 'restore');
  const o = b.last('Op');
  assert.deepEqual([o.rev, o.cmd, o.params], [2, 'collab.restore', { version: 1, doc: '{"v":1}' }]);
  assert.deepEqual(a.last('Op'), o);
  assert.deepEqual(seen.filter(([t]) => t === 'restored'), [['restored', { rev: 2, version: 1 }]]);
  const late = member('late');
  r.join(late);
  assert.equal(late.got[0].ops.at(-1).params.doc, '{"v":1}', 'kept in the log for newcomers');
  await done();
});

test('restoring a version that is not there is refused', async () => {
  const { r, a, done } = await withVersion();
  r.message('a', restore('a', 2, 5));
  r.message('a', restore('a', 3, 'x'));
  await until(() => a.all('Refused').length === 2);
  assert.deepEqual(a.all('Refused').map((x) => [x.seq, x.reason]), [
    [2, 'That version is no longer available'],
    [3, 'That version is no longer available'],
  ]);
  assert.equal(r.rev, 1);
  await done();
});

test('a doc the editor sent along is replaced by the stored one', async () => {
  const { r, a, done } = await withVersion();
  r.message('a', op('a', 2, { kind: 'restore', cmd: 'collab.restore', params: { version: 1, doc: '{"forged":1}' } }));
  await until(() => a.last('Op')?.rev === 2);
  assert.equal(a.last('Op').params.doc, '{"v":1}');
  await done();
});

test('edits arriving while a version loads are sequenced after the restore, in order', async () => {
  const { r, a, done } = await withVersion();
  const b = member('b');
  r.join(b);
  r.message('a', restore('a', 2, 1));
  r.message('b', op('b', 1, { params: { text: 'after' } }));
  r.message('a', op('a', 3, { params: { text: 'mine' } }));
  await until(() => a.all('Op').length === 4);
  assert.deepEqual(a.all('Op').map((o) => [o.rev, o.kind, o.client]), [
    [1, 'cmd', 'a'],
    [2, 'restore', 'a'],
    [3, 'cmd', 'b'],
    [4, 'cmd', 'a'],
  ]);
  await done();
});

test('only editors restore', async () => {
  const { r, done } = await withVersion();
  const c = member('c', { role: 'comment' });
  const v = member('v', { role: 'view' });
  r.join(c);
  r.join(v);
  r.message('c', restore('c', 1, 1));
  r.message('v', restore('v', 1, 1));
  await tick(20);
  assert.equal(c.last('Refused').reason, 'You can only comment on this document');
  assert.equal(v.last('Refused').reason, 'You can only view this document');
  assert.equal(r.rev, 1);
  await done();
});

test('the restorer may undo the restore', async () => {
  const { r, a, done } = await withVersion();
  r.message('a', restore('a', 2, 1));
  await until(() => a.last('Op')?.rev === 2);
  r.message('a', op('a', 3, { kind: 'undo', cmd: 'collab.undo', params: { target: 2 } }));
  await until(() => a.last('Op')?.rev === 3);
  assert.equal(a.last('Op').kind, 'undo');
  await done();
});

test('the document a restore replaces is kept as a version first', async () => {
  const { r, a, done } = await withVersion();
  r.message('a', op('a', 2));
  await r.flush();
  r.message('a', restore('a', 3, 1));
  const ask = a.last('VersionRequest');
  assert.equal(ask.rev, 2, 'asked for the document as it is before the restore');
  r.message('a', { t: 'Version', rev: 2, doc: '{"v":2}' });
  await until(() => a.last('Op')?.kind === 'restore');
  await tick(10);
  r.message('a', { t: 'Versions' });
  assert.deepEqual(a.last('VersionList').versions.map((v) => v.rev), [2, 1]);
  await done();
});
