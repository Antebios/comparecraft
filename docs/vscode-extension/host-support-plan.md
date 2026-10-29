# VS Code host and workspace support plan

## Status and source of truth

**Proposed; implementation has not started.** The local desktop extension work
is tracked in [plan.md](plan.md) and [handoff.md](handoff.md). This follow-on
plan and its companion [handoff-host-support.md](handoff-host-support.md) are
the portable source of truth for extending support to other workspace hosts.
No prior chat or session database is needed to continue.

The owner requested support for untrusted workspaces, Remote SSH, Remote WSL,
Remote Dev Containers, virtual workspaces, and browser-only VS Code, with these
decisions:

- **Untrusted:** allow safe read-only comparisons; require trust for Git staging
  and configuration and all other mutations.
- **Remote SSH / WSL / Dev Containers:** run the extension and helper on the
  remote host.
- **Virtual workspaces:** best-effort support where the provider APIs permit;
  explain unsupported operations.
- **Browser-only:** add a web-compatible extension for embedded comparisons;
  do not rely on launching the desktop application.
- **Feature coverage:** publish a tiered capability matrix with clear
  unavailable-action explanations instead of promising full parity everywhere.

These are product targets, not claims of current support. The current extension
continues to require a trusted local desktop workspace until the corresponding
implementation and verification gates pass.

## Current constraints

The implemented extension currently:

- Declares `extensionKind: ["ui"]`, `untrustedWorkspaces.supported: false`, and
  `virtualWorkspaces.supported: false` in `extensions/vscode/package.json`.
- Rejects untrusted workspaces, any `vscode.env.remoteName`, browser UI, and
  workspace folders whose URI scheme is not `file` in
  `extensions/vscode/src/extension.ts`.
- Uses Node process spawning, filesystem APIs, local executable discovery,
  filesystem paths, local Git operations, and snapshots.
- Converts resources to `Uri.fsPath`; embedded document guards and file watchers
  also assume local filesystem paths.
- Has no browser extension entry point; the extension host package uses Node
  APIs even though the comparison panel itself is a webview.

Do not merely remove the manifest declarations or runtime guards. Preserve
existing local behavior and add support only behind explicit host capabilities
and tested safety boundaries.

## H0 inventory findings (2026-10-28)

H001 source inventory is complete. These are the current implementation touch
points for follow-on work:

| Area | Existing implementation | Host-support implication |
|---|---|---|
| Manifest / menus | `extensions/vscode/package.json`; tested in `extensions/vscode/test/manifest.test.ts` | Current `extensionKind` is UI-only; local trusted and `file:` menu assumptions are also asserted by manifest tests. Update metadata, menu contexts and tests together. |
| Host gate / entry | `extensions/vscode/src/extension.ts` (`assertSupported`) | Rejects untrusted, `env.remoteName`, `UIKind.Web`, and non-`file` workspace roots. Centralize policy before changing these checks. |
| Resource/controller boundary | `src/extension.ts`, `src/controller.ts`, `src/contracts.ts` | `LocalResource.path` and `PathInput.path` are strings; `resource()` resolves local real paths; picker and command inputs return `fsPath`. Introduce URI identity before provider support. |
| Backend/process discovery | `src/backend.ts`, `src/discovery.ts`, `src/process.ts` | Uses Node `spawn`, `fs`, `os`, `path`, and local desktop/helper discovery. Remote Node can run a remote helper; browser code cannot import these modules. |
| Git | `src/git.ts`, `src/gitWorkflows.ts`, `src/gitTools.ts`, `src/extension.ts` | Spawns local `git`, reads local index/files, and mutates Git config/stages. Remote use must run Git operations in the workspace host; virtual and browser support needs a separate Git API boundary. |
| Snapshots / document guards | `src/snapshots.ts`, `src/resources.ts`, `src/embeddedCore.ts`, `src/embedded.ts` | Snapshots use Node filesystem storage; stale-write identity and watchers use `fsPath` and file watchers. Provider-aware reads/writes and storage are required. |
| Shared Rust engine | `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/src/backend_main.rs` | Backend is a native stdio process linked through the Tauri package. `comparecraft_lib` includes Tauri and native file-oriented modules; no browser-ready WASM artifact exists. |
| Existing automated coverage | `extensions/vscode/test/manifest.test.ts`, `test/core.test.ts`, `test/host.ts`, `scripts/test-integration.cjs` | Current tests expect local-only manifest declarations and use Electron/Node integration. Add web and remote host suites; do not treat these tests as remote/browser evidence. |

### Feasibility status

- **H001 — done:** inventory above is source-anchored. The local-only assumptions
  span the manifest, resource contracts, controller, backend, Git, snapshots,
  embedded document tracking and test host; changing only `assertSupported()`
  would be unsafe and incomplete.
