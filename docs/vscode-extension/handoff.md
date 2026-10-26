# Portable implementation handoff

## Current state

**Phases 1-3 are complete and committed** on `feature/vscode-ui` (Phase 1:
`f595f27`, `be98a7c`; Phase 2 and the `ccomp` fix: `e565e21`, `7051dc8`,
`5532e29`; Phase 3: `3d5cdc0`). **Phase 4 (T009-T010, embedded text
comparison) is complete**: it passed its automated gate on Windows and the owner
confirmed it in the Extension Development Host on 2026-10-22 (after the undo and
Ctrl+Z fixes below); it is committed by the owner after this update.
**Phase 5 is complete.** T011 (embedded three-way conflict merge) and T012
(remaining views) both passed the owner's F5 test on 2026-10-23. T012's
sign-off also brought a Table Compare follow-up (Beyond Compare parity) that
changes the shared view in both the desktop app and VS Code; see the Phase 5
handoff. **Phase 6 (T013-T014) is complete**, closed on 2026-10-24 after the
owner confirmed successful Linux use. Windows verification and local Linux
VSIX lifecycle checks are recorded below. Native macOS, untested installer
variants, and remote CI remain explicit verification gaps, not claimed passes.
No Marketplace publication has been performed. Git configuration is changed
only by the user-invoked, confirmed setup command; tests use disposable
repositories and a temporary `GIT_CONFIG_GLOBAL`.

- Planning branch: `feature/vscode-ui`; inspect actual branch/status when resuming.
- An unrelated untracked `.vscode/` directory existed during planning. Preserve it.
- These documents are local until transferred. Commit/push or other transfer is
  a separate user-authorized step before another computer can read them.
- This ledger is the execution source of truth. Session SQL is only a convenience.

## Resume procedure

1. Inspect current Git branch/status and applicable repository instructions.
   Never reset or overwrite another session's work.
2. Read [plan.md](plan.md), [decisions.md](decisions.md), and this ledger.
3. Confirm implementation approval and the next unblocked task. If approval is
   absent, do not begin application edits.
4. Mark the task in progress, with owner if other sessions/computers are active.
   Coordinate file ownership or use separate branches and reviewed integration.
5. Inspect affected code and local prerequisites. Do not assume Windows paths,
   installed tools, or native build outputs exist on Linux/macOS.
6. Complete one coherent increment and focused verification; record evidence.
7. Update status, blockers, changes, commands/results, next task and transfer state.
   Record commit/ref only if actually created.

Suggested future-session request:

> Read docs/vscode-extension/plan.md, decisions.md, and handoff.md. Inspect Git
> status. Resume the next approved, unblocked task, preserving unrelated changes.
> Verify that increment and update the portable handoff documents before stopping.

## Task ledger

Statuses: pending, in_progress, blocked, done. Done requires recorded verification.
Planning coverage is not evidence of implementation completion.

| Task | Phase | Status | Prerequisites | Owner / evidence / blocker |
|---|---|---|---|---|
| T001 | 1 | done | Phase 1 approval received | Isolated manifest/build/dev workspace; activation and contribution tests pass |
| T002 | 1 | done | T001 | Discovery/process tests, installed Windows discovery, CLI/GUI smoke pass |
| T003 | 1 | done | T002 | Controller tests and real VS Code host command/file/folder dispatch pass |
| T004 | 2 | done | T003 | Snapshot store/session, buffer/selection/clipboard/saved/diff commands; unit + host tests pass |
| T005 | 2 | done | T004 | Git HEAD/index/working/revision and conflict resolve/stage; real merge/rebase/cherry-pick fixtures pass |
| T006 | 2 | done | T005 | Reversible mergetool/difftool setup; real `git mergetool` run and installed `ccomp` wait smoke pass |
| T007 | 3 | done | T001 | Contract in backend-protocol.md; `comparecraft-backend` bin; 11 unit + 3 stdio integration tests pass |
| T008 | 3 | done | T002, T007 | Client/manager/discovery + Check Embedded Backend; 8 client tests incl. real helper; signing/ZIP/PKGBUILD updated; verified against the reinstalled helper in real VS Code |
| T009 | 4 | done | T007 | `src/host/` adapters (Tauri + VS Code); 20 shared files import only the host; `npm run build:webview` bundle has 0 Tauri references; desktop typecheck/build pass |
| T010 | 4 | done | T008, T009 | `embedded.ts` WebviewPanel + serializer, CSP, validated RPC, guarded document writes, external-change events, restore on close/reload; 45 unit tests; real VS Code host test with installed helper passes; owner F5 test passed 2026-10-22 after undo/Ctrl+Z fixes |
| T011 | 5 | done | T005, T010 | Embedded three-way merge (`gitResolveConflictEmbedded`); 47 unit tests; real VS Code host test incl. merge result-only/CRLF/unsaved-edit refusal; owner F5 test passed 2026-10-23 after three fixes |
| T012 | 5 | done | T010 | Scope B: read-only Hex/Table/Picture/Patch panels, Text Edit in VS Code's editor, folder views desktop-only; 4 new helper methods; 51 unit + 13 helper tests; host test passes with a T012 helper and falls back to text with an older one; owner F5 sign-off 2026-10-23. Follow-up: Table Compare defaults to key column 1 with no header row, two independently scrolling sides, details pane for the selected side |
| T013 | 6 | done | T006, T011, T012 | Windows x64 matrix and regressions recorded below; owner confirmed Linux success and requested closeout on 2026-10-24; remaining platform/package gaps retained |
| T014 | 6 | done | T013 | VSIX build and isolated install/upgrade/content/host-test/uninstall pass on Windows and Linux; Linux helper-specific steps skipped; docs, icon, and opt-in Marketplace workflow complete; owner Linux sign-off 2026-10-24 |

