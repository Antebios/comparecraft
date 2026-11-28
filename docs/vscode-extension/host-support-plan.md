# VS Code host and workspace support plan

## Status and source of truth

**Implemented on `feature/vscode-workspaces` (2026-11-28); not yet merged or
released.** H001-H018 are done except the verifications that need other
machines: WSL (Windows) and host tests of the Arm64 Linux/Windows, Intel macOS
and Alpine packages, which CI builds but can't run. Status and dated evidence
are in [handoff-host-support.md](handoff-host-support.md). The local desktop
extension work is tracked in [plan.md](plan.md) and [handoff.md](handoff.md).
This plan and its handoff are the portable source of truth; no prior chat or
session database is needed to continue.

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

The H0 gate review (2026-11-28) settled the open questions:

- **Engine:** the Rust engine compiled to WebAssembly, not a TypeScript engine.
  Cargo features build it without Tauri; parity tests compare it with the helper.
- **Helper installation:** platform-specific VSIX packages bundle the helper
  (static musl on Linux); the universal VSIX has none and compares files with
  the WebAssembly engine. Releases also carry helper-only Linux archives. The
  desktop app becomes optional.
- **Trust:** Restricted Mode allows read-only comparisons only. **No Git at all**
  (stricter than the decision above: a repository's configuration can run
  programs), no saving and no desktop app until the folder is trusted.
- **Virtual folders:** compared from bounded read-only copies in desktop VS Code.
- **CI:** builds the WebAssembly engine and runs browser and Restricted Mode
  tests, besides per-platform package tests.

The [decisions](decisions.md#host-support) record these and the resulting
behavior.

## Starting point (2026-10-28)

Before this work, the extension:

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

## Implementation summary

| Area | Implementation (paths under `extensions/vscode/` unless noted) |
|---|---|
| Activation | `src/activate.ts`, shared by `src/extension.ts` (Node hosts) and `src/web/extension.ts` (browser), with platform adapters in `src/platform.ts` and `src/nodePlatform.ts`. Manifest: `extensionKind: ["workspace"]`, `browser` entry, limited untrusted and virtual workspace support. |
| Policy | `src/policy.ts` (pure, shared with unit tests): `denial(state, operation, paths)` for desktop, Git, saving, folders and revealing files, plus the menu context keys. Commands, the controller, embedded panel requests and webview capabilities all consult it. |
| Resources | `src/paths.ts`, `src/uris.ts`: file system paths for `file:` URIs in Node hosts, URI strings for everything else; `src/fileAccess.ts` with `src/vscodeFiles.ts` (VS Code's file system API) and `src/nodeFiles.ts`. |
| Engines | `src/engine.ts` routes each request to the helper (`src/helper.ts`) or the WebAssembly engine (`src/wasmEngine.ts`); Rust side `src-tauri/src/protocol.rs` and `src-tauri/src/wasm.rs` (see [backend-protocol.md](backend-protocol.md#webassembly-engine)). |
| Virtual folders | `src/virtualFolders.ts`: bounded copies with progress and cancellation, released with the panel, swept after crashes. |
| Webview | `src/host/index.ts` (`HostCapabilities`), `src/webview/host.ts` and `src/views/FolderCompare.tsx` in the repository root: desktop and reveal actions follow the host; Restricted Mode note. |
| Packaging | `scripts/stage-helper.cjs`, `scripts/package-targets.cjs`, `scripts/prepublish.cjs`, `scripts/build-engine.cjs`, `scripts/build-web.cjs`; CI in `.github/workflows/vscode-extension.yml`. |
| Tests | Unit: `test/hosts.test.ts`, `test/engine.test.ts`, `test/parity.test.ts`. Electron: `test/host.ts`, `test/environments.ts` (virtual workspaces, no helper), `test/restricted.ts`. Browser: `test/web/suite.ts`. Remote: `test/remote.ts`. Runners: `scripts/test-integration.cjs`, `test-web.cjs`, `test-vsix.cjs`, `test-remote.cjs`. |

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
- **H0 gate — not passed** (as of 2026-10-28): do not begin H004-H015 until
  H002 and H003 are resolved in environments that can run the relevant browser
  and remote hosts. H001 source inventory alone is not sufficient approval to
  alter the runtime support boundary.
- **Update 2026-11-28 — H002, H003 and the H0 gate done:** the real engine
  modules build for WebAssembly behind Cargo features, run in the extension
  (Node and browser hosts) and match the helper on every engine fixture; VS Code
  for the Web activates the extension and compares with it. Remote-SSH and Dev
  Containers windows activate the extension in the remote extension host with
  the bundled helper. The owner approved the gate decisions above. Evidence is
  in the handoff.

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

## Capability matrix

As implemented. Commands stay visible; menus use the policy's context keys, and
every refused operation explains why (with a trust action in Restricted Mode).

| Capability | Trusted local | Restricted Mode | SSH / WSL / Dev Container | Virtual provider (desktop VS Code) | Browser-only |
|---|---|---|---|---|---|
| Embedded two-way text compare | Yes | Yes, read-only | Yes, remote helper | Yes, WebAssembly engine | Yes, WebAssembly engine |
| Embedded text write-back | Yes | No | Yes, through VS Code documents | Yes where the provider allows; read-only providers refused | Yes where the provider allows |
| Git comparisons and conflict merge | Yes | No | Yes, Git on the remote host | No (needs a working tree on disk) | No |
| Git staging and tool configuration | Yes, explicit and confirmed | No | Yes, explicit and confirmed, on the remote host | No | No |
| Hex / Table / Picture views | Yes | Yes (read-only views) | Yes, remote helper | Yes, WebAssembly (64 MiB per file) | Yes, WebAssembly (64 MiB per file) |
| Embedded folder comparison | Yes | Yes | Yes, remote helper | Yes, from bounded copies (20,000 files, 512 MB) | No |
| Folder operations in the desktop app | Yes | No | No | No | No |
| Launch local desktop application | Yes | No | No | No | No |
| Reveal in the OS file manager | Yes | Yes | No (VS Code's Explorer instead) | No (Explorer) | No (Explorer) |

Changes from the original targets: Restricted Mode has no Git comparisons or
merge preview (owner decision: no Git at all), virtual and browser hosts have
no Git, and the browser can't compare folders (the helper can't run there).
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
  inside a container. *Resolved by bundling: VS Code installs the platform
  package (with its helper) on the remote host; helper-only Linux archives on
  each release cover manual installs.*
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
  without differential tests and documented limits. *Decided: the Rust engine
  as WebAssembly, with parity tests against the helper.*
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
2. Run the remaining verifications listed in the handoff (WSL on Windows;
   Arm64 and Intel macOS packages where hardware exists; the first CI run on
   GitHub) and record the evidence there.
3. Work one coherent increment at a time; update task status and evidence in the
   companion handoff on the same branch as code changes.
4. Preserve existing local desktop behavior and avoid overwriting unrelated
   work.
5. Before claiming support, satisfy the phase gate and record environment-specific
   results. Keep unresolved platforms explicitly pending or blocked.
