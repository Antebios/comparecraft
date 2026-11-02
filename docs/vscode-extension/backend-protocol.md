# Headless backend: crate boundary and protocol v1

Status: decided and implemented in T007 (Phase 3). See [plan.md](plan.md) and
[decisions.md](decisions.md). This is the contract between the VS Code extension
and `comparecraft-backend`; change it only by adding a protocol version.

## Crate boundary decision

Inspection of `src-tauri/src/` (2026-10-22) found that only `lib.rs` imports
Tauri. The engine modules (`diff`, `merge`, `align`, `fileio`, `folder`,
`folder_merge`, `hex`, `pix`, `table`, `quick`, `report*`, `script`, `snapshot`,
`sessions`, `settings`, `cli`) are plain Rust and already shared with the
console program `ccomp`, which links `comparecraft_lib`.

Decision: **keep `comparecraft_lib` as the shared engine crate and add a third
binary target**, `comparecraft-backend` (`src-tauri/src/backend_main.rs`),
with the protocol implementation in a Tauri-free module `src-tauri/src/backend.rs`.

- No engine files move, so desktop behavior and existing tests cannot regress
  from extraction churn (a [decisions.md](decisions.md) constraint).
- Tauri bundles every Cargo `[[bin]]` next to the main executable, exactly as it
  already ships `ccomp`, so installers carry the helper with no new bundle config.
  Hand-maintained packaging (portable ZIP, Arch `PKGBUILD`, macOS signing hook)
  lists binaries explicitly and is updated.
- Like `ccomp`, the helper links the library that also contains the Tauri entry
  point; unused GUI code is removed by the linker. Splitting the engine into a
  separate Tauri-free crate stays possible later without changing this protocol.

## Executable and launch

| Platform | Installed location (sibling of the desktop executable) |
|---|---|
| Windows | `%LOCALAPPDATA%\CompareCraft\comparecraft-backend.exe` (per-user NSIS), or the Program Files install folder |
| macOS | `CompareCraft.app/Contents/MacOS/comparecraft-backend` |
| Linux deb/rpm/Arch | `/usr/bin/comparecraft-backend` |

`comparecraft.backendPath` (machine scope, global value only) overrides
discovery; an invalid explicit path fails without falling back.

- `comparecraft-backend --stdio` runs the protocol on stdin/stdout.
- `comparecraft-backend --version` prints `comparecraft-backend <version> (protocol 1)`.
- Any other invocation prints usage to stderr and exits with code 2, so
  double-clicking the helper never leaves a process waiting on a console.
- stdout carries only protocol frames. Diagnostics go to stderr as
  `comparecraft-backend: <level>: <message>` lines. `COMPARECRAFT_BACKEND_LOG=debug`
  adds one line per request (method, id, duration); the default level reports
  only warnings and errors. File contents are never logged.
- No TCP listener, OS service, or shell is used. The extension spawns the helper
  with an argument array and `windowsHide`.

## Framing

LSP-style base protocol in both directions:

```
Content-Length: <bytes>\r\n
\r\n
<UTF-8 JSON body of exactly <bytes> bytes>
```

- Header names are case-insensitive; other headers (for example
  `Content-Type`) are ignored. The header block is limited to 8 KiB.
- `maxMessageBytes` is 64 MiB. A larger body is read and discarded and answered
  with error `-32600` (`id: null`).
- A missing or invalid `Content-Length`, or EOF in the middle of a frame, means
  the stream can't be trusted: the helper logs to stderr and exits with code 2.
- Clean EOF on stdin ends the helper: code 0 after `shutdown`, otherwise 1.

## Messages

JSON-RPC 2.0. Requests carry `id` (number or string), `method`, and optional
`params`; notifications omit `id`. Responses carry exactly one of `result` or
`error: { code, message, data? }`. Responses may arrive in any order.

### Lifecycle