- **H002 — in progress:** a user-local Rustup stable toolchain (Rust 1.99.1)
  and `wasm32-unknown-unknown` target are installed. Building the entire
  Tauri-containing library for WASM fails because host-specific dependencies
  (`mio`, `getrandom`) are not WASM-compatible. In a temporary crate outside the
  repository, the actual `diff.rs` and `align.rs` modules compile to WASM through
  a thin `wasm-bindgen` wrapper. A temporary VS Code Web fixture also activated
  under Chromium with `@vscode/test-web`. These probes show a focused,
  Tauri-free engine boundary and browser extension host are feasible, but the
  actual extension comparison has not yet run in the browser or been compared
  against Rust golden cases. Keep H002 open for that work and for bundle,
  performance and memory-limit evidence.
- **H003 — in progress:** an isolated Ubuntu 24.04 Dev Container is available
  and the locally built `comparecraft-backend` runs inside it. The existing
  extension `BackendClient` successfully spawned it with Docker stdin forwarding,
  negotiated protocol 1, called `text.diff`, received a non-identical result,
  and shut down. This validates the helper stdio protocol across the container
  boundary, not VS Code remote extension-host activation, remote helper
  discovery/packaging, or extension lifecycle. WSL remains a Windows-only
  validation target. The laptop's pre-existing SSH service was not modified or
  used as a test host.
- **H0 gate — not passed:** do not begin H004-H015 until H002 and H003 are
  resolved in environments that can run the relevant browser and remote hosts.
  H001 source inventory alone is not sufficient approval to alter the runtime
  support boundary.

Baseline checks run from this Omarchy/Linux checkout:

- `npm --prefix extensions/vscode test` — passed: TypeScript build and 54
  extension tests.
- Root `npm test` — passed on rerun: TypeScript typecheck and 88 Rust tests.
  The first invocation had one transient `settings_round_trip_and_export`
  failure (`Null` vs `"dark"`); rerun passed. This is recorded as a baseline
  flake to watch, not changed as part of H001.
- Later feasibility probes and their limits are recorded below in
  [handoff-host-support.md](handoff-host-support.md). They do not establish
  product support or complete the H0 gate.

## Target capability matrix

This matrix defines intended support. Keep commands visible/enabled only when
the active host, trust state, resource provider, and helper capabilities permit
the operation.

| Capability | Trusted local | Untrusted local | SSH / WSL / Dev Container | Virtual provider | Browser-only |
|---|---|---|---|---|---|
| Embedded two-way text compare | Yes | Yes, read-only | Yes, remote helper | Best effort via provider reads | Yes, browser implementation |
| Embedded text write-back | Yes | No | Yes via VS Code documents, if provider allows | Best effort via VS Code APIs | Best effort via VS Code APIs |
| Merge/conflict view | Yes | Read-only preview; no result write/stage | Yes with remote helper and Git | Best effort; no staging promise | Best effort; no desktop launch |
| Hex / Table / Picture views | Yes, per existing support | Read-only | Yes, remote helper | Best effort for readable bounded content | Yes within browser-safe limits |
| Read-only Git comparisons | Yes | Yes | Yes, remote Git API/executable | Best effort when Git/provider supports it | Best effort via available VS Code APIs |
| Git staging/configuration | Yes, explicit/confirmed | No | Yes, explicit/confirmed on remote | Only where supported safely | No terminal/native Git mutation |
| Folder compare/sync/merge in desktop app | Yes | Disabled unless read-only safety can be guaranteed | No remote GUI launch | No native path operations | No |
| Launch local desktop application | Yes | Disabled by default | No | No | No |
| Provider-backed files and folders | Local filesystem | Local filesystem, read-only | Remote filesystem | Best effort | Through browser VS Code APIs |

Unavailable operations must explain why and offer a supported alternative where
possible. Do not silently fall back from an embedded comparison to launching a
desktop app.

## Architecture and safety boundaries

### Host capabilities and extension placement

- Split shared command/controller logic from host-specific adapters.
- Keep Node-only process, filesystem, and executable-discovery code out of the
  browser bundle; add a separate browser entry point.
- Model capabilities explicitly: URI reads, directory enumeration, document
  writes, Git reads, Git mutation, local/remote helper execution, and desktop
  GUI launch.
- Select extension placement so commands needing workspace files and Git execute
  in the workspace extension host. UI-only behavior stays in the UI host where
  appropriate.
- Keep embedded panels in VS Code. Use VS Code URIs and document APIs for
  resource identity and edits; webviews must not assume local filesystem paths.

### Remote hosts and helper

- Run the compatible `comparecraft-backend` on the same host as the remote
  workspace so remote file paths and Git state remain on that host.
- Remote workspace paths must never be passed to a local desktop application.
  Disable desktop-only commands in remote hosts with an explanation.
