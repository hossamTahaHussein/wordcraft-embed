import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createRelay } from '../server.mjs';
import { issueToken } from '../token.mjs';

const SECRET = 'server-test-secret-0123456789';
let relay;
let url;
let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wc-relay-'));
  relay = await createRelay({ secret: SECRET, dataDir: dir, port: 0 });
  url = `ws://127.0.0.1:${relay.port}/relay`;
});

after(async () => {
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Connect and collect messages; resolves with helpers once open. */
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const got = [];
    const waiters = [];
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      got.push(m);
      for (const w of waiters.splice(0)) w();
    });
    const closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
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
            await new Promise((r) => waiters.push(r));
          }
        },
      }),
    );
  });
}

const token = (claims) => issueToken(SECRET, { doc: 'doc-a', sub: 'u1', name: 'Ann', role: 'edit', ...claims });
const op = (seq, text) => ({ t: 'Op', client: 'x', seq, base: 0, kind: 'cmd', cmd: 'text.insert', params: { text }, sel: { story: 'body', anchor: 0, head: 0 }, ctx: {} });

test('two people: welcome, revision 0, an op reaches both', async () => {
  const a = await connect();
  a.send({ t: 'hello', token: token({ doc: 'doc-1' }), client: 'ca' });
  const w = await a.next('Welcome');
  assert.deepEqual([w.rev, w.snapshot, w.you], [0, null, 'ca']);
  a.send({ t: 'Snapshot', rev: 0, doc: '{}' });
  const b = await connect();
  b.send({ t: 'hello', token: token({ doc: 'doc-1', sub: 'u2', name: 'Bob' }), client: 'cb' });
  const wb = await b.next('Welcome');
  assert.equal(wb.snapshot, '{}');
  a.send(op(1, 'hi'));
  const [oa, ob] = await Promise.all([a.next('Op'), b.next('Op')]);
  assert.deepEqual([oa.rev, oa.user, oa.client], [1, 'Ann', 'ca'], 'the relay stamps who sent it, whatever the op claims');
  assert.deepEqual(oa, ob);
  a.ws.close();
  b.ws.close();
});

test('rejects bad token with 4401', async () => {
  const a = await connect();
  a.send({ t: 'hello', token: 'nope', client: 'c' });
  assert.equal((await a.closed).code, 4401);
});

test('rejects a non-edit role with 4403 (roles come later)', async () => {
  const a = await connect();
  a.send({ t: 'hello', token: token({ role: 'view' }), client: 'c' });
  assert.equal((await a.closed).code, 4403);
});

test('anything before hello closes the connection', async () => {
  const a = await connect();
  a.send(op(1, 'x'));
  assert.equal((await a.closed).code, 4401);
});

test('an oversized op closes with 1009', async () => {
  const a = await connect();
  a.send({ t: 'hello', token: token({ doc: 'doc-big' }), client: 'cbig' });
  await a.next('Welcome');
  a.send({ t: 'Snapshot', rev: 0, doc: '{}' });
  a.send(op(1, 'x'.repeat(300 * 1024)));
  assert.equal((await a.closed).code, 1009);
});

test('a bad client id is refused', async () => {
  const a = await connect();
  a.send({ t: 'hello', token: token(), client: 'x'.repeat(500) });
  assert.equal((await a.closed).code, 4400);
});
