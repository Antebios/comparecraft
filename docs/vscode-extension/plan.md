# CompareCraft VS Code extension implementation plan

## Status and purpose

**Phases 1 and 2 are complete.** Phase 1 (T001-T003) was accepted by the owner;
on 2026-10-21 the owner confirmed opening the extension in the Extension
Development Host and testing context menus on Windows. Phase 2 (T004-T006,
snapshots, Git comparisons/conflicts, opt-in Git tools) passed its automated gate
on Windows with real Git fixtures; manual desktop-GUI journeys are listed in
[handoff.md](handoff.md). Phase 3 (T007-T008, headless `comparecraft-backend`
helper, protocol client, packaging) is complete and verified on Windows,
including against an installed build. Phase 4 (T009-T010, host adapters,
webview bundle, embedded text-comparison panels) is complete: it passed its
automated gate on Windows against the installed helper, and on 2026-10-22 the
owner confirmed it in the Extension Development Host (after the undo/Ctrl+Z
fixes recorded in [handoff.md](handoff.md)). Phases 5-6 remain pending. Native Linux/macOS
validation is still required.
This directory is the portable source of truth: no prior chat or session database
is required to resume. Read [decisions.md](decisions.md) and
[handoff.md](handoff.md) before working.

Build one extension with two experiences: embedded CompareCraft editor tabs and
commands that launch the installed desktop app. Share SolidJS views and the Rust
engine with the standalone Tauri app. Deliver useful external integration first.

These requirements capture user-confirmed choices. No separate formal spec,
constitution, or topology artifact exists for this feature. Detailed engine and
protocol design is a prerequisite task, not an already completed artifact.

## Requirements

| ID | Requirement |
|---|---|
| REQ-001 | One extension, explicit embedded/desktop commands, configurable default initially embedded, no silent fallback. |
| REQ-002 | Require installed CompareCraft; discover Windows/macOS/Linux installations; allow executable overrides with actionable errors. |
| REQ-003 | External files/folders, Select Left, pickers, parent-folder, selections, clipboard, saved-version, and existing-diff workflows. |
| REQ-004 | Git working/index/HEAD/chosen-revision comparisons and explicit merge/rebase/cherry-pick/stash conflict resolution. |
| REQ-005 | Opt-in Git mergetool/difftool setup; explicit staging; no automatic Git continue/abort. |
| REQ-006 | Protect unsaved buffers, snapshots, original labels, temporary lifetimes, and conflict-aware write-back. |
| REQ-007 | Share the Rust engine and ship a versioned stdio backend through desktop installers; preserve desktop behavior. |
| REQ-008 | Embedded text comparison followed by remaining compare/merge/sync/edit/patch views. |
| REQ-009 | Trusted execution, safe process launch, validated messages, explicit errors, and destructive-operation protection. |
| REQ-010 | Portable incremental delivery, recorded platform validation, documentation, and an installable VSIX. |

## Technical context

- Frontend: SolidJS, TypeScript, Vite. `src/api.ts` wraps Tauri command calls.
- Direct Tauri service imports also occur in `src/App.tsx`, `src/store.ts`,
  components, and views; changing `invoke` alone is insufficient.
- `src-tauri/src/lib.rs` delegates commands to Rust engine modules.
- `src-tauri/src/main.rs` and `console.rs` handle CLI/GUI requests; neither exposes
  a persistent backend service. `ccomp` waits for the GUI, but its current
  completion behavior does not establish successful conflict resolution.
- `src-tauri/src/cli.rs` supports file/folder launch, titles, read-only flags,
  viewer selection, and left/right/ancestor/output arguments for three-way merge.
- Existing platform Tauri configs, `scripts/`, and `.github/workflows/build.yml`
  are the installer/build integration points.

## Constraints and proposed structure

- `extensions/vscode/`: isolated extension manifest/toolchain, host, commands,
  discovery, snapshots, Git integration, backend client, tests, and VSIX packaging.
- `src/`: shared views and typed host adapters, plus a separate webview entry/build.
- Shared Rust engine crate: decided in T007; the existing `comparecraft_lib` is the
  shared engine and the helper is a third bin (see [backend-protocol.md](backend-protocol.md)).
- `src-tauri/`: retain desktop host and add the headless helper entry point.
- Existing installers distribute the helper. No native engine in the VSIX,
  automatic engine download, TCP listener, or OS service.
- Support local desktop Windows/macOS/Linux first. Explicitly defer SSH, WSL,
  Dev Containers, browser-only hosts, and unsupported virtual filesystem resources.
- Preserve standalone app behavior, settings, backup, encoding, BOM, and EOL rules.
- Follow repository instructions and existing patterns; no migration-specific
  transformation guidelines apply to this additive feature.
- No commits, pushes, Git configuration changes, installation, or publication
  are implicitly authorized by approval of these planning documents.

## Incremental phases and concrete tasks

