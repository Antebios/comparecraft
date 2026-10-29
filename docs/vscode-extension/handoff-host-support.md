# VS Code host support handoff

## Status

No host-support runtime/code implementation has started. The source inventory
and continuation notes are documented in the plan at
[host-support-plan.md](host-support-plan.md). The existing local extension
implementation and evidence remain in [handoff.md](handoff.md).

This file is repository-tracked so work can resume from a clean checkout on a
Windows computer. Keep it current with code changes; do not rely on chat history
or a machine-local session database.

## Omarchy/Linux feasibility environment

The following tools were installed or prepared on this Linux laptop for H002 and
H003; they are not prerequisites for a Windows checkout and are not committed
to the repository:

- Rustup 1.29.2 with stable Rust 1.99.1 and the
  `wasm32-unknown-unknown` target under `~/.cargo`. The Cargo bin directory is
  added to the Bash login/interactive and Zsh startup paths.
- `@vscode/test-web` 0.0.81 and `@devcontainers/cli` 0.90.0 in
  `~/.local/share/comparecraft-host-validation`.
- The existing VS Code 1.143.1, Chromium, Docker 29.9.2 and Remote SSH /
  Dev Containers extensions; an Ubuntu 24.04 Dev Container image is cached.
- A disposable Dev Container was started with networking disabled. The backend
  binary was copied into it for the H003 stdio probe. The host's existing SSH
  daemon was left unchanged and was not used for testing.

No system packages were installed and no system configuration was changed;
`sudo` was unavailable. The temporary WASM/browser fixtures live in the
Copilot session folder, not this repository, and are not needed to continue on
Windows.

## Task ledger

Statuses: `pending`, `in_progress`, `blocked`, `done`. A task is `done` only
when its evidence is recorded. Planning is not implementation evidence.

| Task | Phase | Status | Prerequisites | Evidence / blocker |
|---|---|---|---|---|
| H001 | H0 | done | None | Source inventory recorded in `host-support-plan.md`; extension tests pass |
| H002 | H0 | in_progress | H001 | Focused WASM compile and VS Code Web fixture activation pass; actual browser comparison/parity, bundle and performance evidence remain |
| H003 | H0 | in_progress | H001 | Dev Container helper stdio handshake passes; VS Code remote extension-host activation and helper discovery/packaging remain; WSL needs Windows |
| H004 | H1 | pending | H001-H003 | Typed host and URI-safe adapters |
| H005 | H1 | pending | H004 | Provider resources, snapshots, write guards and cleanup |
| H006 | H1 | pending | H004 | Central capability policy |
| H007 | H2 | pending | H004, H006 | Remote extension-host behavior |
| H008 | H2 | pending | H003, H007 | Remote helper discovery and installation |
| H009 | H2 | pending | H005, H007, H008 | Embedded remote workflows and Git |
| H010 | H3 | pending | H006 | Restricted untrusted mode |
| H011 | H3 | pending | H010 | Security audit and enforcement tests |
| H012 | H4 | pending | H005, H006 | Virtual file compare and edit |
| H013 | H4 | pending | H012 | Read-only virtual-folder support |
| H014 | H5 | pending | H002, H004, H005 | Browser embedded comparison |
| H015 | H5 | pending | H014 | Browser views and capability gating |
| H016 | H6 | pending | H009, H011, H013, H015 | Cross-host automated test matrix |
| H017 | H6 | pending | H009, H011, H013, H015 | User docs and screenshots |
| H018 | H6 | pending | H016, H017 | Evidence-based release handoff |

## Resume on Windows

1. Confirm this file, `host-support-plan.md`, and the link from `plan.md` exist
   on the branch/commit being resumed. If they only exist as uncommitted files
   on Linux, first transfer them through the approved repository workflow.
2. In the Windows clone, run `git status` and inspect the branch before
   switching. Preserve any unrelated changes; do not reset a dirty worktree.
3. Read `host-support-plan.md`, `plan.md`, `decisions.md`, `handoff.md`, and
   `backend-protocol.md`. Confirm implementation approval and choose the next
   unblocked task.
