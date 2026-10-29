// Relay persistence: per room, the latest snapshot and the ops after it, so a relay restart
// loses nothing. DATA_DIR/<room hash>/snapshot.json (written whole, then renamed) and ops.jsonl
// (appended in batches, fsynced). Writes for one room happen in order.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createStore(dataDir, { flushMs = 100 } = {}) {
  const rooms = new Map();

  function dirOf(id) {
    return join(dataDir, createHash('sha256').update(id).digest('hex').slice(0, 32));
  }

  function state(id) {
    let s = rooms.get(id);
    if (!s) {
      s = { chain: Promise.resolve(), buffer: [], timer: null };
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

  return {
    /** @returns {Promise<{snapshot: {rev: number, doc: string} | null, ops: object[]}>} */
    async load(id) {
      const dir = dirOf(id);
      let snapshot = null;
      let ops = [];
      try {
        snapshot = JSON.parse(await readFile(join(dir, 'snapshot.json'), 'utf8'));
      } catch {}
      try {
        const text = await readFile(join(dir, 'ops.jsonl'), 'utf8');
        for (const line of text.split('\n')) {
          if (!line) continue;
          try {
            ops.push(JSON.parse(line));
          } catch {
            break; // a torn last line from a crash: everything before it is good
          }
        }
      } catch {}
      if (snapshot) ops = ops.filter((o) => o.rev > snapshot.rev);
      return { snapshot, ops };
    },

    append(id, op) {
      const s = state(id);
      s.buffer.push(op);
      if (flushMs <= 0) return flushBuffer(id);
      if (!s.timer) s.timer = setTimeout(() => flushBuffer(id), flushMs);
      return s.chain;
    },

    /** Replace the snapshot and the ops after it. */
    writeSnapshot(id, snapshot, opsAfter) {
      flushBuffer(id);
      return queue(id, async () => {
        const dir = dirOf(id);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'snapshot.json.tmp'), JSON.stringify(snapshot));
        await rename(join(dir, 'snapshot.json.tmp'), join(dir, 'snapshot.json'));
        await writeFile(join(dir, 'ops.jsonl.tmp'), opsAfter.map((o) => JSON.stringify(o) + '\n').join(''));
        await rename(join(dir, 'ops.jsonl.tmp'), join(dir, 'ops.jsonl'));
      });
    },

    flush(id) {
      return flushBuffer(id);
    },
  };
}
