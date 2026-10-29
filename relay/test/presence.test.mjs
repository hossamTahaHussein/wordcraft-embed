import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Room } from '../room.mjs';
import { createStore } from '../store.mjs';

function member(client) {
  const m = { client, sub: client, user: client.toUpperCase(), role: 'edit', got: [], closed: null };
  m.send = (msg) => m.got.push(msg);
  m.close = (code) => (m.closed = { code });
  m.all = (t) => m.got.filter((x) => x.t === t);
  m.last = (t) => m.all(t).at(-1);
  return m;
}

const sel = (anchor, head = anchor) => ({ story: 'body', anchor, head });

async function room() {
  const dir = mkdtempSync(join(tmpdir(), 'wc-presence-'));
  const store = createStore(dir, { flushMs: 0 });
  const r = new Room({ id: 'doc', store });
  await r.load();
  const a = member('a');
  r.join(a);
  r.message('a', { t: 'Snapshot', rev: 0, doc: '{}' });
  return { r, a, store, dir, done: async () => { await r.flush(); rmSync(dir, { recursive: true, force: true }); } };
}

test('join and leave are broadcast with colours; a free colour is reused', async () => {
  const { r, a, done } = await room();
  const b = member('b');
  r.join(b);
  assert.deepEqual(a.last('Join'), { t: 'Join', client: 'b', user: 'B', color: 1 });
  r.leave('b', b);
  assert.deepEqual(a.last('Leave'), { t: 'Leave', client: 'b' });
  const c = member('c');
  r.join(c);
  assert.equal(a.last('Join').color, 1, 'the colour b left is free again');
  await done();
});

test('presence is forwarded to the others, not the sender', async () => {
  const { r, a, done } = await room();
  const b = member('b');
  r.join(b);
  r.message('a', { t: 'Presence', sel: sel(3, 5) });
  assert.deepEqual(b.last('Presence'), { t: 'Presence', client: 'a', user: 'A', color: 0, sel: sel(3, 5) });
  assert.equal(a.last('Presence'), undefined);
  await done();
});

test('presence is not logged or saved', async () => {
  const { r, a, done } = await room();
  r.message('a', { t: 'Presence', sel: sel(1) });
  assert.equal(r.rev, 0);
  assert.equal(r.log.length, 0);
  await done();
});

test('welcome lists present peers with their last selections', async () => {
  const { r, a, done } = await room();
  r.message('a', { t: 'Presence', sel: sel(4) });
  const b = member('b');
  r.join(b);
  assert.deepEqual(b.last('Welcome').peers, [{ client: 'a', user: 'A', color: 0, sel: sel(4) }]);
  await done();
});

test('malformed presence is ignored', async () => {
  const { r, a, done } = await room();
  const b = member('b');
  r.join(b);
  for (const bad of [{ t: 'Presence' }, { t: 'Presence', sel: 'x' }, { t: 'Presence', sel: { story: 'body', anchor: -1, head: 0 } }]) {
    r.message('a', bad);
  }
  assert.equal(b.last('Presence'), undefined);
  await done();
});

test('leave is broadcast when a connection is closed by the rate limit', async () => {
  const { r, a, done } = await room();
  const b = member('b');
  r.join(b);
  for (let i = 0; i < 260; i++) r.message('b', { t: 'Presence', sel: sel(1) });
  assert.equal(b.closed?.code, 4429, 'presence counts toward the rate limit');
  assert.deepEqual(a.last('Leave'), { t: 'Leave', client: 'b' });
  await done();
});

test('presence keeps the revision it is relative to, for others and for newcomers', async () => {
  const { r, a, done } = await room();
  const b = member('b');
  r.join(b);
  r.message('a', { t: 'Presence', sel: sel(2), rev: 7 });
  assert.equal(b.last('Presence').rev, 7);
  const c = member('c');
  r.join(c);
  assert.equal(c.last('Welcome').peers.find((p) => p.client === 'a').rev, 7);
  r.message('a', { t: 'Presence', sel: sel(2), rev: -1 });
  assert.equal(b.all('Presence').length, 1, 'a bad revision is refused');
  await done();
});
