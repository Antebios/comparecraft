# Developing the CompareCraft VS Code extension

This guide is for contributors, maintainers, and advanced troubleshooting. The
[README](README.md) is the user-facing documentation intended for the extension's
Marketplace page. This guide is excluded from the VSIX.

## Install, upgrade, and remove

The extension is currently distributed as a `.vsix` file; it is not published to
the Visual Studio Marketplace or Open VSX. Update this distribution status when
publishing.

1. Install CompareCraft itself first (Windows installer, macOS app, or Linux
  package). The extension finds standard installations automatically.
2. Install the VSIX from **Extensions > ... > Install from VSIX...**.
3. Run **CompareCraft: Check Embedded Backend** from the Command Palette. It
  reports the helper's version and protocol.

For command-line installation, use:

```text
code --install-extension comparecraft-0.1.0.vsix
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
code --uninstall-extension antebios.comparecraft
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
- A local VS Code desktop installation, or network access so the test runner can
  download one.
- Git for Git integration tests.
- An installed CompareCraft app with `comparecraft-backend`, or a helper built
  from this repository. Building it requires Rust and the platform prerequisites
  described in the [repository README](../../README.md).

## Build and run

First run `npm ci` in the repository root. The extension's embedded UI is built
from the shared SolidJS views there. Then, from `extensions/vscode`:

```text
npm ci
npm run build:all
npm test
```

`build:all` runs `build:webview` (the root Vite build that writes
`media/webview/`, which is git-ignored) and then `build` (extension TypeScript).
`build` alone does not refresh the webview bundle.

Open [dev.code-workspace](dev.code-workspace) in VS Code and press F5 using
**Run CompareCraft Extension**. Its pre-launch task runs `npm run build:all`.
This separate workspace configuration does not edit the repository's existing
workspace settings. In the Extension Development Host, open a trusted local
folder.

## Tests

From this directory:

```text
npm test
npm run test:integration
```

The integration runner uses a temporary profile/workspace and a harmless Node
launcher to verify commands and arguments without changing your normal VS Code
settings or opening the desktop GUI. It does not substitute for manual
installer/GUI verification.

By default the runner downloads a VS Code test build. To use an existing
installation, set `VSCODE_EXECUTABLE_PATH` to its executable. Set
`COMPARECRAFT_BACKEND` to exercise **Check Embedded Backend** and the embedded
panels against a real helper; without it those integration steps are skipped.

For example, in Windows PowerShell:

```powershell
$env:VSCODE_EXECUTABLE_PATH = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
$env:COMPARECRAFT_BACKEND = "$env:LOCALAPPDATA\CompareCraft\comparecraft-backend.exe"
npm run test:integration
```

`COMPARECRAFT_BACKEND` also makes `npm test` run the client contract test against
that helper instead of the repository's debug build. If neither exists, the
real-helper contract test is skipped. To build the debug helper, run
`cargo build --bin comparecraft-backend` from `src-tauri`.

## Package and verify the VSIX

```text
npm run package
npm run test:vsix
```

`package` runs the webview and TypeScript builds and writes
`comparecraft-<version>.vsix` (git-ignored) with
`vsce package --no-dependencies`. There is no publish script.

`test:vsix` uses temporary extension and profile directories to:

1. Package and install an older-version copy of the same code.
2. Upgrade to the real VSIX.
3. Check the installed files: compiled code, webview bundle, screenshots, README,
   and license, without source, tests, scripts, maps, `node_modules`, or this
   development guide.
4. Run the host tests against the installed extension files.
5. Uninstall the extension and confirm it is no longer listed.

The older-version copy tests the upgrade mechanism, not migration from an
actual earlier release. The runner honors `VSCODE_EXECUTABLE_PATH` and
`COMPARECRAFT_BACKEND` like `test:integration`. On Linux without a display, use
`xvfb-run -a npm run test:vsix`.

To test a specific package:

```text
npm run test:vsix -- path-to-package.vsix
```

`COMPARECRAFT_VSIX_SKIP_HOST=1` skips the host step; do not treat that as full
release verification.

The [vscode-extension workflow](../../.github/workflows/vscode-extension.yml)
runs unit tests, packaging, and `test:vsix` on Windows, macOS, and Linux against a
helper built from source, then uploads the VSIX as a workflow artifact. Pushes
and pull requests never publish. A manual run can publish that tested artifact
after every platform passes. Native installer, signing, menus, and desktop GUI
checks remain separate from CI.

## Publish to the Visual Studio Marketplace

### One-time setup

1. Create or verify the Marketplace publisher **antebios**, matching `publisher`
  in the extension manifest. The account used to publish must have access to it.
2. Follow the [VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
  to create a Personal Access Token with **Marketplace > Manage** scope and
  **All accessible organizations**. Use a limited lifetime and rotate it before
  expiry. A GitHub token cannot replace this Marketplace token.
3. In the repository's **Settings > Environments**, create **vscode-marketplace**.
  Restrict deployment branches to **main** and add required reviewers where your
  GitHub plan supports them.
4. Add the token as an environment secret named **VSCE_PAT**. Do not put it in
  source files, workflow inputs, or logs.

### Release an extension version

1. Complete the pending platform/sign-off checks in the release handoff. Confirm
  the desktop app and helper for the extension's release line are available.
2. Set a new version in the extension manifest and keep its lockfile version in
  sync. Merge the release changes into **main**. Do not reuse a published version.
3. In **Actions > vscode-extension > Run workflow**, select **main**, enable
  **Publish the tested VSIX to the Visual Studio Marketplace**, and enter the
  exact extension version, such as `0.1.0`.
4. Wait for the Linux, Windows, and macOS tests, then approve the
  **vscode-marketplace** deployment if required. The publish job downloads the
  tested Linux VSIX and publishes it without rebuilding or changing its version.
5. Verify the listing, icon, screenshots, and installation from the Marketplace.
  After the first successful publication, update the distribution status at the
  top of this guide. This workflow does not publish to Open VSX or GitHub Releases.

Leaving the publish checkbox off runs verification only. Publishing is serialized
to avoid concurrent uploads, and the job only receives the Marketplace token
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

The extension does not modify `PATH` or download an engine. Without an override,
it checks these desktop executable locations:

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
the helper starts and compares text. Its version and protocol appear in a
notification and in the **CompareCraft** Output channel. Embedded mode requires
protocol version 1 and a helper from the same release line. An incompatible
protocol or a crash is reported explicitly rather than replaced by another
installation. If the helper is missing or too old, update the desktop app or
set `comparecraft.backendPath` to the correct helper.

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
always use text comparison. Older helpers without binary, picture, or table
comparison methods fall back to text for initial comparisons; explicit views
unsupported by the helper offer the desktop app instead.

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

The extension requires the installed desktop app; it does not download an
engine. The windowless helper uses stdin/stdout and protocol version 1. See the
[backend protocol](../../docs/vscode-extension/backend-protocol.md) for contracts
and capability handling.

The [implementation plan](../../docs/vscode-extension/plan.md),
[handoff and platform matrix](../../docs/vscode-extension/handoff.md), and
[Phase 6 report](../../docs/vscode-extension/phase-6-report.yaml) track acceptance
and verification gaps. Windows x64 with the per-user installer has been
verified; do not infer macOS/Linux installer support from source-built CI tests
or claim an unexecuted workflow passed.

Before publishing, finish the pending platform/sign-off checks in the handoff,
verify the VSIX with the intended helper, and review the user-facing README.
Publishing is a separate authorized action, not part of packaging or CI.
