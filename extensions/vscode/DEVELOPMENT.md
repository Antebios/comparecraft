# Developing the CompareCraft VS Code extension

This guide is for contributors, maintainers, and advanced troubleshooting. The
[README](README.md) is the user-facing documentation intended for the extension's
Marketplace page. This guide is excluded from the VSIX.

## Install, upgrade, and remove

The extension is currently distributed as `.vsix` files; it is not published to
the Visual Studio Marketplace or Open VSX. Update this distribution status when
publishing.

Each platform has its own package, `comparecraft-<version>-<target>.vsix`, with
the `comparecraft-backend` helper in `bin/` (targets `win32-x64`, `win32-arm64`,
`darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `alpine-x64`,
`alpine-arm64`). The universal `comparecraft-<version>.vsix` has no helper and
compares with the WebAssembly engine; it serves other platforms and VS Code for
the Web. VS Code refuses a platform package built for another platform.

1. Install the VSIX for the computer where your files are from **Extensions >
  ... > Install from VSIX...**. In a remote window (SSH, WSL, Dev Containers)
  that is the remote computer: VS Code installs the extension there.
2. Optional: install the CompareCraft desktop app (Windows installer, macOS app,
  or Linux package) to open comparisons in its window. The extension finds
  standard installations automatically.
3. Run **CompareCraft: Check Embedded Backend** from the Command Palette. It
  reports which engine compares (bundled helper, desktop helper, configured
  helper or WebAssembly), its version and protocol, and the environment.

For command-line installation, use:

```text
code --install-extension comparecraft-0.1.0-linux-x64.vsix
```

**Upgrade:** install the newer VSIX the same way and reload the window when VS
Code asks. Settings and Git tool records are kept. Upgrade the desktop app with
its own installer; close CompareCraft tabs first so the old helper is stopped
(the extension restarts it on the next request).

**Remove:** if you used **Configure as Git Merge/Diff Tool...**, run **Remove Git
Tool Configuration...** *before* uninstalling. The extension records the earlier
values in VS Code and cannot restore them once it is uninstalled. Then
uninstall from the Extensions view or with:

```text
code --uninstall-extension macrossplusinc.comparecraft
```

Uninstalling the extension leaves the desktop app, your files, and your
`comparecraft.*` user settings untouched. If Git still points at CompareCraft
after uninstalling, remove the entries yourself (add `--global` if you chose
the global scope):

```text
git config --unset merge.tool
git config --unset diff.tool
git config --remove-section mergetool.comparecraft
git config --remove-section difftool.comparecraft
```

Only unset `merge.tool`/`diff.tool` if their value is `comparecraft`.

## Prerequisites

- Node.js 22 or newer and npm.
- Rust with the `wasm32-unknown-unknown` target (`rustup target add
  wasm32-unknown-unknown`) to build the WebAssembly engine.
- A local VS Code desktop installation, or network access so the test runner can
  download one.
- Git for Git integration tests.
- A `comparecraft-backend` helper for helper tests: an installed CompareCraft
  app's, `npm run stage:helper -- --target <target>` (Rust only, no desktop
  prerequisites), or `cargo build --bin comparecraft-backend` in `src-tauri`
  (needs the desktop prerequisites in the [repository README](../../README.md)).
- For `test:web`, Playwright's Chromium (`npx playwright install chromium`).
  For `test:remote`, Docker and an OpenSSH client.

## Build and run

First run `npm ci` in the repository root. The extension's embedded UI is built
from the shared SolidJS views there. Then, from `extensions/vscode`:

```text
npm ci
npm run build:all
npm test
```

`build:all` runs `build:webview` (the root Vite build that writes
`media/webview/`), `build:engine` (the Rust engine for WebAssembly, written to
`media/engine/comparecraft-engine.wasm`), `build` (extension TypeScript) and
`build:web` (the esbuild browser bundle `out/web/extension.js`; it fails if Node
built-ins reach the browser code). The outputs are git-ignored. `build` alone
does not refresh the webview, engine or browser bundles.

The extension has two entry points sharing `src/activate.ts`: `src/extension.ts`
(Node extension hosts: desktop, remote) and `src/web/extension.ts` (browser).
To try the browser entry, run `npm run build:all`, then
`npx vscode-test-web --browser=chromium --extensionDevelopmentPath=. <folder>`.

Open [dev.code-workspace](dev.code-workspace) in VS Code and press F5 using
**Run CompareCraft Extension**. Its pre-launch task runs `npm run build:all`.
This separate workspace configuration does not edit the repository's existing
workspace settings. In the Extension Development Host, open a trusted local
folder.

## Tests

From this directory:

```text
npm test                    # unit, contract and engine parity tests (Node)
npm run test:integration    # VS Code (Electron) host tests, then Restricted Mode
npm run test:web            # VS Code for the Web in headless Chromium
npm run test:vsix -- <package.vsix>
npm run test:remote -- --via ssh|container --vsix <linux-x64 package>
```

`npm test` includes parity tests that run every engine fixture through both the
WebAssembly engine and the helper and require identical results; they need
`npm run build:engine` and a helper (`COMPARECRAFT_BACKEND`, or the repository's
debug build) and are skipped otherwise.

The integration runner uses a temporary profile/workspace and a harmless Node
launcher to verify commands and arguments without changing your normal VS Code
settings or opening the desktop GUI. It does not substitute for manual
installer/GUI verification. After the main run it covers virtual workspaces
(in-memory file system providers, writable and read-only), the WebAssembly
fallback without any helper, and then launches VS Code again with workspace
trust on so the folder opens in Restricted Mode (`test/restricted.ts`).

By default the runner downloads a VS Code test build. To use an existing
installation, set `VSCODE_EXECUTABLE_PATH` to its executable. Set
`COMPARECRAFT_BACKEND` to exercise **Check Embedded Backend** and the embedded
panels against a real helper; without it the helper-based steps are skipped and
only the WebAssembly checks run.

On Linux without a display, use `xvfb-run -a`. VS Code prefers Wayland when
`WAYLAND_DISPLAY` is set, so on a Wayland desktop clear it (and any
`OZONE_PLATFORM`/`GDK_BACKEND` overrides) for test runs under Xvfb, for example
`env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 xvfb-run -a npm run test:integration`.

`test:web` bundles `test/web/suite.ts` (no Node modules: it runs in the
browser's extension host) and runs it with `@vscode/test-web` against a
temporary folder of sample files: activation, the WebAssembly engine, text,
Hex, Table and Picture views, saving through the file system provider, and the
explanations for folder, Git and desktop commands.

`test:remote` checks remote windows (see
[Remote smoke tests](#remote-smoke-tests)).

For example, in Windows PowerShell:

```powershell
$env:VSCODE_EXECUTABLE_PATH = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
$env:COMPARECRAFT_BACKEND = "$env:LOCALAPPDATA\CompareCraft\comparecraft-backend.exe"
npm run test:integration
```

`COMPARECRAFT_BACKEND` also makes `npm test` run the client contract test against
that helper instead of the repository's debug build. If neither exists, the
real-helper contract test is skipped. To build the debug helper, run
`cargo build --bin comparecraft-backend` from `src-tauri`. On Windows, first run
`node scripts\build-windows-shell-extension.mjs` from the repository root to
generate the shell-extension resources required by the Tauri build.

For folder integration checks, point `COMPARECRAFT_BACKEND` at the helper built
from the same source as the webview. Folder method capabilities alone do not
establish support for newly added options such as `dotNamesFirst`. Helpers
after v0.5.0 advertise the folder option fields they accept
(`capabilities.folderOptions`); the extension leaves out the others (for older
helpers, everything added after v0.5.0) and the webview shows them disabled.
When the shared folder UI gains an option, add it to `WEBVIEW_FOLDER_OPTIONS` in
`src/embeddedCore.ts` and to the helper's `OPTION_FIELDS`. Do not count
skipped real-helper tests as successful folder verification.

VS Code's webview wrapper forwards every keydown it sees on the webview window
to the workbench keybindings. The webview entry point (`src/webview/main.tsx` in
the repository root) dispatches CompareCraft shortcuts on the document and stops
the ones its view handles there, so they never reach VS Code; it leaves
`Shift+Ctrl+P` to VS Code. The extension contributes no keybindings.

## Package and verify the VSIX

```text
npm run stage:helper -- --target linux-x64 --also alpine-x64
npm run package:targets -- --helpers helpers --targets linux-x64,alpine-x64
npm run test:vsix -- comparecraft-<version>-linux-x64.vsix
env -u COMPARECRAFT_BACKEND npm run test:vsix -- comparecraft-<version>.vsix
```

`stage:helper` builds `comparecraft-backend` with only the `native` feature (no
Tauri, WebView or desktop prerequisites) into `src-tauri/target/portable` and
copies it to `helpers/<target>/`. Linux helpers are static musl binaries that
run on any distribution, Alpine included; other architectures cross-compile
with Rust's bundled `rust-lld`. Windows and macOS helpers are built on those
systems. `package:targets` builds everything once (`build:all`), then packages
each target that has a staged helper plus the universal package (no `bin/`).
`npm run package` alone writes only the universal `comparecraft-<version>.vsix`.
The VSIX files are git-ignored. There is no publish script.

`test:vsix` uses temporary extension and profile directories to:

1. Package and install an older-version copy of the same code.
2. Upgrade to the real VSIX.
3. Check the installed files: compiled code, browser bundle, webview bundle,
   WebAssembly engine, screenshots, README, CHANGELOG and license; the helper in
   `bin/` for platform packages and none in the universal package; without
   source, tests, scripts, maps, `node_modules`, or this development guide.
4. Run the host tests against the installed extension files: with the bundled
   helper for platform packages, otherwise with `COMPARECRAFT_BACKEND` or the
   WebAssembly engine alone.
5. Run the Restricted Mode checks against the installed files.
6. Uninstall the extension and confirm it is no longer listed.

The package's target comes from its file name. The older-version copy tests the
upgrade mechanism, not migration from an actual earlier release. The runner
honors `VSCODE_EXECUTABLE_PATH` like `test:integration`. On Linux without a
display, use `xvfb-run -a npm run test:vsix`.

Both `test:integration` and `test:vsix` launch VS Code through
`scripts/run-host-tests.cjs`. The host tests record whether they passed; if VS Code
then does not quit within 30 seconds (some VS Code releases hang on shutdown), the
runner stops it and uses the recorded result. A run with no result is stopped
after 20 minutes. `COMPARECRAFT_HOST_EXIT_GRACE_MS` and
`COMPARECRAFT_HOST_TIMEOUT_MS` change these limits.

To test a specific package:

```text
npm run test:vsix -- path-to-package.vsix
```

`COMPARECRAFT_VSIX_SKIP_HOST=1` skips the host step; do not treat that as full
release verification.

### Remote smoke tests

```text
npm run build
xvfb-run -a npm run test:remote -- --via ssh --vsix comparecraft-<version>-linux-x64.vsix
xvfb-run -a npm run test:remote -- --via container --vsix comparecraft-<version>-linux-x64.vsix
```

`test:remote` builds a Debian test image, then opens a Remote-SSH window (sshd
in a disposable container on 127.0.0.1 with a throwaway key) or a dev container
window from an isolated VS Code profile with the Remote-SSH or Dev Containers
extension. It runs `test/remote.ts` in the remote extension host with the
extension unpacked from the VSIX: the bundled helper must run on the remote
host, text, folder and Git comparisons must work on remote files, Explorer drops
must become remote paths, the desktop app and the local file manager must be
refused, and the helper must end with the remote extension host. The remote
host doesn't inherit the runner's environment, so expectations and results go
through files in the remote workspace. Containers, keys and the profile are
removed afterwards; `--keep` keeps them (with VS Code's logs) after a failure.
The automated run opens a folder in a dev container rather than attaching to a
running one, because attaching asks a trust question that test windows can't
answer. WSL needs a Windows machine and is verified by hand with the same
checks.

### Continuous integration

The [vscode-extension workflow](../../.github/workflows/vscode-extension.yml)
builds the helper for every target (static musl on Linux, smoke-tested with
`--version`, on Alpine and, for Arm64, under QEMU), packages the eight platform
VSIX files and the universal one, and uploads them as a workflow artifact. Test
jobs on Linux x64, Windows x64 and macOS Arm64 run the unit and parity tests
against their platform's helper and `test:vsix` on their platform package;
Linux also tests the universal package without a helper and runs `test:web`.
Linux runs `test:remote` over SSH and Dev Containers, which reports problems
without holding up publishing. Arm64 Linux and Windows, Intel macOS and Alpine
packages are built and their helpers checked, but not host-tested. Relevant
pushes to `main`, pull requests, and manual dispatch run all these checks without
publishing, using the checked-in extension version. When a GitHub release is
created, the workflow uses the release's tagged source. The tag must use `vN.N.N`
or `vN.N.N-pre` (for example, `v1.2.3` or `v1.2.3-beta.1`, checked by
`scripts/version.mjs`); CI sets the extension manifest and lockfile version to
the tag's version before testing and packaging, without committing those changes.
Only release creation publishes the tested packages, after every test job passes.
Pre-release tags are tested and packaged but not published, because the
Marketplace doesn't accept pre-release version numbers. Every release, pre-releases
included, gets the VSIX files and helper-only Linux archives
(`comparecraft-backend-<version>-linux-<arch>.tar.gz`) as release assets.
Native installer, signing, menus, and desktop GUI checks remain separate from CI.

## Documentation screenshots

Keep extension screenshots in [media/screenshots](media/screenshots), with a
relative image link for every PNG in the [README](README.md). `test:vsix`
checks that each image is packaged and its README link points to the extension
subdirectory in the repository.

All extension screenshots were captured from a real Extension Development Host
using an isolated profile, a local helper and synthetic demo files. Do not
capture personal workspaces, credentials or unrelated windows. Use the same demo
data for related images, dismiss notifications, and crop menus or dialogs without
changing their content.

The current set was captured on Linux with the downloaded test VS Code on an
Xvfb display (1920×1140 for images 01–03, 1440×900 for the others) in the
Default Dark Modern theme:

- VS Code ran with `--ozone-platform=x11 --force-device-scale-factor=1`, without
  `WAYLAND_DISPLAY` and `GDK_SCALE`, and with `--remote-debugging-port`.
- A private `XDG_CONFIG_HOME` kept user fontconfig aliases out, and
  `editor.fontFamily` was set to Liberation Mono, a font without ligatures.
- An `--extensionTestsPath` script opened each scene through the test-mode API.
  The merge came from a real Git merge conflict, opened with **Resolve Conflict
  in VS Code**.
- Playwright's `connectOverCDP` clicked and hovered in the webview (menus, the
  presets dialog, saving a session), and `import -window root` took the image.
- Crops use the webview or dialog bounds.

The [manual image directory](../../docs/manual/images) contains copies of the
extension images needed by the standalone manual. Refresh those copies together
with their originals. The light-theme folder, sorting and text images show the
actual shared frontend in its browser UI harness with a real backend helper,
not native desktop window chrome. The two progress examples use deterministic
test progress events to hold each transient stage for capture; they illustrate
the desktop UI, not measured performance or detailed progress support in VS Code.
Write captures outside the watched manual directory first to avoid hot reload
resetting the view during capture. Validate with the root `npm run docs:build`,
`npm run build`, then extension `npm run package` and `npm run test:vsix`.

## Publish to the Visual Studio Marketplace

### One-time setup

1. Create or verify the Marketplace publisher **MacrossPlusInc**, matching `publisher`
  in the extension manifest. The account used to publish must have access to it.
2. Follow the [VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
  to create a Personal Access Token with **Marketplace > Manage** scope and
  **All accessible organizations**. Use a limited lifetime and rotate it before
  expiry. A GitHub token cannot replace this Marketplace token.
3. In the repository's **Settings > Environments**, create **vscode-marketplace**.
  Allow release tags matching **v*** in the deployment branch/tag rules and add
  required reviewers where your GitHub plan supports them.
4. Add the token as an environment secret named **VSCE_PAT**. Do not put it in
  source files, workflow inputs, or logs.

### Release an extension version

1. Complete the pending platform/sign-off checks in the release handoff. Confirm
  the desktop app and helper for the extension's release line are available.
2. Move the [CHANGELOG](CHANGELOG.md) **Unreleased** entries under the new version,
  merge the release changes into **main** and tag the release commit with a new
  version such as `v1.2.3`. Do not reuse a published version.
3. Create a GitHub release for that tag directly, without saving a draft first.
  The `release.created` event starts the workflow; draft releases do not trigger
  that event. CI derives version `1.2.3` from `v1.2.3`, so no manual manifest or
  lockfile version update is required.
4. Wait for the Linux, Windows, and macOS tests, then approve the
  **vscode-marketplace** deployment if required. The publish job downloads the
  tested platform and universal packages and publishes them together
  (`vsce publish --packagePath ...`) without rebuilding or changing their version.
5. Verify the listing, icon, screenshots, changelog and installation from the
  Marketplace on at least one platform package and in VS Code for the Web.
  After the first successful publication, update the distribution status at the
  top of this guide. This workflow does not publish to Open VSX; it attaches the
  packages and Linux helper archives to the GitHub release.

Publishing is serialized to avoid concurrent uploads, and the job only receives the Marketplace token
after the platform checks and environment protection rules pass. If an upload
fails, check the Marketplace before retrying: a version already accepted there
cannot be overwritten.

## Documentation and screenshots

- Keep [README.md](README.md) focused on getting started, commands, settings,
  screenshots, safety, limitations, and troubleshooting for users.
- Keep manual VSIX installation, upgrade/removal procedures, build, test, CI,
  release-process, and implementation details here.
- Put Marketplace screenshots in [media/screenshots](media/screenshots) and use
  relative image links in the README so they are included in the VSIX.
- The manifest's `vsce.baseContentUrl` and `vsce.baseImagesUrl` point to
  `extensions/vscode` on GitHub's `main` branch. VSCE otherwise rewrites links
  relative to the repository root, ignoring `repository.directory`. The packaged
  README loads screenshots over HTTPS, not from its bundled copies: merge/push
  the images to `main` and ensure they are publicly accessible before release.
  Check that the image URLs return HTTP 200; private or unpublished files return
  404. The VSIX test verifies URL structure and bundled files, not remote access.
- The extension icon is [media/icon.png](media/icon.png), copied from the desktop
  app's [256-pixel icon](../../src-tauri/icons/128x128@2x.png). Keep it in sync
  when the app branding changes.
- After changing packaging rules or documentation, rebuild the VSIX and verify
  that the README and images are included and this guide is excluded.
- Update the distribution status and manual installation instructions here when
  Marketplace distribution becomes available; do not advertise an unpublished listing.

## Advanced Git tool configuration

**Configure as Git Merge/Diff Tool...** asks for:

1. **Scope**: *This repository* (recommended, writes `.git/config`) or *Global*
   (`~/.gitconfig`, requires a second confirmation).
2. **Tools**: merge and diff, merge only, or diff only.
3. Confirmation of the exact values, including any values they replace.

It sets `merge.tool`/`diff.tool` to `comparecraft` and defines
`mergetool.comparecraft.cmd` and `difftool.comparecraft.cmd` to run the installed
console launcher (`ccomp`, next to the desktop app; the desktop executable is used
if it is absent). `mergetool.comparecraft.trustExitCode` is `false`, so Git decides
success from whether the merged file changed and asks when it did not. The window
must be closed before Git continues to the next file.

Previous values are recorded in VS Code. **Remove Git Tool Configuration...**
restores each setting only while it still has CompareCraft's value; settings you
changed afterwards are left alone and reported. Multi-valued settings are never
replaced. Then run, for example:

```text
git mergetool
git difftool HEAD~1 -- path/to/file
```

If the terminal does not use CompareCraft, check
`git config --show-origin merge.tool`; a repository value overrides the global
one. Rerun configuration after moving the app.

## Installation discovery and helper diagnostics

The extension does not modify `PATH` or download anything. Embedded comparisons
use the first helper found: `comparecraft.backendPath` (user setting), the helper
bundled in the extension's `bin/` (made executable if needed), then the one next
to the desktop app. Without any, they use the WebAssembly engine
(`media/engine/comparecraft-engine.wasm`) for text, Hex, Table and Picture
comparisons; folder comparisons need a helper. In VS Code for the Web only the
WebAssembly engine exists. Without an override, the extension checks these
desktop executable locations:

- Windows: `%LOCALAPPDATA%\CompareCraft\comparecraft.exe`, then CompareCraft
  directories under available Program Files locations.
- macOS: `/Applications/CompareCraft.app/Contents/MacOS/comparecraft`, then the
  equivalent app under `~/Applications`.
- Linux: `/usr/bin/comparecraft`, `/usr/local/bin/comparecraft`,
  `~/.local/bin/comparecraft`.

For an AppImage or custom/portable installation, select its absolute executable
path, not a directory or shell command. On Unix it must have execute permission;
Windows requires an `.exe`. Invalid explicit paths are errors, not permission to
use another installation. Workspace-controlled executable settings are ignored.

CompareCraft installs `comparecraft-backend` (`comparecraft-backend.exe` on
Windows) next to the desktop executable, for example
`%LOCALAPPDATA%\CompareCraft\comparecraft-backend.exe`,
`CompareCraft.app/Contents/MacOS/comparecraft-backend`, or
`/usr/bin/comparecraft-backend`. The extension starts it only when needed, talks
to it over stdin/stdout (no network port), and stops it when VS Code closes or
the executable settings change. It only reads files; it never writes them.

Run **CompareCraft: Check Embedded Backend** from the Command Palette to confirm
the engine starts and compares text. It names the engine (and for a helper its
source, path, version and protocol) and the environment (for example "a window
connected to an SSH host (Restricted Mode)") in a notification and in the
**CompareCraft** Output channel. Embedded mode requires protocol version 1. An
incompatible protocol, a crash or an invalid configured path is reported
explicitly rather than replaced by another installation or the WebAssembly
engine. If a helper is too old, update it or set `comparecraft.backendPath` to
the correct helper.

Set `COMPARECRAFT_BACKEND_LOG=debug` before starting VS Code for per-request
timing in the Output channel. After a crash, reopen the comparison; the helper
is restarted on the next request.

## Comparison implementation notes

### Desktop snapshots and process lifecycle

In desktop mode, unsaved editor content is written to private, read-only
snapshots in the extension's global storage. Snapshots are never write-back
targets. They are deleted when the desktop window that uses them closes, or,
if VS Code closed first, on a later start once that desktop process has ended.
Abandoned snapshots are removed after 7 days.

Snapshot comparisons start a dedicated desktop window (`-solo`) so the extension
knows when it closes. Folder comparisons refuse folders containing dirty open
files because a folder cannot be snapshotted reliably.

The desktop app remains open when VS Code or the extension closes. Plain
file/folder comparisons may be handed to an existing CompareCraft instance
through its normal single-instance behavior. Launching or closing the app is
not reported as a successful merge. When a merge window closes, staging is
offered only if the result changed and the Git conflict state is unchanged.

### Embedded views and document handling

The initial view is selected by the type of the first file that exists. Files
with unsaved edits, Git revisions, clipboard content, and other in-memory sides
always use text comparison. Binary, picture and table requests an older helper
doesn't offer are served by the WebAssembly engine.

Switching views inside a CompareCraft tab opens another tab. Text Edit opens
VS Code's normal editor. Folder Compare, Folder Sync, and Folder Merge ask
before opening the desktop app. Embedded view settings are stored by VS Code,
separately from the desktop app's settings.

Editable text sides use the current VS Code buffer. Saving writes through VS
Code documents, preserving existing encoding and line endings and supporting
Undo, Local History, and format-on-save. Saves are refused if the file changed
in an editor or on disk after loading. Merge results do not use the result
file's buffer, so saves are also refused while that buffer is dirty.

Hidden tabs retain their state. Extensions cannot cancel closing an unsaved
webview tab; a notification offers **Restore Comparison** or **Open as Untitled**.
Window reload restores open tabs, including unsaved text.

Git comparisons offer the file's last 50 commits when choosing a revision.
Missing Git sides are empty documents labeled with their absence; add/add
conflicts use an empty base. Current, Base, and Incoming come read-only from
Git's index stages, and only the result can be saved.

## Architecture and release handoff

The extension doesn't need the desktop app: platform packages bundle the
windowless helper (stdin/stdout, protocol version 1) and every package includes
the WebAssembly engine. `src/policy.ts` decides what each environment allows
(desktop app, Git, saving, folders, revealing files) for commands, menus and
webview requests alike; `src/engine.ts` routes requests to the helper or the
WebAssembly engine. See the
[backend protocol](../../docs/vscode-extension/backend-protocol.md) for contracts,
capability handling and the WebAssembly interface, and the
[host support plan](../../docs/vscode-extension/host-support-plan.md) and
[handoff](../../docs/vscode-extension/handoff-host-support.md) for the
environment matrix and its verification.

The [implementation plan](../../docs/vscode-extension/plan.md),
[handoff and platform matrix](../../docs/vscode-extension/handoff.md), and
[Phase 6 report](../../docs/vscode-extension/phase-6-report.yaml) track acceptance
and verification gaps. Windows x64 with the per-user installer has been
verified; do not infer macOS/Linux installer support from source-built CI tests
or claim an unexecuted workflow passed.

Before publishing, finish the pending platform/sign-off checks in the handoff,
verify the VSIX with the intended helper, and review the user-facing README.
Publishing is a separate authorized action, not part of packaging or CI.
