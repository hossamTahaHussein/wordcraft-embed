// End to end: Suggesting per person, the suggest role, version history and the offline limits,
// with real editors in Chromium driven through the JavaScript API.
//
//   EDITOR_DIR=../upstream/dist/web node --test test/e2e/roles.e2e.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join as path, resolve } from 'node:path';
import { chromium } from 'playwright';

const EDITOR_DIR = resolve(process.env.EDITOR_DIR || '../upstream/dist/web');
const PORT = 21000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const work = mkdtempSync(path(tmpdir(), 'wc-roles-e2e-'));
const relayDir = path(work, 'relay');
let server;
let browser;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

function startServer() {
  return new Promise((resolveStart, reject) => {
    server = spawn(process.execPath, ['examples/server.mjs'], {
      env: { ...process.env, PORT: String(PORT), EDITOR_DIR, FILES_DIR: path(work, 'files'), RELAY_DATA_DIR: relayDir, RELAY_SECRET: 'e2e-secret-0123456789abcdef' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    server.stdout.on('data', (d) => d.toString().includes('demo on') && resolveStart());
    server.on('exit', (code) => code && reject(new Error(`server exited ${code}`)));
  });
}

function stopServer() {
  return new Promise((r) => {
    server.once('exit', r);
    server.kill();
  });
}

/** A page on the demo's origin with one co-editing editor as `name` in `role`, joined to `doc`. */
async function join(doc, name, role = 'edit') {
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
  page.on('pageerror', (e) => console.error(`[${name}] page error:`, e.message));
  await page.goto(`${BASE}/`);
  await page.evaluate(
    async ([doc, name, role]) => {
      document.body.innerHTML = '<div id="e" style="height:600px"></div>';
      const { WordCraftEditor } = await import('/sdk/wordcraft-embed.js');
      window.collabStatus = {};
      const editor = new WordCraftEditor('#e', {
        src: '/wordcraft/',
        author: name,
        document: '/blank.docx',
        documentName: `${doc}.docx`,
        guardUnload: false,
        collab: {
          url: `ws://${location.host}/relay`,
          token: async () => (await (await fetch(`/api/token?doc=${doc}&name=${name}&role=${role}`)).json()).token,
        },
        onSave: () => {},
      });
      editor.addEventListener('collab', (e) => (window.collabStatus = e.detail));
      window.editor = editor;
    },
    [doc, name, role],
  );
  await waitFor(() => page.evaluate(() => window.collabStatus.rev != null), `${name} to join`);
  return page;
}

const call = (page, method, ...args) => page.evaluate(([method, args]) => window.editor[method](...args), [method, args]);
const refusal = (page, method, ...args) =>
  page.evaluate(([method, args]) => window.editor[method](...args).then(() => null, (e) => e.message), [method, args]);
const revisions = async (page) => (await call(page, 'run', 'file.inspect', {})).found.revisions;

before(async () => {
  await startServer();
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await stopServer();
  rmSync(work, { recursive: true, force: true });
});

test('Suggesting is each person’s own: only that person’s edits are tracked', async () => {
  const ann = await join('suggesting', 'Ann');
  const bob = await join('suggesting', 'Bob');
  await call(ann, 'run', 'review.trackChanges', { value: true });
  await call(ann, 'insertText', 'Alpha ');
  await waitFor(async () => (await call(bob, 'getText')).includes('Alpha'), 'Ann’s text at Bob');
  await call(bob, 'insertText', 'Beta ');
  await waitFor(async () => (await call(ann, 'getText')).includes('Beta'), 'Bob’s text at Ann');
  // Ann's insertion is one tracked change everywhere; Bob's typing isn't tracked.
  assert.equal(await revisions(ann), 1);
  assert.equal(await revisions(bob), 1);
  await ann.context().close();
  await bob.context().close();
});

test('the suggest role: edits arrive as suggestions, and deciding on them is refused', async () => {
  const ed = await join('suggest-role', 'Editor');
  const sue = await join('suggest-role', 'Sue', 'suggest');
  await call(sue, 'insertText', 'Proposed ');
  await waitFor(async () => (await call(ed, 'getText')).includes('Proposed'), 'the suggestion at the editor');
  assert.equal(await revisions(ed), 1, 'it arrives as a tracked change');
  assert.ok(await refusal(sue, 'run', 'review.acceptAll', {}), 'a suggester cannot accept suggestions');
  await call(ed, 'run', 'review.acceptAll', {});
  await waitFor(async () => (await revisions(sue)) === 0, 'the editor’s accept at the suggester');
  await ed.context().close();
  await sue.context().close();
});

test('a viewer can’t edit, and sees the editors’ changes', async () => {
  const ed = await join('viewer', 'Editor');
  const vic = await join('viewer', 'Vic', 'view');
  assert.ok(await refusal(vic, 'insertText', 'Nope'), 'typing is refused');
  await call(ed, 'insertText', 'Visible ');
  await waitFor(async () => (await call(vic, 'getText')).includes('Visible'), 'the edit at the viewer');
  assert.ok(!(await call(ed, 'getText')).includes('Nope'));
  await ed.context().close();
  await vic.context().close();
});

test('a save is kept as a version on the relay', async () => {
  const ann = await join('versions', 'Ann');
  await call(ann, 'insertText', 'First draft ');
  const dir = path(relayDir, createHash('sha256').update('versions').digest('hex').slice(0, 32), 'versions');
  // Autosave runs a couple of seconds after the last edit; the first save is always kept.
  const kept = await waitFor(() => existsSync(dir) && readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)), 'a version on disk');
  const version = JSON.parse(readFileSync(path(dir, kept[0]), 'utf8'));
  assert.ok(version.doc.includes('First draft'), 'the version holds the saved document');
  assert.deepEqual(version.users, ['Ann']);
  await ann.context().close();
});

test('too many edits offline make the document read only until they sync', { timeout: 240_000 }, async () => {
  const ann = await join('offline', 'Ann');
  await call(ann, 'insertText', 'Online ');
  await waitFor(() => ann.evaluate(() => window.collabStatus.pending === 0), 'the first edit to sync');
  await stopServer();
  await waitFor(() => ann.evaluate(() => window.collabStatus.connected === false), 'the editor to notice');
  // Edits keep working offline, up to 1,000 waiting.
  const made = await ann.evaluate(async () => {
    for (let i = 0; i < 1100; i++) {
      try {
        await window.editor.run('text.insert', { text: 'x' });
      } catch {
        return i;
      }
    }
    return 1100;
  });
  assert.equal(made, 1000, 'read only once 1,000 edits are waiting');
  await startServer();
  await waitFor(() => ann.evaluate(() => window.collabStatus.connected && window.collabStatus.pending === 0), 'the edits to sync', 90_000);
  await waitFor(async () => !(await refusal(ann, 'insertText', ' back')), 'editing again');
  const text = await call(ann, 'getText');
  assert.ok(text.includes('x'.repeat(made)) && text.includes('back'), 'nothing was lost');
  await ann.context().close();
});
