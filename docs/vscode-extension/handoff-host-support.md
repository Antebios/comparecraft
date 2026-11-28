# VS Code host support handoff

## Status

**Implemented on `feature/vscode-workspaces` and verified on Linux, plus the
first CI run on Linux, Windows and macOS (2026-11-28); not merged or released.**
The branch was rebased onto `main` at `7ee0131` and is open as pull request #22.
Its commits:

| Commit | Content |
|---|---|
| `f00d52a`, `538b72e` | Manual page draft, this plan and handoff (2026-10-28) |
| `56b1c8b` | Cargo features: desktop app, Tauri-free `native` helper, WebAssembly engine; shared `protocol.rs` |
| `ffa1642` | Extension: shared activation, browser entry, policy, engine router, URI-aware resources, virtual folder copies, manifest |
| `bb1a9be` | Webview follows host capabilities (desktop app, OS reveal, Restricted Mode note) |
| `f15700d` | Tests for virtual workspaces, Restricted Mode and VS Code for the Web; read-only provider and partial copy fixes |
| `1524d58` | Platform VSIX packages with the bundled helper; CI |
| `67d399d` | Remote smoke tests over Remote-SSH and Dev Containers |
| `9fc51b5` | Removed the view-method table the engine router replaced |
| `bddc16c` | CI attaches the VSIX packages and Linux helpers to releases |
| `3442b6c`, `ead3947` | Documentation and this handoff |
| `e9e76cb` | `test:remote` removes its profile only after VS Code has exited |
| `b5b66ed` | Shorter Restricted Mode test profile path, for macOS's socket path limit (CI evidence in the next commit) |

