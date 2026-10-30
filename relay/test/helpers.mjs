// Shared helpers for the relay tests that came with protocol v2 (roles, undo, versions, API).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Room } from '../room.mjs';
import { createStore } from '../store.mjs';

/** Fake timers: `advance(ms)` runs what is due. */
export function clock(start = 0) {
  let t = start;
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

/** A fake member that records what it is sent. */
export function member(client, { role = 'edit', sub = client, user = client.toUpperCase(), agent } = {}) {
  const m = { client, sub, user, role, got: [], closed: null };
  if (agent) m.agent = true;
  m.send = (msg) => m.got.push(msg);
  m.close = (code, reason) => (m.closed = { code, reason });
  m.types = () => m.got.map((x) => x.t);
  m.all = (t) => m.got.filter((x) => x.t === t);
  m.last = (t) => m.all(t).at(-1);
  return m;
}

export function op(client, seq, fields = {}) {
  return { t: 'Op', client, seq, base: 0, kind: 'cmd', cmd: 'text.insert', params: { text: 'x' }, sel: { story: 'body', anchor: 0, head: 0 }, ctx: {}, ...fields };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A loaded room on a fresh data dir with fake timers. `first`: a member that opens revision 0. */
export async function room({ first = member('a'), events, limits, start = 0, dir, onIdle } = {}) {
  dir ??= mkdtempSync(join(tmpdir(), 'wc-v2-'));
  const c = clock(start);
  const store = createStore(dir, { flushMs: 0 });
  const r = new Room({ id: 'doc-1', store, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, events, limits, onIdle });
  await r.load();
  if (first) {
    r.join(first);
    r.message(first.client, { t: 'Snapshot', rev: 0, doc: '{"v":0}' });
  }
  return {
    r,
    c,
    dir,
    store,
    a: first,
    done: async () => {
      await r.flush();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A WebSocket client of a relay at `url` that collects messages; `next(t)` waits for one. */
export async function connect(url) {
  const { WebSocket } = await import('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const got = [];
    const waiters = [];
    let isClosed = null;
    ws.on('message', (data) => {
      got.push(JSON.parse(data.toString()));
      for (const w of waiters.splice(0)) w();
    });
    const closed = new Promise((r) =>
      ws.on('close', (code, reason) => {
        isClosed = { code, reason: reason.toString() };
        for (const w of waiters.splice(0)) w();
        r(isClosed);
      }),
    );
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        got,
        closed,
        send: (m) => ws.send(JSON.stringify(m)),
        async next(t) {
          for (;;) {
            const i = got.findIndex((m) => m.t === t);
            if (i >= 0) return got.splice(i, 1)[0];
            if (isClosed) throw new Error(`closed ${isClosed.code} ${isClosed.reason} while waiting for ${t}`);
            await new Promise((r) => waiters.push(r));
          }
        },
      }),
    );
  });
}

export const wsOp = (seq, fields = {}) => ({ t: 'Op', client: 'x', seq, base: 0, kind: 'cmd', cmd: 'text.insert', params: { text: 'x' }, sel: { story: 'body', anchor: 0, head: 0 }, ctx: {}, ...fields });
