// wordcraft-embed: put the WordCraft word processor in any web page.
//
// WordCraft (https://github.com/storytold/wordcraft, MIT OR Apache-2.0) runs in the browser as a
// static WebAssembly site. Framed with `?host=parent`, it talks to its parent page over
// postMessage: the parent sends the document to open, and WordCraft hands back every file it
// saves instead of downloading it. This module wraps that protocol:
//
//   const editor = new WordCraftEditor('#editor', {
//     src: '/wordcraft/',                       // where the editor's static files are hosted
//     document: '/files/report.docx',           // optional: URL, File, Blob, ArrayBuffer or Uint8Array
//     author: 'Jane Doe',                       // signs comments and tracked changes
//     onSave: async ({ name, blob }) => { ... } // store the file (Ctrl+S, File > Save, Export)
//   });
//
// or, declaratively, <wordcraft-editor src="/wordcraft/" document="/files/report.docx">.
//
// The editor must be served from the same origin as the page that embeds it: WordCraft only
// answers a same-origin parent, so on another origin saves would be dropped silently.

const MESSAGE = {
  ready: 'wordcraft:ready',
  open: 'wordcraft:open',
  save: 'wordcraft:save',
  dirty: 'wordcraft:dirty',
  failed: 'wordcraft:failed',
  collab: 'wordcraft:collab',
  collabStatus: 'wordcraft:collab.status',
  call: 'wordcraft:call',
  result: 'wordcraft:result',
  event: 'wordcraft:event',
};

/** The editor's events the page hears (`wordcraft:event`). */
const EDITOR_EVENTS = new Set(['change', 'selectionchange', 'presence', 'comment']);

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** Relay close codes after which reconnecting can't help. */
const PERMANENT_CLOSE = {
  4400: 'the editor sent a bad client id',
  4401: 'not allowed to edit this document (the join token was refused)',
  4403: 'not allowed to edit this document (role)',
  4409: 'this document has too many people in it',
};

const DEFAULT_READY_TIMEOUT_MS = 60_000;

const MIME_BY_EXTENSION = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  docm: 'application/vnd.ms-word.document.macroEnabled.12',
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  doc: 'application/msword',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  pdf: 'application/pdf',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  tex: 'application/x-tex',
  txt: 'text/plain',
  png: 'image/png',
};

/** The MIME type for a file name, by its extension. */
export function mimeType(name) {
  const extension = String(name).split('.').pop().toLowerCase();
  return MIME_BY_EXTENSION[extension] || 'application/octet-stream';
}

/** The last path segment of a URL, for naming a document opened from it. */
function nameFromUrl(url) {
  try {
    const segment = new URL(url, location.href).pathname.split('/').filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : 'Document.docx';
  } catch {
    return 'Document.docx';
  }
}

/** Bytes from a File, Blob, ArrayBuffer, typed array or URL, plus a name for them. */
async function toDocument(source, name) {
  if (typeof source === 'string' || source instanceof URL) {
    const response = await fetch(source, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`WordCraft: couldn't fetch ${source} (HTTP ${response.status})`);
    return { name: name || nameFromUrl(String(source)), bytes: await response.arrayBuffer() };
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    return { name: name || source.name || 'Document.docx', bytes: await source.arrayBuffer() };
  }
  if (source instanceof ArrayBuffer) return { name: name || 'Document.docx', bytes: source };
  if (ArrayBuffer.isView(source)) {
    // Copy, so transferring the buffer never detaches the caller's array.
    const copy = new Uint8Array(source.byteLength);
    copy.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
    return { name: name || 'Document.docx', bytes: copy.buffer };
  }
  throw new TypeError('WordCraft: a document is a URL, File, Blob, ArrayBuffer or Uint8Array');
}

/** The editor page's URL with the host-mode query flags. */
function editorUrl(src, { author, webgl, collab, docName, language }) {
  const url = new URL(src, location.href);
  if (url.origin !== location.origin) {
    throw new Error(
      `WordCraft: the editor (${url.origin}) must be served from this page's origin (${location.origin}). ` +
        'Host the editor/ folder on the same site, for example under /wordcraft/.',
    );
  }
  url.searchParams.set('host', 'parent');
  if (author) url.searchParams.set('author', author);
  if (webgl) url.searchParams.set('webgl', '');
  if (language) url.searchParams.set('lang', language);
  if (collab) {
    url.searchParams.set('collab', '1');
    if (docName) url.searchParams.set('docName', docName);
  }
  return url;
}

