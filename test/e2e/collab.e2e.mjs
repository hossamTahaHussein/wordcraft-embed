// End to end: three browsers co-edit one document through the demo server and relay.
//
//   EDITOR_DIR=../upstream/dist/web node --test test/e2e/
//
// Needs a co-editing build of WordCraft (EDITOR_DIR), Playwright's Chromium, and a way to read
// .docx text: WORDCRAFT_CLI (a wordcraft-cli binary) or the WordCraft flatpak.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const EDITOR_DIR = resolve(process.env.EDITOR_DIR || '../upstream/dist/web');
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DOC = 'e2e';
const work = mkdtempSync(join(tmpdir(), 'wc-e2e-'));
const filesDir = join(work, 'files');
const relayDir = join(work, 'relay');
const file = join(filesDir, `${DOC}.docx`);
let server;
let browser;
const pages = [];

function startServer() {
  return new Promise((resolveStart, reject) => {
    server = spawn(process.execPath, ['examples/server.mjs'], {
      env: { ...process.env, PORT: String(PORT), EDITOR_DIR, FILES_DIR: filesDir, RELAY_DATA_DIR: relayDir, RELAY_SECRET: 'e2e-secret-0123456789abcdef' },
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

function docText(path) {
  const cli = process.env.WORDCRAFT_CLI;
  if (cli) return execFileSync(cli, ['text', path]).toString().trim();
  return execFileSync('flatpak', ['run', `--filesystem=${filesDir}`, '--command=wordcraft-cli', 'ai.storyteller.wordcraft', 'text', path]).toString().trim();
}

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

async function joinAs(name) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[${name}] page error:`, e.message));
  await page.goto(`${BASE}/collab.html?doc=${DOC}&name=${name}`);
  await waitFor(() => page.textContent('#status').then((t) => /synced|Saved/.test(t)), `${name} to join`);
  // Let the editor lay the document out, then click into the first page's body.
  await sleep(1500);
  const box = await page.locator('iframe').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.5);
  await page.keyboard.press('Control+Home');
  pages.push({ name, page, context });
  return page;
}

async function typeTogether(texts) {
  const longest = Math.max(...texts.map((t) => t.length));
  for (let i = 0; i < longest; i++) {
    await Promise.all(pages.map(({ page }, n) => (texts[n][i] ? page.keyboard.type(texts[n][i]) : null)));
    await sleep(30);
  }
}

before(async () => {
  assert.ok(existsSync(join(EDITOR_DIR, 'index.html')), `no editor build at ${EDITOR_DIR}`);
  await startServer();
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) await stopServer();
  if (process.env.KEEP) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
});

/** Each person's caret to the end of their own line (line n of the setup). */
async function toOwnLines() {
  for (const [n, { page }] of pages.entries()) {
    await page.keyboard.press('Control+Home');
    for (let i = 0; i < n; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
  }
}

test('three people type at once; autosave holds all three sentences, once each', async () => {
  for (const name of ["Ann", "Bob", "Chen"]) await joinAs(name);
  // One line each, as people co-editing work in different places. (Typing at the very same
  // caret interleaves letters, as in any co-editor, and AutoCorrect may then act on the mixed
  // word — a known limitation.)
  await pages[0].page.keyboard.type('Ann:', { delay: 20 });
  await pages[0].page.keyboard.press('Enter');
  await pages[0].page.keyboard.type('Bob:', { delay: 20 });
  await pages[0].page.keyboard.press('Enter');
  await pages[0].page.keyboard.type('Chen:', { delay: 20 });
  await sleep(3000);
  await toOwnLines();
  const sentences = [' Ann writes here.', ' Bob adds this.', ' Chen was also here.']; 
  await typeTogether(sentences);
  const typedAt = Date.now();
  // Autosave: without anyone pressing Ctrl+S, the file is written a few seconds after typing stops.
  await waitFor(() => existsSync(file) && statSync(file).mtimeMs > typedAt - 500 && docText(file).includes('Chen was also here'), 'autosave', 20_000);
  const text = docText(file);
  for (const s of sentences) {
    assert.equal(text.split(s.trim()).length - 1, 1, `"${s.trim()}" exactly once in:\n${text}`);
  }
  // Every editor has the same document: each saves in turn and the file reads the same.
  const seen = new Set();
  for (const { page } of pages) {
    await page.keyboard.press('Control+s');
    await sleep(1500);
    seen.add(docText(file));
  }
  assert.equal(seen.size, 1, `editors differ:\n${[...seen].join('\n---\n')}`);
});

test('the relay restarts mid-typing: nothing is lost or doubled', async () => {
  await toOwnLines();
  await typeTogether([' One', ' Two', ' Three']);
  await stopServer();
  await typeTogether([' offline-a', ' offline-b', ' offline-c']);
  await startServer();
  // The pages are loaded already; their SDKs reconnect and resend what the relay didn't get.
  await waitFor(
    async () => (await Promise.all(pages.map(({ page }) => page.textContent('#status')))).every((t) => /synced|Saved/.test(t)),
    'everyone to reconnect',
    40_000,
  );
  await sleep(4000);
  const text = docText(file);
  for (const word of ['One', 'Two', 'Three', 'offline-a', 'offline-b', 'offline-c']) {
    assert.equal(text.split(word).length - 1, 1, `"${word}" exactly once in:\n${text}`);
  }
  for (const { page, name } of pages) await page.screenshot({ path: join(process.env.SHOTS_DIR || tmpdir(), `collab-${name}.png`) });
});
