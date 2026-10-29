// One co-edited document on the relay. The relay never reads the document: it numbers edits,
// keeps the log since the latest snapshot, tells newcomers where to start, picks who saves and
// compares the replicas' fingerprints. Message types (`t`) match wordcraft_collab::proto.
//
// A member is { client, user, role, send(message), close(code, reason) }.

export const LIMITS = {
  members: 50,
  opsPerSecond: 200,
  snapshotEvery: 200,
  idleSaveMs: 2000,
  maxSaveDelayMs: 10000,
};

export class Room {
  constructor({ id, store, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, limits = {} }) {
    this.id = id;
    this.store = store;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.limits = { ...LIMITS, ...limits };
    /** The latest snapshot; `seen` is the last edit (seq) it holds from each replica.
     * @type {{rev: number, doc: string, seen?: Record<string, number>} | null} */
    this.snapshot = null;
    this.log = [];
    /** Members in join order (the first editor holds the autosave lease). */
    this.members = new Map();
    /** Members waiting for revision 0 while the first one opens the document. */
    this.waiting = [];
    this.bootstrapper = null;
    this.savedRev = 0;
    this.dirtySince = null;
    this.saveTimer = null;
    this.snapshotAskedAt = 0;
    this.votes = new Map();
  }

  get rev() {
    return (this.snapshot?.rev ?? 0) + this.log.length;
  }

  get holder() {
    for (const m of this.members.values()) if (m.role === 'edit') return m;
    return null;
  }

  async load() {
    const { snapshot, ops } = await this.store.load(this.id);
    this.snapshot = snapshot;
    this.log = ops;
    this.savedRev = this.rev;
  }

  flush() {
    return this.store.flush(this.id);
  }

  /** A member arrives. `haveRev`: the revision a reconnecting replica already has. */
  join(member, haveRev) {
    if (this.members.size >= this.limits.members) {
      member.close(4409, 'This document has too many people in it');
      return;
    }
    member.bucket = { tokens: this.limits.opsPerSecond, at: this.now() };
    this.members.set(member.client, member);
    if (!this.snapshot) {
      if (this.bootstrapper && this.bootstrapper !== member.client) {
        this.waiting.push(member.client);
        return;
      }
      this.bootstrapper = member.client;
      member.send({ t: 'Welcome', rev: 0, snapshot: null, ops: [], you: member.client });
      return;
    }
    this.welcome(member, haveRev);
  }

  welcome(member, haveRev) {
    const base = this.snapshot?.rev ?? 0;
    if (Number.isInteger(haveRev) && haveRev >= base && haveRev <= this.rev) {
      member.send({ t: 'Welcome', rev: haveRev, snapshot: null, ops: this.log.filter((o) => o.rev > haveRev), you: member.client });
    } else {
      member.send({ t: 'Welcome', rev: base, snapshot: this.snapshot.doc, ops: this.log, you: member.client, seen: this.seenBy(member.client) });
    }
  }

  leave(client) {
    this.members.delete(client);
    this.waiting = this.waiting.filter((c) => c !== client);
    if (this.bootstrapper === client && !this.snapshot) {
      this.bootstrapper = null;
      const next = this.waiting.shift();
      if (next && this.members.has(next)) this.join(this.members.get(next));
    }
    if (this.members.size === 0) {
      this.clearTimer(this.saveTimer);
      this.saveTimer = null;
    }
  }

  message(client, msg) {
    const member = this.members.get(client);
    if (!member || !msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'Op':
        return this.op(member, msg);
      case 'Snapshot':
        return this.takeSnapshot(member, msg);
      case 'Hash':
        return this.vote(member, msg);
      case 'Saved':
        if (Number.isInteger(msg.rev)) this.savedRev = Math.max(this.savedRev, Math.min(msg.rev, this.rev));
        return;
      case 'ResyncRequest':
        return this.resync(member);
    }
  }