- Define helper installation/discovery for SSH, WSL and Dev Containers. Verify
  remote OS/architecture compatibility, executable permissions, helper version,
  protocol handshake, startup, crash reporting and clean shutdown.
- Document installing the helper in an SSH host or WSL distribution. Define a
  reproducible Dev Container install path; do not assume the desktop app exists
  inside a container.
- Executable overrides remain user/machine-scoped and are resolved by the host
  that starts the helper. Never execute a workspace-provided command or binary.

### Untrusted workspaces

- Enable limited manifest support only after reviewing every command and
  indirect execution path.
- In restricted mode allow safe read-only comparisons, but deny writes, Git
  staging, Git tool configuration, folder sync/mutation, merge result writes,
  and desktop launches unless their safety can be proven.
- Enforce trust at the controller/host boundary, not just by hiding menu items.
  Direct command invocation must receive the same checks.
- Explain the restricted mode and offer VS Code's trust action when a
  trust-gated command is requested.

### Virtual filesystem providers

- Preserve the full `vscode.Uri` as resource identity. Never convert a
  non-`file` URI to `fsPath`, or treat its URI path as an operating-system path.
- Read through `vscode.workspace.fs`. If a native helper requires a path, create
  an owned, bounded snapshot in extension-host storage and keep it read-only.
- Embedded edits must target the original URI through VS Code document or
  workspace-edit APIs, with stale-write checks. A snapshot is never a
  write-back destination.
- Use `readDirectory` and `readFile` for best-effort read-only folder snapshots
  only when the provider supports them and configured limits are respected.
  Disable copy, move, sync, merge-output and other mutations unless an explicit
  provider-safe implementation exists.
- Surface unsupported schemes, denied permissions, provider limitations,
  cancellation and size limits. Never substitute empty content or silently fall
  back to a local filesystem path.

### Browser-only VS Code

- Add a browser-compatible extension entry point and bundle with no Node built-in
  imports, process spawning or native executable discovery.
- Use VS Code browser APIs for documents and filesystem resources; never promise
  desktop app launch.
- First run a feasibility spike for compiling/reusing the Rust engine as
  WebAssembly. If that is not practical, evaluate a narrowly scoped TypeScript
  engine against the Rust golden cases. Do not ship divergent compare semantics
  without differential tests and documented limits.
- Bound memory and input sizes; cancel long-running comparisons and release
  buffers when panels close.
- Do not upload workspace content to remote services. Preserve the existing
  webview content-security policy.

## Phases, tasks and gates

Task IDs are stable and their status belongs in
[handoff-host-support.md](handoff-host-support.md). Paths are implementation
targets, not a claim that code exists. Every status change must include evidence.

### H0 — Feasibility and capability inventory

- **H001:** Inventory Node-only imports, process launches, filesystem-path
  conversions, local Git assumptions, storage, command visibility and tests.
  Map them to the capability matrix.
- **H002:** Prototype browser-host activation and an embedded text comparison.
  Compare a WebAssembly build of the Rust engine with a TypeScript fallback only
  if necessary. Record parity, performance, bundle size and limits.
- **H003:** Prototype remote extension-host activation and stdio helper
  handshake in one supported remote environment. Establish helper packaging and
  install steps for SSH, WSL and Dev Containers.
- **Gate:** Review engine choice, helper installation model, trust behavior and
  capability matrix before broad implementation.

### H1 — Host abstractions and URI-safe resources

- **H004:** Add typed host capabilities and separate native Node, remote Node,
  and browser adapters. Isolate Node-only imports from shared logic.
- **H005:** Convert resource boundaries to typed VS Code URIs. Add provider
  reads, bounded owned snapshots, URI-aware document guards, writes,
  cancellation and cleanup tracking.
- **H006:** Add one capability-policy layer for command availability based on
  host, trust, URI scheme/provider, helper capabilities and desktop availability.
- **Gate:** Existing trusted local behavior remains unchanged. Tests prove
  non-file resources never flow to `fsPath` or an unintended process launch.

### H2 — Remote SSH, WSL and Dev Containers

- **H007:** Validate remote extension placement, activation, webview resources,
  settings/storage scope, logging and helper lifecycle.
- **H008:** Implement remote helper discovery, health checks and installation
  instructions for SSH, WSL and Dev Containers, including protocol/version
  errors.
- **H009:** Route embedded text, merge, Hex, Table and Picture operations to the
  remote helper; route writes and supported Git actions through VS Code/remote
  APIs. Disable desktop GUI and local-path operations remotely.
- **Gate:** Complete end-to-end remote checks and verify path separation, no
  unintended file transfer and clean helper shutdown.

### H3 — Untrusted workspaces

- **H010:** Enable limited untrusted support and allow safe read-only embedded
  comparisons. Gate mutations and desktop launches behind trust.
