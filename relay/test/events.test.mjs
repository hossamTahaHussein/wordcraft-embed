import { test } from 'node:test';
import assert from 'node:assert/strict';
import { member, op, room } from './helpers.mjs';

function recorder() {
  const seen = [];
  const events = (type, detail) => seen.push([type, detail]);
  return { seen, events, of: (t) => seen.filter(([x]) => x === t).map(([, d]) => d) };
}

test('joined and left, once per connection (a reconnect replacing one is neither)', async () => {
  const rec = recorder();
  const { r, a, done } = await room({ events: rec.events });
  const bot = member('bot', { agent: true, sub: 'b1', user: 'Bot' });
  r.join(bot);
  r.join(member('a'));
  r.leave('bot', bot);
  assert.deepEqual(rec.of('joined'), [
    { sub: 'a', name: 'A', role: 'edit' },
    { sub: 'b1', name: 'Bot', role: 'edit', agent: true },
  ]);
  assert.deepEqual(rec.of('left'), [{ sub: 'b1', name: 'Bot' }]);
  assert.ok(a.closed, 'the old connection was replaced');
  await done();
});

test('a member turned away is never joined', async () => {
  const rec = recorder();
  const { r, done } = await room({ events: rec.events, limits: { members: 1 } });
  r.join(member('x'));
  assert.equal(rec.of('joined').length, 1);
  await done();
});

test('saved when a save lands, edited per sequenced op, commented for comment commands', async () => {
  const rec = recorder();
  const { r, done } = await room({ events: rec.events });
  r.message('a', op('a', 1));
  r.message('a', op('a', 2, { cmd: 'review.newComment' }));
  r.message('a', op('a', 3, { cmd: 'review.resolveComment' }));
  r.message('a', op('a', 4, { cmd: 'review.editComment' }));
  r.message('a', op('a', 5, { cmd: 'review.deleteComment' }));
  await r.flush();
  r.message('a', { t: 'Saved', rev: 5 });
  r.message('a', { t: 'Saved', rev: 5 });
  assert.deepEqual(rec.of('edited').map((d) => [d.rev, d.name]), [[1, 'A'], [2, 'A'], [3, 'A'], [4, 'A'], [5, 'A']]);
  assert.deepEqual(rec.of('commented'), [
    { action: 'added', by: 'A', rev: 2 },
    { action: 'resolved', by: 'A', rev: 3 },
    { action: 'edited', by: 'A', rev: 4 },
    { action: 'deleted', by: 'A', rev: 5 },
  ]);
  assert.deepEqual(rec.of('saved'), [{ rev: 5 }]);
  await done();
});
