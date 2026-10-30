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
    let isClosed = null;
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

test('admits viewers and commenters, telling them their role', async () => {
  const e = await connect();
  e.send({ t: 'hello', token: token({ doc: 'doc-roles' }), client: 'ce' });
  await e.next('Welcome');
  e.send({ t: 'Snapshot', rev: 0, doc: '{}' });
  for (const role of ['view', 'comment']) {
    const m = await connect();
    m.send({ t: 'hello', token: token({ doc: 'doc-roles', sub: role, role }), client: `c${role}` });
    const w = await m.next('Welcome');
    assert.equal(w.role, role);
    m.ws.close();
  }
  e.ws.close();
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

test('only editors may send document-sized messages; a viewer or commenter is held to the op limit', { timeout: 5000 }, async () => {
  const e = await connect();
  e.send({ t: 'hello', token: token({ doc: 'doc-big-roles' }), client: 'cbe' });
  await e.next('Welcome');
  e.send({ t: 'Snapshot', rev: 0, doc: '{}' });
  const big = 'x'.repeat(300 * 1024);
  const large = [
    { t: 'Version', rev: 0, doc: big },
    { t: 'Exported', id: 'x', ok: true, data: big },
    { t: 'RunResult', id: 'x', ok: true, result: big },
    { t: 'Snapshot', rev: 0, doc: big },
    { ...op(1, 'x'), kind: 'restore', cmd: 'collab.restore', params: { version: 1, doc: big } },
  ];
  for (const role of ['view', 'comment']) {
    for (const [i, m] of large.entries()) {
      const c = await connect();
      c.send({ t: 'hello', token: token({ doc: 'doc-big-roles', sub: `${role}${i}`, role }), client: `c${role}${i}` });
      await c.next('Welcome');
      c.send(m);
      assert.equal((await c.closed).code, 1009, `${role} sending a large ${m.t} ${m.kind ?? ''}`);
    }
  }
  // An editor may: the connection stays open (a Version nobody asked for is ignored).
  e.send({ t: 'Version', rev: 0, doc: big });
  e.send({ t: 'Versions' });
  assert.equal((await e.next('VersionList')).t, 'VersionList');
  e.ws.close();
});

test('a bad client id is refused', async () => {
  const a = await connect();
  a.send({ t: 'hello', token: token(), client: 'x'.repeat(500) });
  assert.equal((await a.closed).code, 4400);
});

test('hello with agent: true joins as an agent, which never opens the document', async () => {
  const bot = await connect();
  bot.send({ t: 'hello', token: token({ doc: 'doc-agent', sub: 'bot', name: 'Bot' }), client: 'cbot', agent: true });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(bot.got, [], 'the agent waits for a person to open the document');
  const p = await connect();
  p.send({ t: 'hello', token: token({ doc: 'doc-agent' }), client: 'cp' });
  assert.equal((await p.next('Welcome')).snapshot, null);
  p.send({ t: 'Snapshot', rev: 0, doc: '{}' });
  assert.equal((await bot.next('Welcome')).snapshot, '{}');
  bot.ws.close();
  p.ws.close();
});

test('a Version may be as large as a snapshot', async () => {
  const a = await connect();
  a.send({ t: 'hello', token: token({ doc: 'doc-version' }), client: 'cv' });
  await a.next('Welcome');
  a.send({ t: 'Snapshot', rev: 0, doc: '{}' });
  a.send(op(1, 'x'));
  await a.next('Op');
  a.send({ t: 'Saved', rev: 1 });
  assert.equal((await a.next('VersionRequest')).rev, 1);
  a.send({ t: 'Version', rev: 1, doc: 'x'.repeat(300 * 1024) });
  a.send({ t: 'GetVersion', rev: 1 });
  assert.equal((await a.next('VersionDoc')).doc.length, 300 * 1024);
  a.ws.close();
});

/** Send a raw HTTP request line to the relay; resolves with the status line (or null on close). */
function rawRequest(port, target) {
  return import('node:net').then(
    ({ default: net }) =>
      new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`));
        s.on('data', (d) => {
          resolve(d.toString().split('\r\n')[0]);
          s.destroy();
        });
        s.on('error', () => resolve(null));
        s.on('close', () => resolve(null));
      }),
  );
}

test('a request whose URL does not parse is answered 400; the relay keeps running', async () => {
  for (const target of ['http://[', '//[::1/api/docs/x', 'http://a:b@[/x']) {
    assert.equal(await rawRequest(relay.port, target), 'HTTP/1.1 400 Bad Request', target);
  }
  const a = await connect();
  a.send({ t: 'hello', token: token({ doc: 'doc-after-bad-url' }), client: 'cu' });
  assert.equal((await a.next('Welcome')).rev, 0);
  a.ws.close();
});