1. The client's first request must be `initialize`:
   `{ protocolVersions: [1], client: { name, version } }`.
   The server picks the highest common version. Result:

   ```json
   {
     "protocolVersion": 1,
     "server": { "name": "comparecraft-backend", "version": "0.1.0" },
     "capabilities": {
       "methods": [
         "path.info", "text.load", "text.diff", "text.merge", "hex.align",
         "table.compare", "pix.compare", "pix.image", "folder.compare",
         "folder.compareItems", "file.quickCompare"
       ]
     },
     "limits": { "maxMessageBytes": 67108864, "maxConcurrentRequests": 4, "maxQueuedRequests": 64, "maxLinesPerSide": 2000000 }
   }
   ```

   With no common version, the error is `-32010` with
   `data: { supported: [1] }`, and the server stays uninitialized. Any other
   request before a successful `initialize` gets `-32002`. A second `initialize`
   gets `-32600`.
2. Clients must check `capabilities.methods` before calling a method.
   Methods may be added within protocol 1; changes to existing methods need a
   new protocol version.
3. `shutdown` (request): returns `null` once it has stopped accepting new
   work; later requests get `-32600`.
4. `exit` (notification): the process exits with code 0 after `shutdown`,
   1 otherwise. Clients send `shutdown`, then `exit`, then close stdin, and kill
   the process if it hasn't exited within 2 seconds.

### Cancellation

`$/cancelRequest` notification `{ id }`.

- A queued or running request is answered immediately with `-32800`.
- A late result is discarded.
- A queued job never starts.
- A running engine call can't be interrupted. It finishes on its worker and
  its output is dropped. Unknown or finished ids are ignored.

### Concurrency and limits

- Up to `maxConcurrentRequests` requests run in parallel, at most 4 and capped
  at the available CPUs.
- Up to `maxQueuedRequests` more are queued. Beyond that the server answers
  `-32022` (busy).
- Text inputs above `maxLinesPerSide` lines get `-32021`.
- `table.compare`, `pix.compare` and `pix.image` reject any file above 64 MB
  with `-32021` and `data: { limit, actual }` (they read whole files into
  memory). `pix.compare` skips the check for a side whose decoded image is
  passed as `leftData`/`rightData`.
- `hex.align` has no size limit. Above 256 MB per side the engine compares
  positionally instead of aligning.
- Any response above `maxMessageBytes` becomes `-32021`.

### Methods (protocol 1, read-only)

The helper never writes, deletes, or executes anything. Writes stay in VS Code
document APIs (decision for T010).