## Platform/workflow evidence

Replace not run with pass/fail/blocked and evidence. Record OS/architecture,
VS Code version, app/helper/protocol versions, and installer type.

Windows column: Windows x64, VS Code 1.143.1 (x64 user install), CompareCraft
0.1.0 NSIS per-user install at `%LOCALAPPDATA%\CompareCraft`, helper protocol 1.
The MSI package was not tested. Linux: owner confirmed successful extension use
on 2026-10-24; local automated lifecycle checks used Linux x64 and VS Code 1.139.1,
without a built helper. The owner did not report a distribution, installer format,
or per-journey breakdown, so this is not blanket coverage of the Linux column.
macOS has no native verification recorded. "CI" means configured coverage in the
`vscode-extension` workflow (unit tests, VSIX package, `test:vsix` with host
tests against a source-built debug helper; Linux under Xvfb), which has not yet
run as far as the recorded evidence shows. CI does not exercise installed
packages, native menus, or the desktop GUI.

| Journey | Windows | Linux | macOS |
|---|---|---|---|
| Overall extension use / owner sign-off | owner F5 sign-off in Phases 4-5 | owner confirmed success and requested Phase 6 closeout on 2026-10-24; individual journeys not specified | not recorded |
| Installed discovery, custom paths, spaces | automated pass; default per-user install and override tested | candidate unit tests (CI); native not run | candidate unit tests (CI); native not run |
| Files/folders, Select Left, pickers | host/unit pass; owner F5 use in Phases 4-5 | local host pass for file/folder dispatch, Explorer multi-selection, independent left selections; native picker visuals not recorded | host test (CI); native menus not run |
| Dirty/untitled, selections, clipboard, saved version | unit pass (snapshot content, read-only, release); commands registered in host; owner F5 use | unit/host (CI) | unit/host (CI) |
| Snapshot survival after GUI handoff | design: `-solo` dedicated process + PID marker sweep; unit pass; manual GUI not run | unit (CI) | unit (CI) |
| HEAD/index/working/revisions and existing diff | real Git fixture pass (content/labels); diff forwarding manual not run | Git fixture unit tests (CI) | Git fixture unit tests (CI) |
| Merge/rebase/cherry-pick/stash resolution | real Git fixture pass; owner manual embedded and desktop merge pass 2026-10-23 | Git fixture unit tests (CI) | Git fixture unit tests (CI) |
| Missing stages, renames, binary conflicts | add/add empty base and modify/delete refusal pass; binary/link/submodule unit pass | unit (CI) | unit (CI) |
| Opt-in Git setup, wait/cancel, reversal | local+global (temp `GIT_CONFIG_GLOBAL`) apply/remove restores earlier values and keeps later edits; real `git mergetool` with fake tool pass; installed `ccomp -solo` waits for GUI | unit incl. real `git mergetool` (CI) | unit incl. real `git mergetool` (CI) |
| Installed helper, incompatibility, crash | installed 0.1.0 helper: contract test, Check Embedded Backend and all host tests pass; crash/mismatch/timeout/framing via fake helper pass | source-built helper contract + host tests (CI); installed deb/rpm/AppImage not run | source-built helper (CI); installed app/signing not run |
| Embedded text, edits, undo/save/close/reload | host test pass (CSP bundle, concurrent panels, CRLF, unsaved buffers, stale-write refusal); owner F5 pass 2026-10-22 | host test (CI) | host test (CI) |
| Embedded merge and remaining views | host test pass with installed helper (merge result-only/CRLF/unsaved refusal; hex/table/picture/patch/Text Edit); owner F5 pass 2026-10-23 | host test (CI) | host test (CI) |
| Formats/backups, read-only, destructive confirmations | line endings preserved and read-only sides refuse writes (host); embedded mode has no backups and no destructive folder operations (desktop only); staging asks for confirmation (unit) | host/unit (CI) | host/unit (CI) |
| VSIX install/upgrade/removal | `test:vsix` pass 2026-10-23: isolated install 0.0.1, upgrade to 0.1.0, 20-file content check, 8 host tests on the installed files with the installed helper, uninstall; separate owner install in normal Windows VS Code not recorded | local `test:vsix` PASS 2026-10-24: install 0.0.1, upgrade 0.1.0, 24-file content check including icon, host tests, uninstall; helper steps skipped | `test:vsix` (CI) |
| Desktop regressions | desktop typecheck/build pass; Rust: all suites pass except 14 pre-existing `script_golden` failures ("Unexpected argument(s)"), unchanged by this work | existing `build` workflow | existing `build` workflow |

