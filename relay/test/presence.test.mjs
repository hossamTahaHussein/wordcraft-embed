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
  r.message('a', { t: 'Presence', sel: sel(3, 5), rev: 0 });
  assert.deepEqual(b.last('Presence'), { t: 'Presence', client: 'a', user: 'A', color: 0, sel: sel(3, 5), rev: 0 });
  assert.equal(a.last('Presence'), undefined);
  await done();
});

test('presence is not logged or saved', async () => {
  const { r, a, done } = await room();
  r.message('a', { t: 'Presence', sel: sel(1), rev: 0 });
  assert.equal(r.rev, 0);
  assert.equal(r.log.length, 0);
  await done();
});

test('welcome lists present peers with their last selections', async () => {
  const { r, a, done } = await room();
  r.message('a', { t: 'Presence', sel: sel(4), rev: 0 });
  const b = member('b');
  r.join(b);
  assert.deepEqual(b.last('Welcome').peers, [{ client: 'a', user: 'A', color: 0, sel: sel(4), rev: 0 }]);
  await done();
});

test('malformed presence is ignored', async () => {
  const { r, a, done } = await room();
  const b = member('b');
  r.join(b);
  for (const bad of [
    { t: 'Presence', rev: 0 },
    { t: 'Presence', sel: 'x', rev: 0 },
    { t: 'Presence', sel: { story: 'body', anchor: -1, head: 0 }, rev: 0 },
    { t: 'Presence', sel: sel(1) },
    { t: 'Presence', sel: { story: { part: 2 ** 32 }, anchor: 0, head: 0 }, rev: 0 },
    { t: 'Presence', sel: { story: 'body', anchor: 2 ** 40, head: 0 }, rev: 0 },
  ]) {
    r.message('a', bad);
  }
  assert.equal(b.last('Presence'), undefined);
  await done();
});

test('leave is broadcast when a connection is closed by the rate limit', async () => {
  const { r, a, done } = await room();
  const b = member('b');
  r.join(b);
  for (let i = 0; i < 260; i++) r.message('b', { t: 'SnapshotRequest' });
  assert.equal(b.closed?.code, 4429);
  assert.deepEqual(a.last('Leave'), { t: 'Leave', client: 'b' });
  await done();
});

test('too much presence is dropped, not punished, and uses its own allowance', async () => {
  const { r, a, done } = await room();
  const b = member('b');
  r.join(b);
  for (let i = 0; i < 100; i++) r.message('b', { t: 'Presence', sel: sel(i), rev: 0 });
  assert.equal(b.closed, null, 'not disconnected');
  const forwarded = a.all('Presence').length;
  assert.ok(forwarded >= 1 && forwarded <= 20, `about 15 a second forwarded, got ${forwarded}`);
  await done();
});

test('presence is rebuilt from known fields only', async () => {
  const { r, a, done } = await room();
  const b = member('b');
  r.join(b);
  r.message('b', { t: 'Presence', sel: { story: { part: 1, junk: 'z'.repeat(1000) }, anchor: 2, head: 3, extra: 'x' }, rev: 0, more: 'y' });
  assert.deepEqual(a.last('Presence'), { t: 'Presence', client: 'b', user: 'B', color: 1, sel: { story: { part: 1 }, anchor: 2, head: 3 }, rev: 0 });
  await done();
});

test('presence at a revision the relay has not stored yet is refused', async () => {
  const { r, a, done } = await room();
  const b = member('b');
  r.join(b);
  r.message('b', { t: 'Presence', sel: sel(1), rev: 1 });
  assert.equal(a.last('Presence'), undefined);
  await done();
});

test('the first person is told who else is already waiting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-presence-'));
  const store = createStore(dir, { flushMs: 0 });
  const r = new Room({ id: 'doc', store });
  await r.load();
  const a = member('a');
  const b = member('b');
  r.join(a);
  r.join(b); // waits for a's document
  r.leave('a', a); // b opens the document instead
  assert.equal(b.closed, null, 'b keeps its connection');
  assert.equal(b.last('Welcome').snapshot, null);
  const c = member('c');
  r.join(c); // waits for b's document
  r.message('b', { t: 'Snapshot', rev: 0, doc: '{}' });
  assert.deepEqual(c.last('Welcome').peers.map((p) => p.client), ['b']);
  const d = mkdtempSync(join(tmpdir(), 'wc-presence-'));
  const r2 = new Room({ id: 'doc', store: createStore(d, { flushMs: 0 }) });
  await r2.load();
  const x = member('x');
  const y = member('y');
  r2.join(y);
  r2.leave('y', y);
  r2.join(x);
  const z = member('z');
  r2.join(z);
  r2.leave('x', x);
  assert.deepEqual(z.last('Welcome').peers, [], 'nobody else left');
  await r.flush();
  await r2.flush();
  rmSync(dir, { recursive: true, force: true });
  rmSync(d, { recursive: true, force: true });
});

test('presence keeps the revision it is relative to, for others and for newcomers', async () => {
  const { r, a, done } = await room();
  const b = member('b');
  r.join(b);
  r.message('a', { t: 'Op', seq: 1, base: 0, kind: 'cmd', cmd: 'text.insert', params: { text: 'x' }, sel: sel(0), ctx: {} });
  await r.flush();
  r.message('a', { t: 'Presence', sel: sel(2), rev: 1 });
  assert.equal(b.last('Presence').rev, 1);
  const c = member('c');
  r.join(c);
  assert.equal(c.last('Welcome').peers.find((p) => p.client === 'a').rev, 1);
  r.message('a', { t: 'Presence', sel: sel(2), rev: -1 });
  assert.equal(b.all('Presence').length, 1, 'a bad revision is refused');
  await done();
});
