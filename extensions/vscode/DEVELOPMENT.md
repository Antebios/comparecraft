# Developing the CompareCraft VS Code extension

This guide is for contributors and maintainers. The [README](README.md) is the
user-facing documentation displayed on the extension's Marketplace page.
This guide is excluded from the VSIX.

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
helper built from source, then uploads the VSIX as a workflow artifact. It never
publishes. Native installer, signing, menus, and desktop GUI checks remain
separate from CI.

## Documentation and screenshots

- Keep [README.md](README.md) focused on installation, commands, settings,
  screenshots, safety, limitations, and troubleshooting for users.
- Keep build, test, CI, release-process, and implementation details here.
- Put Marketplace screenshots in [media/screenshots](media/screenshots) and use
  relative image links in the README so they are included in the VSIX.
- After changing packaging rules or documentation, rebuild the VSIX and verify
  that the README and images are included and this guide is excluded.
- Update the public installation instructions when Marketplace distribution
  becomes available; do not advertise an unpublished listing.

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
