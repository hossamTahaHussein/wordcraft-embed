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
| `callTimeout` | `30000` | Milliseconds an API call (`run`, `getText`, …) may take before it rejects |
| `title` | `'Document editor'` | Accessible title of the iframe |
| `onReady`, `onSave`, `onDirtyChange`, `onError` | | Callbacks. The same information arrives as events |

| Member | |
|---|---|
| `await editor.ready` | Resolves `{ version }` when the editor is running |
| `await editor.open(source, name?)` | Open a URL, `File`, `Blob`, `ArrayBuffer` or `Uint8Array`. Waits for `ready` |
| `editor.dirty` | `true` while there are unsaved changes |
| `editor.focus()` / `editor.destroy()` | Focus the editor / remove it and stop listening |
| events | `ready`, `save`, `dirty`, `error`, `collab`, and the API events below (`CustomEvent`, data in `event.detail`). On `<wordcraft-editor>` they are prefixed `wordcraft-` and bubble |

### Driving the editor from JavaScript

Every call returns a promise, waits for `ready`, and rejects with the editor's message when it
fails (an unknown command, an edit while read only). In a co-edited document, edits made this
way sync to everyone like typed ones.

Calls run when the editor draws its next frame, so in a hidden tab (where the browser pauses
drawing) they wait and may reach `callTimeout`. A call that timed out can still run once the tab
is shown again: check with `getText()` or `inspect()` before repeating an edit. On a
`<wordcraft-editor>` element the same calls reject while the element isn't in the page.

| Call | |
|---|---|
| `await editor.run(command, params?)` | Run any WordCraft command and get its result, e.g. `run('format.bold', { value: true })`, `run('insert.table', { rows: 2, cols: 3 })` |
| `await editor.getText()` | The document's text |
| `await editor.getDocument(format?)` | `{ name, blob }`: the document as `docx` (default), `odt`, `rtf`, `pdf`, `html`, `md` or `txt` |
| `await editor.inspect()` | The document's structure as JSON: headings, paragraphs, tables, comments |
| `await editor.insertText(text)` | Type text at the cursor, replacing the selection |
| `await editor.select(text)` | Select the first occurrence of `text` |
| `await editor.setReadOnly(on)` | Read only (Editing › Viewing) or editable again. Other people's edits still arrive while read only |

| Event | `event.detail` |
|---|---|
| `change` | `{ rev, author }` after edits, at most once per frame. `author` is who made them; `rev` is the shared revision when co-editing |
| `selectionchange` | `{ text, length, empty }`: `text` is the first 1000 characters, `length` the whole selection's |
| `presence` | `{ people: [{ name, color }] }`: the others in the document, `color` as CSS |
| `comment` | `{ action, id, author, text }`, `action` one of `added`, `resolved`, `reopened`, `deleted` |

```js
editor.addEventListener('change', ({ detail }) => console.log(`${detail.author} edited (revision ${detail.rev})`));
await editor.insertText('Quarterly report');
const { blob } = await editor.getDocument('pdf');
```

## Co-editing (several people, one document)

Up to about 20 people can edit the same document at once. Each person sees their own typing
instantly and everyone else's within a network round trip. The document is saved automatically
a few seconds after typing stops, through the same `onSave`.

It needs three things:

1. **A co-editing build of WordCraft** in place of the official `editor/`. Build the `co-editing`
   branch of [wordcraft-collab](https://github.com/hossamTahaHussein/wordcraft-collab) (`cd apps/wordcraft-web && trunk build --release`) and serve
   its `dist/web` as `/wordcraft/`. The official release ignores `collab`.
2. **The relay** (`relay/server.mjs`, Node 18+, one dependency: `ws`). It never reads documents;
   it puts edits in order, keeps the session and its versions on disk (`DATA_DIR`) and chooses
   who autosaves.
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

Not yet in this version: other people's cursors and a list of who is present, and Undo while
co-editing (it is greyed out).

### Roles

The token's `role` says what the person may do. The relay enforces it: an edit a role doesn't
allow is refused (the sender's editor is told why) and never reaches anyone else.

| Role | May |
|---|---|
| `edit` | Everything: type, format, undo their own edits, restore versions |
| `comment` | Add, edit, resolve and delete comments (the commands in `relay/comment-commands.json`), and undo those |
| `view` | Read, and see the others' edits and cursors as they happen |

Only editors save: the autosave goes to the editor who has been in the document longest. A
document is opened (from `document`) by the first editor; a viewer or commenter who arrives
first waits for one.

When the relay removes someone or the document is closed (see the HTTP API below), the
editor stops reconnecting and fires `error` with a message to show the person:
`error.code` is 4403 ("Removed from this document") or 4410 ("This document was closed").

### Version history

Saves become versions: the first save of a session, then at most one every 10 minutes, and
always the last save before the last editor leaves. Each version records when it was saved
and who edited since the one before. They are kept in `DATA_DIR/<room>/versions/`, thinned
to at most 100: every version from the last 24 hours, then the newest of each day.

Everyone in the document can list versions and preview them. Editors can restore one; the
restore is an edit like any other, so everyone sees it at once and it can be undone.

### Server-side HTTP API

Your backend can ask the relay about a document, get its content and change it, with no
browser involved. Set `RELAY_API_KEY` (standalone) or pass `apiKey` to `createRelay`; without a
key the API is off and every `/api/` route answers 404. Send the key as a bearer token.
Responses are JSON, errors `{ "error": "…" }`.

| Route | Answers |
|---|---|
| `GET /api/docs/:doc` | `{ doc, rev, savedRev, lastSaved, people: [{ client, sub, name, role, color }] }` |
| `GET /api/docs/:doc/content?format=docx` | The document now, as `docx`, `pdf`, `odt`, `rtf`, `html`, `md` or `txt`, as a download |
| `GET /api/docs/:doc/text` | The document's text (`text/plain`) |
| `POST /api/docs/:doc/commands` | Body `{ command, params?, author? }`: run a WordCraft command as an edit by `author` (default `API`). Answers `{ ok: true, result }`, or `{ ok: false, error }` with 422 |
| `POST /api/docs/:doc/kick` | Body `{ sub }`: remove that user from the document. `{ kicked }` is how many connections closed |
| `POST /api/docs/:doc/close` | Close the document for everyone and refuse joins for 10 seconds. `{ closed }` |

Content and commands are produced by the editor of someone who has the document open, so
they answer 409 when no editor is connected and 504 when that editor doesn't answer within
15 seconds. A document nobody ever opened is 404.

```sh
KEY=…   # RELAY_API_KEY
curl -H "Authorization: Bearer $KEY" https://yoursite.com/api/docs/report-42
curl -H "Authorization: Bearer $KEY" https://yoursite.com/api/docs/report-42/text
curl -H "Authorization: Bearer $KEY" -o report.pdf 'https://yoursite.com/api/docs/report-42/content?format=pdf'
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"command":"insert.table","params":{"rows":2,"cols":3},"author":"Workflow"}' \
     https://yoursite.com/api/docs/report-42/commands
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"sub":"user-17"}' \
     https://yoursite.com/api/docs/report-42/kick
```

Standalone, the relay answers these on its own port. Inside your Node server, hand it the
requests: `if (relay.handle(req, res)) return;` (it returns `false` for anything not under
`/api/`). The demo server does this, so `RELAY_API_KEY=… npm start` turns the API on there.

### Webhooks

The relay can tell your server what happens in documents. Set `WEBHOOK_URL` and
`WEBHOOK_SECRET` (or pass `webhook: { url, secret }` to `createRelay`). Each event is a POST
of JSON `{ event, doc, at, …detail }`:

| Event | Detail |
|---|---|
| `joined` | `{ sub, name, role }`, and `agent: true` for an agent |
| `left` | `{ sub, name }` |
| `edited` | `{ rev, people }`: the names of who edited. At most one every 5 seconds per document |
| `commented` | `{ action, by, rev }`, `action` one of `added`, `resolved`, `edited`, `deleted` |
| `saved` | `{ rev }` |
| `restored` | `{ rev, version }` |

Deliveries time out after 5 seconds and are tried up to three times. Each document's events
arrive in order. They are signed: `X-WordCraft-Signature` is an HMAC-SHA256 of
`<X-WordCraft-Timestamp>.<body>` with your secret. Check it before trusting a delivery, on the
raw body:

```js
import express from 'express';
import { verifyWebhook } from 'wordcraft-embed/relay/webhook.mjs';

app.post('/hooks/wordcraft', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verifyWebhook(process.env.WEBHOOK_SECRET, req.headers, req.body)) return res.sendStatus(401);
  const event = JSON.parse(req.body);
  if (event.event === 'saved') console.log(`${event.doc} saved at revision ${event.rev}`);
  res.sendStatus(204);
});
```

`verifyWebhook(secret, headers, body, toleranceS = 300)` also refuses a delivery whose
timestamp is more than five minutes away, so an old one can't be replayed.

### Agents

A program can join a document like a person, for example an AI agent running a headless
WordCraft replica. It sends the same hello as the editor with `agent: true`
(`{ t: "hello", token, client, agent: true }`). Its token's role applies as usual. An agent never
autosaves, never opens a new document, and is never asked for exports or API commands, so a
document with only agents in it waits for a person.

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