/**
 * An embedded WordCraft editor. It is an EventTarget with these events, each a CustomEvent whose
 * `detail` is described below; the matching `on…` options are shortcuts for them:
 *
 * - `ready`  { version }                     the editor is running and can open documents
 * - `save`   { name, bytes, blob, saveAs }   the user saved or exported a file (see onSave)
 * - `dirty`  { dirty }                       unsaved changes appeared or went away
 * - `error`  { error }                       the editor couldn't start, or onSave failed
 * - `collab` { connected, pending, rev, people }  co-editing: connection, unsent edits or people changed
 */
export class WordCraftEditor extends EventTarget {
  /**
   * @param {string|HTMLElement} container element (or selector) the editor fills
   * @param {object} options
   * @param {string} [options.src='/wordcraft/'] URL of the hosted editor folder (same origin)
   * @param {string|Blob|ArrayBuffer|Uint8Array} [options.document] document to open at start
   * @param {string} [options.documentName] name for `document` when it has none (sets the format)
   * @param {string} [options.author] user name for comments and tracked changes
   * @param {boolean} [options.webgl] force WebGL2 instead of WebGPU
   * @param {string} [options.language] interface language, e.g. 'ar', 'fr' (default: the browser's)
   * @param {boolean} [options.guardUnload=true] warn before leaving the page with unsaved changes
   * @param {number} [options.readyTimeout=60000] ms to wait for the editor before an `error`
   * @param {number} [options.callTimeout=30000] ms an API call (run, getText…) may take
   * @param {string} [options.title='Document editor'] accessible title of the iframe
   * @param {(file: {name: string, bytes: ArrayBuffer, blob: Blob, saveAs: boolean}) => any} [options.onSave]
   * @param {(info: {version: string}) => void} [options.onReady]
   * @param {(dirty: boolean) => void} [options.onDirtyChange]
   * @param {(error: Error) => void} [options.onError]
   * @param {{url: string, token: string | (() => string | Promise<string>)}} [options.collab]
   *   co-edit through a relay (relay/server.mjs): its WebSocket URL and a join token from your
   *   backend (a function is called again for each reconnect). Only the first person's
   *   `document` is opened; everyone else gets the shared copy.
   */
  constructor(container, options = {}) {
    super();
    const host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!host) throw new Error(`WordCraft: no element matches ${container}`);
    this.options = { src: '/wordcraft/', guardUnload: true, readyTimeout: DEFAULT_READY_TIMEOUT_MS, callTimeout: DEFAULT_CALL_TIMEOUT_MS, ...options };
    /** API calls waiting for their answer, by id. */
    this._calls = new Map();
    this._nextCall = 1;
    this.version = null;
    this.dirty = false;
    this.destroyed = false;

    for (const [type, callback, unwrap] of [
      ['ready', this.options.onReady, (d) => d],
      ['save', this.options.onSave, (d) => d],
      ['dirty', this.options.onDirtyChange, (d) => d.dirty],
      ['error', this.options.onError, (d) => d.error],
    ]) {
      if (typeof callback !== 'function') continue;
      this.addEventListener(type, (event) => {
        const result = callback(unwrap(event.detail));
        // A failed async onSave (the upload was refused, say) is reported as an `error`.
        if (type !== 'error' && typeof result?.catch === 'function') {
          result.catch((error) => this._emit('error', { error }));
        }
      });
    }

    const docName =
      this.options.documentName ||
      (typeof this.options.document === 'string' ? nameFromUrl(this.options.document) : this.options.document?.name) ||
      undefined;
    const url = editorUrl(this.options.src, { ...this.options, docName });
    this.docName = docName;
    this.origin = url.origin;

    this.iframe = document.createElement('iframe');
    this.iframe.src = url.href;
    this.iframe.title = this.options.title || 'Document editor';
    this.iframe.allow = 'fullscreen; clipboard-read; clipboard-write; local-fonts';
    this.iframe.style.cssText = 'display:block;width:100%;height:100%;border:0;';

    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    // A rejection nobody awaits shouldn't be reported as unhandled; `error` events still fire.
    this.ready.catch(() => {});

