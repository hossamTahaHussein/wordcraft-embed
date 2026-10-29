import { test } from 'node:test';
import assert from 'node:assert/strict';
import { member, op, room } from './helpers.mjs';

test('an agent is never the lease holder, even when it came first', async () => {
  const { r, c, a, done } = await room();
  const bot = member('bot', { agent: true });
  r.leave('a', a);
  r.join(bot);
  const p = member('p');
  r.join(p);
  r.message('bot', op('bot', 1));
  await r.flush();
  c.advance(2000);
  assert.ok(p.types().includes('Save'));
  assert.equal(bot.types().includes('Save'), false);
  assert.equal(bot.last('Op').rev, 1, 'its edits are sequenced like anyone else\'s');
  await done();
});

test('an agent alone saves nothing and is never asked for a snapshot', async () => {
  const { r, c, a, done } = await room({ limits: { snapshotEvery: 2 } });
  const bot = member('bot', { agent: true });
  r.join(bot);
  r.leave('a', a);
  r.message('bot', op('bot', 1));
  r.message('bot', op('bot', 2));
  await r.flush();
  c.advance(10000);
  assert.deepEqual(bot.types().filter((t) => t === 'Save' || t === 'SnapshotRequest'), []);
  await done();
});

test('an agent never opens a new document: it waits for a person', async () => {
  const { r, done } = await room({ first: null });
  const bot = member('bot', { agent: true });
  r.join(bot);
  assert.equal(bot.got.length, 0);
  const p = member('p');
  r.join(p);
  assert.equal(p.got[0].snapshot, null);
  r.message('p', { t: 'Snapshot', rev: 0, doc: '{}' });
  assert.equal(bot.last('Welcome').snapshot, '{}');
  await done();
});