Stable task IDs are tracked in [handoff.md](handoff.md), not Markdown checkboxes.
Every phase ends with a usable increment and an evidence-based acceptance gate.
Paths below are implementation targets, not claims that new files already exist.

### Phase 1: foundation and core external integration

**Plan item 1.1. Requirements:** REQ-001, REQ-002, REQ-003, REQ-006, REQ-009, REQ-010.

- **T001 [Plan:1.1]:** Inspect current instructions and create isolated
  `extensions/vscode/package.json`, TypeScript entry/build/test configuration,
  manifest commands/settings, and typed comparison contracts. Preserve `.vscode/`.
- **T002 [Plan:1.1]:** Implement discovery/process modules in
  `extensions/vscode/src/`: desktop/backend executable overrides, platform
  candidates, trusted execution, argument-array launch, and visible failure actions.
- **T003 [Plan:1.1]:** Implement Explorer/editor/tab/palette commands and menus in
  `extensions/vscode/`: two files/folders, Select Left/Compare with Left, pickers,
  parent folder, explicit launch modes, and default-mode routing.

**Gate:** core external workflows work with an existing installation; no new
backend is required. Unsupported embedded/default commands show an explanation
and explicit desktop action. External-only availability is documented.

### Phase 2: full external content and Git integration

**Plan item 2.1. Requirements:** REQ-003, REQ-004, REQ-006, REQ-009.

- **T004 [Plan:2.1]:** Implement snapshot/content modules in
  `extensions/vscode/src/` for dirty/untitled buffers, selections, clipboard,
  saved versions, and existing diffs. Verify read-only flags, meaningful labels,
  ownership tracking, GUI handoff lifetime, and conservative cleanup.
- **T005 [Plan:2.1]:** Implement Git/Source Control commands in
  `extensions/vscode/src/`: HEAD/index/working/chosen-revision comparisons and
  explicit conflict resolution from unmerged index stages. Handle multiple
  repositories, missing sides, operation labels, dirty editors, and stale results.

**Plan item 2.2. Requirements:** REQ-004, REQ-005, REQ-006, REQ-010.

- **T006 [Plan:2.2]:** Add opt-in reversible mergetool/difftool setup and docs in
  `extensions/vscode/`. Verify `src-tauri/src/console.rs` wait/success/cancel
  behavior; change completion semantics only if necessary, with regressions.

**Gate:** full external workflow matrix works in disposable Git fixtures,
including merge and rebase. No automatic staging or continuation; Git config
scope requires consent and can be reversed without overwriting later user edits.

### Phase 3: shared Rust backend and installer delivery

**Plan item 3.1. Requirements:** REQ-007, REQ-009, REQ-010.

- **T007 [Plan:3.1]:** Inspect `src-tauri/src/` dependencies; record the chosen
  crate boundary and protocol contract in this documentation directory before
  extraction. Implement shared engine and headless helper with handshake,
  framing, request IDs, capability/version checks, limits, cancellation, errors,
  and stderr diagnostics. *Done:* contract in
  [backend-protocol.md](backend-protocol.md); `src-tauri/src/backend.rs` plus the
  `comparecraft-backend` bin.
- **T008 [Plan:3.1]:** Add the client in `extensions/vscode/src/` and helper
  build/sign/bundle/CI integration in `scripts/`, `src-tauri/tauri*.conf.json`,
  and `.github/workflows/build.yml`. Verify actual installed helper locations.

**Gate:** a helper installed outside the development tree negotiates capabilities
and performs text operations. Incompatibility/crashes fail explicitly. Desktop
regressions pass; package placement/signing is verified, not assumed.

### Phase 4: embedded text comparison

**Plan item 4.1. Requirements:** REQ-001, REQ-006, REQ-007, REQ-008, REQ-009.

- **T009 [Plan:4.1]:** Introduce typed host adapters around `src/api.ts` and all
  direct Tauri service imports under `src/`; retain desktop implementations.
  Add a webview build that does not eagerly import Tauri-only runtime code.
- **T010 [Plan:4.1]:** Connect secure webviews in `extensions/vscode/` to the
  shared text UI/backend. Implement themes/focus/navigation, panel state, guarded
  document edits, undo/save/dirty behavior, and lossless close/reload handling.
  Use custom-editor integration if needed before enabling writes.
  *Done:* a `WebviewPanel` with a serializer and guarded `TextDocument` writes
  was chosen over a custom editor (see [decisions.md](decisions.md)).

**Gate:** embedded comparisons use current buffers and protect intervening edits.
Test concurrent panels, backend failures, undo/save/close/reload, and unchanged
desktop text behavior. A rendered webview alone is not evidence of safe editing.

### Phase 5: embedded conflicts and remaining views

**Plan item 5.1. Requirements:** REQ-004, REQ-005, REQ-006, REQ-008, REQ-009.

