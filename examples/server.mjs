#!/usr/bin/env node
// A zero-dependency demo host: serves the editor, the SDK and the example pages, and keeps saved
// documents in a folder. It shows the two things a real site needs:
//
//   1. the editor's static files on the site's own origin (here /wordcraft/), .wasm as application/wasm
//   2. somewhere for onSave to put the file (here PUT /api/files/<name>)
//
//   node examples/server.mjs            # http://127.0.0.1:8080 (this machine only)
//   PORT=3000 FILES_DIR=./docs node examples/server.mjs
//   HOST=0.0.0.0 node examples/server.mjs   # other machines too (the demo has no logins)
//   EDITOR_DIR=../upstream/dist/web node examples/server.mjs   # a co-editing build of WordCraft
//
// Co-editing (examples/collab.html): the relay listens on /relay of this same server, and
// GET /api/token?doc=…&name=…&role=… hands out join tokens. A real site issues tokens only to
// signed-in users, from its own backend, with a secret it keeps (RELAY_SECRET).
//
//   RELAY_API_KEY=…  turns on the relay's HTTP API (/api/docs/…) on this server
//   WEBHOOK_URL=… WEBHOOK_SECRET=…  turn on the relay's webhooks

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../relay/server.mjs';
import { ROLES, issueToken } from '../relay/token.mjs';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '127.0.0.1';
const filesDir = resolve(process.env.FILES_DIR || join(root, 'examples', 'files'));
const editorDir = resolve(process.env.EDITOR_DIR || join(root, 'editor'));
const relaySecret = process.env.RELAY_SECRET || randomBytes(32).toString('hex');
const relayDir = resolve(process.env.RELAY_DATA_DIR || join(root, 'examples', 'relay-data'));
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DOCUMENT_EXTENSIONS = new Set(['.docx', '.docm', '.dotx', '.doc', '.odt', '.rtf', '.pdf', '.html', '.md', '.tex', '.txt', '.png']);

mkdirSync(filesDir, { recursive: true });

// URL prefix → folder.
const mounts = [
  ['/wordcraft/', editorDir],
  ['/sdk/', join(root, 'src')],
  ['/', join(root, 'examples')],
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.pdf': 'application/pdf',
};

/** A file name safe to store: no folders, no dot files, a document extension. */
function safeName(raw) {
  let name;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!/^[\p{L}\p{N} _.()-]{1,200}$/u.test(name) || name.startsWith('.')) return null;
  return DOCUMENT_EXTENSIONS.has(extname(name).toLowerCase()) ? name : null;
}

/** The file a static URL path maps to, or null when it escapes its folder. */
function staticFile(pathname) {
  for (const [prefix, dir] of mounts) {
    if (!pathname.startsWith(prefix)) continue;
    let rel;
    try {
      rel = decodeURIComponent(pathname.slice(prefix.length));
    } catch {
      return null;
    }
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(dir, rel));
    if (!file.startsWith(dir + sep)) return null;
    return file;
  }
  return null;
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function serveFile(req, res, file, { stored = false } = {}) {
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return send(res, 404, 'Not found');
  }
  if (stats.isDirectory()) {
    res.writeHead(301, { Location: req.url.split('?')[0] + '/' });
    return res.end();
  }
  const ext = extname(file).toLowerCase();
  const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
  if (stored) {
    // Anyone can store a file here, so it never runs as a page on this origin (an uploaded .html
    // would otherwise be stored XSS next to the editor): plain bytes, a download, sandboxed.
    headers['Content-Type'] = 'application/octet-stream';
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(file.split(sep).pop())}`;
    headers['Content-Security-Policy'] = "sandbox; default-src 'none'";
  }
  // Hashed editor assets never change; pages revalidate.
  headers['Cache-Control'] = /-[0-9a-f]{16}(_bg)?\.(wasm|js)$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache';
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && ['.wasm', '.js', '.html'].includes(ext);
  if (gzip) headers['Content-Encoding'] = 'gzip';
  else headers['Content-Length'] = stats.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(file);
  // The headers are out: a file that can't be read after all ends the response early.
  stream.on('error', () => res.destroy());
  (gzip ? stream.pipe(createGzip()) : stream).pipe(res);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) throw Object.assign(new Error('Too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function files(req, res, rawName) {
  if (!rawName) {
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    const list = readdirSync(filesDir)
      .filter((n) => safeName(encodeURIComponent(n)))
      .map((name) => {
        const s = statSync(join(filesDir, name));
        return { name, size: s.size, modified: s.mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
    return send(res, 200, JSON.stringify(list), 'application/json');
  }
  const name = safeName(rawName);
  if (!name) return send(res, 400, 'Bad file name');
  const file = join(filesDir, name);
  if (req.method === 'GET' || req.method === 'HEAD') return serveFile(req, res, file, { stored: true });
  if (req.method === 'PUT') {
    try {
      const body = await readBody(req);
      // Write then rename, so a reader never sees half a file.
      const partial = `${file}.${process.pid}.partial`;
      await writeFile(partial, body);
      await rename(partial, file);
      return send(res, 200, JSON.stringify({ name, size: body.length }), 'application/json');
    } catch (error) {
      return send(res, error.status || 500, error.status ? error.message : 'Could not save');
    }
  }
  return send(res, 405, 'Method not allowed');
}

/** Demo join tokens: anyone may open any document in any role (`role`: edit, the default, suggest,
 * comment or view). A real backend checks who is asking. */
function token(req, res) {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const doc = (q.get('doc') || 'demo').slice(0, 100);
  const name = (q.get('name') || 'Guest').slice(0, 60);
  const role = ROLES.includes(q.get('role')) ? q.get('role') : 'edit';
  const t = issueToken(relaySecret, { doc, sub: `${name}-${randomBytes(4).toString('hex')}`, name, role });
  send(res, 200, JSON.stringify({ token: t }), 'application/json');
}

async function route(req, res) {
  let pathname;
  try {
    ({ pathname } = new URL(req.url, 'http://localhost'));
  } catch {
    return send(res, 400, 'Bad request URL');
  }
  if (pathname === '/api/token') return token(req, res);
  if (pathname.startsWith('/api/docs/') && relay.handle(req, res)) return;
  if (pathname === '/api/files' || pathname.startsWith('/api/files/')) {
    return files(req, res, pathname.slice('/api/files/'.length));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  const file = staticFile(pathname);
  if (!file) return send(res, 404, 'Not found');
  serveFile(req, res, file);
}

// One bad request never takes the server down: whatever goes wrong answers 500.
const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error('demo server:', error);
    if (!res.headersSent) send(res, 500, 'Something went wrong');
    else res.destroy();
  });
});
const relay = await createRelay({
  secret: relaySecret,
  dataDir: relayDir,
  server,
  apiKey: process.env.RELAY_API_KEY,
  webhook: { url: process.env.WEBHOOK_URL, secret: process.env.WEBHOOK_SECRET },
});
server.listen(port, host, () => {
  console.log(`WordCraft embed demo on http://${host}:${port}/`);
  console.log(`Saved documents go to ${filesDir}`);
  console.log(`Editor files from ${editorDir}; co-editing relay on ws://${host}:${port}/relay`);
});