  op(member, msg) {
    if (!this.snapshot || member.role !== 'edit') return;
    if (!this.take(member)) {
      member.close(4429, 'Too many edits per second');
      this.leave(member.client);
      return;
    }
    const { t: _t, rev: _rev, user: _user, ...fields } = msg;
    const op = { t: 'Op', ...fields, client: member.client, rev: this.rev + 1, user: member.user };
    this.log.push(op);
    // Broadcast only once the op is on disk: a relay that crashes and restarts never forgets an
    // edit somebody already has. Ops reach the disk, and so everyone, in revision order.
    this.store.append(this.id, op).then(() => {
      for (const m of this.members.values()) m.send(op);
    });
    this.scheduleSave();
    if (this.rev - (this.snapshot?.rev ?? 0) >= this.limits.snapshotEvery && this.snapshotAskedAt < this.rev - this.limits.snapshotEvery + 1) {
      this.snapshotAskedAt = this.rev;
      this.holder?.send({ t: 'SnapshotRequest' });
    }
  }

  /** Token bucket: `opsPerSecond`, bursting to the same number. */
  take(member) {
    const b = member.bucket;
    const now = this.now();
    b.tokens = Math.min(this.limits.opsPerSecond, b.tokens + ((now - b.at) / 1000) * this.limits.opsPerSecond);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  takeSnapshot(member, msg) {
    if (!Number.isInteger(msg.rev) || typeof msg.doc !== 'string') return;
    if (!this.snapshot) {
      // Revision 0, from the member who opened the document.
      if (msg.rev !== 0 || member.client !== this.bootstrapper) return;
      this.snapshot = { rev: 0, doc: msg.doc, seen: {} };
      this.store.writeSnapshot(this.id, this.snapshot, []);
      for (const c of this.waiting.splice(0)) {
        const m = this.members.get(c);
        if (m) this.welcome(m);
      }
      return;
    }
    if (msg.rev <= this.snapshot.rev || msg.rev > this.rev) return;
    const seen = { ...this.snapshot.seen };
    for (const o of this.log) if (o.rev <= msg.rev) seen[o.client] = o.seq;
    this.log = this.log.filter((o) => o.rev > msg.rev);
    this.snapshot = { rev: msg.rev, doc: msg.doc, seen };
    this.store.writeSnapshot(this.id, this.snapshot, this.log);
  }

  resync(member) {
    if (!this.snapshot) return;
    member.send({ t: 'Resync', rev: this.snapshot.rev, snapshot: this.snapshot.doc, ops: this.log, seen: this.seenBy(member.client) });
  }

  /** The last edit of `client`'s the snapshot holds (0 for none). */
  seenBy(client) {
    return this.snapshot?.seen?.[client] ?? 0;
  }

  /** Compare fingerprints at one revision: whoever disagrees with the majority (on a tie, with
   * the lease holder) starts again from the snapshot. */
  vote(member, msg) {
    if (!Number.isInteger(msg.rev) || typeof msg.h !== 'string') return;
    let votes = this.votes.get(msg.rev);
    if (!votes) {
      votes = { hashes: new Map(), resynced: new Set() };
      this.votes.set(msg.rev, votes);
      for (const r of this.votes.keys()) if (r < msg.rev - 500) this.votes.delete(r);
    }
    votes.hashes.set(member.client, msg.h);
    if (votes.hashes.size < 2) return;
    const counts = new Map();
    for (const h of votes.hashes.values()) counts.set(h, (counts.get(h) || 0) + 1);
    const top = Math.max(...counts.values());
    const leaders = [...counts.entries()].filter(([, n]) => n === top).map(([h]) => h);
    const holderHash = this.holder && votes.hashes.get(this.holder.client);
    const winner = leaders.length === 1 ? leaders[0] : leaders.includes(holderHash) ? holderHash : leaders[0];
    for (const [client, h] of votes.hashes) {
      if (h !== winner && !votes.resynced.has(client)) {
        votes.resynced.add(client);
        const m = this.members.get(client);
        if (m) {
          console.warn(`relay: ${this.id}: replica ${client} diverged at rev ${msg.rev}; resyncing`);
          this.resync(m);
        }
      }
    }
  }

  /** Autosave: 2 s after the last edit, or 10 s after the first unsaved one. */
  scheduleSave() {
    const now = this.now();
    if (this.dirtySince === null) this.dirtySince = now;
    const at = Math.min(now + this.limits.idleSaveMs, this.dirtySince + this.limits.maxSaveDelayMs);
    this.clearTimer(this.saveTimer);
    this.saveTimer = this.setTimer(() => this.autosave(), Math.max(0, at - now));
  }

  autosave() {
    this.saveTimer = null;
    this.dirtySince = null;
    if (this.rev > this.savedRev) this.holder?.send({ t: 'Save' });
  }
}
