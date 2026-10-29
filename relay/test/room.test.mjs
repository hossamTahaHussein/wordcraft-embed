import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Room } from '../room.mjs';
import { createStore } from '../store.mjs';

/** Fake timers: `advance(ms)` runs what is due. */
function clock() {
  let t = 0;
  let timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const timer = { at: t + ms, fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timers = timers.filter((x) => x !== timer);
    },
    advance(ms) {
      t += ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) return;
        timers = timers.filter((x) => x !== due);
        due.fn();
      }
    },
  };
}

function member(client, user = client.toUpperCase()) {
  const m = { client, sub: client, user, role: 'edit', got: [], closed: null };
  m.send = (msg) => m.got.push(msg);
  m.close = (code, reason) => (m.closed = { code, reason });
  m.types = () => m.got.map((x) => x.t);
  m.last = (t) => m.got.filter((x) => x.t === t).at(-1);
  return m;
}

function op(client, seq, text = 'x', base = 0) {
  return { t: 'Op', client, seq, base, kind: 'cmd', cmd: 'text.insert', params: { text }, sel: { story: 'body', anchor: 0, head: 0 }, ctx: {} };
}

async function room(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-room-'));
  const store = createStore(dir, { flushMs: 0 });
  const c = clock();
  const r = new Room({ id: 'doc-1', store, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, ...opts });
  await r.load();
  return { r, c, dir, store, done: async () => { await r.flush(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A room whose first member opened the document and uploaded revision 0. */
async function started() {
  const t = await room();
  const a = member('a');
  t.r.join(a);
  t.r.message('a', { t: 'Snapshot', rev: 0, doc: '{"v":0}' });
  return { ...t, a };
}

test('the first member gets no snapshot and provides revision 0', async () => {
  const { r, done } = await room();
  const a = member('a');
  r.join(a);
  assert.deepEqual(a.got[0], { t: 'Welcome', rev: 0, snapshot: null, ops: [], you: 'a' });
  r.message('a', { t: 'Snapshot', rev: 0, doc: '{"v":0}' });
  assert.equal(r.rev, 0);
  await done();
});

test('a member joining before revision 0 exists waits for it', async () => {
  const { r, done } = await room();
  const a = member('a');
  const b = member('b');
  r.join(a);
  r.join(b);
  assert.equal(b.got.length, 0, 'b must not be told to provide the document too');
  r.message('a', { t: 'Snapshot', rev: 0, doc: '{"v":0}' });
  assert.deepEqual(b.got[0], { t: 'Welcome', rev: 0, snapshot: '{"v":0}', ops: [], you: 'b', seen: 0, history: [] });
  await done();
});

test('ops broadcast to all including sender, stamped with rev and user', async () => {
  const { r, a, done } = await started();
  const b = member('b');
  r.join(b);
  r.message('a', op('a', 1));
  await r.flush();
  const fromA = a.last('Op');
  const fromB = b.last('Op');
  assert.deepEqual([fromA.rev, fromA.user], [1, 'A']);
  assert.deepEqual(fromA, fromB);
  await done();
});

test('sequencing preserves per-client order', async () => {
  const { r, a, done } = await started();
  const b = member('b');
  r.join(b);
  r.message('a', op('a', 1, '1'));
  r.message('b', op('b', 1, 'x'));
  r.message('a', op('a', 2, '2'));
  await r.flush();
  const seen = a.got.filter((m) => m.t === 'Op').map((m) => `${m.client}${m.seq}@${m.rev}`);
  assert.deepEqual(seen, ['a1@1', 'b1@2', 'a2@3']);
  await done();
});

test('ops before revision 0 or from strangers are refused', async () => {
  const { r, done } = await room();
  const a = member('a');
  r.join(a);
  r.message('a', op('a', 1));
  assert.equal(a.last('Op'), undefined);
  r.message('zz', op('zz', 1));
  await done();
});

test('late joiner gets snapshot and tail', async () => {
  const { r, a, done } = await started();
  r.message('a', op('a', 1, 'one'));
  r.message('a', op('a', 2, 'two'));
  await r.flush();
  const c = member('c');
  r.join(c);
  const w = c.got[0];
  assert.equal(w.t, 'Welcome');
  assert.equal(w.rev, 0);
  assert.equal(w.snapshot, '{"v":0}');
  assert.deepEqual(w.ops.map((o) => o.params.text), ['one', 'two']);
  await done();
});

test('a reconnecting member with haveRev gets only what it missed', async () => {
  const { r, a, done } = await started();
  r.message('a', op('a', 1, 'one'));
  r.message('a', op('a', 2, 'two'));
  await r.flush();
  const b = member('b');
  r.join(b, 1);
  assert.deepEqual(b.got[0], { t: 'Welcome', rev: 1, snapshot: null, ops: [r.log[1]], you: 'b' });
  await done();
});

test('snapshot requested every 200 revs from the lease holder, and the log trimmed', async () => {
  const { r, a, done } = await started();
  const b = member('b');
  r.join(b);
  for (let i = 1; i <= 200; i++) r.message('b', op('b', i));
  await r.flush();
  assert.deepEqual(a.types().filter((t) => t === 'SnapshotRequest'), ['SnapshotRequest']);
  assert.equal(b.types().includes('SnapshotRequest'), false);
  r.message('a', { t: 'Snapshot', rev: 200, doc: '{"v":200}' });
  assert.equal(r.log.length, 0);
  assert.equal(r.rev, 200);
  await done();
});

test('restart reloads room', async () => {
  const { r, a, dir, c } = await started();
  r.message('a', op('a', 1, 'one'));
  r.message('a', op('a', 2, 'two'));
  await r.flush();
  const again = new Room({ id: 'doc-1', store: createStore(dir, { flushMs: 0 }), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  await again.load();
  assert.equal(again.rev, 2);
  assert.deepEqual(again.log.map((o) => o.params.text), ['one', 'two']);
  rmSync(dir, { recursive: true, force: true });
});

test('autosave after idle 2s and at most every 10s while typing', async () => {
  const { r, a, c, done } = await started();
  const b = member('b');
  r.join(b);
  r.message('b', op('b', 1));
  c.advance(1999);
  assert.equal(a.types().includes('Save'), false);
  c.advance(1);
  assert.equal(a.types().filter((t) => t === 'Save').length, 1, 'idle 2 s → the lease holder saves');
  assert.equal(b.types().includes('Save'), false);
  r.message('a', { t: 'Saved', rev: 1 });
  // Continuous typing: an op every second for 15 s.
  let seq = 2;
  for (let i = 0; i < 15; i++) {
    r.message('b', op('b', seq++));
    c.advance(1000);
  }
  assert.equal(a.types().filter((t) => t === 'Save').length, 2, 'one save 10 s into continuous typing');
  await done();
});

test('no save when nothing changed since the last one', async () => {
  const { r, a, c, done } = await started();
  r.message('a', op('a', 1));
  c.advance(2000);
  r.message('a', { t: 'Saved', rev: 1 });
  c.advance(60000);
  assert.equal(a.types().filter((t) => t === 'Save').length, 1);
  await done();
});

test('the lease passes to the next member when the holder leaves', async () => {
  const { r, a, c, done } = await started();
  const b = member('b');
  r.join(b);
  r.leave('a');
  r.message('b', op('b', 1));
  c.advance(2000);
  assert.ok(b.types().includes('Save'));
  await done();
});

test('hash mismatch: the minority gets a resync', async () => {
  const { r, a, done } = await started();
  const b = member('b');
  const d = member('d');
  r.join(b);
  r.join(d);
  for (let i = 1; i <= 50; i++) r.message('a', op('a', i));
  r.message('a', { t: 'Hash', rev: 50, h: 'good' });
  r.message('b', { t: 'Hash', rev: 50, h: 'bad' });
  r.message('d', { t: 'Hash', rev: 50, h: 'good' });
  assert.equal(b.last('Resync')?.t, 'Resync');
  assert.equal(a.last('Resync'), undefined);
  assert.equal(d.last('Resync'), undefined);
  await done();
});

test('hash tie: the lease holder wins', async () => {
  const { r, a, done } = await started();
  const b = member('b');
  r.join(b);
  for (let i = 1; i <= 50; i++) r.message('a', op('a', i));
  r.message('b', { t: 'Hash', rev: 50, h: 'x' });
  r.message('a', { t: 'Hash', rev: 50, h: 'y' });
  assert.ok(b.last('Resync'));
  assert.equal(a.last('Resync'), undefined);
  await done();
});

test('resync request answers with snapshot and log', async () => {
  const { r, a, done } = await started();
  r.message('a', op('a', 1, 'one'));
  await r.flush();
  r.message('a', { t: 'ResyncRequest', have: 0 });
  const rs = a.last('Resync');
  assert.deepEqual([rs.rev, rs.snapshot, rs.ops.length], [0, '{"v":0}', 1]);
  await done();
});

test('rate limit closes with 4429', async () => {
  const { r, a, done } = await started();
  for (let i = 1; i <= 260; i++) r.message('a', op('a', i));
  assert.equal(a.closed?.code, 4429);
  await done();
});

test('room full closes with 4409', async () => {
  const { r, done } = await started();
  for (let i = 0; i < 49; i++) r.join(member(`m${i}`));
  const late = member('late');
  r.join(late);
  assert.equal(late.closed?.code, 4409);
  await done();
});

test('an op is only broadcast once it is on disk: a crash never loses an op anyone saw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-room-'));
  const c = clock();
  const r = new Room({ id: 'doc-1', store: createStore(dir, { flushMs: 50 }), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  await r.load();
  const a = member('a');
  r.join(a);
  r.message('a', { t: 'Snapshot', rev: 0, doc: '{"v":0}' });
  r.message('a', op('a', 1, 'one'));
  assert.equal(a.last('Op'), undefined, 'not broadcast before it is durable');
  // Whenever a member has seen it, a fresh relay over the same data dir has it too.
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (a.last('Op')) {
        clearInterval(check);
        resolve();
      }
    }, 5);
  });
  const crashed = new Room({ id: 'doc-1', store: createStore(dir, { flushMs: 50 }), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  await crashed.load();
  assert.equal(crashed.rev, 1);
  await r.flush();
  rmSync(dir, { recursive: true, force: true });
});

test('flushing while a batch waits writes it and releases its broadcasts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-room-'));
  const store = createStore(dir, { flushMs: 60_000 });
  const r = new Room({ id: 'doc-1', store });
  await r.load();
  const a = member('a');
  r.join(a);
  r.message('a', { t: 'Snapshot', rev: 0, doc: '{}' });
  r.message('a', op('a', 1, 'one'));
  const flushed = await Promise.race([r.flush().then(() => 'flushed'), new Promise((res) => setTimeout(() => res('hung'), 2000))]);
  assert.equal(flushed, 'flushed');
  await new Promise((res) => setImmediate(res));
  assert.equal(a.last('Op')?.rev, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('snapshots remember the last edit they hold from each replica (seen)', async () => {
  const { r, a, done } = await started();
  const b = member('b');
  r.join(b);
  r.message('a', op('a', 1));
  r.message('b', op('b', 1));
  r.message('a', op('a', 2));
  await r.flush();
  r.snapshotFrom = 'a';
  r.message('a', { t: 'Snapshot', rev: 2, doc: '{"v":2}' });
  r.message('b', { t: 'ResyncRequest', have: 0 });
  r.message('a', { t: 'ResyncRequest', have: 0 });
  assert.equal(b.last('Resync').seen, 1, "b's first edit is in the snapshot at rev 2");
  assert.equal(a.last('Resync').seen, 1, "only a's first edit is; its second is in the log");
  const late = member('a');
  r.leave('a');
  r.join(late);
  assert.equal(late.got[0].seen, 1);
  await done();
});