    this._onMessage = (event) => this._receive(event);
    window.addEventListener('message', this._onMessage);
    this._onBeforeUnload = (event) => {
      // Co-editing: the relay's autosaver saves the shared document; only edits that haven't
      // reached the relay yet would be lost.
      const unsaved = this._collab ? this._collab.pending > 0 : this.dirty;
      if (this.options.guardUnload && unsaved) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', this._onBeforeUnload);

    this._readyTimer = setTimeout(() => {
      this._fail(
        new Error(
          'WordCraft: the editor did not start in time. Check that its files are served (with .wasm as ' +
            'application/wasm) at ' + url.pathname,
        ),
      );
    }, this.options.readyTimeout);

    host.appendChild(this.iframe);

    if (this.options.collab) {
      this._collab = new CollabLink(this, this.options.collab);
      this.ready.then(() => this._collab?.connect(), () => {});
    } else if (this.options.document != null) {
      this.open(this.options.document, this.options.documentName).catch((error) => this._emit('error', { error }));
    }
  }

  /**
   * Open a document in the editor, replacing what it shows. Waits until the editor is ready.
   * @param {string|URL|Blob|ArrayBuffer|Uint8Array} source
   * @param {string} [name] file name; its extension picks the format (default Document.docx)
   */
  async open(source, name) {
    const [file] = await Promise.all([toDocument(source, name), this.ready]);
    if (this.destroyed) return;
    this.iframe.contentWindow.postMessage({ type: MESSAGE.open, name: file.name, bytes: file.bytes }, this.origin, [file.bytes]);
  }

  /**
   * Run any WordCraft command (the same names the ribbon and the MCP tools use), e.g.
   * `run('format.bold', { value: true })`. Resolves with the command's result.
   * @param {string} command
   * @param {object} [params]
   */
  run(command, params = {}) {
    return this._call('run', { command, params });
  }

  /** The document's text. */
  async getText() {
    return (await this._call('getText')).text;
  }

  /**
   * The document as a file in `format`.
   * @param {'docx'|'odt'|'rtf'|'pdf'|'html'|'md'|'txt'} [format='docx']
   * @returns {Promise<{name: string, blob: Blob}>}
   */
  getDocument(format = 'docx') {
    return this._call('getDocument', { format });
  }

  /** The document's structure (headings, paragraphs, tables, comments) as JSON. */
  inspect() {
    return this._call('inspect');
  }

  /** Type `text` at the cursor, replacing the selection. */
  async insertText(text) {
    await this._call('insertText', { text: String(text) });
  }

  /** Select the first occurrence of `text`. */
  async select(text) {
    await this._call('select', { text: String(text) });
  }

  /** Read only (`true`) or editable again: this person's edits are refused while read only. */
  async setReadOnly(on = true) {
    await this._call('setReadOnly', { on: Boolean(on) });
  }

