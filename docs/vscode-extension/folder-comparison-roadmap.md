# VS Code folder comparison: implementation plan and handoff

## Status and purpose

**Planning only: embedded folder support has not been implemented.** The
extension currently opens folder comparisons in the desktop app. Publication of
this document authorizes documentation only; application implementation requires
separate approval.

This is the portable source of truth for continuing the planning session on
another computer or in another agent session. It complements, rather than
replaces, the existing extension [plan](plan.md), [handoff](handoff.md) and
[backend protocol](backend-protocol.md).

### Branch baseline

- Repository: Antebios/comparecraft.
- Branch at handoff: `feature/quick-compare`.
- HEAD at handoff: `9fad639da4c8cd83107386e9a3d64d3d6b16c36d`.
- Existing uncommitted work implements desktop comparison presets and the
  Compare split-button border fix, with shared UI tests and manual updates.
  Preserve this work; it is not the embedded-folder implementation.
- Phase A tasks T001-T007 below are all **not started**.
- No commit or push was performed for this documentation request.

Saving this document locally does not synchronize computers. Transfer the full
branch and working changes, including untracked files, by committing/pushing or
otherwise transferring a complete patch and new files. Do not rely on Copilot's
machine-local session folder or SQL tracker to carry the plan.

## Scope and confirmed requirements

**First version: local folders, comparison-only.** Reuse the shared SolidJS
Folder Compare view and Rust comparison engines. Do not build a second folder
comparison implementation or broaden the extension's current environment support.

| ID | Requirement |
| --- | --- |
| REQ-001 | Open two local folders inside VS Code through existing compare, folder-picker, parent-folder and remembered-left commands in embedded mode. |
| REQ-002 | Reuse folder tree/gutter, selection, filters, folder modes, navigation, comparison settings, refresh and CRC/Binary/Rules-based presets. |
| REQ-003 | Folder panels are comparison-only: no copy/move/delete/rename/touch, synchronization, folder merge, reports, snapshots or external Open With commands. Explicit desktop launch remains available. |
| REQ-004 | Open normal editable embedded file comparisons from folder rows; parent gutter results reflect saved disk contents, never unsaved editor text. |
| REQ-005 | Persist presets/settings and named folder sessions in VS Code-specific storage, separate from desktop; restore panels after window reload. |
| REQ-006 | Preserve local/trusted-workspace restrictions, read-only backend behavior, explicit errors, capability negotiation and bounded protocol messages. |
| REQ-007 | Preserve desktop and existing embedded file workflows, including Git operations that need to wait for a desktop process. |
| REQ-008 | Provide coherent VS Code UX: theme/focus/keyboard support, responsive toolbars, progress/errors, scope clarity and no misleading unsupported controls or silent fallback. |

Phase A excludes Remote SSH, WSL, Dev Containers, browser/virtual workspaces,
recorded macros, shared desktop settings/sessions, whole-tree filesystem
watchers and embedding the desktop Home/workspace manager.

## Phased roadmap

Later phases are future design milestones, not current functionality or
authorization to implement them.

### Phase A: local comparison-only support (current scope)

Deliver the eight requirements above: tree/gutter, filters, presets, refresh,
navigation, editable file drill-down with disk-only parent verdicts, named
folder sessions and reload restoration. Hide unsupported actions and reject
them at the host boundary. Retain current local/trust guards.

**Exit gate:** actual VS Code/helper integration, packaged-webview checks and
desktop/file regressions pass. Capable helpers open folders without the
unsupported prompt; persistence, errors and disk verdicts are accurate.

### Phase B: full local folder workflows (future)

Add copy, move, delete, rename and synchronization. Decide separately whether
folder merge, snapshots, reports and external commands accompany or follow this
milestone.

Prerequisites:

- Explicit mutation capabilities and validated paths/symlinks.
- Operation previews, confirmations, overwrite/conflict handling and checks for
  changed source/destination files.
- Dirty-document behavior without implicit saves.
- Backup/trash policy, cancellation, partial-success reporting and recovery.
- Accurate post-operation gutter/summary refresh.

**Exit gate:** isolated local runtime tests verify deliberate destructive
operations, permissions, dirty/changed files, partial failures and recovery UX.

