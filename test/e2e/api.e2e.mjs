// End to end: a page drives the real editor through the JavaScript API and hears its events.
//
//   EDITOR_DIR=../upstream/dist/web node --test test/e2e/api.e2e.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const EDITOR_DIR = resolve(process.env.EDITOR_DIR || '../upstream/dist/web');
const PORT = 20000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const work = mkdtempSync(join(tmpdir(), 'wc-api-e2e-'));
let server;
let browser;
let page;

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

before(async () => {
  await new Promise((resolveStart, reject) => {
    server = spawn(process.execPath, ['examples/server.mjs'], {
      env: { ...process.env, PORT: String(PORT), EDITOR_DIR, FILES_DIR: join(work, 'files'), RELAY_DATA_DIR: join(work, 'relay'), RELAY_SECRET: 'e2e-secret-0123456789abcdef' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    server.stdout.on('data', (d) => d.toString().includes('demo on') && resolveStart());
    server.on('exit', (code) => code && reject(new Error(`server exited ${code}`)));
  });
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`${BASE}/`);
  // A bare page on the editor's origin with one editor, its events recorded on `window.heard`.
  await page.evaluate(async () => {
    document.body.innerHTML = '<div id="e" style="height:600px"></div>';
    const { WordCraftEditor } = await import('/sdk/wordcraft-embed.js');
    window.heard = [];
    const editor = new WordCraftEditor('#e', { src: '/wordcraft/', document: new Blob(['Start']), documentName: 'start.txt', guardUnload: false });
    for (const type of ['change', 'selectionchange', 'presence', 'comment']) {
      editor.addEventListener(type, (e) => window.heard.push({ type, detail: e.detail }));
    }
    window.editor = editor;
    await editor.ready;
  });
  await waitFor(() => page.evaluate(() => window.editor.getText().then((t) => t.includes('Start'), () => false)), 'the document to open');
});

after(async () => {
  await browser?.close();
  await new Promise((r) => {
    server.once('exit', r);
    server.kill();
  });
  rmSync(work, { recursive: true, force: true });
});

const heard = (type) => page.evaluate((t) => window.heard.filter((h) => h.type === t).map((h) => h.detail), type);

test('edits through the API show up in the text and as change events', async () => {
  await page.evaluate(async () => {
    await window.editor.select('Start');
    await window.editor.insertText('Hello API');
  });
  assert.equal((await page.evaluate(() => window.editor.getText())).trim(), 'Hello API');
  const changes = await waitFor(async () => (await heard('change')).length && heard('change'), 'a change event');
  assert.ok(changes.at(-1).rev > 0 && typeof changes.at(-1).author === 'string');
});

test('selecting tells the page what is selected', async () => {
  await page.evaluate(() => window.editor.select('API'));
  const sel = await waitFor(async () => (await heard('selectionchange')).find((d) => d.text === 'API'), 'selectionchange API');
  assert.equal(sel.empty, false);
});

test('the document comes back as a PDF', async () => {
  const head = await page.evaluate(async () => {
    const { name, blob } = await window.editor.getDocument('pdf');
    return [name, new TextDecoder().decode((await blob.arrayBuffer()).slice(0, 4))];
  });
  assert.ok(head[0].endsWith('.pdf'), head[0]);
  assert.equal(head[1], '%PDF');
});

test('a comment made through run() arrives as a comment event', async () => {
  await page.evaluate(() => window.editor.run('review.newComment', { text: 'Check this' }));
  const added = await waitFor(async () => (await heard('comment')).find((d) => d.action === 'added'), 'comment added');
  assert.equal(added.text, 'Check this');
});

test('read only refuses edits until it is turned off', async () => {
  await page.evaluate(() => window.editor.setReadOnly(true));
  const refused = await page.evaluate(() => window.editor.insertText('nope').then(() => 'ran', (e) => e.message));
  assert.match(refused, /open for viewing/);
  // Typing on the page changes nothing either.
  const box = await page.locator('iframe').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.4);
  await page.keyboard.type('zzz');
  await sleep(500);
  assert.ok(!(await page.evaluate(() => window.editor.getText())).includes('zzz'));
  await page.evaluate(() => window.editor.setReadOnly(false));
  await page.evaluate(async () => {
    await window.editor.select('Hello');
    await window.editor.insertText('Bye');
  });
  assert.ok((await page.evaluate(() => window.editor.getText())).includes('Bye API'));
});
