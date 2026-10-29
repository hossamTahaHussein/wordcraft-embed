// Webhooks: the relay tells your server what happens in its documents (someone joined, left,
// edited, commented, a save landed, a version was restored) by POSTing signed JSON to WEBHOOK_URL.
//
//   POST <WEBHOOK_URL>   { event, doc, at, ...detail }
//   X-WordCraft-Event: <event>
//   X-WordCraft-Timestamp: <unix seconds>
//   X-WordCraft-Signature: sha256=<hex HMAC-SHA256(WEBHOOK_SECRET, "<timestamp>.<body>")>
//
// Receivers check a delivery with `verifyWebhook(secret, headers, rawBody)`.

import { createHmac, timingSafeEqual } from 'node:crypto';

const TIMEOUT_MS = 5000;
/** The waits before the second and third attempts. */
const RETRY_MS = [1000, 5000];
const EDITED_EVERY_MS = 5000;

/** The signature header's value for `body` sent at `timestamp` (unix seconds). */
export function signWebhook(secret, timestamp, body) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

function header(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  return undefined;
}

/**
 * Whether a webhook delivery really comes from the relay: the signature matches the raw body
 * and the timestamp is at most `toleranceS` seconds away (so an old delivery can't be replayed).
 * @param {string} secret WEBHOOK_SECRET
 * @param {Headers | Record<string, string | string[] | undefined>} headers the request's headers
 * @param {string | Uint8Array} body the raw request body, exactly as received
 */
export function verifyWebhook(secret, headers, body, toleranceS = 300, now = Date.now()) {
  const timestamp = header(headers, 'x-wordcraft-timestamp');
  const signature = header(headers, 'x-wordcraft-signature');
  if (typeof secret !== 'string' || !secret || typeof timestamp !== 'string' || typeof signature !== 'string') return false;
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > toleranceS) return false;
  const text = typeof body === 'string' ? body : Buffer.from(body ?? '').toString('utf8');
  const want = Buffer.from(signWebhook(secret, timestamp, text));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * The relay's sender, or null when `url` or `secret` is missing (webhooks off).
 * Deliveries never hold up a room: `send` returns at once, and each document's events go out
 * one at a time in order, each tried up to three times.
 */
export function createWebhooks({
  url,
  secret,
  fetch = globalThis.fetch,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  timeoutMs = TIMEOUT_MS,
  retryMs = RETRY_MS,
  editedEveryMs = EDITED_EVERY_MS,
  log = (m) => console.warn(m),
} = {}) {
  if (!url || !secret) return null;
  /** Per document: the delivery chain, and the edits waiting for the next `edited`. */
  const docs = new Map();
  const stateOf = (doc) => {
    let s = docs.get(doc);
    if (!s) {
      s = { chain: Promise.resolve(), timer: null, rev: 0, people: new Set() };
      docs.set(doc, s);
    }
    return s;
  };

  async function deliver(event, body) {
    for (let attempt = 0; attempt <= retryMs.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, retryMs[attempt - 1]));
      const timestamp = String(Math.floor(now() / 1000));
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-WordCraft-Event': event,
            'X-WordCraft-Timestamp': timestamp,
            'X-WordCraft-Signature': signWebhook(secret, timestamp, body),
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) return;
        log(`relay: webhook ${event} answered ${res.status}`);
      } catch (e) {
        log(`relay: webhook ${event} failed: ${e.message || e}`);
      }
    }
    log(`relay: webhook ${event} given up after ${retryMs.length + 1} attempts`);
  }

  function send(doc, event, detail = {}) {
    const s = stateOf(doc);
    const body = JSON.stringify({ event, doc, at: new Date(now()).toISOString(), ...detail });
    s.chain = s.chain.then(() => deliver(event, body));
  }

  return {
    send,
    /** `name` made revision `rev`: an `edited` event goes out at most every 5 s, after the first. */
    edited(doc, rev, name) {
      const s = stateOf(doc);
      s.rev = Math.max(s.rev, rev);
      s.people.add(name);
      if (s.timer) return;
      s.timer = setTimer(() => {
        s.timer = null;
        const people = [...s.people];
        s.people.clear();
        send(doc, 'edited', { rev: s.rev, people });
      }, editedEveryMs);
    },
    /** Stop the waiting `edited` timers (the relay is closing). */
    close() {
      for (const s of docs.values()) {
        clearTimer(s.timer);
        s.timer = null;
      }
    },
  };
}
