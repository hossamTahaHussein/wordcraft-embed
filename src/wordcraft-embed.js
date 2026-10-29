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
function editorUrl(src, { author, webgl }) {
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
   * @param {boolean} [options.guardUnload=true] warn before leaving the page with unsaved changes
   * @param {number} [options.readyTimeout=60000] ms to wait for the editor before an `error`
   * @param {string} [options.title='Document editor'] accessible title of the iframe
   * @param {(file: {name: string, bytes: ArrayBuffer, blob: Blob, saveAs: boolean}) => any} [options.onSave]
   * @param {(info: {version: string}) => void} [options.onReady]
   * @param {(dirty: boolean) => void} [options.onDirtyChange]
   * @param {(error: Error) => void} [options.onError]
   */
  constructor(container, options = {}) {
    super();
    const host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!host) throw new Error(`WordCraft: no element matches ${container}`);
    this.options = { src: '/wordcraft/', guardUnload: true, readyTimeout: DEFAULT_READY_TIMEOUT_MS, ...options };
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

    const url = editorUrl(this.options.src, this.options);
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
      if (this.options.guardUnload && this.dirty) {
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

    if (this.options.document != null) {
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
export class WordCraftEditorElement extends HTMLElement {
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
    for (const type of ['ready', 'save', 'dirty', 'error']) {
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
}

if (typeof customElements !== 'undefined' && !customElements.get('wordcraft-editor')) {
  customElements.define('wordcraft-editor', WordCraftEditorElement);
}

if (typeof window !== 'undefined') {
  window.WordCraft = { WordCraftEditor, createEditor, mimeType };
}