### Phase C: authority-aware remote foundations (future)

Do not simply remove remote guards. First design resource identity and execution:

- Distinguish URI scheme/authority from OS paths and the rendering machine from
  the folder-owning machine.
- Review `extensionKind`, host placement, trust and folder pickers.
- Discover/install/version-check helpers on the owning machine; never send
  remote paths to a local backend.
- Scope helper lifecycle, sessions and restored resources by authority.
- Handle missing/disconnected authorities without silently interpreting remote
  paths as local paths.
- Account for latency, large trees, cancellation, reconnect, permissions,
  symlinks, case sensitivity, platform path formats and unavailable desktop
  launch or OS trash.
- Decide same-authority comparison policy. Cross-authority comparisons and
  transfers remain separate, unresolved future scope.

**Exit gate:** resource identities and execution locations are explicit and
tested, with local behavior preserved.

### Phase D: remote comparison-only support (future)

Proposed incremental rollout, with a real-environment gate for each:

1. **Remote SSH:** remote helper/version, permissions, disconnections, remote
   file drill-down and session restoration.
2. **WSL:** Linux-side helper, distribution identity and Windows/WSL path
   separation. Do not assume Windows desktop fallback accepts WSL paths.
3. **Dev Containers:** helper provisioning/architecture, volumes, ephemeral
   lifecycle, rebuild and reconnect restoration.

**Exit gate per environment:** actual remote extension-host tests prove folder
comparison, filters/presets, saved-disk child verdicts, storage/restoration and
reconnect UX. Keep mutations disabled for comparison-only authorities.

### Phase E: full remote workflows (eventual target)

Combine validated Phase B operations with Phase D authorities. Enable
copy/move/delete/rename/synchronization per environment only after verifying
remote permissions, dirty files, stale sources/destinations, backup/trash,
partial execution and interrupted connections.

Use explicit capabilities and confirmations. Local operation success is not
evidence of remote safety. Cross-host copy/sync, remote external apps and desktop
launch require separate decisions.

**Exit gate:** every advertised remote workflow is verified in that environment
with documented failure/recovery behavior and scope.

## Phase A architecture and constraints

| Surface | Current gap / planned integration |
| --- | --- |
| [controller.ts](../../extensions/vscode/src/controller.ts) | `route` sends embedded folders to desktop confirmation. Route validated folder pairs to an embedded panel when capabilities exist. |
| [extension.ts](../../extensions/vscode/src/extension.ts) | File-view detection and spec creation do not support folders. Detect directory inputs before file fallback, including direct callers. |
| [embeddedCore.ts](../../extensions/vscode/src/embeddedCore.ts) | Spec parsing, titles and capabilities need folder support. |
| [embedded.ts](../../extensions/vscode/src/embedded.ts) | Add folder request mapping, real session storage and cross-panel origin associations. Current session handlers return empty/null, including no-op saves. |
| [webview main](../../src/webview/main.tsx) | Render FolderCompare; new tabs currently become serialized `openTab` requests, so callback functions cannot cross panels. |
| [webview host](../../src/webview/host.ts) | Currently emits text state only. Add folder state and disk-result transport. |
| [FolderCompare.tsx](../../src/views/FolderCompare.tsx) | Reuse desired comparison behavior and stale-result guards; gate its mutating/desktop-only commands. |
| [backend.rs](../../src-tauri/src/backend.rs) | Add advertised read-only folder/quick methods, reusing existing engines. |
| [backend protocol](backend-protocol.md) | Additive methods are permitted within protocol 1; changing existing contracts requires a new version. |

Use existing workers, cancellation, helpers and message-size enforcement. No new
dependency or replacement backend is planned. Existing helper cancellation can
suppress late results even when an in-progress engine call cannot stop
immediately.

Use a focused host capability for comparison-only folder views. Desktop defaults
remain unchanged. Gate menus, context actions, toolbar, shortcuts and settings;
independently reject unsupported mutation requests in the extension. UI hiding
is not an authorization boundary.

Validate local absolute base paths and directory kinds, including restored
panels. Support an empty side as a chooser for orphan subfolder navigation,
without comparing an empty path. Reject snapshots and mixed file/folder pairs
clearly. Retain trust, remote-host, executable-discovery and CSP restrictions.