Distinguish Windows NSIS/MSI, Linux deb/rpm/AppImage, and macOS app/signing.
One package/architecture result does not implicitly cover another.
Use disposable Git repositories for configuration/conflict tests, never this
working repository. Cleanup only explicitly owned fixtures.

## Verification

Existing root commands:

```text
npm run typecheck
npm run test:rust
npm run build
```

Phase 1 checks (from `extensions/vscode` unless stated otherwise):

- `npm test`: 15 tests passed, zero failures/skips. Includes candidate discovery
  for all three platforms, explicit override errors, kind/count/duplicate checks,
  picker cancellation, mode fallback, dirty-resource guards, manifest, and actual
  process arguments/spawn/nonzero-exit errors.
- `npm run test:integration` with `VSCODE_EXECUTABLE_PATH` pointing to the installed
  Code executable: passed in an isolated VS Code profile. Verified activation,
  all 11 commands, file/folder launches through a harmless Node launcher,
  Explorer multi-selection arguments, independent left selections, and default
  desktop dispatch. This is not visual menu/picker automation.
- Root `npm run typecheck`: passed. No Rust or desktop frontend implementation
  changed; full Rust/build suites were not run.
- Manual Windows validation (owner-reported, 2026-10-21): successfully opened
  the extension in the Extension Development Host and tested context menus.
  This confirms host startup and context-menu testing, not exhaustive coverage
  of every menu location, picker, or comparison workflow.
- Installed discovery found `%LOCALAPPDATA%\CompareCraft\comparecraft.exe`.
  Installed `ccomp.exe -qc=binary -- <left> <right>` with differing temporary
  files and spaces returned expected code 11.
- Installed desktop `-solo -- <left> <right>` opened a responsive native window.
  The specifically owned process was stopped and its fixtures removed. Window
  responsiveness does not assert individual diff-row rendering.
- `git diff --check` passed for tracked changes; documentation/task/link checks
  and new-file whitespace checks also passed.

Choose focused checks when implementing; prerequisites differ by platform.
Missing GUI, platform, or signing validation remains a gap, not a pass.

Phase 2 checks (Windows, from `extensions/vscode` unless stated otherwise):

- `npm test`: 30 tests passed, zero failures/skips (about 65 s; Git on Windows
  is slow). Adds snapshot write/read-only/release/sweep, CLI titles/read-only/
  `-solo`, dirty-file snapshot routing, conflict helpers, real disposable Git
  repositories for merge, rebase, add/add, modify/delete, cherry-pick stale-state
  refusal, HEAD/index/working/revision content, tool quoting, local and
  temp-global apply/remove, and an actual `git mergetool` invoking a fake tool
  in a path with spaces and an apostrophe.
- `npm run test:integration` (installed VS Code 1.143.0): exit code 0; all 24
  commands registered; Phase 1 file/folder dispatch still passes.
- Root `npm run typecheck`: passed. `git diff --check`: passed.
- Installed `ccomp.exe -solo -- "a b.txt" "c d.txt"` kept running while its
  `comparecraft.exe -solo -- ...` child ran and exited after that owned child was
  stopped; arguments were forwarded intact. Fixtures removed.
- 2026-10-22, after the owner installed the rebuilt desktop with the `ccomp`
  fix: `ccomp.exe -title1=Left -- "a b.txt" "c d.txt"` (no `-solo`) launched
  `comparecraft.exe -solo -title1=Left -- ...` and waited for the window.
  A real `git mergetool` using the extension's generated command opened the
  installed app on a disposable conflict and waited until the owner closed the
  window. Git then kept the file unresolved because it was unchanged, as expected.
  No extension change was required.

Phase 3 checks (Windows x64, 2026-10-22):

- `cd src-tauri; cargo test`: `backend::tests` 11 passed (framing, oversize skip,
  handshake gating, exit codes, malformed messages, engine parity with direct
  engine calls, invalid params, concurrency, cancellation, busy queue, duplicate
  ids). `tests/backend.rs` 3 passed against the built binary over real pipes
  (`--version`, usage exit 2, full session, stdout carries only frames, EOF
  without shutdown exits 1). `ccomp` unit 2 and `tests/console.rs` passed.
  `tests/script_golden.rs` fails 14 tests **with and without** the Phase 3
  changes (verified by stashing them): a pre-existing Windows issue, out of scope.
- `cargo clippy --all-targets`: no warnings in `backend.rs`/`backend_main.rs`
  (pre-existing warnings elsewhere unchanged).
- `extensions/vscode`: `npm test` 38 passed (8 new backend client tests, one of
  them against `src-tauri/target/debug/comparecraft-backend.exe`);
  `npm run test:integration` exit 0 with 25 commands; root `npm run typecheck`
  passed; `node --test tests/macos-signing.test.mjs` 7 passed.
