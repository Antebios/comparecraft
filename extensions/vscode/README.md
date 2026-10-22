# CompareCraft for VS Code (Phase 2)

Compare files, folders, editor text, and Git revisions, and resolve Git merge or
rebase conflicts, using the installed CompareCraft desktop application. This is
an early increment of one extension that will offer both desktop and embedded
experiences. **The embedded (in-editor) UI is not available yet**; every command
opens the desktop app.

## Requirements

- VS Code 1.95 or newer on local Windows, macOS, or Linux desktop.
- An installed [CompareCraft desktop app](https://github.com/Antebios/comparecraft/releases).
- A trusted local workspace. Remote SSH, WSL, Dev Containers, browser-only hosts,
  and virtual workspaces are not supported in this increment.
- Git on `PATH` (or VS Code's configured Git) for the Git commands.

The extension does not modify PATH or download an engine. It changes Git settings
only when you run **Configure as Git Merge/Diff Tool...** and confirm.

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
uses the active text tab or asks for files; use Compare Folder With for
folder-only picking. Select Left state lasts until cleared or the extension host
restarts; it does not change desktop shell selections.

### Editor text

Right-click inside an editor (including untitled ones) and open **CompareCraft**:

| Command | Behavior |
|---|---|
| Compare with Saved | Compares the unsaved buffer with the file on disk (shown only when the editor is dirty). The disk side opens read-only. |
| Select Text as Left | Remembers the selection, or the whole buffer when nothing is selected. Multiple selections are joined. |
| Compare Text with Left | Compares the current selection/buffer with the remembered left text. |
| Compare Selection with Clipboard | Compares the selection/buffer with the clipboard text. |
| Open Active Diff in Desktop App | In a VS Code diff editor (including Git diffs), opens the same two sides in CompareCraft. Available from the diff editor's **...** menu. |

**Unsaved content is never silently replaced by disk content, and never saved
automatically.** When a compared file has unsaved changes, the extension writes
its current buffer to a private, read-only snapshot labeled *(unsaved buffer)*.
Snapshots live in the extension's global storage, are never write-back targets,
and are deleted when the desktop window that uses them closes (or, if VS Code
closed first, on a later start once that desktop process has ended; abandoned
snapshots are removed after 7 days). Folder comparisons still refuse folders that
contain dirty open files, because a folder cannot be snapshotted reliably.

Snapshot comparisons start a dedicated desktop window (`-solo`) so the extension
knows when it closes. Edits in a snapshot side cannot be saved back to VS Code.

### Git and conflicts

Git commands are in the **CompareCraft > Git** submenu for files (Explorer and
editor) and in the Source Control view's context menu for changed files:

| Command | Behavior |
|---|---|
| Compare with HEAD | Last commit vs working file (or its unsaved buffer). |
| Compare Index with Working Tree | Staged version vs working file. |
| Compare HEAD with Index | Last commit vs staged version. |
| Compare with Revision... | Pick one of the file's last 50 commits and compare with the working file. |
| Resolve Conflict in Desktop App | For a conflicted file, opens a three-way merge: **Current**, **Incoming**, and **Base** come read-only from Git's index stages; the working file is the editable **Result**. |
| Stage Resolved Conflict... | After you save a resolution, runs `git add` for that file only, after confirmation. |
| Configure as Git Merge/Diff Tool... | Opt-in setup so `git mergetool` / `git difftool` in a terminal use CompareCraft. |
| Remove Git Tool Configuration... | Restores the Git settings changed by the command above. |

Conflict labels describe the actual operation instead of "ours/theirs". During a
**merge**, Current is your branch and Incoming is the branch being merged. During
a **rebase**, Current is the new base plus commits already replayed, and Incoming
is the commit being replayed. Cherry-pick, revert, and stash-apply conflicts are
also supported. Missing sides are shown as empty documents with a label such as
*(not in HEAD)*; a conflict added on both sides uses an empty base.

Safety rules:

- The extension **never** commits, continues, skips, or aborts a merge, rebase,
  or cherry-pick. After staging, continue from Source Control or the terminal.
- When the desktop window closes, the extension checks the file. If it changed and
  the conflict state is unchanged, it offers **Stage Resolved File**; otherwise it
  only reports what happened. Staging asks for confirmation, warns about leftover
  conflict markers, and is refused if the Git conflict state changed after the
  merge window opened.
- Save or revert unsaved editor changes to the conflicted file first; the
  desktop app writes the result to the file on disk.
- Binary, symbolic link, submodule, and modify/delete (or rename) conflicts are
  refused with an explanation. Resolve those with Git directly (`git add`/`git rm`).

### Using CompareCraft with `git mergetool` and `git difftool`

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

## Settings and installation discovery

| Setting | Default | Meaning |
|---|---|---|
| `comparecraft.defaultMode` | `embedded` | Applies to Compare Selected. `embedded` offers an explicit desktop action until embedded mode exists. Set to `desktop` for direct external launches. Text and Git commands always use the desktop app. |
| `comparecraft.desktopPath` | empty | User/machine absolute executable path; never a directory or shell command. |
| `comparecraft.backendPath` | empty | Reserved for the later headless backend; currently unused. |

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

The desktop app remains open when VS Code or the extension closes. Plain
file/folder comparisons may be handed to an existing CompareCraft instance through
its normal single-instance behavior. The extension does not report a successful
merge merely because an application launches or closes.

## Next increments

See the repository's [implementation plan](../../docs/vscode-extension/plan.md)
and [portable handoff](../../docs/vscode-extension/handoff.md). Phase 3 adds a
headless backend for the embedded UI. Marketplace publication is not part of
this increment.