Do not impose arbitrary folder-size limits. Enforce existing protocol limits and
report oversized results explicitly rather than silently truncating trees.
Scans must run off extension/UI threads.

This is an enhancement, not a framework migration. No separate migration spec,
constitution or topology artifacts were supplied. Follow existing contributor
patterns, type safety, shared helpers, explicit errors and regression safeguards.

## Phase A UX decisions

### Launch and folder panel

- Existing **Compare Selected in VS Code**, **Compare Folder With...**,
  **Compare Parent Folder With...** and remembered-left commands open folder
  panels in embedded mode.
- Use a title such as `Folder: left-name <-> right-name`, with full paths inside.
- Reuse path bars, tree/gutter, selection, configured filters, Peek/Suppress,
  display filters, presets, refresh and status bar.
- Preserve initial metadata comparison behavior. Content comparison is explicitly
  requested through existing settings or presets.
- Show **Folder comparison reads saved files on disk.** Child text views may
  contain unsaved buffers; those are not folder disk verdicts.
- Do not require saving/reverting every dirty file just to inspect embedded
  folders. Never auto-save. Retain existing desktop dirty-document safeguards.
- Keep theme variables, visible focus, keyboard access and responsive pin overflow.
- Hide deferred folder operations; editable child file copy/edit controls remain.
- Provide **Open Folder Comparison in Desktop App** for current paths.
- With an older helper, explain required capabilities/update and offer explicit
  desktop fallback or Cancel. Never silently treat folders as text.

### File drill-down and parent results

- Double-click files to open the corresponding text/hex/table/picture view;
  double-click folders expands them, while Open in New View opens a folder panel.
- Preserve existing editable document and stale-write safeguards.
- Issue opaque origin tokens at the host. Do not serialize callbacks or trust
  webview-provided parent IDs/path pairs.
- On completion triggers, re-evaluate the originating pair from disk using
  appropriate existing engine/view semantics. Do not forward an unsaved-buffer
  display verdict.
- Return validated verdict/error and paths to the originating callback. Update
  gutter/ancestors/summary only when token, paths, options, row ticket and
  comparison generation still match. Refresh invalidates older results.
- A child may outlive its parent harmlessly. Dispose associations and callbacks.
- Parent refresh stays explicit; whole-tree filesystem watching is deferred.

### Presets, sessions and restoration

- Keep existing preset editor and choose-versus-run UX. Default scope is All
  Included: configured filters apply, collapsed descendants participate,
  status-display filters do not restrict work, and Peek/Suppress must not broaden
  inclusion. Presets store name/method/scope, not custom filters/rules.
- Keep shared preset library/defaults in VS Code embedded settings; active choice
  and pins belong to each folder session. Do not share desktop storage.
- Implement actual named/recent folder sessions with Save/Save As and lock
  semantics. Add **CompareCraft: Open Saved Folder Session...** Quick Pick.
- Restore latest paths/options, session identity/name/lock and preset choice/pins
  after reload; recompute disk trees rather than persisting huge stale results.
- Scope updates to their panels; shared library changes must not overwrite
  per-session choices in other panels.
- Persistence failures must reach the UI. A no-op or failed save must not show
  a Saved success notification.

## Phase A implementation tasks

All tasks below are pending. Task tracking should be recreated in the next
session; this document carries their portable descriptions and dependencies.

### T001 / P1.1: add read-only backend methods

Requirements: REQ-002, REQ-006, REQ-007.

Extend [backend.rs](../../src-tauri/src/backend.rs) with advertised
`folder.compare`, `folder.compareItems` and `file.quickCompare`, reusing
`folder::compare_folders`, `folder::compare_items` and the quick engine. Validate
request shapes, enums, absolute paths, directory/file kinds and safe relative
items. Preserve result/verdict shapes, workers and limits; expose no filesystem
execution or scripts. Document additive methods in the [protocol](backend-protocol.md).

### T002 / P2.1: route folders and map host requests

Requirements: REQ-001, REQ-002, REQ-006, REQ-007, REQ-008.

