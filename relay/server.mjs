#!/usr/bin/env node
// The co-editing relay: a WebSocket endpoint (default path /relay) that checks each person's
// join token and puts them in their document's room (room.mjs).
//
// Standalone:   RELAY_SECRET=… DATA_DIR=./relay-data PORT=8090 node relay/server.mjs
// In a server:  const relay = await createRelay({ secret, dataDir, server: httpServer });
//
// The first message on a connection must be { t: "hello", token, client, haveRev? }.

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room } from './room.mjs';
import { createStore } from './store.mjs';
import { TokenError, verifyToken } from './token.mjs';

export const MAX_OP_BYTES = 256 * 1024;
export const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_HELLO_BYTES = 16 * 1024;
const PING_EVERY_MS = 30_000;

/**
 * @param {{secret: string, dataDir: string, server?: import('node:http').Server, port?: number, host?: string, path?: string}} options
 * Pass `server` to share an existing HTTP server, or `port` (0 = any) to listen on its own.
 */
export async function createRelay({ secret, dataDir, server, port, host = '127.0.0.1', path = '/relay' }) {
  const store = createStore(dataDir);
  const rooms = new Map();
  let own = null;
  if (!server) {
    own = createServer((_, res) => {
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
      const room = new Room({ id, store });
      entry = { room, ready: room.load() };
      rooms.set(id, entry);
    }
    await entry.ready;
    return entry.room;
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
        room.join(me, Number.isInteger(msg.haveRev) ? msg.haveRev : undefined);
        return;
      }
      if (msg?.t !== 'Snapshot' && text.length > MAX_OP_BYTES) return close(1009, 'Message too large');
      room.message(client, msg);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (room && client) room.leave(client, me);
    });
  });

  return {
    wss,
    get port() {
      return server.address()?.port;
    },
    async close() {
      clearInterval(heartbeat);
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
  });
  console.log(`WordCraft relay on ws://${process.env.HOST || '127.0.0.1'}:${relay.port}/relay`);
}
