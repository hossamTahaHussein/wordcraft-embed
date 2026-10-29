import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../server.mjs';
import { issueToken } from '../token.mjs';
import { connect, member, room, wsOp } from './helpers.mjs';

const SECRET = 'server-test-secret-0123456789';
const KEY = 'api-key-0123456789abcdef';
let relay;
let base;
let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wc-api-'));
  relay = await createRelay({ secret: SECRET, dataDir: dir, port: 0, apiKey: KEY, apiTimeoutMs: 300 });
  base = `http://127.0.0.1:${relay.port}`;
});

after(async () => {
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

const api = (path, { method = 'GET', body, key = KEY } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

/** Someone in `doc` with `role`; the first editor uploads revision 0. */
async function enter(doc, { role = 'edit', sub = role, name = sub, client = `c${sub}`, agent } = {}) {
  const m = await connect(`ws://127.0.0.1:${relay.port}/relay`);
  m.send({ t: 'hello', token: issueToken(SECRET, { doc, sub, name, role }), client, ...(agent ? { agent } : {}) });
  const w = await m.next('Welcome');
  if (w.snapshot === null) m.send({ t: 'Snapshot', rev: 0, doc: '{}' });
  return m;
}

test('the API needs the key', async () => {
  assert.equal((await api('/api/docs/x', { key: null })).status, 401);
  const res = await api('/api/docs/x', { key: 'wrong' });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'This needs the relay API key' });
  assert.equal((await api('/api/nothing')).status, 404);
});

test('without a key configured there is no API', async () => {
  const d = mkdtempSync(join(tmpdir(), 'wc-api-off-'));
  const off = await createRelay({ secret: SECRET, dataDir: d, port: 0 });
  const res = await fetch(`http://127.0.0.1:${off.port}/api/docs/x`, { headers: { Authorization: 'Bearer ' } });
  assert.equal(res.status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${off.port}/`)).status, 426);
  await off.close();
  rmSync(d, { recursive: true, force: true });
});

test('a document nobody opened is 404', async () => {
  const res = await api('/api/docs/never');
  assert.equal(res.status, 404);
  assert.ok((await res.json()).error);
});

test('GET a document: revision, saves and who is here', async () => {
  const e = await enter('info doc', { sub: 'u1', name: 'Ann' });
  const v = await enter('info doc', { role: 'view', sub: 'u2', name: 'Bob' });
  e.send(wsOp(1));
  await e.next('Op');
  let res = await api(`/api/docs/${encodeURIComponent('info doc')}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await res.json(), {
    doc: 'info doc',
    rev: 1,
    savedRev: 0,
    lastSaved: null,
    people: [
      { client: 'cu1', sub: 'u1', name: 'Ann', role: 'edit', color: 0 },
      { client: 'cu2', sub: 'u2', name: 'Bob', role: 'view', color: 1 },
    ],
  });
  e.send({ t: 'Saved', rev: 1 });
  await e.next('VersionRequest');
  res = await (await api(`/api/docs/${encodeURIComponent('info doc')}`)).json();
  assert.equal(res.savedRev, 1);
  assert.ok(Date.now() - Date.parse(res.lastSaved) < 5000);
  e.ws.close();
  v.ws.close();
});

test('content: the lease holder exports the document', async () => {
  const first = await enter('exp', { sub: 'first' });
  const v = await enter('exp', { role: 'view' });
  const bot = await enter('exp', { sub: 'bot', agent: true });
  const e = await enter('exp', { sub: 'ed' });
  first.ws.close();
  // The agent came before e, but e holds the lease once first is gone.
  while ((await (await api('/api/docs/exp')).json()).people.some((p) => p.sub === 'first')) await new Promise((r) => setTimeout(r, 5));
  const pending = api('/api/docs/exp/content?format=pdf');
  const ask = await e.next('Export');
  assert.equal(ask.format, 'pdf');
  assert.equal(typeof ask.id, 'string');
  const bytes = Buffer.alloc(300 * 1024, 7); // larger than an op
  v.send({ t: 'Exported', id: ask.id, ok: true, data: Buffer.from('not you').toString('base64') });
  e.send({ t: 'Exported', id: ask.id, ok: true, data: bytes.toString('base64') });
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="exp.pdf"');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  assert.equal(bot.got.some((m) => m.t === 'Export'), false, 'agents are never asked');
  for (const m of [v, bot, e]) m.ws.close();
});

test('text: the document as plain text', async () => {
  const e = await enter('txt');
  const pending = api('/api/docs/txt/text');
  const ask = await e.next('Export');
  assert.equal(ask.format, 'txt');
  e.send({ t: 'Exported', id: ask.id, ok: true, data: Buffer.from('Hello, wörld').toString('base64') });
  const res = await pending;
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await res.text(), 'Hello, wörld');
  e.ws.close();
});

