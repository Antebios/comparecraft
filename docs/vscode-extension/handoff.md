# Portable implementation handoff

## Current state

**Phase 1 is complete** (accepted by the owner). Implemented on Windows;
T001-T003 are done. Phases 2-6 have not been started or authorized by the Phase 1 request.
No backend/installer changes, Git configuration changes, commits, pushes, or
Marketplace publication have been performed. Extension-only development
dependencies were installed; the existing desktop installation was not changed.

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
| T004 | 2 | pending | T003 | |
| T005 | 2 | pending | T004 | |
| T006 | 2 | pending | T005 | |
| T007 | 3 | pending | T001 | |
| T008 | 3 | pending | T002, T007 | |
| T009 | 4 | pending | T007 | |
| T010 | 4 | pending | T008, T009 | |
| T011 | 5 | pending | T005, T010 | |
| T012 | 5 | pending | T010 | |
| T013 | 6 | pending | T006, T011, T012 | |
| T014 | 6 | pending | T013 | |

## Platform/workflow evidence

Replace not run with pass/fail/blocked and evidence. Record OS/architecture,
VS Code version, app/helper/protocol versions, and installer type.

| Journey | Windows | Linux | macOS |
|---|---|---|---|
| Installed discovery, custom paths, spaces | automated pass; default per-user install and override tested | candidate unit tests only; native not run | candidate unit tests only; native not run |
| Files/folders, Select Left, pickers | host/unit pass; native picker/menu visual checks not run | not run | not run |
| Dirty/untitled, selections, clipboard, saved version | not run | not run | not run |
| Snapshot survival after GUI handoff | not run | not run | not run |
| HEAD/index/working/revisions and existing diff | not run | not run | not run |
| Merge/rebase/cherry-pick/stash resolution | not run | not run | not run |
| Missing stages, renames, binary conflicts | not run | not run | not run |
| Opt-in Git setup, wait/cancel, reversal | not run | not run | not run |
| Installed helper, incompatibility, crash | not run | not run | not run |
| Embedded text, edits, undo/save/close/reload | not run | not run | not run |
| Embedded merge and remaining views | not run | not run | not run |
| Formats/backups, read-only, destructive confirmations | not run | not run | not run |
| VSIX install/upgrade/removal, desktop regressions | not run | not run | not run |

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
