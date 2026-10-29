import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../server.mjs';
import { issueToken } from '../token.mjs';
import { verifyWebhook } from '../webhook.mjs';
import { connect, tick, wsOp } from './helpers.mjs';

const SECRET = 'server-test-secret-0123456789';
const HOOK_SECRET = 'hook-secret-0123456789';

test('the relay sends signed webhooks for what happens in a document', async () => {
  const got = [];
  const rx = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    got.push({ ok: verifyWebhook(HOOK_SECRET, req.headers, body), ...JSON.parse(body) });
    res.end();
  });
  await new Promise((r) => rx.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'wc-hooks-'));
  const relay = await createRelay({
    secret: SECRET,
    dataDir: dir,
    port: 0,
    webhook: { url: `http://127.0.0.1:${rx.address().port}/`, secret: HOOK_SECRET, editedEveryMs: 50 },
  });
  try {
  const a = await connect(`ws://127.0.0.1:${relay.port}/relay`);
  a.send({ t: 'hello', token: issueToken(SECRET, { doc: 'hooked', sub: 'u1', name: 'Ann', role: 'edit' }), client: 'ca' });
  await a.next('Welcome');
  a.send({ t: 'Snapshot', rev: 0, doc: '{}' });
  a.send(wsOp(1));
  await a.next('Op');
  a.send({ t: 'Saved', rev: 1 });
  a.ws.close();
  const end = Date.now() + 3000;
  while (got.length < 4 && Date.now() < end) await tick(10);
  assert.deepEqual(
    got.map((e) => [e.ok, e.event, e.doc]),
    [
      [true, 'joined', 'hooked'],
      [true, 'saved', 'hooked'],
      [true, 'left', 'hooked'],
      [true, 'edited', 'hooked'],
    ],
  );
  assert.deepEqual(got[3].people, ['Ann']);
  } finally {
    await relay.close();
    rx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