Update [controller.ts](../../extensions/vscode/src/controller.ts),
[extension.ts](../../extensions/vscode/src/extension.ts),
[embeddedCore.ts](../../extensions/vscode/src/embeddedCore.ts) and
[embedded.ts](../../extensions/vscode/src/embedded.ts) for folder construction,
validation, titles, restoration and capability negotiation. Map `compare_folders`,
`compare_items` and `quick_compare`. Validate folders before file-view detection,
including direct compareInputs calls. Preserve desktop/onClosed flows and add
explicit current-folder desktop launch; correct fallback messages after support
exists.

### T003 / P2.2: render comparison-only folder UI

Requirements: REQ-002, REQ-003, REQ-007, REQ-008.

Add a focused folder capability in [host index](../../src/host/index.ts), set it
in [webview host](../../src/webview/host.ts), and render FolderCompare through
[webview main](../../src/webview/main.tsx), including new-folder-tab requests.
Gate [FolderCompare](../../src/views/FolderCompare.tsx), Session/FolderSettings,
menus, contexts, toolbar and keyboard registrations. Reuse shared comparison,
filter, preset and MenuList behavior; audit nested settings/submenus. Keep
desktop actions unchanged.

### T004 / P3.1: persist folder settings and sessions

Requirements: REQ-005, REQ-006, REQ-008.

Implement validated VS Code folder session storage/handlers in
[embedded.ts](../../extensions/vscode/src/embedded.ts); extract a helper only if
needed. Extend specs and [main](../../src/webview/main.tsx) /
[host](../../src/webview/host.ts) state transport for paths/options, session
identity/name/lock and active presets/pins. Add the saved-folder Quick Pick in
[extension.ts](../../extensions/vscode/src/extension.ts) and
[manifest](../../extensions/vscode/package.json). Broadcast shared settings.
Fix directly coupled suppressed/no-op persistence errors in
[store.ts](../../src/store.ts) / [sessionMenu.tsx](../../src/views/sessionMenu.tsx)
as necessary so Saved means persisted.

### T005 / P3.2: bridge child saved-disk completions

Requirements: REQ-004, REQ-006, REQ-007, REQ-008.

Implement a bounded host-owned origin-token/callback bridge across
[main](../../src/webview/main.tsx), [host](../../src/webview/host.ts),
[store](../../src/store.ts), [comparisonStatus](../../src/comparisonStatus.ts) and
[embedded.ts](../../extensions/vscode/src/embedded.ts). Preserve ownership when
local child tabs become separate panels; re-compare disk contents before parent
notification. Dispose associations without blocking independent child use.
Retain row/path/generation guards. Test saves, reloads, unsaved buffers, errors,
orphan opening, Compare To and parent disposal.

### T006 / P4.1: validate runtime, regressions and package

Requirements: REQ-001 through REQ-008.

Extend existing Rust backend tests, extension
[backend tests](../../extensions/vscode/test/backend.test.ts),
[core tests](../../extensions/vscode/test/core.test.ts),
[embedded tests](../../extensions/vscode/test/embedded.test.ts),
[host tests](../../extensions/vscode/test/host.ts) and
[manifest tests](../../extensions/vscode/test/manifest.test.ts).
Add focused [UI tests](../../tests/ui) as appropriate. Simulated host tests alone
do not prove extension support: run actual VS Code with the built helper and
verify the VSIX includes the newly built webview.

### T007 / P4.2: document implemented behavior

Requirements: REQ-001, REQ-003, REQ-005, REQ-006, REQ-007, REQ-008.

After implementation, update the [extension README](../../extensions/vscode/README.md),
related extension/root docs advertising folder fallback, the
[folder manual](../manual/folder-compare.md) where behavior differs, and this
roadmap's status. Document backend capabilities, comparison-only/local bounds,
disk-versus-buffer results, named sessions, storage isolation and explicit
desktop fallback. Add screenshots only from implemented UI.

### Dependencies

| Task | Prerequisites |
| --- | --- |
| T001 | None |
| T002 | T001 |
| T003 | T002 |
| T004 | T002, T003 |
| T005 | T001, T002, T003 |
| T006 | T001, T002, T003, T004, T005 |
| T007 | T003, T004, T005 |

T004/T005 conceptually differ but share host/state files; avoid parallel edits
there. Validation and user documentation can proceed independently once
behavior is settled.

## Validation plan (not yet executed for embedded folders)