- `cargo build --release --bin comparecraft-backend`: 2.2 MB. A copy in
  `%TEMP%` (outside the repo) printed `comparecraft-backend 0.1.0 (protocol 1)`
  and passed the real contract test via `COMPARECRAFT_BACKEND=<path>`.
- `discoverBackend()` against the currently installed per-user build (which
  predates the helper) reported: "The installed CompareCraft (...) does not
  include the embedded-mode helper ...\comparecraft-backend.exe. Update
  CompareCraft ...", as intended.
- `npx tauri build --bundles nsis` succeeded. The generated
  `target/release/nsis/x64/installer.nsi` installs
  `comparecraft-backend.exe` next to `ccomp.exe` and deletes it on uninstall,
  confirming Tauri bundles the third bin with no configuration changes.
- After the owner reinstalled from that build (2026-10-22),
  `%LOCALAPPDATA%\CompareCraft\comparecraft-backend.exe` (2.3 MB) is present;
  `--version` prints `comparecraft-backend 0.1.0 (protocol 1)` and no arguments
  exit 2 with usage. `discoverBackend()` with no override returns that path.
  `node --test out/test/backend.test.js` with `COMPARECRAFT_BACKEND` set to it:
  8 passed, 0 skipped. `npm run test:integration` with the same variable runs
  **Check Embedded Backend** in real VS Code and asserts the returned executable
  and protocol (PASS); with a nonexistent path it fails as expected. No
  `comparecraft-backend` processes remain afterwards.

Phase 4 checks (Windows x64, VS Code 1.143.0, installed helper 0.1.0, 2026-10-22):

- Root `npm run typecheck` and `npm run build` (desktop) pass. Desktop
  behavior only changed under `isEmbedded()` checks in `TextCompare.tsx`.
- Root `npm run build:webview`: `extensions/vscode/media/webview/webview.js`
  (100 KB) and `webview.css` (33 KB); `__TAURI` occurs 0 times in the bundle.
- `extensions/vscode`: `npm test` 45 passed (new: spec validation, exact
  line-ending round trips, document guard, dialog filters, input conversion,
  embedded routing for files/folders/content/merges).
- `npm run test:integration` with `VSCODE_EXECUTABLE_PATH` and
  `COMPARECRAFT_BACKEND=%LOCALAPPDATA%\CompareCraft\comparecraft-backend.exe`:
  exit 0 on three consecutive runs. The host test opens two real panels via
  **Compare Selected in VS Code** and waits for the webview's own `init`,
  `load_text` x2 and `diff_texts` requests and state; then drives the panel's
  request handler against real documents (CRLF save, conflict after an unsaved
  VS Code edit, unsaved buffer as source, conflict after an external disk
  write, new-file creation, unsupported command, refused `file:` URL, missing
  backend error and recovery). Extension-host stdout capture is flaky on this
  machine, so some runs print no `PASS:` lines; the exit code is authoritative.
- No Rust code changed in Phase 4; `cargo test` was not rerun.

## Phase 1 implementation handoff

- Branch: `feature/vscode-ui`. Transfer state: local only, not committed/pushed.
- Environment: Windows x64, Node 24.14.1, npm 11.11.0, VS Code 1.143.0.
- Changes: [extension](../../extensions/vscode/README.md), isolated lockfile,
  source/tests/development workspace, root README link, and planning evidence.
- Development: open
  [dev.code-workspace](../../extensions/vscode/dev.code-workspace), run `npm ci`
  in that directory on a new computer, and press F5. Normal root `.vscode/`
  settings are untouched. F5 opens a second "Extension Development Host" window.
- Workspace-file launch fixes (found during first manual F5 run): in a
  `.code-workspace`, use `${workspaceFolder:vscode}` (plain `${workspaceFolder}`
  fails to resolve) and a `shell` task running `npm run build` (workspace-level
  `npm` tasks are not detected).
- Phase 1 compares saved disk files only. It explicitly blocks dirty compared
  documents/folder descendants until Phase 2 snapshots exist. Existing diff,
  untitled, and virtual resources are unsupported, not silently misrouted.
- Configured default remains embedded as agreed: unavailable embedded mode offers
  an explicit desktop action. Set `comparecraft.defaultMode` to `desktop` for
  direct external launches.
- Remaining checks: native Linux/macOS install/GUI tests; minimum VS Code runtime
  (types compile against 1.95, host tested on 1.143); exhaustive menu-location
  and picker checks; untrusted/remote UI flows (controller guards and manifest
  are tested). Host startup and context-menu testing were confirmed by the owner.
- Next sequential task: T004 (Phase 2), requiring user authorization. T007 is
  independently ready after T001, but also outside Phase 1 approval.
- Detailed trace: [tasks-to-impl.yaml](checkpoints/tasks-to-impl.yaml).
- Batch evidence: [phase-1-report.yaml](phase-1-report.yaml).

## Phase 2 implementation handoff

