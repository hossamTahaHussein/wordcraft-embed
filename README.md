# wordcraft-embed

Put a full Word-style editor in any website. Users open, edit and save `.docx` files in the page, and
your site decides where the files go.

The editor is [WordCraft](https://github.com/storytold/wordcraft) by the ArtCraft team: an
open-source (MIT OR Apache-2.0) Word reimplementation in Rust that runs in the browser through
WebAssembly. It covers the ribbon, styles, tables, track changes, comments, references, mail merge,
and .docx/.odt/.rtf/.md/.html/PDF. This package adds the pieces that turn it into an embeddable
component:

| Path | What it is |
|---|---|
| `src/wordcraft-embed.js` | The SDK: a `WordCraftEditor` class and a `<wordcraft-editor>` tag. No dependencies, about 13 KB |
| `src/wordcraft-embed.d.ts` | TypeScript types |
| `scripts/fetch-editor.mjs` | Downloads the WordCraft web build into `editor/` and checks its SHA-256 against the release |
| `editor/` | The editor itself: a static site (`index.html`, `.js`, `.wasm`). It has no server code |
| `examples/` | A demo site with a file list and server saving, a one-tag page, a React wrapper, and a Node server |

## How it works

```
your page (https://yoursite.com/docs)
 └─ <iframe src="/wordcraft/?host=parent">    ← WordCraft, hosted by you on the same origin
      ▲  wordcraft:open  { name, bytes }        (SDK → editor: show this file)
      ▼  wordcraft:save  { name, bytes, saveAs } (editor → SDK → your onSave: store this file)
         wordcraft:dirty { dirty }               wordcraft:ready { version }   wordcraft:failed
```

When WordCraft runs in a frame with `?host=parent`, it sends every file it saves or exports
(Ctrl+S, File › Save / Save As / Export) to the parent page instead of downloading it. The SDK wraps
these messages in a small API.

**The one rule:** the `editor/` folder must be served from **the same origin** (scheme + domain +
port) as the page that embeds it. WordCraft only answers a same-origin parent, so a page on another
origin would never receive saves. The SDK checks this and throws a clear error if the origins
differ.

## Try the demo

```sh
npm run fetch-editor      # downloads WordCraft 0.12.0 (~18 MB zip) into editor/
npm start                 # http://localhost:8080
```

- `http://localhost:8080/` is a document manager. Use **New document** or **Upload…**, type, then press
  **Ctrl+S**. The file is PUT to the demo server, stored in `examples/files/`, and listed on the
  left. Click a file to reopen it.
- `http://localhost:8080/web-component.html` is the one-tag integration.

## Add it to your site

### 1. Host the editor files

Copy `editor/` to your site, for example under `/wordcraft/`. It is plain static files. Serve
`.wasm` as `application/wasm` and turn on gzip or Brotli (that cuts the download from about 50 MB to
about 18 MB). `editor/HOSTING.md` has nginx, Apache, Netlify and Cloudflare settings.

| Platform | How |
|---|---|
| Next.js / Vite / CRA | Copy `editor/` to `public/wordcraft/` |
| Django / Rails / Laravel / Express | Serve it as a static folder at `/wordcraft/` |
| WordPress / PHP | Upload it to `wp-content/…/wordcraft/` (or anywhere) and point `src` at it |
| nginx | `location /wordcraft/ { alias /var/www/wordcraft/; }` plus the MIME type |

### 2. Add the SDK

Use it as an ES module, either copied into your site or installed (`npm install ./wordcraft-embed`):

```html
<div id="editor" style="height: 80vh"></div>

<script type="module">
  import { WordCraftEditor } from '/js/wordcraft-embed.js';

  const editor = new WordCraftEditor('#editor', {
    src: '/wordcraft/',                    // where you put editor/
    document: '/files/contract.docx',      // optional: URL, File, Blob, ArrayBuffer or Uint8Array
    author: currentUser.name,              // signs comments and tracked changes

    // Ctrl+S, File › Save / Save As and exports land here instead of the Downloads folder.
    onSave: async ({ name, blob, saveAs }) => {
      const res = await fetch(`/api/files/${encodeURIComponent(name)}`, { method: 'PUT', body: blob });
      if (!res.ok) throw new Error('Upload failed');  // reported through onError
    },
    onDirtyChange: (dirty) => (saveIndicator.hidden = !dirty),
    onError: (error) => console.error(error),
  });
</script>
```

Or with no JavaScript of your own:

```html
<script type="module" src="/js/wordcraft-embed.js"></script>
<wordcraft-editor src="/wordcraft/" document="/files/contract.docx" author="Jane"
                  style="height: 80vh"></wordcraft-editor>
<script>
  document.querySelector('wordcraft-editor')
    .addEventListener('wordcraft-save', (e) => upload(e.detail.name, e.detail.blob));
</script>
```

React: see `examples/react/WordEditor.jsx` (`<WordEditor document=… onSave=… />`).

### 3. Store the saved files

`onSave` gets `{ name, bytes, blob, saveAs }`:

- `name`: the file name. Its extension tells you the format: `report.docx`, or `report.pdf` for a PDF
  export.
- `saveAs: false` means a plain Save of the open file (overwrite it), or an export copy such as a PDF
  or PNG.
- `saveAs: true` means the file becomes the document's file: Save As, the first save of a new
  document, or an export to .docx/.odt/.rtf. Store it as a new file.

The backend just stores bytes. `examples/server.mjs` shows a minimal `PUT /api/files/:name` with name
checks and atomic writes. In production, put it behind your own authentication and per-user
storage (S3, a database blob, …).

## API

### `new WordCraftEditor(container, options)`

| Option | Default | |
|---|---|---|
| `src` | `'/wordcraft/'` | URL of the hosted `editor/` folder. Must be on the page's origin |
| `document` | none | Document to open once the editor is ready |
| `documentName` | from the URL or file | Name for `document`. Its extension picks the format (`.docx`, `.odt`, `.md`, …) |
| `author` | none | User name on comments and tracked changes |
| `webgl` | `false` | Force WebGL2 instead of WebGPU, for a misbehaving GPU driver |
| `guardUnload` | `true` | Warn before the user leaves the page with unsaved changes |
| `readyTimeout` | `60000` | Milliseconds to wait for the editor before `error` |
| `title` | `'Document editor'` | Accessible title of the iframe |
| `onReady`, `onSave`, `onDirtyChange`, `onError` | | Callbacks. The same information arrives as events |

| Member | |
|---|---|
| `await editor.ready` | Resolves `{ version }` when the editor is running |
| `await editor.open(source, name?)` | Open a URL, `File`, `Blob`, `ArrayBuffer` or `Uint8Array`. Waits for `ready` |
| `editor.dirty` | `true` while there are unsaved changes |
| `editor.focus()` / `editor.destroy()` | Focus the editor / remove it and stop listening |
| events | `ready`, `save`, `dirty`, `error` (`CustomEvent`, data in `event.detail`). On `<wordcraft-editor>` they are prefixed `wordcraft-` and bubble |

## Co-editing (several people, one document)

Up to about 20 people can edit the same document at once. Each person sees their own typing
instantly and everyone else's within a network round trip. The document is saved automatically
a few seconds after typing stops, through the same `onSave`.

It needs three things:

1. **A co-editing build of WordCraft** in place of the official `editor/`. Build the `co-editing`
   branch of [wordcraft-collab](https://github.com/hossamTahaHussein/wordcraft-collab) (`cd apps/wordcraft-web && trunk build --release`) and serve
   its `dist/web` as `/wordcraft/`. The official release ignores `collab`.
2. **The relay** (`relay/server.mjs`, Node 18+, one dependency: `ws`). It never reads documents;
   it puts edits in order, keeps the session on disk (`DATA_DIR`) and chooses who autosaves.
   Run it on its own (`RELAY_SECRET=… DATA_DIR=./relay-data node relay/server.mjs`, then proxy
   `wss://yoursite/relay` to it) or inside your Node server (`createRelay({ secret, dataDir, server })`).
3. **Join tokens from your backend.** Only your site knows who is signed in, so it issues a short
   token per user and document, signed with `RELAY_SECRET`:

```js
import { issueToken } from 'wordcraft-embed/relay/token.mjs';
app.get('/api/wordcraft-token', requireLogin, (req, res) => {
  res.json({ token: issueToken(process.env.RELAY_SECRET, { doc: req.query.doc, sub: req.user.id, name: req.user.name, role: 'edit' }) });
});
```

(Any language can do this: it is a standard HS256 JWT with claims `doc`, `sub`, `name`, `role`,
`iat`, `exp`, valid for at most 24 hours.)

Then add `collab` to the editor:

```js
new WordCraftEditor('#editor', {
  src: '/wordcraft/',
  author: user.name,
  document: `/files/${id}.docx`,         // opened only by the first person in the session
  documentName: `${id}.docx`,
  collab: {
    url: 'wss://yoursite.com/relay',
    token: async () => (await (await fetch(`/api/wordcraft-token?doc=${id}`)).json()).token,
  },
  onSave: ({ name, blob }) => fetch(`/files/${name}`, { method: 'PUT', body: blob }),
});
```

`editor.addEventListener('collab', e => …)` reports `{ connected, pending, rev }` for a
"Saving… / All changes synced / Offline" indicator. The demo (`npm start` with
`EDITOR_DIR` pointing at the fork's build) has a working page at `/collab.html?doc=demo`.

Not yet in this version: other people's cursors and a list of who is present, Undo while
co-editing (it is greyed out), roles other than editor, and version history.

## Limits to know

- **Saving is started by the user.** The editor protocol has no "give me the document now"
  message, so a host button can't trigger a save. Users press Ctrl+S or use File › Save. Adding that
  message would mean changing WordCraft's `apps/wordcraft-web/src/host.rs` and rebuilding the wasm
  (Rust and trunk).
- **Same origin only**, as described above. Serving the editor from a CDN on another domain would
  also need an upstream change to the bridge's origin check.
- **Size:** about 18 MB to download with compression. The hashed files are cached forever, so it is
  paid once per version.
- **Browsers:** WebGPU or WebGL2 is required (any current Chrome, Edge, Firefox or Safari). WebGPU
  needs HTTPS or `localhost`. Elsewhere the editor falls back to WebGL2 on its own.
- **Maturity:** WordCraft is alpha (v0.12). Test it with your real documents before you rely on it.

## Updating WordCraft

```sh
node scripts/fetch-editor.mjs latest     # or a version: node scripts/fetch-editor.mjs 0.13.0
```

Pin the version you tested in `package.json` (`"wordcraftVersion"`).

## License

The SDK and examples are MIT OR Apache-2.0, the same as WordCraft. The `editor/` folder is the
unmodified official WordCraft web build, with its own `LICENSE-*`, `NOTICE`, `ATTRIBUTION.md` and
font licenses (OFL). Ship those files with it. The ArtCraft name and logos are ArtCraft's
trademarks. If you modify and rebuild WordCraft, upstream requires removing them (see
`docs/brand/LICENSE-brand.txt` in the WordCraft repository). Microsoft Word is a trademark of
Microsoft; WordCraft is not affiliated with it.
