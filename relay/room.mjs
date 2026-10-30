// One co-edited document on the relay. The relay never reads the document: it numbers edits,
// keeps the log since the latest snapshot, tells newcomers where to start, picks who saves and
// compares the replicas' fingerprints. Message types (`t`) match wordcraft_collab::proto.
//
// A member is { client, sub, user, role, agent?, send(message), close(code, reason) }: `client`
// is the replica (one per editor tab), `sub` the user from the join token, `role` what they may
// do ('edit' | 'suggest' | 'comment' | 'view'), `agent` a program rather than a person (never the holder).

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const LIMITS = {
  members: 50,
  opsPerSecond: 200,
  presencePerSecond: 15,
  snapshotEvery: 200,
  hashEvery: 50,
  idleSaveMs: 2000,
  maxSaveDelayMs: 10000,
  resyncEveryMs: 5000,
  freshWaitMs: 15000,
  versionWaitMs: 30000,
  maxHistory: 2000,
  versionEveryMs: 10 * 60 * 1000,
  maxVersions: 100,
  /** How long a room nobody is in (and with nothing waiting) stays in memory. */
  idleEvictMs: 10 * 60 * 1000,
  /** At most this many [rev, name] entries of who edited since the newest version are kept in
   * meta.json, for the revisions only the snapshot holds (see `compactEdited`). */
  maxEditedKept: 1000,
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long joins are refused after the document was closed (the HTTP API's close). */
const CLOSED_FOR_MS = 10_000;

/** An HTTP API request the room can't answer: `status` is the HTTP status. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The replica's answer to each API request type. */
const ANSWERS = { Export: 'Exported', Run: 'RunResult' };

/** Which versions to keep (`list` oldest first): all from the last 24 hours, then the newest of
 * each calendar day (UTC), at most `max` of them, the newest. */
export function thinVersions(list, now, max = LIMITS.maxVersions) {
  const kept = [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    const recent = Date.parse(v.at) >= now - DAY_MS;
    const newestOfDay = i === list.length - 1 || list[i + 1].at.slice(0, 10) !== v.at.slice(0, 10);
    if (recent || newestOfDay) kept.push(v);
  }
  return kept.slice(-max);
}

/** Who edited (`editedSince`, [rev, name] in revision order) as kept on disk: of each run by
 * one name only its first and last revision; past `max` entries, only each name's first and
 * last; then the newest `max`. A name is in the next version that reaches its first revision,
 * and kept for a later one while its last revision is past that version. */
export function compactEdited(pairs, max) {
  let kept = pairs.filter(([, name], i) => name !== pairs[i - 1]?.[1] || name !== pairs[i + 1]?.[1]);
  if (kept.length > max) {
    const first = new Map();
    const last = new Map();
    for (const p of kept) {
      if (!first.has(p[1])) first.set(p[1], p);
      last.set(p[1], p);
    }
    kept = kept.filter((p) => first.get(p[1]) === p || last.get(p[1]) === p);
  }
  return kept.slice(-max);
}

const isEdited = (p) => Array.isArray(p) && Number.isSafeInteger(p[0]) && typeof p[1] === 'string';

const OP_KINDS = new Set(['cmd', 'undo', 'redo', 'restore']);
/** The commands a commenter may run (generated from the engine registry). */
export const COMMENT_COMMANDS = new Set(JSON.parse(readFileSync(new URL('./comment-commands.json', import.meta.url), 'utf8')));
/** What a suggester may run besides comments: the commands whose whole effect the engine records
 * as a tracked change (the engine's `SUGGEST_COMMANDS`, proved by a test that Reject All takes each back). */
export const SUGGEST_COMMANDS = new Set(JSON.parse(readFileSync(new URL('./suggest-commands.json', import.meta.url), 'utf8')));
/** The comment commands and the `commented` webhook action each one is. */
const COMMENT_ACTIONS = {
  'review.newComment': 'added',
  'review.reply': 'replied',
  'review.resolveComment': 'resolved',
  'review.editComment': 'edited',
  'review.deleteComment': 'deleted',
};
const REFUSED = {
  view: 'You can only view this document',
  comment: 'You can only comment on this document',
  suggest: 'You can only suggest changes in this document',
};
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
/** The roles that may undo or redo an edit of their own, by what the edit `needs` (see `needs`). */
const MAY_UNDO = {
  edit: new Set(['comment', 'suggest', 'edit']),
  suggest: new Set(['comment', 'suggest']),
  comment: new Set(['comment']),
};

const PALETTE_SIZE = 12;
/** The largest story part index and offset a replica can hold (u32). */
const MAX_INDEX = 2 ** 32 - 1;
const isIndex = (n) => isCount(n) && n <= MAX_INDEX;

/** A selection as story offsets (wordcraft_collab::proto::Anchor). */
function validSel(sel) {
  return (
    !!sel &&
    typeof sel === 'object' &&
    (sel.story === 'body' || (sel.story && typeof sel.story === 'object' && isIndex(sel.story.part))) &&
    isIndex(sel.anchor) &&
    isIndex(sel.head)
  );
}

/** A selection with only the fields replicas read (nothing else is forwarded). */
function cleanSel(sel) {
  return { story: sel.story === 'body' ? 'body' : { part: sel.story.part }, anchor: sel.anchor, head: sel.head };
}

/** Whether `msg` has the shape of an op (wordcraft_collab::proto::Op); replicas can't decode one
 * that doesn't, and a revision nobody can apply would stall the document. */
function wellFormed(msg) {
  return (
    isCount(msg.seq) &&
    msg.seq > 0 &&
    isCount(msg.base) &&
    OP_KINDS.has(msg.kind) &&
    typeof msg.cmd === 'string' &&
    msg.cmd.length <= 200 &&
    validSel(msg.sel) &&
    !!msg.ctx &&
    typeof msg.ctx === 'object' &&
    !Array.isArray(msg.ctx)
  );
}

/** Whether a member may hold the lease (and so open a new document). */
const canHold = (m) => m.role === 'edit' && !m.agent;

export class Room {
  /** `events(type, detail)` hears what webhooks report: joined, left, saved, edited (one per
   * op: { rev, name }), commented, restored. `onIdle(room)`: the room has had nobody in it and
   * nothing to do for `idleEvictMs`, everything on disk; the owner lets it go (a later lookup
   * loads it again). */
  constructor({ id, store, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, limits = {}, events = () => {}, onIdle = null }) {
    this.id = id;
    this.events = events;
    this.onIdle = onIdle;
    this.evictTimer = null;
    /** Set once let go: nothing may use it any more. */
    this.evicted = false;
    this.store = store;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.limits = { ...LIMITS, ...limits };
    /** The latest snapshot: `seen` is the last edit (seq) it holds from each replica, `history`
     * the change spans of the revisions before it (for edits based on an earlier revision).
     * @type {{rev: number, doc: string, seen?: Record<string, number>, history?: object[]} | null} */
    this.snapshot = null;
    this.log = [];
    /** The newest revision on disk: only those are given out (Welcome, Resync, broadcasts). */
    this.durableRev = 0;
    /** The last edit sequenced from each replica, to drop a resent duplicate. */
    this.lastSeq = new Map();
    /** Members in join order (the first editor holds the autosave lease). */
    this.members = new Map();
    /** Members waiting for revision 0 while the first one opens the document. */
    this.waiting = [];
    /** Replicas waiting for a fresh snapshot (`ResyncRequest` with `fresh`). */
    this.freshWaiting = new Set();
    this.bootstrapper = null;
    this.savedRev = 0;
    this.dirtySince = null;
    this.saveTimer = null;
    this.snapshotAskedAt = 0;
    /** The member asked for the next snapshot; only it may send one. */
    this.snapshotFrom = null;
    this.votes = new Map();
    /** Who (sub) made each recent revision, for undo checks. On disk with each op and, for the
     * last `maxHistory` revisions before it, with the snapshot. */
    this.authors = new Map();
    /** The least role that may undo or redo each recent revision ('comment' | 'suggest' |
     * 'edit', see `needs`), kept and stored like `authors`. A revision without one (stored by
     * an older relay) needs 'edit'. */
    this.needed = new Map();
    /** Stored versions without their documents, oldest first. */
    this.versions = [];
    /** The version asked for: { rev, client }. */
    this.versionAsk = null;
    /** Who made each revision since the newest version: [rev, name]. Those the snapshot holds
     * (no longer in the log) are kept in meta.json too, written with the snapshot. */
    this.editedSince = [];
    /** Those entries as last written to meta.json (JSON), to skip writing them unchanged. */
    this.editedKept = '[]';
    /** Edits waiting while a restore's version loads ([member, msg]), or null. */
    this.held = null;
    /** When the last save landed (ISO), or null. */
    this.lastSaved = null;
    /** API requests waiting for the holder's answer, by id. */
    this.asks = new Map();
    this.closedUntil = -Infinity;
  }

  get rev() {
    return (this.snapshot?.rev ?? 0) + this.log.length;
  }

  /** The autosave lease holder: the longest-connected editor that is a person. It alone saves,
   * uploads snapshots and versions, and answers API requests. */
  get holder() {
    for (const m of this.members.values()) if (canHold(m)) return m;
    return null;
  }

  async load() {
    const { snapshot, ops, meta } = await this.store.load(this.id);
    for (const [rev, sub] of Object.entries(snapshot?.authors ?? {})) this.authors.set(Number(rev), sub);
    for (const [rev, role] of Object.entries(snapshot?.needs ?? {})) if (Object.hasOwn(MAY_UNDO, role)) this.needed.set(Number(rev), role);
    if (snapshot) {
      delete snapshot.authors;
      delete snapshot.needs;
    }
    this.snapshot = snapshot;
    this.log = ops.map(({ sub, needs, ...o }) => {
      if (typeof sub === 'string') this.authors.set(o.rev, sub);
      if (Object.hasOwn(MAY_UNDO, needs)) this.needed.set(o.rev, needs);
      return o;
    });
    this.durableRev = this.rev;
    this.savedRev = Math.min(meta?.savedRev ?? 0, this.rev);
    this.lastSaved = meta?.lastSaved ?? null;
    for (const [client, seq] of Object.entries(snapshot?.seen ?? {})) this.lastSeq.set(client, seq);
    for (const o of ops) this.lastSeq.set(o.client, o.seq);
    this.versions = await this.store.loadVersions(this.id);
    const newest = this.versions.at(-1)?.rev ?? 0;
    // Those the snapshot holds from meta.json (none in one an older relay wrote), the rest from
    // the log: no revision from both.
    const base = snapshot?.rev ?? 0;
    const kept = (Array.isArray(meta?.editedSince) ? meta.editedSince : []).filter((p) => isEdited(p) && p[0] > newest && p[0] <= base);
    this.editedKept = JSON.stringify(kept);
    this.editedSince = [...kept, ...this.log.filter((o) => o.rev > newest).map((o) => [o.rev, o.user])];
    // Loaded for a lookup, maybe, with nobody coming.
    this.idleCountdown();
  }

  /** Whether the room has nobody in it and nothing to finish: no API request waiting, no
   * restore loading, joins not being refused, and everything written to disk. */
  idle() {
    return this.members.size === 0 && this.asks.size === 0 && !this.held && this.now() >= this.closedUntil && this.store.idle?.(this.id) !== false;
  }

  /** Start (again) counting down to letting the room go, when nobody is in it. */
  idleCountdown() {
    if (!this.onIdle || this.evicted || this.members.size) return;
    this.clearTimer(this.evictTimer);
    this.evictTimer = this.setTimer(() => this.evictIfIdle(), Math.max(this.limits.idleEvictMs, this.closedUntil - this.now()));
    this.evictTimer?.unref?.();
  }

  evictIfIdle() {
    this.evictTimer = null;
    if (this.members.size) return;
    // Something still to finish (writes landing, say): look again later.
    if (!this.idle()) return this.idleCountdown();
    this.evicted = true;
    for (const t of [this.saveTimer, this.freshTimer]) this.clearTimer(t);
    this.saveTimer = this.freshTimer = null;
    this.store.forget?.(this.id);
    this.onIdle(this);
  }

  flush() {
    return this.store.flush(this.id);
  }

  /** The durable part of the log after `rev`. */
  durableAfter(rev) {
    return this.log.filter((o) => o.rev > rev && o.rev <= this.durableRev);
  }

  /** A member arrives. `haveRev`: the revision a reconnecting replica already has. */
  join(member, haveRev) {
    if (this.now() < this.closedUntil) {
      member.close(4410, 'This document was closed');
      return;
    }
    const old = this.members.get(member.client);
    if (old && old.sub !== member.sub) {
      member.close(4400, 'That client id belongs to someone else');
      return;
    }
    if (!old && this.members.size >= this.limits.members) {
      member.close(4409, 'This document has too many people in it');
      return;
    }
    if (old) old.close(4000, 'Replaced by a newer connection');
    this.clearTimer(this.evictTimer);
    this.evictTimer = null;
    member.bucket = { tokens: this.limits.opsPerSecond, at: this.now() };
    member.presenceBucket = { tokens: this.limits.presencePerSecond, at: this.now() };
    member.resyncAt = -Infinity;
    member.color = old ? old.color : this.freeColor();
    member.sel = old?.sel;
    member.selRev = old?.selRev;
    this.members.set(member.client, member);
    if (!old) {
      this.broadcast({ t: 'Join', client: member.client, user: member.user, color: member.color }, member.client);
      this.events('joined', { sub: member.sub, name: member.user, role: member.role, ...(member.agent ? { agent: true } : {}) });
    }
    if (!this.snapshot) {
      if ((this.bootstrapper && this.bootstrapper !== member.client) || !canHold(member)) {
        this.waiting.push(member.client);
        return;
      }
      this.bootstrap(member);
      return;
    }
    this.welcome(member, haveRev);
    // Revisions nobody saved yet (the last person left, or the relay restarted) are saved now.
    if (this.rev > this.savedRev && !this.saveTimer) this.scheduleSave();
  }

  /** `member` opens the document (there is none yet); revision 0 is its snapshot. */
  bootstrap(member) {
    this.bootstrapper = member.client;
    member.send({ t: 'Welcome', rev: 0, snapshot: null, ops: [], you: member.client, peers: this.peersOf(member.client), role: member.role });
  }

  /** The lowest palette index no present member uses. */
  freeColor() {
    const used = new Set([...this.members.values()].map((m) => m.color));
    for (let i = 0; i < PALETTE_SIZE; i++) if (!used.has(i)) return i;
    return this.members.size % PALETTE_SIZE;
  }

  /** Send to every member but `except`. */
  broadcast(msg, except) {
    for (const m of this.members.values()) if (m.client !== except) m.send(msg);
  }

  /** How a member is described to the others (`t` set for a message, left out in a list). */
  peerOf(m, t) {
    const peer = { client: m.client, user: m.user, color: m.color };
    if (m.sel) peer.sel = m.sel;
    if (m.sel && m.selRev !== undefined) peer.rev = m.selRev;
    return t ? { t, ...peer } : peer;
  }

  /** The other members as a Welcome lists them. */
  peersOf(client) {
    return [...this.members.values()].filter((m) => m.client !== client).map((m) => this.peerOf(m));
  }

  welcome(member, haveRev) {
    const base = this.snapshot?.rev ?? 0;
    if (Number.isInteger(haveRev) && haveRev >= base && haveRev <= this.durableRev) {
      member.send({ t: 'Welcome', rev: haveRev, snapshot: null, ops: this.durableAfter(haveRev), you: member.client, peers: this.peersOf(member.client), role: member.role });
    } else {
      member.send({ t: 'Welcome', ...this.fromSnapshot(member), you: member.client, peers: this.peersOf(member.client), role: member.role });
    }
  }

  /** The snapshot and what a replica needs with it. */
  fromSnapshot(member) {
    return {
      rev: this.snapshot.rev,
      snapshot: this.snapshot.doc,
      ops: this.durableAfter(this.snapshot.rev),
      seen: this.snapshot.seen?.[member.client] ?? 0,
      history: this.snapshot.history ?? [],
    };
  }

  /** A member's connection closed. With `member`, only if it is still that connection (a
   * reconnect may have replaced it). */
  leave(client, member) {
    if (member && this.members.get(client) !== member) return;
    const gone = this.members.get(client);
    if (!this.members.delete(client)) return;
    this.broadcast({ t: 'Leave', client });
    this.events('left', { sub: gone.sub, name: gone.user });
    this.waiting = this.waiting.filter((c) => c !== client);
    if (this.snapshotFrom === client) {
      this.snapshotFrom = null;
      this.answerFresh();
    }
    if (this.bootstrapper === client && !this.snapshot) {
      this.bootstrapper = null;
      const next = this.waiting.find((c) => canHold(this.members.get(c)));
      if (next) {
        this.waiting = this.waiting.filter((c) => c !== next);
        this.bootstrap(this.members.get(next));
      }
    }
    for (const [id, ask] of this.asks) {
      if (ask.client === client) this.settle(id, new ApiError(504, 'The editor left before answering'));
    }
    if (this.members.size === 0) {
      this.clearTimer(this.saveTimer);
      this.saveTimer = null;
      this.idleCountdown();
    }
  }

  message(client, msg) {
    const member = this.members.get(client);
    if (!member || !msg || typeof msg.t !== 'string') return;
    // Presence has its own allowance: too much is dropped, never a reason to disconnect.
    if (msg.t === 'Presence') return this.presence(member, msg);
    if (!this.take(member.bucket, this.limits.opsPerSecond)) {
      member.close(4429, 'Too many messages per second');
      this.leave(member.client, member);
      return;
    }
    switch (msg.t) {
      case 'Op':
        return this.op(member, msg);
      case 'Snapshot':
        return this.takeSnapshot(member, msg);
      case 'Hash':
        return this.vote(member, msg);
      case 'Saved':
        if (member.role !== 'edit') return;
        if (Number.isInteger(msg.rev) && msg.rev > this.savedRev) {
          this.savedRev = Math.min(msg.rev, this.rev);
          this.lastSaved = new Date(this.now()).toISOString();
          this.writeMeta();
          this.events('saved', { rev: this.savedRev });
          if (member === this.holder) this.askVersion(member, this.savedRev);
        }
        return;
      case 'Version':
        return this.takeVersion(member, msg);
      case 'Versions':
        return member.send({ t: 'VersionList', versions: [...this.versions].reverse().map(({ rev, at, users }) => ({ rev, at, users })) });
      case 'GetVersion':
        return this.sendVersion(member, msg.rev);
      case 'Exported':
      case 'RunResult':
        return this.answer(member, msg);
      case 'ResyncRequest':
        return msg.fresh === true ? this.freshResync(member) : this.resync(member);
    }
  }

  /** Where this person is: forwarded, kept for newcomers, never logged. `rev`: the confirmed
   * revision the selection is relative to, one the relay has stored. */
  presence(member, msg) {
    if (!validSel(msg.sel) || !isCount(msg.rev) || msg.rev > this.durableRev) return;
    if (!this.take(member.presenceBucket, this.limits.presencePerSecond)) return;
    member.sel = cleanSel(msg.sel);
    member.selRev = msg.rev;
    this.broadcast(this.peerOf(member, 'Presence'), member.client);
  }

  /** Why `member` may not make edit `msg`, or null when it may. */
  refusal(member, msg) {
    if (member.role === 'view') return REFUSED.view;
    if (member.role === 'suggest') {
      // Comments, and edits the engine records whole as suggestions, tracked (`ctx.track`); no restores.
      const allowed =
        msg.kind === 'undo' ||
        msg.kind === 'redo' ||
        (msg.kind === 'cmd' && (COMMENT_COMMANDS.has(msg.cmd) || (msg.ctx?.track === true && SUGGEST_COMMANDS.has(msg.cmd))));
      if (!allowed) return REFUSED.suggest;
    }
    if (member.role === 'comment') {
      const allowed = msg.kind === 'cmd' ? COMMENT_COMMANDS.has(msg.cmd) : msg.kind === 'undo' || msg.kind === 'redo';
      if (!allowed) return REFUSED.comment;
    }
    if (msg.kind === 'undo' || msg.kind === 'redo') {
      // `target`, and `more`: the rest of a run of typing undone as one step.
      const more = msg.params?.more ?? [];
      if (!Array.isArray(more) || more.length > 1000) return 'There is no such change to undo';
      for (const target of [msg.params?.target, ...more]) {
        if (!Number.isSafeInteger(target) || target < 1 || target > this.rev) return 'There is no such change to undo';
        if (this.authors.get(target) !== member.sub) return 'You can only undo your own changes';
        // By the role they have now: someone who edited and now only comments can't take
        // their old edits back (or bring them back).
        if (!MAY_UNDO[member.role]?.has(this.needed.get(target) ?? 'edit')) return REFUSED[member.role] ?? REFUSED.view;
      }
    }
    return null;
  }

  /** The least role that may undo or redo `msg` (an allowed op): 'comment' for a comment
   * command, 'suggest' for a tracked suggest command, else 'edit'; an undo or redo needs what
   * the most any of its targets needs (so a redo of an undone comment is still a comment). */
  needs(msg) {
    if (msg.kind === 'cmd') {
      if (COMMENT_COMMANDS.has(msg.cmd)) return 'comment';
      return msg.ctx?.track === true && SUGGEST_COMMANDS.has(msg.cmd) ? 'suggest' : 'edit';
    }
    if (msg.kind === 'undo' || msg.kind === 'redo') {
      const all = [msg.params?.target, ...(msg.params?.more ?? [])].map((t) => this.needed.get(t) ?? 'edit');
      return all.includes('edit') ? 'edit' : all.includes('suggest') ? 'suggest' : 'comment';
    }
    return 'edit';
  }

  op(member, msg) {
    if (!this.snapshot) return;
    // While a restore's version loads, later edits wait so they are sequenced after it.
    if (this.held) {
      this.held.push([member, msg]);
      return;
    }
    if (!wellFormed(msg) || msg.base > this.rev) return;
    // A resent edit the relay already has (a reconnect raced its echo).
    if (msg.seq <= (this.lastSeq.get(member.client) ?? 0)) return;
    const reason = this.refusal(member, msg);
    if (reason) {
      member.send({ t: 'Refused', seq: msg.seq, reason });
      return;
    }
    this.lastSeq.set(member.client, msg.seq);
    if (msg.kind === 'restore') return this.restore(member, msg);
    this.sequence(member, msg);
  }

  /** An editor restores a version: the op carries the version's document (`params.doc`). */
  restore(member, msg) {
    const version = msg.params?.version;
    const refuse = () => member.send({ t: 'Refused', seq: msg.seq, reason: 'That version is no longer available' });
    if (!Number.isSafeInteger(version) || !this.versions.some((v) => v.rev === version)) return refuse();
    // The document it replaces is kept as a version first (the holder's copy, asked before the
    // restore reaches it).
    const holder = this.holder;
    if (holder && this.durableRev > (this.versions.at(-1)?.rev ?? 0)) {
      this.versionAsk = { rev: this.durableRev, client: holder.client, at: this.now() };
      holder.send({ t: 'VersionRequest', rev: this.durableRev });
    }
    this.held = [];
    this.store.readVersion(this.id, version).then((v) => {
      if (typeof v?.doc === 'string') {
        const op = this.sequence(member, { ...msg, params: { ...msg.params, version, doc: v.doc } });
        op.durable.then(() => {
          this.events('restored', { rev: op.rev, version });
          // The restore carries a whole document: a snapshot after it takes it out of the log,
          // so what newcomers and resyncs are sent stays small.
          const source = this.holder ?? (this.members.get(member.client) === member ? member : null);
          if (source && !this.snapshotFrom) {
            this.snapshotAskedAt = this.rev;
            this.snapshotFrom = source.client;
            source.send({ t: 'SnapshotRequest' });
          }
        });
      } else {
        refuse();
      }
      const held = this.held;
      this.held = null;
      while (held.length && !this.held) this.op(...held.shift());
      if (this.held) this.held.unshift(...held);
    });
  }

  /** Give an allowed edit the next revision; broadcast it once it is on disk. */
  sequence(member, msg) {
    const { t: _t, rev: _rev, user: _user, ...fields } = msg;
    const op = { t: 'Op', ...fields, client: member.client, rev: this.rev + 1, user: member.user };
    const needs = this.needs(msg);
    this.log.push(op);
    this.authors.set(op.rev, member.sub);
    this.needed.set(op.rev, needs);
    this.editedSince.push([op.rev, op.user]);
    // Broadcast only once the op is on disk: a relay that crashes and restarts never forgets an
    // edit somebody already has. Ops reach the disk, and so everyone, in revision order.
    const durable = this.store.append(this.id, { ...op, sub: member.sub, needs }).then(() => {
      this.durableRev = Math.max(this.durableRev, op.rev);
      for (const m of this.members.values()) m.send(op);
      this.events('edited', { rev: op.rev, name: op.user });
      const action = op.kind === 'cmd' && Object.hasOwn(COMMENT_ACTIONS, op.cmd) && COMMENT_ACTIONS[op.cmd];
      if (action) this.events('commented', { action, by: op.user, rev: op.rev });
    });
    this.scheduleSave();
    if (this.rev - (this.snapshot?.rev ?? 0) >= this.limits.snapshotEvery && this.snapshotAskedAt < this.rev - this.limits.snapshotEvery + 1) {
      const holder = this.holder;
      if (holder) {
        this.snapshotAskedAt = this.rev;
        this.snapshotFrom = holder.client;
        holder.send({ t: 'SnapshotRequest' });
      }
    }
    return { rev: op.rev, durable };
  }

  /** Token bucket for every message: `opsPerSecond`, bursting to the same number. */
  /** One message from token bucket `b`, refilled at `perSecond`. */
  take(b, perSecond) {
    const now = this.now();
    b.tokens = Math.min(perSecond, b.tokens + ((now - b.at) / 1000) * perSecond);
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
      this.snapshot = { rev: 0, doc: msg.doc, seen: {}, history: [] };
      this.writeSnapshot();
      for (const c of this.waiting.splice(0)) {
        const m = this.members.get(c);
        if (m) this.welcome(m);
      }
      return;
    }
    // Only the member asked, once, and only a revision it can have.
    if (member.client !== this.snapshotFrom) return;
    this.snapshotFrom = null;
    if (msg.rev <= this.snapshot.rev || msg.rev > this.durableRev) return this.answerFresh();
    const history = Array.isArray(msg.history) ? msg.history.slice(-this.limits.maxHistory) : [];
    const seen = { ...this.snapshot.seen };
    for (const o of this.log) if (o.rev <= msg.rev) seen[o.client] = o.seq;
    this.log = this.log.filter((o) => o.rev > msg.rev);
    this.snapshot = { rev: msg.rev, doc: msg.doc, seen, history };
    this.writeSnapshot();
    this.answerFresh();
  }

  /** Resync the replicas waiting for a fresh snapshot from the one there is now. */
  answerFresh() {
    this.clearTimer(this.freshTimer);
    this.freshTimer = null;
    for (const c of this.freshWaiting) {
      const m = this.members.get(c);
      if (m && this.snapshot) {
        m.resyncAt = this.now();
        m.send({ t: 'Resync', ...this.fromSnapshot(m) });
      }
    }
    this.freshWaiting.clear();
  }

  /** The entries of `editedSince` meta.json keeps: those the snapshot holds, compacted. */
  editedToKeep() {
    const base = this.snapshot?.rev ?? 0;
    return compactEdited(this.editedSince.filter(([rev]) => rev <= base), this.limits.maxEditedKept);
  }

  /** Store the last save and who edited since the newest version in revisions the snapshot
   * holds (the log has the rest). */
  writeMeta() {
    const edited = this.editedToKeep();
    this.editedKept = JSON.stringify(edited);
    this.store.writeMeta(this.id, { savedRev: this.savedRev, lastSaved: this.lastSaved, editedSince: edited });
  }

  /** Store the snapshot with who made the revisions before it, and the log after it. */
  writeSnapshot() {
    const rev = this.snapshot.rev;
    // Who made the revisions leaving the log goes to meta.json first: a crash between the two
    // writes leaves them in both, never in neither.
    if (JSON.stringify(this.editedToKeep()) !== this.editedKept) this.writeMeta();
    for (const r of this.authors.keys()) if (r <= rev - this.limits.maxHistory) this.authors.delete(r);
    for (const r of this.needed.keys()) if (r <= rev - this.limits.maxHistory) this.needed.delete(r);
    const authors = {};
    for (const [r, sub] of this.authors) if (r <= rev) authors[r] = sub;
    const needs = {};
    for (const [r, role] of this.needed) if (r <= rev) needs[r] = role;
    const ops = this.log.map((o) => ({ ...o, sub: this.authors.get(o.rev), needs: this.needed.get(o.rev) }));
    this.store.writeSnapshot(this.id, { ...this.snapshot, authors, needs }, ops);
  }

  /** Everyone here, as the HTTP API lists them. */
  people() {
    return [...this.members.values()].map((m) => ({ client: m.client, sub: m.sub, name: m.user, role: m.role, color: m.color }));
  }

  /** Ask the lease holder's replica `msg` (Export or Run) for the HTTP API; resolves with its
   * answer. No holder: 409. No answer in `timeoutMs`: 504 (no other editor is tried). */
  ask(msg, timeoutMs) {
    const holder = this.holder;
    if (!holder) return Promise.reject(new ApiError(409, 'No editor has this document open'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => this.settle(id, new ApiError(504, 'The editor did not answer in time')), timeoutMs);
      this.asks.set(id, { client: holder.client, answer: ANSWERS[msg.t], resolve, reject, timer });
      holder.send({ ...msg, id });
    });
  }

  answer(member, msg) {
    const ask = this.asks.get(msg.id);
    if (ask && ask.client === member.client && ask.answer === msg.t) this.settle(msg.id, null, msg);
  }

  settle(id, error, value) {
    const ask = this.asks.get(id);
    if (!ask) return;
    this.asks.delete(id);
    this.clearTimer(ask.timer);
    if (error) ask.reject(error);
    else ask.resolve(value);
    if (!this.members.size) this.idleCountdown();
  }

  /** Close the connections of everyone `which` picks with `code`; how many. */
  closeWhere(which, code, reason) {
    const gone = [...this.members.values()].filter(which);
    for (const m of gone) {
      m.close(code, reason);
      this.leave(m.client, m);
    }
    return gone.length;
  }

  /** Remove a user (every connection of theirs). */
  kick(sub) {
    return this.closeWhere((m) => m.sub === sub, 4403, 'Removed from this document');
  }

  /** Close the document for everyone, refusing joins for 10 s. */
  closeAll() {
    this.closedUntil = this.now() + CLOSED_FOR_MS;
    return this.closeWhere(() => true, 4410, 'This document was closed');
  }

  /** A save at `rev` landed: keep it as a version when there is none yet, the newest is 10
   * minutes old, or the holder is the last editor here (the session is ending). */
  askVersion(holder, rev) {
    const newest = this.versions.at(-1);
    if (newest && rev <= newest.rev) return;
    const othersEditing = [...this.members.values()].some((m) => m !== holder && m.role === 'edit');
    if (newest && this.now() - Date.parse(newest.at) < this.limits.versionEveryMs && othersEditing) return;
    // A request still waiting (the document a restore replaces, say) isn't replaced.
    if (this.versionAsk && this.now() - this.versionAsk.at < this.limits.versionWaitMs) return;
    this.versionAsk = { rev, client: holder.client, at: this.now() };
    holder.send({ t: 'VersionRequest', rev });
  }

  takeVersion(member, msg) {
    const ask = this.versionAsk;
    // The document at the revision asked for or later: others may have edited since the save.
    if (!ask || ask.client !== member.client || !Number.isSafeInteger(msg.rev) || msg.rev < ask.rev || msg.rev > this.durableRev) return;
    if (typeof msg.doc !== 'string') return;
    this.versionAsk = null;
    ask.rev = msg.rev;
    const users = [...new Set(this.editedSince.filter(([rev]) => rev <= ask.rev).map(([, name]) => name))];
    this.editedSince = this.editedSince.filter(([rev]) => rev > ask.rev);
    const version = { rev: ask.rev, at: new Date(this.now()).toISOString(), users, doc: msg.doc };
    const all = [...this.versions, { rev: version.rev, at: version.at, users }];
    this.versions = thinVersions(all, this.now(), this.limits.maxVersions);
    const drop = all.filter((v) => !this.versions.includes(v)).map((v) => v.rev);
    this.store.writeVersion(this.id, version, drop, this.versions);
  }

  /** Answer GetVersion; answers go out in the order asked. */
  sendVersion(member, rev) {
    if (!Number.isSafeInteger(rev)) return;
    const known = this.versions.some((x) => x.rev === rev);
    this.reads = (this.reads ?? Promise.resolve()).then(async () => {
      const v = known ? await this.store.readVersion(this.id, rev) : null;
      member.send({ t: 'VersionDoc', rev, doc: typeof v?.doc === 'string' ? v.doc : null });
    });
  }

  /** A replica that can't apply an edit from what the stored snapshot holds (an undo of an
   * edit from before it joined): another editor's replica uploads a snapshot now (the holder's,
   * unless it is the one asking), then it starts again from that. Only right after an undo or
   * redo, at most once per `resyncEveryMs` each; without another editor to ask, or no answer
   * within `freshWaitMs`, the stored snapshot. */
  freshResync(member) {
    if (this.now() - member.resyncAt < this.limits.resyncEveryMs) return;
    const undone = this.log.some((o) => o.kind === 'undo' || o.kind === 'redo');
    const others = [...this.members.values()].filter((m) => m !== member && canHold(m));
    const source = others.includes(this.holder) ? this.holder : others[0];
    if (!undone || !source) {
      if (undone) console.warn(`relay: ${this.id}: no other editor to send ${member.client} a fresh snapshot; resyncing from the stored one`);
      return this.resync(member);
    }
    member.resyncAt = this.now();
    this.freshWaiting.add(member.client);
    if (this.snapshotFrom) return;
    this.snapshotAskedAt = this.rev;
    this.snapshotFrom = source.client;
    source.send({ t: 'SnapshotRequest' });
    this.clearTimer(this.freshTimer);
    this.freshTimer = this.setTimer(() => {
      if (!this.freshWaiting.size) return;
      console.warn(`relay: ${this.id}: no fresh snapshot came; resyncing from the stored one`);
      this.snapshotFrom = null;
      this.answerFresh();
    }, this.limits.freshWaitMs);
  }

  resync(member) {
    if (!this.snapshot) return;
    const now = this.now();
    if (now - member.resyncAt < this.limits.resyncEveryMs) return;
    member.resyncAt = now;
    member.send({ t: 'Resync', ...this.fromSnapshot(member) });
  }

  /** Compare fingerprints at a checkpoint revision, one vote per user: whoever disagrees with
   * the majority (on a tie, with the lease holder) starts again from the snapshot. */
  vote(member, msg) {
    if (!Number.isInteger(msg.rev) || typeof msg.h !== 'string' || msg.h.length > 64) return;
    if (msg.rev <= 0 || msg.rev > this.rev || msg.rev % this.limits.hashEvery !== 0) return;
    let votes = this.votes.get(msg.rev);
    if (!votes) {
      votes = { hashes: new Map(), clients: new Map(), resynced: new Set() };
      this.votes.set(msg.rev, votes);
      for (const r of this.votes.keys()) if (r < this.rev - 10 * this.limits.hashEvery) this.votes.delete(r);
    }
    if (votes.hashes.has(member.sub)) return;
    votes.hashes.set(member.sub, msg.h);
    votes.clients.set(member.sub, member.client);
    if (votes.hashes.size < 2) return;
    const counts = new Map();
    for (const h of votes.hashes.values()) counts.set(h, (counts.get(h) || 0) + 1);
    const top = Math.max(...counts.values());
    const leaders = [...counts.entries()].filter(([, n]) => n === top).map(([h]) => h);
    const holderHash = this.holder && votes.hashes.get(this.holder.sub);
    const winner = leaders.length === 1 ? leaders[0] : leaders.includes(holderHash) ? holderHash : leaders[0];
    for (const [sub, h] of votes.hashes) {
      if (h !== winner && !votes.resynced.has(sub)) {
        votes.resynced.add(sub);
        const m = this.members.get(votes.clients.get(sub));
        if (m) {
          console.warn(`relay: ${this.id}: replica ${m.client} diverged at rev ${msg.rev}; resyncing`);
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