- **H011:** Audit direct and indirect commands for writes, process execution,
  Git configuration, staging, snapshots and GUI launch; add runtime enforcement.
- **Gate:** Untrusted tests prove read-only comparisons work and trust-gated
  operations are denied even when invoked directly; trusted behavior regresses
  cleanly.

### H4 — Virtual providers

- **H012:** Implement file comparisons from provider `readFile` and URI-backed
  documents. Support write-back only through the provider and VS Code APIs.
- **H013:** Add bounded, read-only virtual-folder enumeration/snapshots where
  provider methods permit; leave native mutations unavailable.
- **Gate:** Test readable/writable, read-only, directory, permission failure,
  missing-method, cancellation and oversized-resource providers. Each
  unsupported case explains the missing capability.

### H5 — Browser-only VS Code

- **H014:** Ship the web-compatible extension entry and browser-safe comparison
  engine chosen at H002. Implement embedded text comparison and supported
  document writes.
- **H015:** Add browser-safe read-only views/Git reads only when APIs support
  them. Disable all native/desktop commands explicitly.
- **Gate:** Run in the browser extension host without Node built-ins,
  process spawning, local filesystem access or network upload of workspace data.
  Verify limits, cancellation and panel lifecycle.

### H6 — Validation and user documentation

- **H016:** Add unit, host-integration and browser tests for all capability
  classes and security boundaries.
- **H017:** Update the user guide, extension README, manifest descriptions,
  troubleshooting, setup/release instructions and screenshots for host-specific
  support.
- **H018:** Record actual host/OS/architecture/helper versions and test evidence
  in the handoff. Do not mark support based only on package builds or unit tests.
- **Gate:** Each advertised host has reproducible setup instructions, automated
  results, and manual smoke evidence where applicable. Unsupported combinations
  remain clearly documented.

## Windows continuation and portability

The next implementation computer may be Windows. The checked-in files in
`docs/vscode-extension/` are the handoff; do not depend on this Linux home
directory, installed Linux app/helper, ignored build outputs, session state, or
chat history.

### Transfer

1. Make sure `host-support-plan.md`, `handoff-host-support.md`, and the link from
   `plan.md` are included in an approved commit/branch and are available on the
   remote repository. Uncommitted files on the Omarchy/Linux computer are not
   visible to a clean Windows checkout.
2. On Windows, inspect `git status` and the current branch before switching or
   merging. Preserve unrelated work. Fetch/switch to the branch containing the
   handoff; do not reset or discard a dirty worktree.
3. Read this plan and handoff, then the existing `plan.md`, `decisions.md`,
   `handoff.md` and `backend-protocol.md`. Confirm the next task is approved and
   unblocked before implementation.
4. Record the Windows commit/ref, branch, VS Code version, Windows version and
   available remote test targets in the handoff before starting.

### Windows prerequisites and baseline

- Windows 10/11 with VS Code desktop and the Extension Development Host.
- Git for Windows and a clean clone of the repository.
- Node.js and npm versions required by the current
  [extension developer guide](../../extensions/vscode/DEVELOPMENT.md).
- Rust stable and the Windows C++ build prerequisites only when building the
  helper/desktop app; use the documented repo setup rather than assuming Linux
  binaries are portable.
- Docker Desktop only for Dev Container validation; working SSH credentials or
  a remote test host for Remote SSH; WSL installed for WSL validation.
- Use disposable test workspaces and Git repositories. Never use a production
  repository to test staging or Git tool configuration.

Start with the existing baseline documented in
[DEVELOPMENT.md](../../extensions/vscode/DEVELOPMENT.md): install dependencies
with `npm ci` from the repository root and the extension directory, then run
`npm run build:all`, `npm test`, and the applicable integration/VSIX checks from
`extensions/vscode`. Update command instructions if prerequisites change.

### Cross-platform evidence

Record results separately for native Windows, Linux, macOS, Remote SSH,
Remote WSL, Dev Containers, virtual providers and browser-only VS Code. For
each run include:

- Date, commit, OS/architecture, VS Code host/version and extension version.
- Remote distro/container/provider scheme and helper version/protocol where
  applicable; redact hostnames and private paths.
- Exact command/test, pass/fail/blocked status, relevant output and known gaps.
- Whether evidence is unit, integration, manual UI or packaged-installer
  validation. A Windows build does not prove remote or browser support.

## Continuation steps

1. Follow the Windows transfer procedure above and inspect status/instructions.
2. Begin with H001-H003; do not skip the feasibility gate.
3. Work one coherent increment at a time; update task status and evidence in the
   companion handoff on the same branch as code changes.
4. Preserve existing local desktop behavior and avoid overwriting unrelated
   work.
5. Before claiming support, satisfy the phase gate and record environment-specific
   results. Keep unresolved platforms explicitly pending or blocked.
