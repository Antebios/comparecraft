# CompareCraft for VS Code (Phase 4)

Compare files, folders, editor text, and Git revisions, and resolve Git merge or
rebase conflicts, using CompareCraft. Two-sided text comparisons can open in a
**CompareCraft tab inside VS Code** (embedded mode, the default) or in the
installed desktop app. Folder comparisons and three-way conflict merges still
use the desktop app. Both modes require an installed CompareCraft: embedded mode
uses its windowless `comparecraft-backend` helper.

## Requirements

- VS Code 1.95 or newer on local Windows, macOS, or Linux desktop.
- An installed [CompareCraft desktop app](https://github.com/Antebios/comparecraft/releases).
- A trusted local workspace. Remote SSH, WSL, Dev Containers, browser-only hosts,
  and virtual workspaces are not supported in this increment.
- Git on `PATH` (or VS Code's configured Git) for the Git commands.

The extension does not modify PATH or download an engine. It changes Git settings
only when you run **Configure as Git Merge/Diff Tool...** and confirm.

## Develop and run

From this directory (the embedded view is built from the repository root's
shared UI, so run `npm ci` in the repository root as well):

Use Node.js 22 or newer for development and tests.

```text
npm ci
npm run build:all
npm test
```

`build:all` runs `build:webview` (the root Vite build that writes
`media/webview/`, which is git-ignored) and then `build` (extension TypeScript).

Open [dev.code-workspace](dev.code-workspace) in VS Code and press F5 using
**Run CompareCraft Extension**. Its pre-launch task runs `npm run build:all`.
This uses a separate workspace configuration,
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

To also run **Check Embedded Backend** and the embedded-panel tests in that VS
Code instance against a real helper, set `COMPARECRAFT_BACKEND` first; without
it, those steps are skipped:

```powershell
$env:COMPARECRAFT_BACKEND = "$env:LOCALAPPDATA\CompareCraft\comparecraft-backend.exe"
npm run test:integration
```

The same variable makes `npm test` run the client contract test against that
helper instead of the repository's debug build.

## Commands

Right-click resources in Explorer, a text editor, or an editor tab and open the
**CompareCraft** submenu. All commands are also available in the Command Palette.

| Command | Behavior |
|---|---|
| Compare Selected... | Uses the configured destination; two Explorer selections preserve the supplied left/right order. With one item, picks a matching right item. |
| Compare Selected in Desktop App | Explicitly launches the installed desktop app. |
| Compare Selected in VS Code | Opens two files in an embedded CompareCraft tab. Folders ask before opening the desktop app; never silently switches. |
| Select Left File or Folder | Remembers one file and one folder independently for this VS Code window. |
| Compare with Selected Left... | Compares the chosen right item with the remembered left item of the same type. |
| Clear Left Selections | Clears both remembered selections. |
| Compare File With... | Uses the selected/active file, or asks for a left file, then picks a right file. |
| Compare Folder With... | Uses the selected folder, or asks for a left folder, then picks a right folder. |
| Compare Parent Folder With... | Compares the selected file's parent directory against a chosen folder. |
| Open Desktop App | Opens CompareCraft's home view directly. |
| Locate Desktop Executable... | Validates and saves an absolute executable path in user settings. |
| Check Embedded Backend | Starts the installed headless helper, runs a sample text comparison, and reports its version and protocol. |

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
automatically.** In embedded mode these comparisons open in a CompareCraft tab
(see [Embedded comparisons](#embedded-comparisons)). In desktop mode, when a
compared file has unsaved changes, the extension writes
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
editor) and in the **CompareCraft** submenu of the Source Control view's context
menu for changed files:

| Command | Behavior |
|---|---|
| Compare with HEAD | Last commit vs working file (or its unsaved buffer). |
| Compare Index with Working Tree | Staged version vs working file. |
| Compare HEAD with Index | Last commit vs staged version. |
| Compare with Revision... | Pick one of the file's last 50 commits and compare with the working file. |
| Resolve Conflict in VS Code | For a conflicted file, opens a three-way merge in a VS Code tab: **Current**, **Incoming**, and **Base** come read-only from Git's index stages; the working file is the **Result**. Saving writes only the result; when no conflict markers remain you are offered to stage it (after confirmation). Nothing is ever committed. Unsaved merge work is offered as an Untitled document when the tab closes. |
| Resolve Conflict in Desktop App | The same three-way merge in the desktop app. |
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

## Embedded comparisons

In embedded mode, two-sided comparisons open in a **CompareCraft** editor tab
that uses the same text-comparison UI as the desktop app, styled with your VS
Code theme. Several tabs can be open at once. What opens where:

| Comparison | Embedded mode |
|---|---|
| Two Explorer files, Compare File With..., Select Left / Compare with Left | VS Code tab; both sides editable |
| Compare with Saved, text/selection/clipboard, Git HEAD/index/revision | VS Code tab; sides without a file (or the saved disk side) are read-only |
| Folders | Asks, then opens the desktop app |
| Resolve Conflict in VS Code | VS Code tab; three read-only sides and the result file |
| Resolve Conflict in Desktop App, Open Active Diff in Desktop App | Always the desktop app |

Editing and saving:

- An editable side shows the file's **current VS Code buffer**, including
  unsaved edits made in a normal editor. Saving in the CompareCraft tab
  writes through VS Code (so Undo in the normal editor, Local History, and
  format-on-save apply) and saves that file.
- If the file changed in a normal editor or on disk after the tab loaded it,
  the save is refused and the tab warns you; reload the side first. Line
  endings and encoding of existing files are preserved.
- A merge tab never shows the result file's own buffer, so it refuses to save
  while that file has unsaved edits in another editor. Save or revert them,
  click **Refresh** in the merge tab, then save.
- Tabs keep their state while hidden behind other tabs, so switching away
  does not lose merge choices or undo history.
- Closing a tab that has unsaved changes cannot be cancelled by an extension,
  so a notification offers **Restore Comparison** (reopens it with your edits)
  or **Open as Untitled** (puts the edited text in new untitled editors).
  Reloading the window restores open tabs, including unsaved text.

Limitations in this increment: text comparison only (folder, merge, binary,
image, table, hex, and other views open in the desktop app); no sessions,
reports, backups, or Open With; embedded view settings are stored by VS Code
and are separate from the desktop app's settings. If the helper is missing or
crashes, the tab shows the error; fix the installation or `backendPath` and
reopen the comparison (a crashed helper is restarted on the next request).

## Settings and installation discovery

| Setting | Default | Meaning |
|---|---|---|
| `comparecraft.defaultMode` | `embedded` | Where Compare Selected, Compare with..., editor-text, and Git comparisons open. `embedded` opens two-sided comparisons in a VS Code tab and asks before using the desktop app for folders. `desktop` always launches the desktop app. Commands named "in Desktop App" always use the desktop app. |
| `comparecraft.desktopPath` | empty | User/machine absolute executable path; never a directory or shell command. |
| `comparecraft.backendPath` | empty | Absolute path to `comparecraft-backend`, the windowless helper for embedded mode. Empty uses the helper installed next to the desktop executable. |

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

## Embedded backend helper

CompareCraft installs `comparecraft-backend` (`comparecraft-backend.exe` on
Windows) next to the desktop executable, for example
`%LOCALAPPDATA%\CompareCraft\comparecraft-backend.exe`,
`CompareCraft.app/Contents/MacOS/comparecraft-backend`, or
`/usr/bin/comparecraft-backend`. The extension starts it only when needed, talks
to it over stdin/stdout (no network port), and stops it when VS Code closes or
the executable settings change. It only reads files; it never writes them.

Run **CompareCraft: Check Embedded Backend** from the Command Palette to confirm
the helper starts and compares text. Its version and protocol appear in a
notification and in the **CompareCraft** Output channel. If your installed
CompareCraft predates the helper, the command says so; update CompareCraft. An
older or newer helper with an incompatible protocol, or one that crashes, is
reported explicitly rather than replaced by another installation. Set
`COMPARECRAFT_BACKEND_LOG=debug` before starting VS Code for per-request timing
in the Output channel. The protocol is documented in
[backend-protocol.md](../../docs/vscode-extension/backend-protocol.md).

## Next increments

See the repository's [implementation plan](../../docs/vscode-extension/plan.md)
and [portable handoff](../../docs/vscode-extension/handoff.md). Phase 5 adds
embedded three-way conflict resolution and the remaining views. Marketplace
publication is not part of this increment.
