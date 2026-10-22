# CompareCraft for VS Code (Phase 1)

Compare local saved files and folders using the installed CompareCraft desktop
application. This is the first increment of one extension offering desktop and
embedded experiences. **Embedded UI, buffer/selection/clipboard snapshots, and Git
commands are not available yet.**

## Requirements

- VS Code 1.95 or newer on local Windows, macOS, or Linux desktop.
- An installed [CompareCraft desktop app](https://github.com/Antebios/comparecraft/releases).
- A trusted local workspace. Remote SSH, WSL, Dev Containers, browser-only hosts,
  and virtual resources are not supported in this increment.

The extension does not modify PATH, download an engine, or change Git settings.

## Develop and run

From this directory:

Use Node.js 22 or newer for development and tests.

```text
npm ci
npm run build
npm test
```

Open [dev.code-workspace](dev.code-workspace) in VS Code and press F5 using
**Run CompareCraft Extension**. This uses a separate workspace configuration,
without editing the repository's existing workspace settings. In the Extension
Development Host, open a trusted local folder.

For real-host integration tests:

```text
npm run test:integration
```

By default the VS Code test runner downloads a test build. To use an existing
installation instead, set `VSCODE_EXECUTABLE_PATH` to its executable before running
the command. For example, in Windows PowerShell:

```powershell
$env:VSCODE_EXECUTABLE_PATH = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
npm run test:integration
```

Tests use a temporary profile/workspace and a harmless Node launcher to verify
commands and arguments without changing your normal VS Code settings or opening
the desktop GUI. They do not substitute for manual installer/GUI verification.

## Commands

Right-click resources in Explorer, a text editor, or an editor tab and open the
**CompareCraft** submenu. All commands are also available in the Command Palette.

| Command | Behavior |
|---|---|
| Compare Selected... | Uses the configured destination; two Explorer selections preserve the supplied left/right order. With one item, picks a matching right item. |
| Compare Selected in Desktop App | Explicitly launches the installed desktop app. |
| Compare Selected in VS Code | Explains that embedded support is not available and offers **Open in Desktop App**; never silently switches. |
| Select Left File or Folder | Remembers one file and one folder independently for this VS Code window. |
| Compare with Selected Left... | Compares the chosen right item with the remembered left item of the same type. |
| Clear Left Selections | Clears both remembered selections. |
| Compare File With... | Uses the selected/active file, or asks for a left file, then picks a right file. |
| Compare Folder With... | Uses the selected folder, or asks for a left folder, then picks a right folder. |
| Compare Parent Folder With... | Compares the selected file's parent directory against a chosen folder. |
| Open Desktop App | Opens CompareCraft's home view directly. |
| Locate Desktop Executable... | Validates and saves an absolute executable path in user settings. |

Only two files or two folders can be compared. Duplicate items, mixed types, and
invalid resources produce visible errors. From the palette, Compare Selected
uses the active saved text tab or asks for files; use Compare Folder With for
folder-only picking. Select Left state lasts until cleared or the extension host
restarts; it does not change desktop shell selections.

**Unsaved content is never silently replaced by disk content.** Phase 1 blocks
comparisons of dirty open files, including dirty files inside compared folders.
Save intentionally before retrying. Untitled/virtual documents are unsupported.
Snapshot-based comparisons arrive in Phase 2; there is no automatic save.

## Settings and installation discovery

| Setting | Default | Meaning |
|---|---|---|
| `comparecraft.defaultMode` | `embedded` | `embedded` offers an explicit desktop action in Phase 1. Set to `desktop` for direct external launches. |
| `comparecraft.desktopPath` | empty | User/machine absolute executable path; never a directory or shell command. |
| `comparecraft.backendPath` | empty | Reserved for the later headless backend; unused in Phase 1. |

An invalid explicit path is an error, not permission to use another installation.
Workspace-controlled executable settings are ignored.

Without an override, the extension checks:

- Windows: `%LOCALAPPDATA%\CompareCraft\comparecraft.exe`, then CompareCraft
  directories under available Program Files locations.
- macOS: `/Applications/CompareCraft.app/Contents/MacOS/comparecraft`, then the
  equivalent app under `~/Applications`.
- Linux: `/usr/bin/comparecraft`, `/usr/local/bin/comparecraft`,
  `~/.local/bin/comparecraft`.

For an AppImage or custom/portable installation, select its absolute executable
path. On Unix it must have execute permission; Windows requires an `.exe`.
Missing installations offer **Locate Executable** and **Download CompareCraft**.
The **CompareCraft** Output channel records launches and errors.

The desktop app remains open when VS Code or the extension closes. Existing
CompareCraft instances may receive comparisons through their normal single-instance
behavior. The extension does not report a successful merge merely because an
application launches or closes.

## Next increments

See the repository's [implementation plan](../../docs/vscode-extension/plan.md)
and [portable handoff](../../docs/vscode-extension/handoff.md). No backend, Git
configuration, merge resolution, or native comparison algorithm was changed by
this phase. Marketplace publication is not part of this increment.