4. Check prerequisites: VS Code desktop, Git for Windows, Node/npm per
   `extensions/vscode/DEVELOPMENT.md`; Rust/C++ tooling when building the
   helper; Docker Desktop for Dev Containers; WSL and/or a reachable SSH host
   for remote tests. The Linux feasibility environment is user-local and does
   not transfer to Windows: it has Rustup plus `wasm32-unknown-unknown`,
   `@vscode/test-web`, `@devcontainers/cli`, Chromium, and a cached Ubuntu
   Dev Container image.
5. Use disposable workspaces and Git repositories. Record the Windows commit,
   OS/architecture, VS Code version, test command and results below.
6. H001 is complete; H002 and H003 have partial Linux feasibility evidence
   below. Resume the remaining browser comparison/parity and actual VS Code
   remote extension-host checks in suitable Windows/browser and remote-host
   environments. Validate WSL on Windows. Do not begin H004 until the H0 gate
   selects the browser engine and remote helper installation approach.

## Evidence log

H001 baseline evidence from the Omarchy/Linux checkout:

| Date | Task | Host / versions | Command or journey | Result and evidence |
|---|---|---|---|---|
| 2026-10-28 | H001 | Omarchy Linux; Node v24.11.0, npm 11.6.1, Rust 1.99.1 | `npm --prefix extensions/vscode test` | Pass: TS build and 54 extension tests |
| 2026-10-28 | H001 | Omarchy Linux; Rust 1.99.1 | `npm test` at repository root | Pass on rerun: typecheck and 88 Rust tests. Initial run had one settings round-trip failure (`Null` vs `"dark"`); first-run issue remains a baseline flake to investigate if it recurs. |
| 2026-10-28 | H002 | Omarchy Linux; Rust 1.99.1; user-local Rustup and `wasm32-unknown-unknown` | `cargo check --lib --target wasm32-unknown-unknown` | Full crate fails at host-specific `mio`/`getrandom` dependencies; this is not a viable whole-crate browser build. |
| 2026-10-28 | H002 | Omarchy Linux; Rust 1.99.1 | Temporary `wasm-bindgen` crate importing the repository's `src-tauri/src/diff.rs` and `align.rs` | Pass: actual diff/alignment modules compile for `wasm32-unknown-unknown`. Temporary probe is not part of the repository and does not establish parity or browser execution. |
| 2026-10-28 | H002 | Omarchy Linux; VS Code 1.143.1; Chromium; `@vscode/test-web` 0.0.81 | Temporary browser-extension fixture run with `@vscode/test-web` | Pass: VS Code Web activated the fixture and its assertion passed. This did not activate CompareCraft's production extension or run a comparison in-browser. |
| 2026-10-28 | H003 | Omarchy Linux; Docker 29.9.2; Ubuntu 24.04 Dev Container | Existing `BackendClient` spawned `comparecraft-backend` using `docker exec -i`, requested `text.diff`, then disposed the client | Pass: protocol 1 handshake, diff response (`identical=false`) and clean shutdown. No VS Code remote extension host was attached. |
| 2026-10-28 | H003 | Omarchy Linux | Check local SSH / WSL availability | SSH daemon already listens on the host; it was not modified or used. WSL is unavailable on Linux and remains pending Windows validation. |

No Windows-specific, CompareCraft production browser-host, remote
extension-host, or packaged-helper installation tests have been run. Append
evidence as work proceeds:

| Date | Task | Host / versions | Command or journey | Result and evidence |
|---|---|---|---|---|
| — | — | — | — | — |

Record Windows, Linux, macOS, SSH, WSL, Dev Container, virtual-provider and
browser evidence separately. Identify evidence as unit, integration, manual UI
or packaged-installer verification. Redact hostnames and private paths.

## Change log / next action

- H001 inventory is complete. H002 and H003 are in progress with partial
  feasibility evidence; H004-H018 remain pending.
- Next action: run a real comparison through a browser-compatible engine and
  differential tests; attach VS Code to the isolated Dev Container and validate
  production extension activation/helper discovery. Then continue remote-host
  checks (including WSL on Windows). Do not start H004 until H0's gate passes.