test('content: a bad format is 400, a failed export 422', async () => {
  const e = await enter('exp-bad');
  assert.equal((await api('/api/docs/exp-bad/content?format=exe')).status, 400);
  const pending = api('/api/docs/exp-bad/content?format=docx');
  const ask = await e.next('Export');
  e.send({ t: 'Exported', id: ask.id, ok: false, error: 'Out of memory' });
  const res = await pending;
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: 'Out of memory' });
  e.ws.close();
});

test('no editor connected is 409; an editor that does not answer is 504', async () => {
  const v = await enter('lonely', { role: 'edit', sub: 'first' });
  v.ws.close();
  await v.closed;
  const viewer = await enter('lonely', { role: 'view' });
  let res = await api('/api/docs/lonely/text');
  assert.equal(res.status, 409);
  assert.ok((await res.json()).error);
  assert.equal((await api('/api/docs/lonely/commands', { method: 'POST', body: { command: 'x' } })).status, 409);
  const e = await enter('lonely', { sub: 'ed' });
  res = await api('/api/docs/lonely/text');
  assert.equal(res.status, 504);
  viewer.ws.close();
  e.ws.close();
});

test('commands run on the holder as an edit by the author', async () => {
  const e = await enter('cmds');
  let pending = api('/api/docs/cmds/commands', { method: 'POST', body: { command: 'format.bold', params: { value: true } } });
  let ask = await e.next('Run');
  assert.deepEqual({ ...ask, id: undefined }, { t: 'Run', id: undefined, cmd: 'format.bold', params: { value: true }, author: 'API' });
  e.send({ t: 'RunResult', id: ask.id, ok: true, result: { done: 1 } });
  let res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, result: { done: 1 } });

  pending = api('/api/docs/cmds/commands', { method: 'POST', body: { command: 'nope', author: 'Robot' } });
  ask = await e.next('Run');
  assert.deepEqual([ask.params, ask.author], [{}, 'Robot']);
  e.send({ t: 'RunResult', id: ask.id, ok: false, error: 'Unknown command' });
  res = await pending;
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { ok: false, error: 'Unknown command' });

  assert.equal((await api('/api/docs/cmds/commands', { method: 'POST', body: {} })).status, 400);
  assert.equal((await api('/api/docs/cmds/commands', { method: 'POST', body: 'not json' })).status, 400);
  e.ws.close();
});

test('a large RunResult is accepted', async () => {
  const e = await enter('big-run');
  const pending = api('/api/docs/big-run/commands', { method: 'POST', body: { command: 'inspect' } });
  const ask = await e.next('Run');
  e.send({ t: 'RunResult', id: ask.id, ok: true, result: 'x'.repeat(300 * 1024) });
  assert.equal((await (await pending).json()).result.length, 300 * 1024);
  e.ws.close();
});

test('kick closes every connection of that user with 4403', async () => {
  const a1 = await enter('kick', { sub: 'ann', client: 'k1' });
  const a2 = await enter('kick', { sub: 'ann', client: 'k2' });
  const b = await enter('kick', { sub: 'bob' });
  const res = await api('/api/docs/kick/kick', { method: 'POST', body: { sub: 'ann' } });
  assert.deepEqual(await res.json(), { kicked: 2 });
  for (const m of [a1, a2]) assert.deepEqual(await m.closed, { code: 4403, reason: 'Removed from this document' });
  assert.equal((await api('/api/docs/kick/kick', { method: 'POST', body: {} })).status, 400);
  b.ws.close();
});

test('close closes everyone with 4410 and refuses joins for a while', async () => {
  const a = await enter('shut');
  const b = await enter('shut', { role: 'view' });
  const res = await api('/api/docs/shut/close', { method: 'POST' });
  assert.deepEqual(await res.json(), { closed: 2 });
  for (const m of [a, b]) assert.deepEqual(await m.closed, { code: 4410, reason: 'This document was closed' });
  const again = await connect(`ws://127.0.0.1:${relay.port}/relay`);
  again.send({ t: 'hello', token: issueToken(SECRET, { doc: 'shut', sub: 'x', name: 'X', role: 'edit' }), client: 'cx' });
  assert.equal((await again.closed).code, 4410);
});

test('after a close, joins are refused for 10 s only', async () => {
  const { r, c, a, done } = await room();
  assert.equal(r.closeAll(), 1);
  assert.equal(a.closed.code, 4410);
  const b = member('b');
  r.join(b);
  assert.equal(b.closed?.code, 4410);
  c.advance(10_000);
  const d = member('d');
  r.join(d);
  assert.equal(d.closed, null);
  assert.equal(d.last('Welcome').t, 'Welcome');
  await done();
});