The plan is [host-support-plan.md](host-support-plan.md); owner decisions are in
[decisions.md](decisions.md#host-support). The local extension's own history and
evidence remain in [handoff.md](handoff.md). This file is repository-tracked so
work can resume from a clean checkout on another computer; keep it current with
code changes.

What remains (see [Next actions](#next-actions)): a CI rerun to confirm the
macOS fix, WSL, and host tests of the Arm64 Linux/Windows, Intel macOS and
Alpine packages.

## Task ledger

Statuses: `pending`, `in_progress`, `blocked`, `done`. A task is `done` only
when its evidence is recorded. Planning is not implementation evidence.

| Task | Phase | Status | Evidence (see the log below) |
|---|---|---|---|
| H001 | H0 | done | Source inventory in the plan (2026-10-28) |
| H002 | H0 | done | WebAssembly engine from the real modules; parity with the helper on all engine fixtures; runs in VS Code for the Web |
| H003 | H0 | done | Remote-SSH and Dev Containers windows activate the extension remotely with the bundled helper |
| H004 | H1 | done | `activate.ts` with Node and browser platforms; browser bundle contains only `require("vscode")` (enforced by `build-web.cjs`) |
| H005 | H1 | done | URI-aware paths, `FileAccess`, provider reads and document writes with stale guards, bounded virtual folder copies with cleanup |
| H006 | H1 | done | `policy.ts` with unit tests; enforced in commands, controller, panel requests and webview capabilities |
| H007 | H2 | done (SSH, Dev Containers) | Remote extension placement, activation, webview, storage and helper lifecycle in both remote smoke tests; WSL is H019 |
| H008 | H2 | done (SSH, Dev Containers) | Platform packages bundle the helper; `checkBackend` reports it; helper-only Linux archives in CI; WSL is H019 |
| H009 | H2 | done (SSH, Dev Containers) | Remote text, folder and Git comparisons; desktop app and OS reveal refused; drops mapped; helper ends with the extension host |
| H010 | H3 | done | Limited untrusted support; Restricted Mode run compares read-only |
| H011 | H3 | done | Saving, Git and desktop refused even when requested directly; trust grant updates panels |
| H012 | H4 | done | In-memory providers: compare, save through the provider, read-only refusal, missing file |
| H013 | H4 | done | Folder copies with file/size limits, cancellation, invalid and case-colliding names, sweep; integration compare of provider folders |
| H014 | H5 | done | Browser entry and WebAssembly engine; text compare, merge and save in VS Code for the Web |
| H015 | H5 | done | Hex/Table/Picture in the browser; folder, Git and desktop refused with explanations (no browser Git reads, by decision) |
| H016 | H6 | done | Unit, parity, Electron, Restricted Mode, browser, VSIX and remote suites; CI workflow (first run: H020) |
| H017 | H6 | done | README, manual page (screenshots refreshed), DEVELOPMENT, CHANGELOG, decisions, backend protocol, plan, folder roadmap. No new screenshots: environments differ only in available actions and messages |
| H018 | H6 | done | This handoff |
| H019 | H2 | pending | WSL on Windows: install the `linux-x64` package in a WSL window and repeat the remote checks (`test/remote.ts` expects `remoteName` `wsl`) |
| H020 | H6 | in_progress | First run on PR #22 (run 46169716620): every job passed except Test (darwin-arm64), whose Restricted Mode launch hit macOS's socket path limit; fixed and verified locally, CI rerun pending |
| H021 | H6 | pending | Host tests of `linux-arm64`, `win32-arm64`, `darwin-x64` and Alpine packages on matching hardware (CI only builds them and checks the helpers) |

## Evidence log

Earlier feasibility evidence (2026-10-28, before implementation):

| Date | Task | Host / versions | Command or journey | Result and evidence |
|---|---|---|---|---|
| 2026-10-28 | H001 | Omarchy Linux; Node v24.11.0, npm 11.6.1, Rust 1.99.1 | `npm --prefix extensions/vscode test` | Pass: TS build and 54 extension tests |
| 2026-10-28 | H001 | Omarchy Linux; Rust 1.99.1 | `npm test` at repository root | Pass on rerun: typecheck and 88 Rust tests; one settings round-trip failure on the first run (see Known issues) |
| 2026-10-28 | H002 | Omarchy Linux; Rust 1.99.1 | `cargo check --lib --target wasm32-unknown-unknown` | Whole Tauri crate fails at `mio`/`getrandom`: led to Cargo features |
| 2026-10-28 | H002 | Omarchy Linux; VS Code Web via `@vscode/test-web` 0.0.81 | Temporary fixture | Pass: a browser extension fixture activated |
| 2026-10-28 | H003 | Omarchy Linux; Docker 29.9.2; Ubuntu 24.04 container | `BackendClient` over `docker exec -i` | Pass: protocol 1 handshake, `text.diff`, clean shutdown (no VS Code remote host) |

Implementation evidence. All runs on Omarchy Linux x64 (Hyprland/Wayland desktop;
Electron tests under Xvfb on X11), Node v26.13.1, npm 11.20.0, Rust 1.99.1,
VS Code 1.148.0 (`@vscode/test-electron` download), Docker 29.9.2:

| Date | Task | Kind | Command or journey | Result and evidence |
|---|---|---|---|---|
| 2026-11-28 | baseline | unit/UI | Root `npm test`; extension `npm test` before changes | Pass: typecheck, 101 Playwright UI tests, 149 Rust tests; 64 extension tests |
| 2026-11-28 | H002 | build | `cargo test` (default features); `npx tauri build --no-bundle --debug` | Pass: desktop app and tests build with the feature-gated manifest |
| 2026-11-28 | H002/H008 | build | `cargo build --release --no-default-features --features native --bin comparecraft-backend --target x86_64-unknown-linux-musl` | Pass: 4.7 MB static-pie helper without Tauri; `--version` works |
| 2026-11-28 | H002 | build | `npm run build:engine` + Node smoke test | Pass: 2.68 MB module, no imports; exports `memory`, `cc_alloc`, `cc_call`, `cc_free` |
| 2026-11-28 | H002 | unit | `node --test out/test/parity.test.js` with the debug helper | Pass: 1,936 `text.diff` comparisons (121 fixtures × 16 rule sets) identical; `text.decode`/`kind.detect`, `text.merge`, `hex.alignData` (3 alignments), `pix.compareData`/`pix.imageData` (4 option sets), `table.compareData`, `quick.compareData` identical. All `text.diff` cases: helper 1,824 ms including IPC, WebAssembly 383 ms |
| 2026-11-28 | H004-H006, H013 | unit | `npm test` (extensions/vscode) | Pass: 84 tests (policy, URI paths, engine routing, folder copies incl. removal of partial copies) |
| 2026-11-28 | H004 | build | `node scripts/build-web.cjs` | Pass: 106 KB browser bundle; only `require("vscode")` |
| 2026-11-28 | H005, H010-H013 | integration | `COMPARECRAFT_BACKEND=<debug helper> node scripts/test-integration.cjs` | Pass: 15 checks, including in-memory providers (save through the provider, "r.txt is read-only", missing file "not found", Hex/Table/Picture via WebAssembly, folder copies), the WebAssembly fallback without a helper, and the Restricted Mode launch (read-only compare, folders shown, save/Git/desktop refused) |
| 2026-11-28 | H014/H015 | browser | `node scripts/build-web.cjs --tests && node scripts/test-web.cjs` (VS Code for the Web stable `661626d0`, headless Chromium, `@vscode/test-web` 0.0.81) | Pass: activation, `checkBackend` engine `wasm`, text load/diff/merge/save through the provider, Hex/Table/Picture views, desktop/Git/folder/reveal refused with explanations |
| 2026-11-28 | H011 | UI | Root `npm run typecheck && npx playwright test` | Pass 101/102 including the new Restricted Mode UI test; the one failure is the pre-existing minimap flake (see Known issues) |
| 2026-11-28 | H008 | build | `npm run stage:helper -- --target linux-x64 --also alpine-x64`; `--target linux-arm64 --also alpine-arm64` | Pass: x64 static-pie 4.5 MB; Arm64 statically linked 3.7 MB, cross-compiled with `rust-lld` |
| 2026-11-28 | H008 | manual | `docker run --rm --network none -v <helpers/alpine-x64>:/h:ro alpine:3 /h/comparecraft-backend --version` | Pass on Alpine 3.24.4: `comparecraft-backend 0.1.0-dev (protocol 1)` |
| 2026-11-28 | H008 | package | `COMPARECRAFT_PREBUILT=1 node scripts/package-targets.cjs --helpers helpers --targets linux-x64,alpine-x64` | Pass: 4.4 MB platform packages (`TargetPlatform` set, `extension/bin/comparecraft-backend` mode 0755); 2.2 MB universal package without `bin/` |
| 2026-11-28 | H008/H016 | packaged | `node scripts/test-vsix.cjs comparecraft-0.1.0-linux-x64.vsix` | Pass: older install, upgrade, 53-file content check including the helper, host checks with the bundled helper, Restricted Mode, uninstall |
| 2026-11-28 | H016 | packaged | `env -u COMPARECRAFT_BACKEND node scripts/test-vsix.cjs comparecraft-0.1.0.vsix` | Pass: 52 files, no helper; WebAssembly fallback; Restricted Mode with the WebAssembly engine explains that folders need the helper |
| 2026-11-28 | H016 | lint | `actionlint .github/workflows/vscode-extension.yml` (1.7.12) | Pass; the workflow hasn't run on GitHub yet (H020) |
| 2026-11-28 | H003, H007-H009 | remote | `node scripts/test-remote.cjs --via ssh --vsix comparecraft-0.1.0-linux-x64.vsix`: Remote-SSH (Marketplace latest) from an isolated profile to Debian bookworm sshd in a container on 127.0.0.1, throwaway ed25519 key | Pass: activated in the `ssh-remote` extension host (workspace kind, Linux); bundled helper ran remotely; environment "a window connected to an SSH host"; remote text load/diff/save; `vscode-remote` drops became remote paths; desktop app and OS reveal refused; folder scan via the helper; Git compare with HEAD ran Git remotely; helper exited with the remote extension host |
| 2026-11-28 | H003, H007-H009 | remote | `node scripts/test-remote.cjs --via container ...`: Dev Containers 0.481.0, folder opened in a dev container (remote user `tester`, local Git config and credential helpers not copied) | Pass: the same checks in the `dev-container` extension host ("a window connected to a dev container"); containers and derived images removed afterwards |
| — | H019 | remote | WSL | Pending: needs Windows |

First CI run: GitHub Actions run 46169716620 of `vscode-extension.yml` for PR #22
at `ead3947`, 2026-11-28 (job results from the run page; the macOS log was
downloaded):

| Job | Runner | Result and evidence |
|---|---|---|
| Helper (all six jobs, eight targets) | ubuntu-22.04, windows-latest, macos-latest | Pass: static Linux helpers (Alpine x64 smoke in Docker, Arm64 under QEMU); Windows x64 and macOS Arm64 `--version`; Windows Arm64 and Intel macOS cross-compiled |
| Package | ubuntu-22.04 | Pass: eight platform packages and the universal package; Linux helper archives |
| Test (linux-x64) | ubuntu-22.04 | Pass: unit and parity tests with the Linux helper; platform package host tests and Restricted Mode; universal package without a helper; VS Code for the Web |
| Test (win32-x64) | windows-latest | Pass: unit and parity tests with the Windows helper; platform package install, upgrade, host tests with the bundled helper, Restricted Mode, uninstall |
| Test (darwin-arm64) | macos-26 Arm64 (image 20261123.0526) | Fail: 84/84 unit tests and every platform package host check with the bundled helper passed; the Restricted Mode launch failed with `listen EINVAL` on `<tmp>/comparecraft-vscode-restricted-XXXXXX/profile/1.14-main.sock`, 109 characters where macOS allows 103 |
| Remote smoke (ssh), (container) | ubuntu-22.04 | Pass |

The macOS fix (Restricted Mode runs keep their profile under `cc-restricted-XXXXXX`,
92 characters on macOS) was checked on Linux, which allows 107 characters, with
`XDG_RUNTIME_DIR` unset (VS Code then puts its socket in the profile, as on
macOS) and `TMPDIR` set 4 characters longer than macOS's:

| Date | Task | Kind | Command or journey | Result and evidence |
|---|---|---|---|---|
| 2026-11-28 | H020 | packaged | Restricted Mode launch alone, before the fix | Fail as on macOS: `listen EINVAL` on a 113-character socket path |
| 2026-11-28 | H020 | packaged | Restricted Mode launch alone, after the fix | Pass |
| 2026-11-28 | H020 | packaged | `node scripts/test-vsix.cjs comparecraft-0.1.0-linux-x64.vsix` under the same conditions | Pass: content check with the helper, every host check with the bundled helper, Restricted Mode, uninstall |

Record further evidence the same way: date, task, host and versions, exact
command, and whether it is unit, integration, browser, packaged, remote or
manual evidence. Redact hostnames and private paths.

## Known issues and notes

- **Rust test flake (pre-existing):** `settings::tests::settings_round_trip_and_export`
  races a `cli` test over `COMPARECRAFT_CONFIG_DIR` and failed about one run in
  three, on `main` as well. Not changed here.
- **Playwright flake (pre-existing):** `tests/ui/comparison-lifecycle.spec.ts:35`
  (minimap viewport) failed 1 of 15 repeats on the code before these changes.
- **VS Code 1.148 hangs on exit after tests:** the runners stop it once the
  tests have recorded their result (`scripts/run-host-tests.cjs`).
- **Socket path limit for test profiles:** VS Code listens on
  `<profile>/<version>-main.sock` on macOS (and on Linux without
  `XDG_RUNTIME_DIR`); socket paths are limited to 103 characters on macOS, and
  its temporary directory takes about 50. Keep test profile paths short. The
  integration runner's main profile (`comparecraft-vscode-host-XXXXXX/profile`)
  reaches exactly 103 there, the length at which VS Code starts warning; shorten
  it if `npm run test:integration` fails on a Mac (CI doesn't run it there).
- **Wayland desktops:** Electron tests under Xvfb need `WAYLAND_DISPLAY` (and
  `OZONE_PLATFORM`/`GDK_BACKEND` overrides) cleared; see DEVELOPMENT.md.
- **Attaching to running containers** asks a modal trust question that test
  windows refuse, so `test:remote --via container` opens a folder in a dev
  container instead. Attach flows use the same extension host and code paths.
- **Saved sessions don't record their host:** sessions keep paths without the
  remote authority. If VS Code shares the extension's global state between local
  and remote windows, a session saved in an SSH window can be listed where its
  paths don't exist. Not verified; scoping sessions by authority is open (folder
  roadmap Phase C).
- **WebAssembly calls are synchronous** in the extension host: a 64 MiB input
  blocks it while comparing. The helper is used whenever it is installed and the
  files are on disk.
- **Release workflow trigger (pre-existing):** `release: created` doesn't fire for
  releases created with `GITHUB_TOKEN` (for example by the desktop build's
  `tauri-action` draft); create the release directly as DEVELOPMENT.md says.

## Environment on the Linux laptop

Installed user-locally, not committed and not needed on other computers: Rustup
targets `wasm32-unknown-unknown`, `x86_64-unknown-linux-musl` and
`aarch64-unknown-linux-musl`; npm dev dependencies `esbuild` and
`@vscode/test-web`; VS Code 1.148.0 and VS Code for the Web downloads in the
ignored `.vscode-test/` and `.vscode-test-web/`. Docker images pulled for tests:
`alpine:3`, `debian:bookworm-slim` (base of `comparecraft-remote-test`, which
`test:remote` builds and keeps for reruns). The host's own SSH daemon was not
used or changed; remote tests used disposable containers bound to 127.0.0.1.

## Next actions

1. Push the macOS fix and confirm Test (darwin-arm64) passes on the rerun (H020).
2. On Windows with WSL: install the `linux-x64` VSIX in a WSL window and repeat
   the remote checks (H019). CI now covers the `win32-x64` package.
3. Where hardware exists, host-test the Arm64 and Intel macOS packages (H021).
4. Consider scoping saved sessions by remote authority before advertising
   remote folder sessions (folder roadmap Phase C/D).