- Task IDs / status: T004, T005, T006 done (automated gate). Branch
  `feature/vscode-ui`; transfer state: local only, not committed.
- Environment: Windows x64, Node 24.14.1, npm 11.11.0, VS Code 1.143.0,
  Git 2.53.0.windows.2, installed CompareCraft per-user build.
- New modules in `extensions/vscode/src/`: `snapshots.ts` (owned read-only
  snapshot sessions, marker + PID sweep), `git.ts` (shell-free Git runner, stages,
  operation labels, config), `conflicts.ts` (stage validation, binary/marker
  checks), `gitWorkflows.ts` (comparisons, resolve, revalidated staging),
  `gitTools.ts` (reversible mergetool/difftool settings). Modified: `contracts.ts`,
  `process.ts` (titles, `-roN`, `-solo`), `controller.ts` (`compareInputs`, dirty
  files become snapshots), `extension.ts` (13 new commands, SCM/diff adapters),
  `package.json` (24 commands, `comparecraft.git` submenu, SCM and diff menus).
- Behavior: every content-backed or tracked launch uses `-solo` so the extension
  owns the desktop process; snapshots are released on exit, and later activations
  sweep only marked sessions whose PID ended (24 h unattached grace, 7 day cap).
  Conflict sides come from index stages (never markers in the working file); the
  working file is the 4th (output) side. Staging is explicit, confirmed, refuses
  stale stage signatures, and never continues/aborts operations.
- Desktop fix: `src-tauri/src/console.rs` used to append `-solo` after the
  user's arguments, so a `--` in them turned it into an extra positional path.
  `gui_args` now inserts `-solo` first (unit-tested with `cargo test --bin ccomp`).
  Git tool commands still pass `-solo` before `--`, so they also work with older
  installed builds.
- Git exit-code semantics: the GUI exit code does not distinguish save from
  cancel, so `trustExitCode=false`; Git judges success by whether MERGED changed.
- Integration-runner note: on this machine the test VS Code starts `wsl.exe -l -q`,
  which can hang and keep the runner's output pipe open after VS Code exits with
  code 0. Stop only those test-spawned `wsl.exe` PIDs; the result is unaffected.
  VS Code 1.143 does not forward the host test's `console.log` PASS line.
- Remaining manual checks (desktop GUI, not automatable here): Compare with
  Saved / clipboard / text-left / active Git diff open correctly labeled sides;
  snapshot sides are read-only; Resolve Conflict writes the result and the
  "Stage Resolved File" prompt appears after closing; Source Control context menu
  items appear in the right groups; `git mergetool`/`git difftool` with the
  installed app after Configure, then Remove restores settings.
- Next sequential task: T007 (Phase 3 backend), requiring user authorization.
- Batch evidence: [phase-2-report.yaml](phase-2-report.yaml).

## Phase 3 implementation handoff

- Task IDs / status: T007 and T008 done.
  Branch `feature/vscode-ui`; transfer state: local only, not committed.
- Environment: Windows x64, Rust stable, Node 24.14.1, VS Code 1.143.0.
- Crate boundary: no extraction. `comparecraft_lib` engine modules (`diff`,
  `merge`, `fileio`, ...) are already Tauri-free; only `lib.rs` uses Tauri. The
  helper is a third `[[bin]]` (`src/backend_main.rs`) like `ccomp`, so Tauri
  bundles it next to the desktop executable with no config. Contract and
  rationale: [backend-protocol.md](backend-protocol.md).
- Rust: `src-tauri/src/backend.rs` (protocol server: Content-Length framing,
  JSON-RPC 2.0, `initialize`/`shutdown`/`exit`/`$/cancelRequest`, worker pool,
  limits, read-only `path.info`/`text.load`/`text.diff`/`text.merge`),
  `src/backend_main.rs`, `tests/backend.rs`; `lib.rs` exports the module.
  `tests/console.rs` now expects `-solo L R -ro` (it was left at the old order by
  the `ccomp` fix and would have failed on Linux/macOS CI).
- Extension: `src/backend.ts` (`BackendClient`: handshake with 10 s timeout,
  protocol/capability checks, AbortSignal cancellation, crash rejection with exit
  code and recent stderr, shutdown/exit/kill dispose; `BackendManager`: lazy
  start, crash restart, reset on `desktopPath`/`backendPath` change, disposed on
  deactivate). `discovery.ts`: `discoverBackend` (global `backendPath`, else the
  sibling of the discovered desktop executable; no fallback on an invalid
  override). New command **CompareCraft: Check Embedded Backend**
  (`comparecraft.checkBackend`, 25 commands).
- Packaging: `scripts/sign-macos-binaries.mjs` signs every helper
  (`ccomp`, `comparecraft-backend`) and fails if either is missing; Windows
  portable ZIP includes `comparecraft-backend.exe`; Arch `PKGBUILD` installs
  `/usr/bin/comparecraft-backend`; Windows portable and macOS packaging READMEs
  mention it. deb/rpm/AppImage/NSIS/MSI/app bundles include every Cargo bin
  automatically.
