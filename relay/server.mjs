#!/usr/bin/env node
// The co-editing relay: a WebSocket endpoint (default path /relay) that checks each person's
// join token and puts them in their document's room (room.mjs).
//
// Standalone:   RELAY_SECRET=… DATA_DIR=./relay-data PORT=8090 node relay/server.mjs
//               (optional: RELAY_API_KEY for the HTTP API, WEBHOOK_URL + WEBHOOK_SECRET for webhooks)
// In a server:  const relay = await createRelay({ secret, dataDir, server: httpServer });
//
// The first message on a connection must be { t: "hello", token, client, haveRev?, agent? }
// (`agent: true` for a program such as an MCP agent: never the autosave lease holder).

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ApiError, Room } from './room.mjs';
import { createStore } from './store.mjs';
import { TokenError, verifyToken } from './token.mjs';
import { createWebhooks } from './webhook.mjs';

export const MAX_OP_BYTES = 256 * 1024;
export const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_HELLO_BYTES = 16 * 1024;
const PING_EVERY_MS = 30_000;
const API_TIMEOUT_MS = 15_000;
/** What GET /api/docs/:doc/content can produce. */
const FORMATS = {
  txt: 'text/plain; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
};
/** Messages that may carry a whole document (up to MAX_SNAPSHOT_BYTES); the rest are ops-sized. */
const LARGE = new Set(['Snapshot', 'Version', 'Exported', 'RunResult']);

/** Compare two strings in constant time (whatever their lengths). */
function sameSecret(a, b) {
  const h = (x) => createHash('sha256').update(String(x)).digest();
  return timingSafeEqual(h(a), h(b));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_OP_BYTES) throw new ApiError(400, 'The request body is too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  throw new ApiError(400, 'The request body must be a JSON object');
}

/**
 * @param {{secret: string, dataDir: string, server?: import('node:http').Server, port?: number, host?: string, path?: string,
 *   apiKey?: string, apiTimeoutMs?: number, webhook?: {url?: string, secret?: string}}} options
 * Pass `server` to share an existing HTTP server, or `port` (0 = any) to listen on its own.
 * With a shared server, pass its requests to `relay.handle(req, res)` for the HTTP API.
 * `apiKey`: the bearer key of the HTTP API under /api/ (no key: no API).
 * `webhook`: where to POST events (both `url` and `secret`, or webhooks are off).
 */
