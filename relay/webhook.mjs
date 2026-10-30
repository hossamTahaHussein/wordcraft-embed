// Webhooks: the relay tells your server what happens in its documents (someone joined, left,
// edited, commented, a save landed, a version was restored) by POSTing signed JSON to WEBHOOK_URL.
//
//   POST <WEBHOOK_URL>   { event, doc, at, delivery, ...detail }
//   X-WordCraft-Event: <event>
//   X-WordCraft-Delivery: <uuid, the same on every retry of one delivery: dedupe on it>
//   X-WordCraft-Timestamp: <unix seconds>
//   X-WordCraft-Signature: sha256=<hex HMAC-SHA256(WEBHOOK_SECRET, "<timestamp>.<body>")>
//
// Receivers check a delivery with `verifyWebhook(secret, headers, rawBody)`, and skip a
// `delivery` id they already handled (a retry after a timeout may arrive twice).

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const TIMEOUT_MS = 5000;
/** The waits before the second and third attempts. */
const RETRY_MS = [1000, 5000];
const EDITED_EVERY_MS = 5000;
/** The most deliveries one document keeps waiting (while the receiver is down, say); beyond
 * that the oldest waiting one is dropped. */
const MAX_PENDING = 100;

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
 * The body's `delivery` id (signed with it) is the same on every retry: dedupe on it.
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
 * one at a time in order, each tried up to three times. At most `maxPending` wait per document:
 * when more come, the oldest waiting one is dropped (with a warning, once per burst).
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
  maxPending = MAX_PENDING,
  log = (m) => console.warn(m),
} = {}) {
  if (!url || !secret) return null;
  /** Per document, while anything is waiting: the deliveries not yet started (`queue`),
   * whether one is under way (`busy`), how many were dropped in this burst, and the edits
   * waiting for the next `edited`. Let go once nothing is. */
  const docs = new Map();
  const stateOf = (doc) => {
    let s = docs.get(doc);
    if (!s) {
      s = { queue: [], busy: false, dropped: 0, timer: null, rev: 0, people: new Set() };
      docs.set(doc, s);
    }
    return s;
  };
  const prune = (doc, s) => {
    if (s.queue.length || s.busy || s.timer) return;
    if (s.dropped) log(`relay: webhooks for ${doc}: ${s.dropped} dropped while the receiver was behind`);
    if (docs.get(doc) === s) docs.delete(doc);
  };

  /** Deliver `doc`'s waiting deliveries one at a time, in order. */
  async function drain(doc, s) {
    s.busy = true;
    while (s.queue.length) {
      const { event, id, body } = s.queue.shift();
      await deliver(event, id, body);
    }
    s.busy = false;
    prune(doc, s);
  }

  async function deliver(event, id, body) {
    for (let attempt = 0; attempt <= retryMs.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, retryMs[attempt - 1]));
      const timestamp = String(Math.floor(now() / 1000));
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-WordCraft-Event': event,
            'X-WordCraft-Delivery': id,
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
    const id = randomUUID();
    const body = JSON.stringify({ event, doc, at: new Date(now()).toISOString(), delivery: id, ...detail });
    if (s.queue.length >= maxPending) {
      s.queue.shift();
      if (!s.dropped++) log(`relay: webhooks for ${doc} are ${maxPending} behind; dropping the oldest waiting ones`);
    }
    s.queue.push({ event, id, body });
    if (!s.busy) drain(doc, s);
  }

  return {
    send,
    /** How many deliveries of `doc` wait (not counting one under way). */
    pending: (doc) => docs.get(doc)?.queue.length ?? 0,
    /** How many documents the sender holds anything for. */
    documents: () => docs.size,
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
