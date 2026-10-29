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
  server = spawn(process.execPath, ['examples/server.mjs'], { env: { ...process.env, PORT: String(PORT), FILES_DIR: filesDir }, stdio: 'pipe' });
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
