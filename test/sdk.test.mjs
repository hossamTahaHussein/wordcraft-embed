// The SDK's co-editing plumbing, with a fake page, iframe and WebSocket.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN = 'http://localhost:8080';

/** A fake browser page: one window that hears `message` events, and iframes it records. */
function fakePage() {
  const handlers = { message: [], beforeunload: [], visibilitychange: [] };
  const frames = [];
  globalThis.location = new URL(`${ORIGIN}/collab.html`);
  globalThis.window = {
    addEventListener: (t, h) => handlers[t]?.push(h),
    removeEventListener: (t, h) => (handlers[t] = (handlers[t] || []).filter((x) => x !== h)),
  };
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: (t, h) => handlers[t]?.push(h),
    removeEventListener: () => {},
    querySelector: () => container,
    createElement: () => {
      const posted = [];
      const frame = {
        style: {},
        setAttribute() {},
        remove() {},
        focus() {},
        posted,
        contentWindow: { postMessage: (data) => posted.push(data) },
      };
      frames.push(frame);
      return frame;
    },
  };
  const container = { appendChild() {} };
  return {
    frames,
    /** A message from the editor iframe to the page. */
    fromEditor(data, frame = frames[0]) {
      for (const h of handlers.message) h({ origin: ORIGIN, source: frame.contentWindow, data });
    },
    hide() {
      globalThis.document.visibilityState = 'hidden';
      for (const h of handlers.visibilitychange) h();
    },
    unload(event) {
      for (const h of handlers.beforeunload) h(event);
    },
  };
}

/** A fake WebSocket class that records every instance. */
function fakeSockets() {
  const made = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.readyState = 0;
      made.push(this);
    }
    send(m) {
      this.sent.push(JSON.parse(m));
    }
    close() {
      this.readyState = 3;
    }
    // test helpers
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    relay(msg) {
      this.onmessage?.({ data: JSON.stringify(msg) });
    }
    drop(code = 1006) {
      this.readyState = 3;
      this.onclose?.({ code, reason: '' });
    }
  }
  FakeWS.OPEN = 1;
  return { FakeWS, made };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let WordCraftEditor;
beforeEach(async () => {
  ({ WordCraftEditor } = await import('../src/wordcraft-embed.js'));
});

async function setup(collab = {}, options = {}) {
  const page = fakePage();
  const { FakeWS, made } = fakeSockets();
  const editor = new WordCraftEditor('#e', {
    src: '/wordcraft/',
    readyTimeout: 5000,
    document: new Uint8Array([1, 2, 3]),
    documentName: 'report.docx',
    collab: { url: 'ws://localhost:8080/relay', token: 'tok-1', WebSocket: FakeWS, retryMs: [5, 20], ...collab },
    ...options,
  });
  page.fromEditor({ type: 'wordcraft:ready', version: '0.12.0' });
  await tick();
  return { page, made, editor, frame: page.frames[0] };
}

test('the editor url asks for co-editing and names the document', async () => {
  const { frame, editor } = await setup();
  const url = new URL(frame.src);
  assert.equal(url.searchParams.get('collab'), '1');
  assert.equal(url.searchParams.get('docName'), 'report.docx');
  editor.destroy();
});

test('forwards relay to iframe and back', async () => {
  const { made, frame, page, editor } = await setup();
  assert.equal(made.length, 1);
  const ws = made[0];
  assert.equal(ws.url, 'ws://localhost:8080/relay');
  ws.open();
  await tick();
  const hello = ws.sent[0];
  assert.equal(hello.t, 'hello');
  assert.equal(hello.token, 'tok-1');
  assert.match(hello.client, /^[A-Za-z0-9_-]{1,64}$/);
  ws.relay({ t: 'Welcome', rev: 3, snapshot: '{}', ops: [], you: hello.client });
  const toFrame = frame.posted.find((m) => m.type === 'wordcraft:collab');
  assert.equal(JSON.parse(toFrame.msg).t, 'Welcome');
  page.fromEditor({ type: 'wordcraft:collab', msg: JSON.stringify({ t: 'Op', seq: 1 }) });
  assert.deepEqual(ws.sent.at(-1), { t: 'Op', seq: 1 });
  editor.destroy();
});