- Open risks: on Linux the helper links the same library as the desktop app, so
  it may need the WebKitGTK shared libraries present (as `ccomp` does); the
  native Linux/macOS builds and macOS signing have not been run here.
- Installed check: done on Windows (see "Phase 3 checks"). To repeat on another
  machine, install a build containing the helper, then run **CompareCraft:
  Check Embedded Backend** in the Extension Development Host, or
  `npm run test:integration` with `COMPARECRAFT_BACKEND` set to the helper. It
  should report `CompareCraft backend 0.1.0 (protocol 1) is working`.
- Next sequential task: T009 (Phase 4 embedded text views), requiring user
  authorization.
- Batch evidence: [phase-3-report.yaml](phase-3-report.yaml).

## Phase 4 implementation handoff

- Task IDs / status: T009 and T010 done; Phase 4 closed 2026-10-22 after the
  owner's manual F5 confirmation. Branch `feature/vscode-ui`; committed by the
  owner after this update.
- Environment: Windows x64, Node 24.14.1, VS Code 1.143.0, installed
  CompareCraft with `comparecraft-backend` 0.1.0 (protocol 1).
- T009 (shared UI): `src/host/index.ts` defines the `Host` interface and
  delegating wrappers named like the Tauri functions; `src/host/tauri.ts` is
  the desktop implementation (`src/index.tsx` calls `setHost(tauriHost)`).
  Twenty shared files now import from `host` instead of `@tauri-apps/*`.
  `TextCompare.tsx` gains embedded-only hooks: `restore` option (unsaved text
  over loaded files), `file-changed` event (reload clean side, warn on dirty
  side), and a `text-state` emit (paths, titles, options, dirty flags, unsaved
  lines, content of path-less sides). Webview entry: `src/webview/main.tsx`
  (one text comparison per panel; other views are forwarded as `openTab`),
  `src/webview/host.ts` (request/response RPC, debounced state),
  `src/webview/vscode.css` (VS Code theme tokens), `vite.webview.config.ts`,
  root script `build:webview`.
- T010 (extension): `src/embeddedCore.ts` (pure: spec validation, line
  split/join, `DocumentGuard`, input conversion) and `src/embedded.ts`
  (`EmbeddedPanels` with serializer, `EmbeddedPanel` with nonce CSP, validated
  messages, guarded `load_text`/`save_text` through `TextDocument`s, backend
  `text.diff`/`text.merge`/`path.info`, settings in `globalState`, dialogs,
  clipboard, URL allow-list, file watchers, restore on close). `controller.ts`:
  in embedded mode, two-sided inputs (files, editor text, clipboard, saved
  version, Git revisions) open a panel; folders and tracked three-way merges ask
  before using the desktop app. `package.json`: `onWebviewPanel` activation,
  descriptions, `build:webview`/prepublish/integration scripts. Media output
  `media/webview/` is git-ignored and built by `vscode:prepublish`.
- Behavior notes: dirty Explorer files open as live (editable) sides because
  `load_text` reads the VS Code buffer; read-only inputs such as "saved on disk"
  become content sides. Backups, sessions, reports, and Open With are
  desktop-only; embedded settings are separate from the desktop app.
  Format-on-save results are reloaded into the view after saving. Commands
  titled "in Desktop App" (Open Active Diff, Resolve Conflict) pass
  `mode: "desktop"` and never open a panel or ask.
- Owner manual F5 test (2026-10-22): comparison, editing and saving worked.
  Two defects found and fixed: (1) Ctrl+Z/Ctrl+Y (and Ctrl+S/F/P) did nothing
  in the panel because VS Code's webview wrapper registers its keydown listener
  on the frame before the page loads and calls `preventDefault` on those
  chords; `src/webview/main.tsx` now claims them in the capture phase.
  (2) Undo after a save restored the pre-edit dirty flag, so Save stayed
  disabled although the text no longer matched the file (desktop app too);
  `TextCompare.tsx` now records a per-side disk baseline id in each undo entry
  and marks a side dirty when undo/redo crosses a load or save. Verified in a
  browser against the built bundle with a wrapper-like listener and the real
  helper: edit, Save, Ctrl+Z re-enables Save; Ctrl+Y disables it again.
  The owner re-tested in F5 and confirmed the fixes work ("working great").
- Development: F5 now runs `npm run build:all` in `extensions/vscode` (webview
  bundle via the root Vite build, then the extension TypeScript), so the root
  dependencies must be installed (`npm ci` in the repository root) as well as
  the extension's.
- Optional regression checks for later phases (not blocking; not individually
  recorded by the owner): close a panel with unsaved changes (Restore/Untitled),
  reload the window with a panel open, edit the file in a normal editor and
  confirm the warning, switch light/dark/high-contrast themes, keyboard focus.
- Batch evidence: [phase-4-report.yaml](phase-4-report.yaml).

## Phase 5 handoff (complete)

