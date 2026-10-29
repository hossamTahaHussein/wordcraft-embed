// End to end: an agent joins a shared document through the real relay with
// `wordcraft-cli collab-mcp` (MCP over stdio), edits it as a tracked suggestion, sees a person's
// edit and who is here.
//
//   WORDCRAFT_CLI=../upstream/target/debug/wordcraft-cli node --test test/e2e/agent.e2e.mjs
//
// Skipped when the CLI isn't built.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createRelay } from '../../relay/server.mjs';
import { issueToken } from '../../relay/token.mjs';
import { connect } from '../../relay/test/helpers.mjs';

const CLI = resolve(process.env.WORDCRAFT_CLI || '../upstream/target/debug/wordcraft-cli');
const SECRET = 'agent-e2e-secret-0123456789';
const skip = !existsSync(CLI) && `no wordcraft-cli at ${CLI}`;
const work = mkdtempSync(join(tmpdir(), 'wc-agent-e2e-'));
let relay;
let url;

before(async () => {
  if (skip) return;
  relay = await createRelay({ secret: SECRET, dataDir: join(work, 'relay'), port: 0 });
  url = `ws://127.0.0.1:${relay.port}/relay`;
});

after(async () => {
  await relay?.close();
  rmSync(work, { recursive: true, force: true });
});

/** The document as WordCraft's native JSON (what an editor uploads as revision 0). */
function nativeDoc(text) {
  writeFileSync(join(work, 'in.txt'), text);
  const r = spawnSync(CLI, ['convert', join(work, 'in.txt'), join(work, 'doc.json')]);
  assert.equal(r.status, 0, String(r.stderr));
  return readFileSync(join(work, 'doc.json'), 'utf8');
}

/** `wordcraft-cli collab-mcp` with a JSON-RPC client on its stdio. */
function agent(token, name) {
  const child = spawn(CLI, ['collab-mcp', '--relay', url, '--token', token, '--name', name], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((res) => {
      id += 1;
      waiting.set(id, res);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const tool = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r.result.content.find((c) => c.type === 'text').text;
    if (r.result.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return { child, rpc, tool };
}

test('an agent joins, suggests an edit, sees a person edit and who is here', { skip }, async () => {
  const doc = 'shared';
  const ann = await connect(url);
  ann.send({ t: 'hello', token: issueToken(SECRET, { doc, sub: 'ann', name: 'Ann', role: 'edit' }), client: 'ann1' });
  const welcome = await ann.next('Welcome');
  assert.equal(welcome.snapshot, null);
  ann.send({ t: 'Snapshot', rev: 0, doc: nativeDoc('Hello there') });

  const bot = agent(issueToken(SECRET, { doc, sub: 'bot', name: 'Helper', role: 'edit' }), 'Helper');
  await bot.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  const joined = await ann.next('Join');
  assert.equal(joined.user, 'Helper');

  await bot.tool('execute', { command: 'caret.docEnd' });
  await bot.tool('execute', { command: 'text.insert', params: { text: '!' } });
  const op = await ann.next('Op');
  assert.equal(op.user, 'Helper');
  assert.equal(op.cmd, 'text.insert');
  assert.equal(op.ctx.track, true, 'the agent suggests');

  const who = await bot.tool('who_is_here', {});
  assert.deepEqual(who.people.map((p) => p.name), ['Ann']);

  // Ann types at the start; the agent waits for it.
  ann.send({
    t: 'Op', client: 'ann1', seq: 1, base: op.rev, kind: 'cmd', cmd: 'text.insert', params: { text: 'Oh. ' },
    sel: { story: 'body', anchor: 0, head: 0 },
    ctx: { author: 'Ann', initials: 'A', time: 0, track: false, editing: { autocorrect: {}, typingReplacesSelection: true, overtype: false } },
  });
  const changes = await bot.tool('wait_for_changes', { since: op.rev, timeoutMs: 5000 });
  assert.deepEqual(changes.changes.map((c) => [c.by, c.command]), [['Ann', 'text.insert']]);
  const text = await bot.tool('execute', { command: 'document.text' });
  assert.match(text.text, /^Oh\. Hello there!/);

  bot.child.kill();
  ann.ws.close();
});

test('an agent can only join a document someone has open', { skip }, async () => {
  const token = issueToken(SECRET, { doc: 'empty', sub: 'b', name: 'B', role: 'edit' });
  const bot = spawn(CLI, ['collab-mcp', '--relay', url, '--token', token], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  bot.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((r) => bot.on('exit', r));
  assert.notEqual(code, 0);
  assert.match(stderr, /nobody has this document open yet/);
});
