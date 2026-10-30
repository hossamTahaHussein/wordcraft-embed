export type DocumentSource = string | URL | Blob | ArrayBuffer | Uint8Array;

export interface SavedFile {
  /** File name, e.g. "report.docx" or "report.pdf" for an export. */
  name: string;
  bytes: ArrayBuffer;
  /** The same bytes, typed by the file's extension. */
  blob: Blob;
  /**
   * true when the file becomes the document's file (Save As, a new document's first Save, export to
   * .docx/.odt/.rtf); false for a Save of the open file or a copy such as a PDF export.
   */
  saveAs: boolean;
}

export interface WordCraftEditorOptions {
  /** URL of the hosted editor folder, on this page's origin. Default "/wordcraft/". */
  src?: string;
  /** Document to open when the editor is ready. */
  document?: DocumentSource;
  /** Name for `document` when it has none; its extension picks the format. */
  documentName?: string;
  /** User name that signs comments and tracked changes. */
  author?: string;
  /** Force WebGL2 instead of WebGPU. */
  webgl?: boolean;
  /** Interface language, e.g. "ar", "fr", "ja" (default: the browser's). Right-to-left languages mirror the window. */
  language?: string;
  /** Warn before leaving the page with unsaved changes. Default true. */
  guardUnload?: boolean;
  /** Milliseconds to wait for the editor to start before an `error`. Default 60000. */
  readyTimeout?: number;
  /** Accessible title of the iframe. */
  title?: string;
  /** Milliseconds an API call (run, getText…) may take before it rejects. Default 30000. */
  callTimeout?: number;
  onReady?: (info: { version: string | null }) => void;
  /** Store the file. A rejected promise is reported as an `error` event. */
  onSave?: (file: SavedFile) => void | Promise<unknown>;
  onDirtyChange?: (dirty: boolean) => void;
  /** Something failed. When co-editing, an error with `code` 4403 (removed from the document)
   * or 4410 (the document was closed) has a message to show the person; the editor doesn't
   * reconnect after those (or after 4400, 4401, 4409). */
  onError?: (error: WordCraftError) => void;
  /**
   * Co-edit through a relay (`relay/server.mjs`). Only the first person's `document` is opened;
   * everyone who joins later gets the shared copy. Saves (autosave every few seconds, Ctrl+S)
   * come through `onSave` as usual.
   */
  collab?: {
    /** The relay's WebSocket URL, e.g. `wss://example.com/relay`. */
    url: string;
    /** A join token from your backend; a function is called again for every reconnect. */
    token: string | (() => string | Promise<string>);
  };
}

export interface WordCraftError extends Error {
  /** The relay's close code, for errors that ended co-editing. */
  code?: number;
}

export interface CollabStatus {
  /** In the document: the relay has welcomed this connection (an open socket alone isn't). */
  connected: boolean;
  /** Edits made here that the relay hasn't confirmed yet. */
  pending: number;
  /** The last confirmed revision, or null before joining. */
  rev: number | null;
  /** Everyone in the document, this person included. */
  people: number;
}

export type DocumentFormat = 'docx' | 'odt' | 'rtf' | 'pdf' | 'html' | 'md' | 'txt';

export interface ChangeDetail {
  /** The document's revision (the shared revision when co-editing). */
  rev: number;
  /** Who made the edits. */
  author: string;
}

export interface SelectionDetail {
  /** The selected text's first 1000 characters. */
  text: string;
  /** The whole selection's length in characters. */
  length: number;
  /** No text selected (a caret). */
  empty: boolean;
}

export interface PresenceDetail {
  /** The others in the document. */
  people: { name: string; color: string }[];
}

export interface CommentDetail {
  action: 'added' | 'resolved' | 'reopened' | 'deleted';
  id: number;
  author: string;
  text: string;
}

export interface WordCraftEventMap {
  ready: CustomEvent<{ version: string | null }>;
  save: CustomEvent<SavedFile>;
  dirty: CustomEvent<{ dirty: boolean }>;
  error: CustomEvent<{ error: WordCraftError }>;
  collab: CustomEvent<CollabStatus>;
  change: CustomEvent<ChangeDetail>;
  selectionchange: CustomEvent<SelectionDetail>;
  presence: CustomEvent<PresenceDetail>;
  comment: CustomEvent<CommentDetail>;
}

/** Driving the editor from JavaScript; every call waits for `ready`. */
export interface WordCraftApi {
  /** Run any WordCraft command and get its result. */
  run(command: string, params?: Record<string, unknown>): Promise<any>;
  getText(): Promise<string>;
  getDocument(format?: DocumentFormat): Promise<{ name: string; blob: Blob }>;
  /** The document's structure as JSON. */
  inspect(): Promise<any>;
  insertText(text: string): Promise<void>;
  select(text: string): Promise<void>;
  /** Read only (Editing › Viewing) or editable again. */
  setReadOnly(on?: boolean): Promise<void>;
}

export interface WordCraftEditor extends WordCraftApi {}
export class WordCraftEditor extends EventTarget {
  constructor(container: string | HTMLElement, options?: WordCraftEditorOptions);
  readonly iframe: HTMLIFrameElement;
  /** Resolves once the editor is running. */
  readonly ready: Promise<{ version: string | null }>;
  readonly version: string | null;
  readonly dirty: boolean;
  open(source: DocumentSource, name?: string): Promise<void>;
  focus(): void;
  destroy(): void;
  addEventListener<K extends keyof WordCraftEventMap>(
    type: K,
    listener: (event: WordCraftEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
}

export function createEditor(container: string | HTMLElement, options?: WordCraftEditorOptions): WordCraftEditor;
export function mimeType(name: string): string;

export interface WordCraftEditorElement extends WordCraftApi {}
export class WordCraftEditorElement extends HTMLElement {
  editor: WordCraftEditor | null;
  open(source: DocumentSource, name?: string): Promise<void>;
}

declare global {
  interface HTMLElementTagNameMap {
    'wordcraft-editor': WordCraftEditorElement;
  }
}