- T011 done (owner F5 sign-off 2026-10-23). New command **CompareCraft:
  Resolve Conflict in VS Code** (`comparecraft.gitResolveConflictEmbedded`),
  in the Source Control **CompareCraft** submenu for merge-group files and in
  CompareCraft > Git. It opens `src/views/TextMerge.tsx` in a panel: Current,
  Incoming and Base come from Git's index stages as read-only content sides;
  the working file is the result. The panel can write only the result file,
  through its VS Code document (guarded like text compare). After a save with
  no conflict markers it offers to stage (with confirmation via
  `stageResolved`); a save with markers only warns. Nothing commits, continues
  or aborts the Git operation. Unsaved merged text is offered as an Untitled
  document when the panel closes or is restored after a reload (resolution
  choices are not persisted). Resolve Conflict in Desktop App is unchanged.
- Defects found in the owner's F5 testing, all fixed and covered:
  (1) blank merge panel: store-proxy side text could not be structured-cloned
  to the host; `TextMerge` unwraps it and `src/webview/host.ts` retries with a
  plain copy (or shows a readable error). (2) Source Control entries were flat
  and "Resolve Conflict" was ambiguous; they are now under a CompareCraft
  submenu and the command says "in VS Code". (3) Hidden panels were unloaded
  and reloaded when shown again, losing merge choices and undo, and re-reading
  the result file (including unsaved edits in another tab) as a new baseline;
  panels now use `retainContextWhenHidden`, and a merge refuses to save while
  its result file has unsaved edits in another editor (even after Refresh).
- Owner manual journeys passed 2026-10-23 (repo with two conflicted files,
  including a path with spaces and parentheses): open embedded merge, Take
  Left/Right, save, stage prompt, staged without commit; save with an
  unresolved conflict warns, writes markers and does not offer staging;
  unsaved edit in another editor blocks the save and is preserved; recovery
  after reverting and Refresh succeeds.
- T012 done (scope B, chosen by the owner 2026-10-23; owner F5 sign-off
  2026-10-23: the views look and behave the same in VS Code and the desktop
  app).
  - Helper (`src-tauri/src/backend.rs`): read-only `hex.align`,
    `table.compare`, `pix.compare`, `pix.image` with absolute-path checks and
    64 MB table/picture file limits (`-32021`). Protocol stays 1; see
    [backend-protocol.md](backend-protocol.md). The extension does not
    require them at startup, so older helpers still work.
  - Extension: `parseSpec` accepts kinds hex/table/picture (two paths) and
    patch (one path), always read-only. `read_bytes` (4 MB) and
    `read_data_url` (64 MB) are served with Node file APIs; the other view
    commands are forwarded to the helper. Explorer file pairs choose the view
    by `path.info` kind of the first existing file; unsaved VS Code edits,
    in-memory sides, and helpers without the methods keep the text view.
    `openTab` from a view: text and the four read-only kinds open a panel (or
    offer the desktop app with a reason when the helper is too old); `edit`
    opens VS Code's editor; folder/sync/fmerge/merge offer the desktop app
    with `-fv=<view>`.
  - Webview (`src/webview/main.tsx`): renders HexCompare, TableCompare,
    PictureCompare, PatchView unchanged; read-only views persist their
    state for reload. Bundle still has 0 `__TAURI` references.
  - Verification: `cargo test --lib backend::` 13 pass; `npm test` 51 pass;
    root typecheck and `build:webview` pass; `npm run test:integration` passes
    with `COMPARECRAFT_BACKEND` = `src-tauri\target\debug\comparecraft-backend.exe`
    (real hex/picture/table webviews compare through the helper; patch, byte
    reads, data URLs, Text Edit) and with the installed pre-T012 helper (text
    fallback, reported as SKIP for the views).
  - Owner manual journeys passed 2026-10-23.