  /** Send API call `method` once the editor is ready; resolves with its result. */
  async _call(method, params = {}) {
    await this.ready;
    if (this.destroyed) throw new Error('WordCraft: the editor was destroyed');
    const id = this._nextCall++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._calls.delete(id);
        reject(new Error(`WordCraft: ${method} timed out`));
      }, this.options.callTimeout);
      this._calls.set(id, { resolve, reject, timer });
      this.iframe.contentWindow.postMessage({ type: MESSAGE.call, id, method, params }, this.origin);
    });
  }

  /** Give keyboard focus to the editor. */
  focus() {
    this.iframe.focus();
  }

  /** Remove the editor from the page and stop listening. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this._readyTimer);
    window.removeEventListener('message', this._onMessage);
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    this._collab?.stop();
    this._collab = null;
    for (const { reject, timer } of this._calls.values()) {
      clearTimeout(timer);
      reject(new Error('WordCraft: the editor was destroyed'));
    }
    this._calls.clear();
    this.iframe.remove();
    this._rejectReady(new Error('WordCraft: the editor was destroyed'));
  }

  _receive(event) {
    // Only our own frame, on our own origin, is heard.
    if (event.origin !== this.origin || event.source !== this.iframe.contentWindow) return;
    const data = event.data;
    if (!data || typeof data.type !== 'string') return;
    switch (data.type) {
      case MESSAGE.ready:
        clearTimeout(this._readyTimer);
        this.version = data.version || null;
        this._resolveReady({ version: this.version });
        this._emit('ready', { version: this.version });
        break;
      case MESSAGE.dirty:
        this.dirty = Boolean(data.dirty);
        this._emit('dirty', { dirty: this.dirty });
        break;
      case MESSAGE.save: {
        const bytes = data.bytes instanceof ArrayBuffer ? data.bytes : new Uint8Array(data.bytes).buffer;
        const name = String(data.name || 'Document.docx');
        const blob = new Blob([bytes], { type: mimeType(name) });
        this._emit('save', { name, bytes, blob, saveAs: Boolean(data.saveAs) });
        break;
      }
      case MESSAGE.collab:
        if (typeof data.msg === 'string') this._collab?.toRelay(data.msg);
        break;
      case MESSAGE.collabStatus:
        this._collab?.status(data);
        break;
      case MESSAGE.result: {
        const call = this._calls.get(data.id);
        if (!call) break;
        this._calls.delete(data.id);
        clearTimeout(call.timer);
        if (!data.ok) {
          call.reject(new Error(String(data.error || 'the call failed')));
        } else if (data.bytes != null) {
          const bytes = data.bytes instanceof ArrayBuffer ? data.bytes : new Uint8Array(data.bytes).buffer;
          const name = String(data.name || 'Document.docx');
          call.resolve({ name, blob: new Blob([bytes], { type: mimeType(name) }) });
        } else {
          call.resolve(data.result);
        }
        break;
      }
      case MESSAGE.event:
        if (EDITOR_EVENTS.has(data.event)) this._emit(data.event, data.detail);
        break;
      case MESSAGE.failed:
        this._fail(new Error(`WordCraft couldn't start: ${data.error || 'unknown error'}`));
        break;
    }
  }

  _fail(error) {
    clearTimeout(this._readyTimer);
    this._rejectReady(error);
    this._emit('error', { error });
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/**
 * Co-editing: one WebSocket to the relay, carrying messages between it and the editor frame.
 * The editor's replica does the real work (and resends unconfirmed edits after a reconnect);
 * this only connects, reconnects, and opens the document for the first person.
 */
class CollabLink {
  constructor(editor, { url, token, WebSocket: WS = globalThis.WebSocket, retryMs = [500, 10_000] }) {
    this.editor = editor;
    this.url = url;
    this.token = token;
    this.WS = WS;
    this.retry = retryMs;
    this.delay = retryMs[0];
    // A relay client id: letters and digits only.
    this.client = (globalThis.crypto?.randomUUID?.() || String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9]/g, '');
    this.ws = null;
    this.stopped = false;
    this.rev = null;
    this.pending = 0;
    this.people = 1;
    this.connected = false;
  }

  async connect() {
    if (this.stopped) return;
    let token;
    try {
      token = typeof this.token === 'function' ? await this.token() : this.token;
    } catch (error) {
      this.editor._emit('error', { error: new Error(`WordCraft: couldn't get a join token: ${error.message || error}`) });
      return this.reconnectLater();
    }
    if (this.stopped) return;
    const ws = new this.WS(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.delay = this.retry[0];
      const hello = { t: 'hello', token, client: this.client };
      if (this.rev !== null) hello.haveRev = this.rev;
      ws.send(JSON.stringify(hello));
      this.setConnected(true);
    };
    ws.onmessage = (event) => this.fromRelay(String(event.data));
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setConnected(false);
      const permanent = PERMANENT_CLOSE[event.code];
      if (permanent) {
        this.editor._emit('error', { error: new Error(`WordCraft: ${permanent}`) });
        return;
      }
      this.reconnectLater();
    };
    ws.onerror = () => {};
  }

  reconnectLater() {
    if (this.stopped) return;
    setTimeout(() => this.connect(), this.delay);
    this.delay = Math.min(this.delay * 2, this.retry[1]);
  }

  fromRelay(text) {
    // The first person (no snapshot yet) opens the document; everyone else gets the shared copy.
    if (text.startsWith('{"t":"Welcome"')) {
      try {
        const welcome = JSON.parse(text);
        if (welcome.snapshot === null && this.rev === null && this.editor.options.document != null) {
          this.editor.open(this.editor.options.document, this.editor.docName).catch((error) => this.editor._emit('error', { error }));
        }
      } catch {}
    }
    this.toEditor(text);
  }

  toEditor(msg) {
    if (this.editor.destroyed) return;
    this.editor.iframe.contentWindow.postMessage({ type: MESSAGE.collab, msg }, this.editor.origin);
  }

  /** A message from the editor for the relay; dropped while disconnected (the replica resends its edits). */
  toRelay(msg) {
    if (this.ws && this.ws.readyState === (this.WS.OPEN ?? 1)) this.ws.send(msg);
  }

  status({ pending, rev, people }) {
    if (Number.isInteger(rev)) this.rev = rev;
    if (Number.isInteger(pending)) this.pending = pending;
    if (Number.isInteger(people)) this.people = people;
    this.emit();
  }

  setConnected(on) {
    this.connected = on;
    this.emit();
  }

  emit() {
    this.editor._emit('collab', { connected: this.connected, pending: this.pending, rev: this.rev, people: this.people });
  }

  stop() {
    this.stopped = true;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}

/** Mount an editor; the same as `new WordCraftEditor(container, options)`. */
export function createEditor(container, options) {
  return new WordCraftEditor(container, options);
}

/**
 * <wordcraft-editor src="/wordcraft/" document="/files/report.docx" author="Jane"></wordcraft-editor>
 *
 * Attributes: src, document, document-name, author, webgl, no-unload-guard. Events (CustomEvent,
 * same `detail` as WordCraftEditor): wordcraft-ready, wordcraft-save, wordcraft-dirty,
 * wordcraft-error. Methods: open(source, name), focus(). Property: editor (the WordCraftEditor).
 * Give the element a height; it is a block that the editor fills.
 */
// Server-side rendering (Next.js, Nuxt…) imports this module where there is no DOM.
const ElementBase = typeof HTMLElement === 'undefined' ? class {} : HTMLElement;

export class WordCraftEditorElement extends ElementBase {
  static get observedAttributes() {
    return ['document'];
  }

  connectedCallback() {
    if (!this.style.display) this.style.display = 'block';
    this.editor = new WordCraftEditor(this, {
      src: this.getAttribute('src') || '/wordcraft/',
      document: this.getAttribute('document') || undefined,
      documentName: this.getAttribute('document-name') || undefined,
      author: this.getAttribute('author') || undefined,
      webgl: this.hasAttribute('webgl'),
      guardUnload: !this.hasAttribute('no-unload-guard'),
      title: this.getAttribute('title') || undefined,
    });
    for (const type of ['ready', 'save', 'dirty', 'error', 'change', 'selectionchange', 'presence', 'comment']) {
      this.editor.addEventListener(type, (event) => {
        this.dispatchEvent(new CustomEvent(`wordcraft-${type}`, { detail: event.detail, bubbles: true, composed: true }));
      });
    }
  }

  disconnectedCallback() {
    this.editor?.destroy();
    this.editor = null;
  }

  attributeChangedCallback(name, previous, value) {
    if (name === 'document' && this.editor && value && value !== previous) {
      this.editor.open(value, this.getAttribute('document-name') || undefined);
    }
  }

  open(source, name) {
    return this.editor.open(source, name);
  }

  focus() {
    this.editor?.focus();
  }

  run(command, params) {
    return this.editor.run(command, params);
  }

  getText() {
    return this.editor.getText();
  }

  getDocument(format) {
    return this.editor.getDocument(format);
  }

  inspect() {
    return this.editor.inspect();
  }

  insertText(text) {
    return this.editor.insertText(text);
  }

  select(text) {
    return this.editor.select(text);
  }

  setReadOnly(on) {
    return this.editor.setReadOnly(on);
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('wordcraft-editor')) {
  customElements.define('wordcraft-editor', WordCraftEditorElement);
}

if (typeof window !== 'undefined') {
  window.WordCraft = { WordCraftEditor, createEditor, mimeType };
}