export async function createRelay({ secret, dataDir, server, port, host = '127.0.0.1', path = '/relay', apiKey, apiTimeoutMs = API_TIMEOUT_MS, webhook }) {
  const store = createStore(dataDir);
  const hooks = createWebhooks(webhook);
  const rooms = new Map();
  let own = null;
  if (!server) {
    own = createServer((req, res) => {
      if (handle(req, res)) return;
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('WebSocket only');
    });
    await new Promise((resolve) => own.listen(port ?? 8090, host, resolve));
    server = own;
  }
  const wss = new WebSocketServer({ server, path, maxPayload: MAX_SNAPSHOT_BYTES });
  // A connection that stops answering pings (a sleeping laptop, a dropped network) is closed,
  // so its replica can reconnect and the room doesn't keep a dead member.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, PING_EVERY_MS);
  heartbeat.unref?.();

  async function roomFor(id) {
    let entry = rooms.get(id);
    if (!entry) {
      const events = !hooks ? undefined : (type, detail) => (type === 'edited' ? hooks.edited(id, detail.rev, detail.name) : hooks.send(id, type, detail));
      const room = new Room({ id, store, events });
      entry = { room, ready: room.load() };
      rooms.set(id, entry);
    }
    await entry.ready;
    return entry.room;
  }

  /** The HTTP API. Returns false for a request that isn't under /api/ (not the relay's). */
  function handle(req, res) {
    const url = new URL(req.url, 'http://relay');
    if (!url.pathname.startsWith('/api/')) return false;
    api(req, res, url).catch((e) => {
      if (!(e instanceof ApiError)) console.error('relay api:', e);
      if (!res.headersSent) json(res, e instanceof ApiError ? e.status : 500, { error: e instanceof ApiError ? e.message : 'Something went wrong' });
    });
    return true;
  }

  async function api(req, res, url) {
    if (!apiKey) throw new ApiError(404, 'Not found');
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !sameSecret(auth.slice(7), apiKey)) throw new ApiError(401, 'This needs the relay API key');
    const route = /^\/api\/docs\/([^/]+)(?:\/(content|text|commands|kick|close))?$/.exec(url.pathname);
    const action = route?.[2] ?? 'info';
    const method = { info: 'GET', content: 'GET', text: 'GET', commands: 'POST', kick: 'POST', close: 'POST' }[action];
    if (!route || req.method !== method) throw new ApiError(404, 'Not found');
    let doc;
    try {
      doc = decodeURIComponent(route[1]);
    } catch {
      throw new ApiError(400, 'Bad document id');
    }
    if (!rooms.has(doc) && !(await store.exists(doc))) throw new ApiError(404, 'No such document');
    const room = await roomFor(doc);
    switch (action) {
      case 'info':
        return json(res, 200, { doc, rev: room.rev, savedRev: room.savedRev, lastSaved: room.lastSaved, people: room.people() });
      case 'content':
      case 'text': {
        const format = action === 'text' ? 'txt' : url.searchParams.get('format') || 'docx';
        if (!Object.hasOwn(FORMATS, format)) throw new ApiError(400, `format must be one of ${Object.keys(FORMATS).join(', ')}`);
        const reply = await room.ask({ t: 'Export', format }, apiTimeoutMs);
        if (!reply.ok || typeof reply.data !== 'string') throw new ApiError(422, typeof reply.error === 'string' ? reply.error : 'The editor could not export the document');
        const headers = { 'Content-Type': FORMATS[format] };
        if (action === 'content') headers['Content-Disposition'] = `attachment; filename="${doc.replace(/[^\x20-\x7e]|["\\]/g, '_')}.${format}"`;
        res.writeHead(200, headers);
        return res.end(Buffer.from(reply.data, 'base64'));
      }
      case 'commands': {
        const body = await readJson(req);
        if (typeof body.command !== 'string' || !body.command) throw new ApiError(400, 'command must be a command id');
        if (body.params !== undefined && (typeof body.params !== 'object' || body.params === null || Array.isArray(body.params))) throw new ApiError(400, 'params must be an object');
        if (body.author !== undefined && (typeof body.author !== 'string' || !body.author || body.author.length > 200)) throw new ApiError(400, 'author must be a name');
        const reply = await room.ask({ t: 'Run', cmd: body.command, params: body.params ?? {}, author: body.author ?? 'API' }, apiTimeoutMs);
        if (reply.ok) return json(res, 200, { ok: true, result: reply.result ?? null });
        return json(res, 422, { ok: false, error: typeof reply.error === 'string' ? reply.error : 'The command failed' });
      }
      case 'kick': {
        const body = await readJson(req);
        if (typeof body.sub !== 'string' || !body.sub) throw new ApiError(400, 'sub must be a user id');
        return json(res, 200, { kicked: room.kick(body.sub) });
      }
      case 'close':
        return json(res, 200, { closed: room.closeAll() });
    }
  }

  wss.on('connection', (ws) => {
    let room = null;
    let client = null;
    let me = null;
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    const helloTimer = setTimeout(() => ws.close(4401, 'No hello'), HELLO_TIMEOUT_MS);
    const send = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    const close = (code, reason) => ws.close(code, reason);

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return close(1003, 'Text messages only');
      const text = data.toString();
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return close(1007, 'Not JSON');
      }
      if (!room) {
        // Nothing large before the token is checked.
        if (text.length > MAX_HELLO_BYTES) return close(1009, 'Say hello first');
        if (client) return; // hello is being handled
        if (msg?.t !== 'hello') return close(4401, 'Say hello first');
        if (typeof msg.client !== 'string' || !CLIENT_ID.test(msg.client)) return close(4400, 'Bad client id');
        client = msg.client;
        clearTimeout(helloTimer);
        let claims;
        try {
          claims = verifyToken(secret, msg.token);
        } catch (e) {
          return close(4401, e instanceof TokenError ? `Not allowed: ${e.code}` : 'Not allowed');
        }
        const r = await roomFor(claims.doc);
        if (ws.readyState !== ws.OPEN) return;
        room = r;
        me = { client, sub: claims.sub, user: claims.name, role: claims.role, send, close };
        if (msg.agent === true) me.agent = true;
        room.join(me, Number.isInteger(msg.haveRev) ? msg.haveRev : undefined);
        return;
      }
      if (text.length > MAX_OP_BYTES && !LARGE.has(msg?.t) && !(msg?.t === 'Op' && msg.kind === 'restore')) return close(1009, 'Message too large');
      room.message(client, msg);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (room && client) room.leave(client, me);
    });
  });

  return {
    wss,
    handle,
    get port() {
      return server.address()?.port;
    },
    async close() {
      clearInterval(heartbeat);
      hooks?.close();
      for (const { room } of rooms.values()) await room.flush();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      if (own) await new Promise((resolve) => own.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const secret = process.env.RELAY_SECRET;
  if (!secret) {
    console.error('Set RELAY_SECRET (the secret your backend signs join tokens with).');
    process.exit(1);
  }
  const relay = await createRelay({
    secret,
    dataDir: process.env.DATA_DIR || './relay-data',
    port: Number(process.env.PORT) || 8090,
    host: process.env.HOST || '127.0.0.1',
    apiKey: process.env.RELAY_API_KEY,
    webhook: { url: process.env.WEBHOOK_URL, secret: process.env.WEBHOOK_SECRET },
  });
  console.log(`WordCraft relay on ws://${process.env.HOST || '127.0.0.1'}:${relay.port}/relay`);
}