| Method | Params | Result |
|---|---|---|
| `path.info` | `{ path }` (absolute) | `{ path, exists, isDir, size, modified, kind }` |
| `text.load` | `{ path }` (absolute file) | `{ path, lines, encoding, bom, eol, finalNewline, size, modified, binary, readOnly }` using the desktop's decoding (BOM, UTF-16, legacy encodings) |
| `text.diff` | `{ left: string[], right: string[], rules? }` | desktop `DiffResult`: `{ rows, hunks, important, unimportant, sameLines, identical }` |
| `text.merge` | `{ base, left, right: string[], rules? }` | desktop `MergeResult`: `{ chunks, conflicts, changes }` |
| `hex.align` | `{ left, right, align? }` (absolute files; `align` is `none`, `fast` or `complete`, default `complete`) | desktop `HexAlignment` (byte alignment rows and sizes) |
| `table.compare` | `{ left, right, options? }` (absolute files; desktop `TableOptions`) | desktop `TableResult` |
| `pix.compare` | `{ left, right, options?, leftData?, rightData? }` (absolute files; `*Data` is an already decoded image as base64 or a data URL) | desktop `PixResult` with a PNG difference image as a data URL |
| `pix.image` | `{ path }` (absolute file) | PNG data URL of the decoded picture (for formats the webview can't show) |
| `folder.compare` | `{ left, right, options? }` (absolute existing directories) | desktop `FolderResult`: `{ root: Node, summary: { files, same, similar, diff, leftOnly, rightOnly, errors } }` |
| `folder.compareItems` | `{ left, right, rels, options? }` (absolute existing directories; `rels` is an array of safe relative item paths) | `Array<Node | null>` with `null` for each item no longer present or filtered out; results retain the input order |
| `file.quickCompare` | `{ left, right, mode }` (absolute existing files; `mode` is `rules`, `size`, `crc` or `binary`) | Integer verdict from the desktop quick engine |

`FolderResult` and each non-null folder item use the shared desktop shapes.
`Node` contains `name`, `rel`, `dir`, and `status`, with optional `children`,
`left`/`right` sides (`{ name, size, modified }`), `leftPath`/`rightPath`,
`newer`, `error`, and `content`. Status values are `same`, `similar`, `diff`,
`left`, `right` and `error`; content verdicts are `sameBinary`, `same`,
`similar`, `different` and `differentBinary`.

`folder.compare` and `folder.compareItems` accept the desktop `FolderOptions`
object. Its optional fields are `criteria` (`timesize`, `size`, `binary`,
`crc` or `rules`), `timeToleranceSecs`, `include`, `exclude`, `includeFolders`,
`otherFilters`, `excludeHidden`, `flatten`, `ignoreDst`, `ignoreTz`,
`ignoreCaseNames`, `followSymlinks`, and `align`. `timeToleranceSecs` must be between zero and
`i64::MAX / 1000` (the engine stores timestamps in milliseconds). Each `otherFilters` entry
accepts `kind` (`date`, `size` or `content`), `enabled`, `newer`, `days`,
`date`, `larger`, `size`, `notContaining`, `text`, `caseSensitive`,
`wholeWords` and `regex`. Each `align` entry accepts `parent`, `left` and
`right`. Omitted options and fields use the engine's defaults. Unknown fields,
unsupported enum values, out-of-range `timeToleranceSecs`, malformed content
filter regular expressions (including disabled filters), and unsafe alignment or item paths are invalid params. Relative
item paths use slash-separated segments and may not be absolute, empty, `.`,
`..`, contain empty segments, backslashes, drive prefixes or control
characters.

`file.quickCompare` preserves the quick engine's integer verdicts: `1` means
binary-identical, `2` means rules-equivalent, `11` means binary-different,
`12` means similar under rules, `13` means rules-different, and `100` means an
engine I/O/error result. The request mode is required and must be one of the
four listed values.

All three methods require the expected path kind (directories for folder
methods, regular files for quick comparison). Nonexistent or inaccessible paths
return `-32020`; wrong path kinds and malformed params return `-32602`.
Folder methods are read-only and use the existing comparison engines. They add
no per-tree or per-item cap; the existing worker/queue and message/response
limits still apply.

Methods beyond the initial four were added incrementally in protocol 1. They
appear in `capabilities.methods` only for helpers built from a release that
implements them; clients must check capabilities before calling them.

`rules` uses the desktop `Rules` shape (camelCase, every field optional). An
omitted field takes the engine default. Unknown fields are rejected as
invalid params so typos are visible.

### Error codes

| Code | Meaning |
|---|---|
| -32700 | Body is not valid JSON |
| -32600 | Invalid request, message too large, duplicate `initialize`, or request after `shutdown` |
| -32601 | Unknown method |
| -32602 | Invalid params (including relative paths and unknown fields) |
| -32603 | Internal error (a caught engine panic; the helper keeps running) |
| -32002 | Not initialized |
| -32800 | Request cancelled |
| -32010 | No common protocol version (`data.supported`) |
| -32020 | File system error (`data: { path, kind }`) |
| -32021 | Input limit exceeded (`data: { limit, actual }`) |
| -32022 | Server busy (queue full) |

## Client obligations (extension)

- Spawn only from global/default settings in a trusted local workspace.
- Fail explicitly on handshake timeout (10 s), protocol mismatch, missing
  capability, crash, or framing violation. Never silently fall back to another
  mode or installation.
- Reject every pending request when the helper exits, and include the exit
  code/signal plus recent stderr in the error.
- Dispose on deactivation and when the executable settings change, so no helper
  is orphaned.
