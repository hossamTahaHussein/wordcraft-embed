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
    /** A message from another origin (a page that is not the editor). */
    fromOtherOrigin(data, frame = frames[0]) {
      for (const h of handlers.message) h({ origin: 'http://evil.example', source: frame.contentWindow, data });
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
    drop(code = 1006, reason = '') {
      this.readyState = 3;
      this.onclose?.({ code, reason });
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
  const toFrame = frame.posted.filter((m) => m.type === 'wordcraft:collab').map((m) => JSON.parse(m.msg));
  assert.deepEqual(toFrame[0], { t: 'Connection', online: true }, 'the editor knows it is connected');
  assert.equal(toFrame[1].t, 'Welcome');
  page.fromEditor({ type: 'wordcraft:collab', msg: JSON.stringify({ t: 'Op', seq: 1 }) });
  assert.deepEqual(ws.sent.at(-1), { t: 'Op', seq: 1 });
  ws.drop(1006);
  assert.deepEqual(JSON.parse(frame.posted.filter((m) => m.type === 'wordcraft:collab').at(-1).msg), { t: 'Connection', online: false });
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

for (const [code, reason, message] of [
  [4403, 'Removed from this document', 'Removed from this document'],
  [4403, '', 'Not allowed in this document'],
  [4410, 'This document was closed', 'This document was closed'],
  [4410, '', 'This document was closed'],
]) {
  test(`close ${code} "${reason}" reports "${message}" and does not reconnect`, async () => {
    const errors = [];
    const { made, editor } = await setup({}, { onError: (e) => errors.push(e) });
    made[0].open();
    made[0].drop(code, reason);
    await tick(50);
    assert.equal(made.length, 1);
    assert.deepEqual(errors.map((e) => [e.message, e.code]), [[message, code]]);
    editor.destroy();
  });
}

test('collab status events carry connection and pending edits', async () => {
  const seen = [];
  const { made, page, editor } = await setup();
  editor.addEventListener('collab', (e) => seen.push({ ...e.detail }));
  made[0].open();
  await tick();
  page.fromEditor({ type: 'wordcraft:collab.status', pending: 2, rev: 4 });
  assert.deepEqual(seen.at(-1), { connected: true, pending: 2, rev: 4, people: 1 });
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

test('collab status carries how many people are in the document', async () => {
  const seen = [];
  const { made, page, editor } = await setup();
  editor.addEventListener('collab', (e) => seen.push({ ...e.detail }));
  made[0].open();
  await tick();
  page.fromEditor({ type: 'wordcraft:collab.status', pending: 0, rev: 3, people: 4 });
  assert.equal(seen.at(-1).people, 4);
  editor.destroy();
});

test('a language option sets the interface language', async () => {
  const { frame, editor } = await setup({}, { language: 'ar' });
  assert.equal(new URL(frame.src).searchParams.get('lang'), 'ar');
  editor.destroy();
});

// The JavaScript API: calls over `wordcraft:call` / `wordcraft:result`, events over `wordcraft:event`.

function plain(options = {}) {
  const page = fakePage();
  const editor = new WordCraftEditor('#e', { src: '/wordcraft/', readyTimeout: 5000, guardUnload: false, ...options });
  const frame = page.frames[0];
  const ready = () => page.fromEditor({ type: 'wordcraft:ready', version: '0.12.0' });
  const calls = () => frame.posted.filter((m) => m.type === 'wordcraft:call');
  const reply = (call, fields) => page.fromEditor({ type: 'wordcraft:result', id: call.id, ...fields });
  return { page, editor, frame, ready, calls, reply };
}

test('calls_wait_for_ready', async () => {
  const { editor, ready, calls, reply } = plain();
  const text = editor.getText();
  await tick();
  assert.equal(calls().length, 0, 'nothing is sent before the editor is ready');
  ready();
  await tick();
  assert.deepEqual(calls().map((c) => [c.method, c.params]), [['getText', {}]]);
  reply(calls()[0], { ok: true, result: { text: 'Hi' } });
  assert.equal(await text, 'Hi');
});

test('each method sends its call', async () => {
  const { editor, ready, calls, reply } = plain();
  ready();
  await tick();
  const pending = [
    editor.run('format.bold', { value: true }),
    editor.inspect(),
    editor.insertText('Hello'),
    editor.select('Hello'),
    editor.setReadOnly(true),
  ];
  await tick();
  assert.deepEqual(
    calls().map((c) => [c.method, c.params]),
    [
      ['run', { command: 'format.bold', params: { value: true } }],
      ['inspect', {}],
      ['insertText', { text: 'Hello' }],
      ['select', { text: 'Hello' }],
      ['setReadOnly', { on: true }],
    ],
  );
  const results = [{ ok: 1 }, { paragraphs: [] }, {}, {}, { viewing: true }];
  calls().forEach((c, i) => reply(c, { ok: true, result: results[i] }));
  const got = await Promise.all(pending);
  assert.deepEqual(got[0], { ok: 1 });
  assert.deepEqual(got[1], { paragraphs: [] });
  assert.equal(got[2], undefined);
});

test('a_failed_call_rejects_only_itself', async () => {
  const { editor, ready, calls, reply } = plain();
  ready();
  await tick();
  const bad = editor.run('no.such');
  const good = editor.getText();
  await tick();
  const [b, g] = calls();
  reply(b, { ok: false, error: 'unknown command no.such' });
  reply(g, { ok: true, result: { text: 'still fine' } });
  await assert.rejects(bad, /unknown command no\.such/);
  assert.equal(await good, 'still fine');
});

test('getdocument_returns_a_named_blob', async () => {
  const { editor, ready, calls, reply } = plain();
  ready();
  await tick();
  const file = editor.getDocument('pdf');
  await tick();
  assert.deepEqual(calls()[0].params, { format: 'pdf' });
  reply(calls()[0], { ok: true, result: { name: 'Doc.pdf' }, name: 'Doc.pdf', bytes: new Uint8Array([37, 80, 68, 70]).buffer });
  const { name, blob } = await file;
  assert.equal(name, 'Doc.pdf');
  assert.equal(blob.type, 'application/pdf');
  assert.equal(new TextDecoder().decode(await blob.arrayBuffer()), '%PDF');
  const second = editor.getDocument();
  await tick();
  assert.deepEqual(calls()[1].params, { format: 'docx' }, 'docx by default');
  editor.destroy();
  await assert.rejects(second, /destroyed/);
});

test('destroy_rejects_pending_calls', async () => {
  const { editor, ready } = plain();
  ready();
  await tick();
  const text = editor.getText();
  await tick();
  editor.destroy();
  await assert.rejects(text, /destroyed/);
  await assert.rejects(editor.getText(), /destroyed/);
});

test('a_call_times_out', async () => {
  const { editor, ready } = plain({ callTimeout: 30 });
  ready();
  await tick();
  await assert.rejects(editor.getText(), /timed out/);
});

test('events_are_dispatched', async () => {
  const { page, editor, frame, ready } = plain();
  ready();
  await tick();
  const heard = [];
  for (const type of ['change', 'selectionchange', 'presence', 'comment']) {
    editor.addEventListener(type, (e) => heard.push([type, e.detail]));
  }
  const send = (event, detail) => page.fromEditor({ type: 'wordcraft:event', event, detail }, frame);
  send('change', { rev: 3, author: 'Ann' });
  send('selectionchange', { text: 'Hi', empty: false });
  send('presence', { people: [{ name: 'Ann', color: '#aabbcc' }] });
  send('comment', { action: 'added', id: 1, author: 'Ann', text: 'Note' });
  send('somethingElse', {});
  assert.deepEqual(heard, [
    ['change', { rev: 3, author: 'Ann' }],
    ['selectionchange', { text: 'Hi', empty: false }],
    ['presence', { people: [{ name: 'Ann', color: '#aabbcc' }] }],
    ['comment', { action: 'added', id: 1, author: 'Ann', text: 'Note' }],
  ]);
  // Another origin is never heard.
  const before = heard.length;
  page.fromOtherOrigin({ type: 'wordcraft:event', event: 'change', detail: { rev: 9 } }, frame);
  assert.equal(heard.length, before);
});

test('calls wait for the starting document to open', async () => {
  const { editor, ready, frame, calls } = plain({ document: new Uint8Array([1, 2, 3]), documentName: 'start.docx' });
  const text = editor.getText();
  ready();
  await tick(20);
  const types = frame.posted.map((m) => m.type);
  assert.ok(types.indexOf('wordcraft:open') !== -1, 'the document is sent');
  assert.ok(types.indexOf('wordcraft:open') < types.indexOf('wordcraft:call'), `the call goes after the document: ${types}`);
  editor.destroy();
  await assert.rejects(text, /destroyed/);
  void calls;
});

test('co-editing calls wait until the shared document is joined', async () => {
  const { page, editor, frame } = await setup();
  const text = editor.getText();
  await tick(20);
  assert.equal(frame.posted.filter((m) => m.type === 'wordcraft:call').length, 0, 'not before the document is joined');
  page.fromEditor({ type: 'wordcraft:collab.status', pending: 0, rev: 0, people: 1 });
  await tick(20);
  assert.equal(frame.posted.filter((m) => m.type === 'wordcraft:call').length, 1);
  editor.destroy();
  await assert.rejects(text, /destroyed/);
});

test('the element refuses calls with a rejected promise before it is connected', async () => {
  const { WordCraftEditorElement } = await import('../src/wordcraft-embed.js');
  const element = new WordCraftEditorElement();
  for (const call of [() => element.getText(), () => element.run('edit.undo'), () => element.open(new Uint8Array(1)), () => element.setReadOnly(true)]) {
    let result;
    assert.doesNotThrow(() => { result = call(); });
    await assert.rejects(result, /not in the page/);
  }
});
