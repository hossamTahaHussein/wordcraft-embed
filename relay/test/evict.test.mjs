import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Room } from '../room.mjs';
import { createRelay } from '../server.mjs';
import { createStore } from '../store.mjs';
import { issueToken } from '../token.mjs';
import { connect, member, op, room, tick } from './helpers.mjs';

const MIN = 60_000;
const START = Date.parse('2026-10-29T09:00:00Z');

test('a room nobody is in is let go after it has been idle for idleEvictMs', async () => {
  const idle = [];
  const { r, c, done } = await room({ onIdle: (x) => idle.push(x) });
  const b = member('b');
  r.join(b);
  r.message('a', op('a', 1));
  await r.flush();
  c.advance(60 * MIN);
  assert.equal(idle.length, 0, 'not while people are in it');
  r.leave('a');
  c.advance(60 * MIN);
  assert.equal(idle.length, 0, 'b is still there');
  r.leave('b');
  c.advance(10 * MIN - 1);
  assert.equal(idle.length, 0);
  c.advance(1);
  assert.deepEqual(idle, [r]);
  await done();
});

test('someone arriving stops the countdown; it starts again when they leave', async () => {
  const idle = [];
  const { r, c, done } = await room({ onIdle: (x) => idle.push(x), limits: { idleEvictMs: 1000 } });
  await r.flush(); // revision 0 is on disk
  r.leave('a');
  c.advance(900);
  r.join(member('b'));
  c.advance(5000);
  assert.equal(idle.length, 0);
  r.leave('b');
  c.advance(1000);
  assert.equal(idle.length, 1);
  await done();
});

test('a room loaded only for a lookup (nobody joins) is let go too', async () => {
  const { dir, c, done } = await room();
  const idle = [];
  const again = new Room({ id: 'doc-1', store: createStore(dir, { flushMs: 0 }), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onIdle: (x) => idle.push(x) });
  await again.load();
  c.advance(10 * MIN);
  assert.deepEqual(idle, [again]);
  await done();
});

test('a room with writes still to land is not let go until they have', async () => {
  const idle = [];
  const { r, c, store, done } = await room({ onIdle: (x) => idle.push(x), limits: { idleEvictMs: 1000 } });
  await r.flush(); // revision 0 is on disk
  let busy = true;
  const real = store.idle;
  store.idle = (id) => !busy && real(id);
  r.leave('a');
  c.advance(1000);
  assert.equal(idle.length, 0, 'the store is still writing');
  busy = false;
  c.advance(1000);
  assert.equal(idle.length, 1);
  await done();
});

test('a room just closed (joins refused for 10 s) is not let go while that holds', async () => {
  const idle = [];
  const { r, c, done } = await room({ onIdle: (x) => idle.push(x), limits: { idleEvictMs: 1000 } });
  await r.flush(); // revision 0 is on disk
  r.closeAll();
  c.advance(1000);
  assert.equal(idle.length, 0);
  c.advance(9000);
  assert.equal(idle.length, 1);
  await done();
});

test('a room let go and loaded again has everything: rev, saves, versions, who made what', async () => {
  const { r, a, c, dir, done } = await room({ start: START, limits: { snapshotEvery: 3 } });
  r.message('a', op('a', 1));
  r.message('a', op('a', 2, { cmd: 'review.newComment' }));
  r.message('a', op('a', 3));
  await r.flush();
  r.message('a', { t: 'Snapshot', rev: 3, doc: '{"v":3}' });
  r.message('a', op('a', 4));
  r.message('a', op('a', 5, { cmd: 'review.newComment' }));
  await r.flush();
  r.message('a', { t: 'Saved', rev: 5 });
  r.message('a', { t: 'Version', rev: 5, doc: '{"v":5}' });
  await r.flush();
  await tick(20);
  r.leave('a');
  await r.flush();
  const again = new Room({ id: 'doc-1', store: createStore(dir, { flushMs: 0 }), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  await again.load();
  assert.equal(again.rev, 5);
  assert.equal(again.savedRev, 5);
  assert.equal(again.lastSaved, r.lastSaved);
  assert.deepEqual(again.versions, r.versions);
  assert.equal(again.versions.length, 1);
  assert.deepEqual([...again.authors], [...r.authors]);
  assert.deepEqual([...again.needed], [...r.needed]);
  // As the person who made them, now a commenter: only the comments can be undone.
  const cm = member('a-c', { sub: 'a', role: 'comment' });
  again.join(cm);
  again.message('a-c', op('a-c', 1, { kind: 'undo', cmd: 'collab.undo', params: { target: 2 } }));
  again.message('a-c', op('a-c', 2, { kind: 'undo', cmd: 'collab.undo', params: { target: 4 } }));
  again.message('a-c', op('a-c', 3, { kind: 'undo', cmd: 'collab.undo', params: { target: 5 } }));
  await again.flush();
  assert.deepEqual(cm.all('Refused').map((x) => x.seq), [2]);
  assert.equal(again.rev, 7);
  // An edit resent after the reload is still recognised as a duplicate.
  const a2 = member('a');
  again.join(a2, 7);
  again.message('a', op('a', 5));
  await again.flush();
  assert.equal(again.rev, 7);
  assert.equal(a.closed, null);
  await done();
});

test('the relay lets go of rooms nobody is in and loads them again when needed', async () => {
  const SECRET = 'evict-secret-0123456789';
  const KEY = 'evict-key-0123456789';
  const dir = mkdtempSync(join(tmpdir(), 'wc-evict-'));
  const relay = await createRelay({ secret: SECRET, dataDir: dir, port: 0, apiKey: KEY, limits: { idleEvictMs: 100 } });
  const info = async () => (await fetch(`http://127.0.0.1:${relay.port}/api/docs/ev`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
  const enter = async (sub, client) => {
    const m = await connect(`ws://127.0.0.1:${relay.port}/relay`);
    m.send({ t: 'hello', token: issueToken(SECRET, { doc: 'ev', sub, name: sub, role: 'edit' }), client });
    return m;
  };
  try {
    const a = await enter('ann', 'ca');
    assert.equal((await a.next('Welcome')).snapshot, null);
    a.send({ t: 'Snapshot', rev: 0, doc: '{}' });
    a.send({ t: 'Op', client: 'ca', seq: 1, base: 0, kind: 'cmd', cmd: 'text.insert', params: { text: 'x' }, sel: { story: 'body', anchor: 0, head: 0 }, ctx: {} });
    await a.next('Op');
    await tick(300);
    assert.deepEqual(relay.loadedRooms(), ['ev'], 'kept while someone is in it');
    a.ws.close();
    await a.closed;
    await tick(300);
    assert.deepEqual(relay.loadedRooms(), []);
    assert.equal((await info()).rev, 1, 'a lookup loads it again, with everything');
    assert.deepEqual(relay.loadedRooms(), ['ev']);
    await tick(300);
    assert.deepEqual(relay.loadedRooms(), [], 'and lets it go again');
    const b = await enter('ann', 'ca2');
    const w = await b.next('Welcome');
    assert.equal(w.rev, 0);
    assert.equal(w.ops.length, 1);
    b.ws.close();
  } finally {
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