- Table Compare follow-up (owner request after T012 sign-off, Beyond Compare
  parity; shared by the desktop app and VS Code):
  - Defaults are now key column 1 and no header row (`TableOptions::default`
    in `src-tauri/src/table.rs` and `src/views/TableCompare.tsx`). Keyed rows
    are listed in key order, and rows whose key is on one side only are
    orphans instead of being paired by position. Saved sessions keep their
    stored options. Script reports without table options keep the old
    unkeyed, headerless default (`src-tauri/src/report.rs`) so their output
    is unchanged.
  - Two panes: each side has its own horizontal scrollbar, vertical
    scrolling is synced, and a draggable splitter (10-90%, saved in the tab
    as `tableSplit`) sets the widths.
  - The details pane shows only the selected side's row.
  - Verified: new `defaults_key_on_first_column_without_header` test; all
    lib tests pass (`cargo test -- --test-threads=1`; the settings test can
    race on its shared config variable in parallel runs); `script_golden`
    output is byte-identical with and without the change (its 14 failures
    are pre-existing); typecheck, desktop and webview builds; 51 unit tests;
    integration test with the debug helper; browser check with the owner's
    two CSV files gives 20,836 rows (2 same, 12,700 left-only, 8,134
    right-only), matching Beyond Compare's 20,834 difference rows.
  - Needs a CompareCraft rebuild (the helper's defaults changed) and a quick
    owner look in both the desktop app and VS Code.
- Next: Phase 6 (T013, T014).
- Batch evidence: [phase-5-report.yaml](phase-5-report.yaml).

## Phase 6 handoff (complete: owner Linux sign-off 2026-10-24)

- Closeout: the owner confirmed that the extension is working successfully on
  Linux and requested Phase 6 completion on 2026-10-24. T013 and T014 are done.
  This closes the implementation phase, not every platform/package release check.

- T014 packaging: `@vscode/vsce` devDependency; `npm run package` runs
  `vscode:prepublish` (webview + TypeScript builds) and `vsce package
  --no-dependencies` to `comparecraft-0.1.0.vsix` (git-ignored; 21 entries,
  about 110 KB at the original Windows checkpoint). The latest Linux package
  includes the 256x256 app icon and screenshots. `.vscodeignore` also excludes
  `.gitignore`, `*.vsix`, and the development guide. Publishing uses an environment
  secret, not a token stored in the repository.
- T014 lifecycle: `scripts/test-vsix.cjs` (`npm run test:vsix [vsix]`) uses a
  temporary `--extensions-dir`/`--user-data-dir`: packages a 0.0.1 copy of the
  same build, installs it, upgrades to the real VSIX, checks the installed files
  (required: manifest `main`, icon, webview bundle, README, LICENSE; forbidden:
  sources, tests, scripts, maps, `node_modules`, lockfile), runs `out/test/host.js`
  with the installed folder as the extension, uninstalls, and confirms it is no
  longer listed. `COMPARECRAFT_VSIX_SKIP_HOST=1` skips the host step.
- T014 CI: `.github/workflows/vscode-extension.yml` (push to main / PRs touching
  the extension, shared UI, `src-tauri`, or root manifests; manual dispatch);
  `contents: read`; Windows, macOS, Ubuntu 22.04: builds the debug helper,
  `npm ci` (root and extension), `npm test`, `npm run package`, `test:vsix`
  (Xvfb on Linux), and uploads the VSIX artifact from Linux. A completed remote
  run is not recorded. Optional Marketplace publishing requires manual dispatch
  from main, an exact-version confirmation, all platform checks, and the
  `vscode-marketplace` environment's `VSCE_PAT` secret. No publication performed.
- T014 docs: user-focused README with quick start, commands, screenshots, safety,
  settings, troubleshooting, and limitations. Manual VSIX installation, upgrade,
  removal, Git cleanup, diagnostics, and publishing setup are in DEVELOPMENT.md.
- Git setup reversal: covered by the unit test "applying and removing tool
  settings restores earlier values and keeps later user edits" (temp global and
  repo config). Uninstalling does not touch Git configuration; the records
  needed to restore earlier values live in VS Code's extension state, so the
  README tells users to run Remove Git Tool Configuration first.
- T013 regressions on Windows x64 (2026-10-23): extension `npm test` 51/51 with
  the installed helper (no skips); `npm run test:vsix` PASS (VS Code 1.143.1,
  installed helper 0.1.0, 8 host tests); root `npm run build` (typecheck +
  Vite) pass; `tests/macos-signing.test.mjs` pass; `cargo test --no-fail-fast
  -- --test-threads=1`: lib 87, ccomp 2, backend 3, console 4, engine_golden
  15, hex_golden 3, pix_golden 1 pass; `script_golden` 4 pass / 14 fail, the
  same pre-existing failures recorded in Phase 5.
- Linux verification (2026-10-24): `npm --prefix extensions/vscode run package`
  passed; `VSCODE_EXECUTABLE_PATH=/usr/share/code/code xvfb-run -a npm --prefix
  extensions/vscode run test:vsix` passed on Linux x64 / VS Code 1.139.1:
  install 0.0.1, upgrade 0.1.0, 24 installed files including the icon, host tests
  (26 commands, file/folder dispatch, multi-selection, left selections), uninstall.
  Backend-specific host steps were skipped because no local debug helper was
  built. Workflow YAML, release version/branch guards, icon bytes/dimensions,
  and VSIX icon metadata passed local checks. Owner success is recorded separately
  from these automated results; no additional manual journeys are inferred.
- Remaining release checks: native macOS app/signing; individual Linux
  deb/rpm/AppImage variants (owner's format not recorded); Windows MSI and ARM64;
  exhaustive native menu/picker visuals; optional owner Git setup/remove in a
  scratch repository; completed three-platform CI. These remain follow-up
  verification gaps rather than reasons to leave Phase 6 in progress.
- Batch evidence: [phase-6-report.yaml](phase-6-report.yaml).

## Per-increment handoff entry

- Task IDs / status / owner:
- Branch/ref / commit if created:
- Files changed / behavior delivered:
- OS/architecture / tools / installed artifacts:
- Exact validation commands and results:
- Manual journeys:
- Failures / unexecuted checks:
- Decisions changed and rationale:
- Next task / prerequisites:
- Transfer status: local only / committed / pushed:
