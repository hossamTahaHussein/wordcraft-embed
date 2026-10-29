import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
let server;
let filesDir;
let banner = '';

before(async () => {
  filesDir = mkdtempSync(join(tmpdir(), 'wc-files-'));
  server = spawn(process.execPath, ['examples/server.mjs'], { env: { ...process.env, PORT: String(PORT), FILES_DIR: filesDir, RELAY_DATA_DIR: join(filesDir, 'relay'), RELAY_API_KEY: 'demo-api-key-0123456789' }, stdio: 'pipe' });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => {
      banner += d.toString();
      if (banner.includes('demo on')) resolve();
    });
    server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
});

after(() => {
  server.kill();
  rmSync(filesDir, { recursive: true, force: true });
});

test('a stored HTML file is served as a sandboxed download, never as a page', async () => {
  const put = await fetch(`${base}/api/files/evil.html`, { method: 'PUT', body: '<script>alert(1)</script>' });
  assert.equal(put.status, 200);
  const res = await fetch(`${base}/api/files/evil.html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /^attachment/);
  assert.match(res.headers.get('content-security-policy') || '', /sandbox/);
  assert.notEqual(res.headers.get('content-type'), 'text/html; charset=utf-8');
});

test('stored .docx still downloads with its bytes', async () => {
  const bytes = new Uint8Array([80, 75, 3, 4, 1, 2, 3]);
  await fetch(`${base}/api/files/a.docx`, { method: 'PUT', body: bytes });
  const res = await fetch(`${base}/api/files/a.docx`);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
});

test('listens on loopback only by default', () => {
  assert.match(banner, /demo on http:\/\/127\.0\.0\.1:/);
});

test('a token from /api/token joins the relay on /relay', async () => {
  const { WebSocket } = await import('ws');
  const { token } = await (await fetch(`${base}/api/token?doc=t1&name=Ann`)).json();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/relay`);
  const welcome = await new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token, client: 'c1' })));
    ws.on('message', (d) => resolve(JSON.parse(d.toString())));
    ws.on('close', (code) => reject(new Error(`closed ${code}`)));
  });
  ws.close();
  assert.deepEqual([welcome.t, welcome.you], ['Welcome', 'c1']);
});

test("the relay's HTTP API answers on the demo server with RELAY_API_KEY", async () => {
  const { WebSocket } = await import('ws');
  const { token } = await (await fetch(`${base}/api/token?doc=apidoc&name=Ann`)).json();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/relay`);
  await new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token, client: 'c1' })));
    ws.on('message', resolve);
    ws.on('close', (code) => reject(new Error(`closed ${code}`)));
  });
  assert.equal((await fetch(`${base}/api/docs/apidoc`)).status, 401);
  const res = await fetch(`${base}/api/docs/apidoc`, { headers: { Authorization: 'Bearer demo-api-key-0123456789' } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).people.map((p) => p.name), ['Ann']);
  ws.close();
});

test('demo tokens may ask for a role', async () => {
  const { token } = await (await fetch(`${base}/api/token?doc=r&name=Vi&role=view`)).json();
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  assert.equal(claims.role, 'view');
  const { token: t2 } = await (await fetch(`${base}/api/token?doc=r&name=X&role=admin`)).json();
  assert.equal(JSON.parse(Buffer.from(t2.split('.')[1], 'base64url').toString()).role, 'edit');
});