Use existing configured tooling; inspect current scripts before running:

- Root: `npm run typecheck`, `npm run build`, `npm run build:webview`.
- Backend: `cargo test --manifest-path src-tauri\Cargo.toml --lib backend::tests`,
  focused folder/quick tests and a build of `comparecraft-backend`.
- Extension directory: `npm run typecheck`, `npm test`,
  `npm run test:integration` with `COMPARECRAFT_BACKEND` set to the built helper.
- Focused Playwright folder/preset/lifecycle tests plus embedded transport/UX
  cases. Use filenames as selectors; normalize test fixture relative paths on
  Windows where engine paths require it.
- Extension packaging: `npm run package`, `npm run test:vsix` with existing
  package-validation prerequisites.

Acceptance criteria:

1. Every folder entry point opens embedded panels without desktop prompts when
   capabilities exist; explicit desktop and Git-wait behavior still work.
2. Tree/gutter, nested/orphan rows, masks/advanced/display filters, Peek/Suppress,
   flattening/alignment, rules/methods, refresh and presets match shared semantics.
3. Deferred controls/shortcuts are absent; crafted mutation requests are rejected.
4. Child views are correct; unsaved/apply-only edits do not change parent disk
   verdicts. Saving/reloading can update them. Parent disposal, changed paths,
   filters, refresh and out-of-order receipts invalidate stale results.
5. Named/recent sessions, locks, deletion and reload work; presets remain isolated
   from desktop; storage failures are visible and truthful.
6. Older helpers, missing/unreadable files, malformed paths/options, oversized
   output, backend exit/cancellation and orphan navigation have explicit outcomes.
7. Actual VS Code dark/light/high-contrast, focus/keyboard, narrow panes, long
   paths/names, pin overflow, progress/errors and disk-only notice are verified.
8. Existing embedded file/merge and desktop folder/preset/lifecycle tests pass.

Earlier desktop preset checks passed typecheck, desktop/webview builds and 39
focused tests; the subsequent border fix passed two focused regression tests.
Those results do not validate embedded folder support.

## Requirement mapping

| Requirement | Plan items | Planned completion evidence |
| --- | --- | --- |
| REQ-001 | P2.1, P4.1, P4.2 | Entry points, folder specs, launch tests and user docs |
| REQ-002 | P1.1, P2.1, P2.2, P4.1 | Backend methods, shared rendering and folder/preset tests |
| REQ-003 | P2.2, P4.1, P4.2 | Capability gates, host rejection tests and scope docs |
| REQ-004 | P3.2, P4.1 | Host-origin receipts and saved-disk tests |
| REQ-005 | P3.1, P4.1, P4.2 | Storage, Quick Pick, restoration/failure tests |
| REQ-006 | P1.1, P2.1, P3.1, P3.2, P4.1, P4.2 | Read-only validation, limits, negotiation and errors |
| REQ-007 | P1.1, P2.1, P2.2, P3.2, P4.1, P4.2 | Desktop/file regressions and Git-wait safeguards |
| REQ-008 | P2.1, P2.2, P3.1, P3.2, P4.1, P4.2 | Actual VS Code UX/focus/theme and truthful errors |

All eight requirements map to planned work; this is traceability, not completion.

## Resume checklist

1. Obtain the full branch/working patch, including untracked preset files and
   this roadmap. Inspect Git status and preserve existing work.
2. Read this document and the [protocol](backend-protocol.md); reinspect source
   integration points against the current branch.
3. Recreate T001-T007 and dependencies in the new session tracker. Do not depend
   on the prior machine's session SQL or absolute paths.
4. Confirm implementation authorization. Documentation approval alone does not
   authorize application changes.
5. Implement Phase A only, retaining local/comparison-only boundaries.
6. Record completed tasks, exact validation results, deviations and blockers
   here so the next handoff is self-contained.
7. Propose future phases independently after Phase A passes its gate.

Suggested resume prompt:

> Read docs/vscode-extension/folder-comparison-roadmap.md and inspect the branch.
> Continue Phase A only: local, comparison-only embedded folders. Preserve
> desktop preset/border work. Present the plan for approval before implementation
> unless authorization is already clear. Do not enable remote or folder mutations.