test('only the first person opens the document', async () => {
  const first = await setup();
  first.made[0].open();
  first.made[0].relay({ t: 'Welcome', rev: 0, snapshot: null, ops: [], you: 'c' });
  await tick();
  assert.ok(first.frame.posted.some((m) => m.type === 'wordcraft:open' && m.name === 'report.docx'));
  first.editor.destroy();

  const joiner = await setup();
  joiner.made[0].open();
  joiner.made[0].relay({ t: 'Welcome', rev: 9, snapshot: '{}', ops: [], you: 'c' });
  await tick();
  assert.equal(joiner.frame.posted.some((m) => m.type === 'wordcraft:open'), false);
  joiner.editor.destroy();
});

test('reconnect says which revision it has and resends nothing itself', async () => {
  const { made, page, editor } = await setup();
  made[0].open();
  await tick();
  page.fromEditor({ type: 'wordcraft:collab.status', pending: 1, rev: 7 });
  page.fromEditor({ type: 'wordcraft:collab', msg: JSON.stringify({ t: 'Op', seq: 2 }) });
  made[0].drop();
  await tick(30);
  assert.equal(made.length, 2, 'reconnected');
  made[1].open();
  await tick();
  assert.equal(made[1].sent.length, 1);
  assert.deepEqual([made[1].sent[0].t, made[1].sent[0].haveRev], ['hello', 7]);
  assert.equal(made[1].sent[0].client, made[0].sent[0].client, 'same replica id');
  editor.destroy();
});

test('token function called on each connect', async () => {
  let n = 0;
  const { made, editor } = await setup({ token: async () => `t${++n}` });
  made[0].open();
  await tick();
  assert.equal(made[0].sent[0].token, 't1');
  made[0].drop();
  await tick(30);
  made[1].open();
  await tick();
  assert.equal(made[1].sent[0].token, 't2');
  editor.destroy();
});

test('a refused token stops reconnecting and reports an error', async () => {
  const errors = [];
  const { made, editor } = await setup({}, { onError: (e) => errors.push(e.message) });
  made[0].open();
  made[0].drop(4401);
  await tick(50);
  assert.equal(made.length, 1);
  assert.match(errors.join(), /not allowed/i);
  editor.destroy();
});

test('collab status events carry connection and pending edits', async () => {
  const seen = [];
  const { made, page, editor } = await setup();
  editor.addEventListener('collab', (e) => seen.push({ ...e.detail }));
  made[0].open();
  await tick();
  page.fromEditor({ type: 'wordcraft:collab.status', pending: 2, rev: 4 });
  assert.deepEqual(seen.at(-1), { connected: true, pending: 2, rev: 4 });
  made[0].drop();
  assert.equal(seen.at(-1).connected, false);
  editor.destroy();
});

test('hiding the page never makes this copy save over the shared file', async () => {
  const { page, frame, editor } = await setup();
  page.fromEditor({ type: 'wordcraft:dirty', dirty: true });
  page.hide();
  assert.equal(frame.posted.some((m) => m.type === 'wordcraft:collab' && JSON.parse(m.msg).t === 'Save'), false);
  editor.destroy();
});

test('co-editing warns before leaving only while edits are unsynced', async () => {
  const { page, editor } = await setup();
  const leave = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    page.unload(event);
    return event.prevented;
  };
  page.fromEditor({ type: 'wordcraft:dirty', dirty: true });
  assert.equal(leave(), false, 'dirty but synced: the autosaver saves it');
  page.fromEditor({ type: 'wordcraft:collab.status', pending: 2, rev: 4 });
  assert.equal(leave(), true);
  editor.destroy();
});

test('cross-origin src still throws', async () => {
  fakePage();
  assert.throws(() => new WordCraftEditor('#e', { src: 'https://elsewhere.example/wordcraft/' }), /same origin|origin/i);
});
