// Relay persistence: per room, the latest snapshot and the ops after it, so a relay restart
// loses nothing. DATA_DIR/<room hash>/snapshot.json (written whole, synced, then renamed),
// ops.jsonl (appended in batches, synced) and meta.json (the last saved revision). Versions are
// versions/<rev>.json ({ rev, at, users, doc }) with versions/index.json listing them without
// their documents. Writes for one room happen in order.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';

export function createStore(dataDir, { flushMs = 20 } = {}) {
  const rooms = new Map();

  function dirOf(id) {
    return join(dataDir, createHash('sha256').update(id).digest('hex').slice(0, 32));
  }

  function state(id) {
    let s = rooms.get(id);
    if (!s) {
      s = { chain: Promise.resolve(), buffer: [], timer: null, durable: null, release: null };
      rooms.set(id, s);
    }
    return s;
  }

  /** Run `task` after every earlier write of this room. */
  function queue(id, task) {
    const s = state(id);
    s.chain = s.chain.then(task).catch((e) => console.error(`relay store (${id}):`, e));
    return s.chain;
  }

  async function appendLines(file, lines) {
    const fh = await open(file, 'a');
    try {
      await fh.appendFile(lines);
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  /** Write `text` to `name` in `dir` so that a crash leaves either the old file or the new one. */
  async function replaceFile(dir, name, text) {
    const tmp = join(dir, `${name}.tmp`);
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(text);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, join(dir, name));
    // The rename itself survives a crash once the folder is synced.
    const d = await open(dir, 'r');
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  }

  function flushBuffer(id) {
    const s = state(id);
    clearTimeout(s.timer);
    s.timer = null;
    if (!s.buffer.length) return s.chain;
    const lines = s.buffer.map((op) => JSON.stringify(op) + '\n').join('');
    s.buffer = [];
    return queue(id, async () => {
      await mkdir(dirOf(id), { recursive: true });
      await appendLines(join(dirOf(id), 'ops.jsonl'), lines);
    });
  }

  /** Write the waiting batch now and resolve its ops' promise once it is synced. */
  function releaseBatch(id) {
    const s = state(id);
    const release = s.release;
    s.durable = null;
    s.release = null;
    return flushBuffer(id).then(() => release?.());
  }

  /** Write whatever is buffered, releasing a waiting batch. */
  function flush(id) {
    return state(id).durable ? releaseBatch(id) : flushBuffer(id);
  }

  return {
    /** @returns {Promise<{snapshot: object | null, ops: object[], meta: {savedRev?: number} | null}>} */
    async load(id) {
      const dir = dirOf(id);
      let snapshot = null;
      let meta = null;
      const ops = [];
      try {
        snapshot = JSON.parse(await readFile(join(dir, 'snapshot.json'), 'utf8'));
      } catch {}
      try {
        meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
      } catch {}
      try {
        const file = join(dir, 'ops.jsonl');
        const text = await readFile(file, 'utf8');
        // A crash mid-append leaves a torn last line: cut it off, or the next append would be
        // glued to it and lost on the following load.
        const end = text.lastIndexOf('\n') + 1;
        if (end < text.length) await truncate(file, Buffer.byteLength(text.slice(0, end)));
        for (const line of text.slice(0, end).split('\n')) {
          if (!line) continue;
          try {
            ops.push(JSON.parse(line));
          } catch {}
        }
      } catch {}
      return { snapshot, ops: snapshot ? ops.filter((o) => o.rev > snapshot.rev) : ops, meta };
    },

    /** Queue an op; the promise resolves once it is written and synced. */
    append(id, op) {
      const s = state(id);
      s.buffer.push(op);
      if (flushMs <= 0) return flushBuffer(id);
      if (!s.durable) {
        s.durable = new Promise((resolve) => {
          s.release = resolve;
          s.timer = setTimeout(() => releaseBatch(id), flushMs);
        });
      }
      return s.durable;
    },

    /** Replace the snapshot and the ops after it. */
    writeSnapshot(id, snapshot, opsAfter) {
      flush(id);
      return queue(id, async () => {
        const dir = dirOf(id);
        await mkdir(dir, { recursive: true });
        await replaceFile(dir, 'snapshot.json', JSON.stringify(snapshot));
        await replaceFile(dir, 'ops.jsonl', opsAfter.map((o) => JSON.stringify(o) + '\n').join(''));
      });
    },

    writeMeta(id, meta) {
      return queue(id, async () => {
        const dir = dirOf(id);
        await mkdir(dir, { recursive: true });
        await replaceFile(dir, 'meta.json', JSON.stringify(meta));
      });
    },

    flush,

    /** Whether the room was ever stored. */
    async exists(id) {
      try {
        return (await stat(dirOf(id))).isDirectory();
      } catch {
        return false;
      }
    },

    /** The room's versions without their documents, oldest first. */
    async loadVersions(id) {
      const dir = join(dirOf(id), 'versions');
      try {
        return JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
      } catch {}
      // No index (or a torn one): read the versions themselves.
      const list = [];
      let names = [];
      try {
        names = await readdir(dir);
      } catch {}
      for (const name of names) {
        if (!/^\d+\.json$/.test(name)) continue;
        try {
          const { rev, at, users } = JSON.parse(await readFile(join(dir, name), 'utf8'));
          list.push({ rev, at, users });
        } catch {}
      }
      return list.sort((a, b) => a.rev - b.rev);
    },

    /** One version ({ rev, at, users, doc }), or null when it is gone. */
    async readVersion(id, rev) {
      await state(id).chain;
      try {
        return JSON.parse(await readFile(join(dirOf(id), 'versions', `${rev}.json`), 'utf8'));
      } catch {
        return null;
      }
    },

    /** Store `version`, remove the versions `drop` (revisions), and write the new `index`. */
    writeVersion(id, version, drop, index) {
      return queue(id, async () => {
        const dir = join(dirOf(id), 'versions');
        await mkdir(dir, { recursive: true });
        await replaceFile(dir, `${version.rev}.json`, JSON.stringify(version));
        await replaceFile(dir, 'index.json', JSON.stringify(index));
        for (const rev of drop) await rm(join(dir, `${rev}.json`), { force: true });
      });
    },
  };
}
