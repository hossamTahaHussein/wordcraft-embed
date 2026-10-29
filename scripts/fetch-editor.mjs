#!/usr/bin/env node
// Download a WordCraft Collab web release, check it against the release's SHA256SUMS.txt and unpack it
// into editor/ (the static site the SDK frames).
//
//   node scripts/fetch-editor.mjs            # the version pinned in package.json ("wordcraftVersion")
//   node scripts/fetch-editor.mjs 1.0.0      # a specific release
//   node scripts/fetch-editor.mjs latest
//
// Needs Node 18+ and `unzip` on PATH.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'hossamTahaHussein/wordcraft-collab';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pinned = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).wordcraftVersion;

async function latestVersion() {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (!response.ok) throw new Error(`GitHub API: HTTP ${response.status}`);
  return (await response.json()).tag_name.replace(/^v/, '');
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

let version = process.argv[2] || pinned;
if (version === 'latest') version = await latestVersion();
const base = `https://github.com/${REPO}/releases/download/v${version}`;
const zipName = `wordcraft-web-${version}.zip`;

console.log(`Downloading ${zipName} from ${REPO}…`);
const [zip, sums] = await Promise.all([download(`${base}/${zipName}`), download(`${base}/SHA256SUMS.txt`)]);

const expected = sums
  .toString('utf8')
  .split('\n')
  .map((line) => line.trim().split(/\s+/))
  .find(([, name]) => name === zipName)?.[0];
const actual = createHash('sha256').update(zip).digest('hex');
if (!expected) throw new Error(`${zipName} is not listed in SHA256SUMS.txt`);
if (expected !== actual) throw new Error(`Checksum mismatch for ${zipName}: expected ${expected}, got ${actual}`);
console.log(`SHA-256 verified: ${actual}`);

// Unpack beside editor/ so the final rename stays on one filesystem.
const work = mkdtempSync(join(root, '.wordcraft-web-'));
try {
  writeFileSync(join(work, zipName), zip);
  execFileSync('unzip', ['-q', join(work, zipName), '-d', work]);
  const editor = join(root, 'editor');
  if (existsSync(editor)) rmSync(editor, { recursive: true });
  renameSync(join(work, `wordcraft-web-${version}`), editor);
  writeFileSync(join(editor, 'VERSION'), `${version}\n`);
  console.log(`WordCraft Collab ${version} unpacked into editor/`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
