#!/usr/bin/env node
// A zero-dependency demo host: serves the editor, the SDK and the example pages, and keeps saved
// documents in a folder. It shows the two things a real site needs:
//
//   1. the editor's static files on the site's own origin (here /wordcraft/), .wasm as application/wasm
//   2. somewhere for onSave to put the file (here PUT /api/files/<name>)
//
//   node examples/server.mjs            # http://localhost:8080
//   PORT=3000 FILES_DIR=./docs node examples/server.mjs

import { createServer } from 'node:http';
import { createReadStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const port = Number(process.env.PORT) || 8080;
const filesDir = resolve(process.env.FILES_DIR || join(root, 'examples', 'files'));
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DOCUMENT_EXTENSIONS = new Set(['.docx', '.docm', '.dotx', '.doc', '.odt', '.rtf', '.pdf', '.html', '.md', '.tex', '.txt', '.png']);

mkdirSync(filesDir, { recursive: true });

// URL prefix → folder.
const mounts = [
  ['/wordcraft/', join(root, 'editor')],
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

function serveFile(req, res, file) {
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
  // Hashed editor assets never change; pages revalidate.
  headers['Cache-Control'] = /-[0-9a-f]{16}(_bg)?\.(wasm|js)$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache';
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && ['.wasm', '.js', '.html'].includes(ext);
  if (gzip) headers['Content-Encoding'] = 'gzip';
  else headers['Content-Length'] = stats.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(file);
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
  if (req.method === 'GET' || req.method === 'HEAD') return serveFile(req, res, file);
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

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/files' || pathname.startsWith('/api/files/')) {
    return files(req, res, pathname.slice('/api/files/'.length));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  const file = staticFile(pathname);
  if (!file) return send(res, 404, 'Not found');
  serveFile(req, res, file);
}).listen(port, () => {
  console.log(`WordCraft embed demo on http://localhost:${port}/`);
  console.log(`Saved documents go to ${filesDir}`);
});