- **T011 [Plan:5.1]:** (done; owner F5 sign-off 2026-10-23) Adapt `src/views/TextMerge.tsx` and Git routing for embedded
  three-way resolution, operation-aware labels, and explicit save/review/stage.
  Adds `comparecraft.gitResolveConflictEmbedded`; the merge panel reuses the
  text-compare view type, writes only the result file (guarded against stale
  edits), offers staging only after a marker-free save, and offers unsaved
  merged text as an Untitled document on close/reload. Automated: 47 unit tests
  and the VS Code integration test pass.
- **T012 [Plan:5.1]:** (done; owner F5 sign-off 2026-10-23) Extend protocol/host adapters across `src/views/` for folder
  compare/sync/merge, hex, table, picture, text edit, and patch. Maintain a per-view
  capability matrix, read-only constraints, and destructive confirmations.
  Scope B: read-only Hex/Table/Picture (new helper methods `hex.align`,
  `table.compare`, `pix.compare`, `pix.image`) and Patch in the embedded panel;
  Text Edit uses VS Code's editor; Folder Compare/Sync/Merge are explicit
  desktop-only release gaps. Capability matrix in `extensions/vscode/README.md`.
  Automated: 51 unit tests, 13 helper tests, and the VS Code integration test
  (with a T012 helper, and the text fallback with an older one) pass.
  Follow-up (owner request): Table Compare matches Beyond Compare's defaults
  (key column 1, no header row) and layout (two independently scrolling sides,
  details for the selected side) in both the desktop app and VS Code.

**Gate:** all existing view kinds work or remain explicitly blocking release
gaps. Verify format/backup preservation, large-payload boundaries, unsupported
conflicts, and destructive folder behavior; no placeholder successes.

### Phase 6: cross-platform validation and release handoff

**Plan item 6.1. Requirements:** REQ-001 through REQ-010.

- **T013 [Plan:6.1]:** Complete [handoff.md](handoff.md)'s workflow/platform matrix
  and extension/Rust/desktop regressions; record installed-artifact checks by
  OS, architecture, and package. Never mark unexecuted checks as passed.
- **T014 [Plan:6.1]:** Finalize README/configuration/Git setup/troubleshooting and
  reproducible VSIX/CI artifacts in `extensions/vscode/` and `.github/workflows/`.
  Verify upgrade/removal and reversible Git setup. Do not publish automatically.

**Gate:** installable VSIX and compatible installers are verified on supported
platforms; remaining unsupported environments and gaps are documented.

## Dependencies

| Task | Prerequisites |
|---|---|
| T001 | Phase 1 approval (received) |
| T002 | T001 |
| T003 | T002 |
| T004 | T003 |
| T005 | T004 |
| T006 | T005 |
| T007 | T001 |
| T008 | T002, T007 |
| T009 | T007 |
| T010 | T008, T009 |
| T011 | T005, T010 |
| T012 | T010 |
| T013 | T006, T011, T012 |
| T014 | T013 |

The Rust branch can proceed independently of advanced external commands after
T001. Prefer completing phase gates; coordinate file ownership across computers.

## Validation strategy

Application type: desktop plus VS Code extension/webview.
Use focused existing TypeScript/Rust checks, extension tests, and VS Code
Extension Development Host integration checks. A browser-only UI check cannot
substitute for extension/document/menu/process validation.

Critical journeys: desktop two-file/folder launch; current buffer versus disk;
snapshot survival after GUI handoff; HEAD/index/working comparisons; merge/rebase
save without implicit staging; installed-helper embedded text; stale write
rejection; guarded folder sync.

Use disposable repositories and owned fixtures for Git/conflict/destructive tests.
Record missing GUI/platform/signing facilities as gaps. Existing checks include
`npm run typecheck`, `npm run test:rust`, and `npm run build`; choose the smallest
relevant command. Record extension test commands once those scripts exist.

## Requirement mapping

Expected evidence is planned, not yet implemented.

| Requirement | Plan items | Expected evidence |
|---|---|---|
| REQ-001 | 1.1, 4.1, 6.1 | Manifest/settings, mode routing and panel tests |
| REQ-002 | 1.1, 6.1 | Discovery tests and installed launch matrix |
| REQ-003 | 1.1, 2.1, 6.1 | Command/menu/content/diff tests |
| REQ-004 | 2.1, 2.2, 5.1, 6.1 | Git adapter, merge/rebase/other conflict fixtures |
| REQ-005 | 2.2, 5.1, 6.1 | Consent/reversible setup and explicit staging tests |
| REQ-006 | 1.1, 2.1, 2.2, 4.1, 5.1, 6.1 | Dirty-input guards, snapshot lifetime and document/version tests |
| REQ-007 | 3.1, 4.1, 6.1 | Protocol, engine regressions, installed-helper tests |
| REQ-008 | 4.1, 5.1, 6.1 | Embedded view capability matrix |
| REQ-009 | 1.1, 2.1, 3.1, 4.1, 5.1, 6.1 | Trust/process/message/confirmation tests |
| REQ-010 | 1.1, 2.2, 3.1, 6.1 | Portable ledger, platform CI, VSIX and installer evidence |
