import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createWebhooks, verifyWebhook } from '../webhook.mjs';
import { clock, tick } from './helpers.mjs';

const SECRET = 'webhook-secret-0123456789';

/** A receiver on a free port. `answer(req, n)` picks the status (or 'hang'). */
async function receiver(answer = () => 200) {
  const got = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    got.push({ headers: req.headers, body, json: JSON.parse(body), method: req.method });
    const status = answer(req, got.length);
    if (status === 'hang') return;
    res.writeHead(status);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    got,
    url: `http://127.0.0.1:${server.address().port}/hook`,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await tick(5);
  }
}

test('no URL or no secret: webhooks are off', () => {
  assert.equal(createWebhooks({ url: '', secret: SECRET }), null);
  assert.equal(createWebhooks({ url: 'http://x', secret: '' }), null);
  assert.equal(createWebhooks({}), null);
});

test('an event is POSTed as signed JSON that verifyWebhook accepts', async () => {
  const rx = await receiver();
  const hooks = createWebhooks({ url: rx.url, secret: SECRET });
  assert.equal(hooks.send('doc-1', 'joined', { sub: 'u1', name: 'Ann', role: 'edit' }), undefined, 'never waits');
  await until(() => rx.got.length === 1);
  const [{ headers, body, json, method }] = rx.got;
  assert.equal(method, 'POST');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-wordcraft-event'], 'joined');
  assert.deepEqual({ ...json, at: undefined }, { event: 'joined', doc: 'doc-1', at: undefined, sub: 'u1', name: 'Ann', role: 'edit' });
  assert.ok(!Number.isNaN(Date.parse(json.at)));
  const ts = headers['x-wordcraft-timestamp'];
  assert.match(ts, /^\d+$/);
  assert.equal(headers['x-wordcraft-signature'], `sha256=${createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`);
  assert.equal(verifyWebhook(SECRET, headers, body), true);
  assert.equal(verifyWebhook(SECRET, headers, Buffer.from(body)), true, 'a Buffer body works too');
  assert.equal(verifyWebhook(SECRET, new Headers(headers), body), true, 'and fetch Headers');
  assert.equal(verifyWebhook('another-secret-0123456789', headers, body), false);
  assert.equal(verifyWebhook(SECRET, headers, body.replace('Ann', 'Eve')), false);
  assert.equal(verifyWebhook(SECRET, headers, body, 300, (Number(ts) + 301) * 1000), false, 'too old');
  assert.equal(verifyWebhook(SECRET, { ...headers, 'x-wordcraft-signature': undefined }, body), false);
  await rx.close();
});

test('a failed delivery is tried up to three times, then given up', async () => {
  const rx = await receiver(() => 500);
  const hooks = createWebhooks({ url: rx.url, secret: SECRET, retryMs: [10, 20], log: () => {} });
  hooks.send('d', 'saved', { rev: 3 });
  await until(() => rx.got.length === 3);
  await tick(100);
  assert.equal(rx.got.length, 3);
  await rx.close();
});

test('a receiver that does not answer in time counts as a failure', async () => {
  const rx = await receiver((_, n) => (n === 1 ? 'hang' : 200));
  const hooks = createWebhooks({ url: rx.url, secret: SECRET, timeoutMs: 100, retryMs: [10, 20], log: () => {} });
  hooks.send('d', 'saved', { rev: 1 });
  await until(() => rx.got.length === 2);
  await rx.close();
});

test("one document's events arrive in order, retries included", async () => {
  const rx = await receiver((_, n) => (n === 1 ? 503 : 200));
  const hooks = createWebhooks({ url: rx.url, secret: SECRET, retryMs: [30, 30], log: () => {} });
  hooks.send('d', 'saved', { rev: 1 });
  hooks.send('d', 'saved', { rev: 2 });
  await until(() => rx.got.length === 3);
  assert.deepEqual(rx.got.map((g) => g.json.rev), [1, 1, 2]);
  await rx.close();
});

test('edited is debounced: at most one per 5 s per document, trailing, naming who edited', async () => {
  const c = clock(Date.parse('2026-10-29T12:00:00Z'));
  const sent = [];
  const fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200 };
  };
  const hooks = createWebhooks({ url: 'http://x/hook', secret: SECRET, fetch, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  hooks.edited('d', 1, 'Ann');
  c.advance(1000);
  hooks.edited('d', 2, 'Bob');
  hooks.edited('d', 3, 'Ann');
  hooks.edited('other', 1, 'Cy');
  c.advance(3999);
  await tick();
  assert.equal(sent.length, 0);
  c.advance(1);
  await tick();
  assert.deepEqual(sent.map((e) => [e.event, e.doc, e.rev, e.people]), [['edited', 'd', 3, ['Ann', 'Bob']]]);
  c.advance(1000);
  await tick();
  assert.deepEqual(sent.map((e) => e.doc), ['d', 'other']);
  hooks.edited('d', 4, 'Cy');
  c.advance(5000);
  await tick();
  assert.deepEqual(sent.at(-1).people, ['Cy']);
  assert.equal(sent.length, 3);
});
