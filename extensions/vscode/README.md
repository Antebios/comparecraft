# CompareCraft for VS Code

Compare files, local folders, selected text, and Git revisions side by side without leaving
VS Code. Edit text comparisons, explore CSV differences, and resolve three-way
merge conflicts in a CompareCraft tab that follows your VS Code theme.

Prefer a separate window? Open comparisons in the CompareCraft desktop app.
Folder panels inside VS Code are comparison-only; use the desktop app for folder operations.

### Folder comparison roadmap

The
[folder comparison roadmap](../../docs/vscode-extension/folder-comparison-roadmap.md)
documents the local, comparison-only first version, implementation tasks and
handoff instructions, followed by future full local workflows and Remote SSH,
WSL and Dev Containers phases.

**Requires the [CompareCraft desktop app](https://github.com/Antebios/comparecraft/releases),
installed separately.**

## Screenshots

### Compare and edit files without leaving VS Code

![Embedded text comparison with highlighted changes and copy controls](media/screenshots/01-text-comparison.png)

### Resolve three-way conflicts in an embedded merge tab

![Three-way merge showing current, base, incoming, and the editable result](media/screenshots/02-three-way-merge.png)

### Compare CSV data side by side

![Read-only CSV comparison with keyed rows, highlighted cells, and selected-row details](media/screenshots/03-csv-comparison.png)

### Compare local folders in a VS Code tab

![Embedded folder comparison with expanded trees, difference and orphan markers, presets and the saved-disk notice](media/screenshots/04-folder-comparison.png)

Folder results come from saved disk contents. Use **Open in Desktop App** for
folder operations.

### Choose a comparison method and scope

![Comparison preset dropdown with All included files expanded to CRC, Binary and Rules-based choices](media/screenshots/05-comparison-presets.png)

Choosing a preset changes the main button; click that button to run it.

![Comparison Presets dialog editing Release check with Binary, All included files and Pin in this folder session selected](media/screenshots/06-manage-presets.png)

Named presets are shared across extension folder panels; pins belong to the
current folder session. Extra pins appear under **More**.

### Save and reopen a named folder session

![Save Session split-button menu offering Save Session and Save Session As](media/screenshots/07-save-session.png)

Use the main button to save, or its arrow to save a copy under another name.

![VS Code Open Saved Folder Session Quick Pick listing the named Release review comparison](media/screenshots/08-open-saved-folder-session.png)

Run **CompareCraft: Open Saved Folder Session...** from the Command Palette to
find your saved folder sessions.

### Locate text changes with the difference map

![Embedded text comparison scrolled to a changed line with four difference-map marks and a blue viewport highlight](media/screenshots/09-text-difference-map.png)

The map at the left shows changes throughout the file and highlights the
currently visible lines.

## Requirements

- VS Code 1.95 or newer on local Windows, macOS, or Linux desktop.
- An installed [CompareCraft desktop app](https://github.com/Antebios/comparecraft/releases)
  from the same release line as the extension.
- A trusted local workspace. Remote SSH, WSL, Dev Containers, browser-only hosts,
  and virtual workspaces are not supported.
- Git installed and available to VS Code for Git comparisons and conflict resolution.

## Get started

1. Install the CompareCraft desktop app. Standard installations are detected
  automatically. For a portable or custom installation, run **CompareCraft:
  Locate Desktop Executable...** from the Command Palette.
2. Select two files in Explorer, right-click, and choose **CompareCraft >
  Compare Selected...**.
3. Review the differences in a CompareCraft tab. Text files can be edited and
  saved directly; images, binary files, and tables open read-only.

To compare folders, use **CompareCraft: Compare Folder With...**, or select two
folders and choose **Compare Selected in VS Code**. An older helper without
folder capabilities offers an explicit desktop alternative; update CompareCraft
to enable embedded folders.

## Compare files and folders

Right-click resources in Explorer, a text editor, or an editor tab and open the
**CompareCraft** submenu. All commands are also available in the Command Palette.

| Command | Behavior |
| --- | --- |
| Compare Selected... | Compares two selected files or folders. With one selected item, asks for the other. |
| Compare Selected in VS Code | Opens a file or local folder comparison in a VS Code tab. |
| Compare Selected in Desktop App | Opens a comparison in the desktop app. |
| Select Left File or Folder | Remembers an item to compare later. |
| Compare with Selected Left... | Compares the current item with your remembered selection of the same type. |
| Clear Left Selections | Clears both remembered selections. |
| Compare File With... | Picks another file to compare with the selected or active file. |
| Compare Folder With... | Picks another folder to compare with the selected folder. |
| Compare Parent Folder With... | Compares the selected file's parent directory against a chosen folder. |
| Open Desktop App | Opens CompareCraft's home view directly. |
| Open Saved Folder Session... | Opens a named VS Code folder session from a Quick Pick. |

Compare two different files or two different folders, not a file against a
folder. Remembered selections last until cleared or VS Code restarts.

## Compare editor text

Right-click inside an editor (including untitled ones) and open **CompareCraft**:

| Command | Behavior |
| --- | --- |
| Compare with Saved | Compares your unsaved edits with the saved file. The saved side is read-only. |
| Select Text as Left | Remembers selected text, or the whole document when nothing is selected. |
| Compare Text with Left | Compares selected text or the whole document with the remembered text. |
| Compare Selection with Clipboard | Compares selected text or the whole document with your clipboard. |
| Open Active Diff in Desktop App | In a VS Code diff editor (including Git diffs), opens the same two sides in CompareCraft. Available from the diff editor's **...** menu. |

**Your unsaved edits are included and never saved automatically.** In desktop
mode, unsaved text opens as a read-only copy labeled *(unsaved buffer)*; edits
to that copy cannot be saved back to VS Code. Save or revert unsaved files
before comparing their folders in the desktop app.

## Folder comparisons inside VS Code

- Inspect the shared folder tree and gutter, select files, configure inclusion
  and display filters, use CRC/Binary/Rules-based comparison presets, and refresh.
- Folder comparisons read **saved files on disk**. Unsaved editor buffers are
  shown in child text comparisons but never treated as saved-disk gutter results.
  No files are automatically saved.
- Open file rows in editable text comparisons or read-only binary/table/picture
  views. Saved changes and reloads re-evaluate the originating pair from disk;
  refreshing/changing the parent invalidates old child results.
- Save named folder sessions from the folder panel; reopen them with
  **CompareCraft: Open Saved Folder Session...**. Presets and sessions are stored
  separately from the desktop app. Window reload restores paths and options and
  recomputes the tree, rather than restoring stale comparison results.
- Copy, move, delete, rename, touch, synchronization, folder merge, snapshots,
  reports and external Open With are not available in folder panels. Use
  **Open Folder Comparison in Desktop App** explicitly for full folder workflows.

The helper must advertise protocol-v1 `folder.compare`, `folder.compareItems`
and `file.quickCompare`. Protocol 1 alone does not imply folder support.
Remote SSH, WSL and Dev Containers remain unsupported.

## Git comparisons and conflicts

Git commands are in the **CompareCraft > Git** submenu for files (Explorer and
editor) and in the **CompareCraft** submenu of the Source Control view's context
menu for changed files:

| Command | Behavior |
| --- | --- |
| Compare with HEAD | Last commit vs working file (or its unsaved buffer). |
| Compare Index with Working Tree | Staged version vs working file. |
| Compare HEAD with Index | Last commit vs staged version. |
| Compare with Revision... | Pick a recent commit and compare it with the working file. |
| Resolve Conflict in VS Code | Opens Current, Base, Incoming, and an editable Result in a three-way merge tab. |
| Resolve Conflict in Desktop App | The same three-way merge in the desktop app. |
| Stage Resolved Conflict... | Stages the resolved file after confirmation. |
| Configure as Git Merge/Diff Tool... | Opt-in setup so `git mergetool` / `git difftool` in a terminal use CompareCraft. |
| Remove Git Tool Configuration... | Restores the Git settings changed by the command above. |

Only the **Result** is saved in a merge tab; Current, Base, and Incoming are
read-only. Save or revert unsaved edits in the file's normal editor before
resolving its conflict.

Conflict labels describe the actual operation instead of "ours/theirs". During a
**merge**, Current is your branch and Incoming is the branch being merged. During
a **rebase**, Current is the new base plus commits already replayed, and Incoming
is the commit being replayed. Cherry-pick, revert, and stash-apply conflicts are
also supported.

Safety rules:

- The extension **never** commits, continues, skips, or aborts a merge, rebase,
  or cherry-pick. After staging, continue from Source Control or the terminal.
- Staging always asks for confirmation, warns about leftover conflict markers,
  and is refused if the Git conflict state changed while you were resolving it.
- Binary, symbolic link, submodule, and modify/delete (or rename) conflicts are
  refused with an explanation. Resolve those with Git directly (`git add`/`git rm`).

Git settings change only when you run **Configure as Git Merge/Diff Tool...**
and confirm. To undo that setup, run **Remove Git Tool Configuration...** before
uninstalling the extension.

## Editing and saving

- Text comparisons include your current VS Code edits. Save in the CompareCraft
  tab to save the corresponding file through VS Code. Saved versions, Git
  revisions, and clipboard text are read-only.
- If a file changes elsewhere, saving is refused to prevent overwriting newer
  work. Reload the side first. For merge tabs, save or revert edits in the normal
  editor, then click **Refresh** before saving the result.
- Switching tabs keeps your comparison and merge work intact.
- Closing an unsaved tab offers **Restore Comparison** or **Open as Untitled**
  so you can recover your edits. Reloading the window also restores open tabs.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `comparecraft.defaultMode` | `embedded` | Open comparisons in a VS Code tab (`embedded`) or the desktop app (`desktop`). Commands named "in Desktop App" always use the desktop app. |
| `comparecraft.desktopPath` | empty | Path to the desktop executable for a custom installation. Usually set with **Locate Desktop Executable...**. |
| `comparecraft.backendPath` | empty | Advanced: override the path to the helper used for VS Code tabs. Normally detected automatically. |

Executable paths must be set in your **User** settings, not workspace settings.
Comparison preferences inside VS Code are separate from the desktop app's settings.

## Troubleshooting

Open **View > Output** and pick **CompareCraft** for launch commands, helper
start-up, and errors.

| Symptom | What to do |
| --- | --- |
| "CompareCraft is not installed" | Install the desktop app, or run **Locate Desktop Executable...** for portable/AppImage/custom installs. |
| A comparison tab fails to open | Run **CompareCraft: Check Embedded Backend** from the Command Palette. Update the desktop app to match your extension version, then reopen the comparison. |
| A view offers to open in the desktop app | Your installed app does not support that view inside VS Code yet. Update CompareCraft. |
| Commands are missing or disabled | Trust the workspace; remote and virtual workspaces are not supported. |
| Save in a CompareCraft tab is refused | The file changed in an editor or on disk after the tab loaded it, or (merge tabs) the result file has unsaved edits elsewhere. Save or revert, click **Refresh**, then save. |
| Resolve Conflict is refused | Binary, symbolic link, submodule, and modify/delete conflicts must be resolved with Git directly. |
| Git's terminal tools do not use CompareCraft | Run **Configure as Git Merge/Diff Tool...** for the repository, and rerun it if you move the desktop app. |

## Known limitations

- Local desktop workspaces only; remote and virtual workspaces are not supported.
- Folder sync and folder merge require the desktop app; embedded folders are comparison-only.
- Binary (Hex), CSV/TSV (Table), Picture, and Patch views are read-only inside
  VS Code. Table and Picture views support files up to 64 MB.
- Unsaved files, Git revisions, and clipboard content are always compared as text.
- Named folder sessions are supported; reports, backups and external Open With
  remain desktop features.

## Feature locations

### Text Compare difference map

Open a Text Compare in a VS Code tab. The narrow **difference map** is at the far left of the text panes. It marks where differences occur; click a mark to jump to it, or click elsewhere in the strip to move both panes to that location. A viewport highlight tracks the visible area. See the [Text Compare manual](../../docs/manual/text-compare.md#the-window).

### Save and reopen sessions

In an embedded Text Compare tab, use **★ Save Session** on the toolbar. The first save asks for a name; later saves update that session. Use the adjacent **▾** arrow or **Session > Save Session As…** to save a copy under another name. If that name belongs to a different saved session, CompareCraft asks before replacing it. Use the toolbar's **Sessions** menu to reopen a saved Text Compare. Session data is stored in this VS Code installation's extension global state and is available across workspaces. See the [Sessions manual](../../docs/manual/sessions.md#save-a-session).

### Folder sorting and comparison progress

From VS Code, choose **CompareCraft > Compare Selected…** for two folders to open a comparison tab in embedded mode. Explicit desktop commands open the desktop app instead. Embedded folder comparisons show an indeterminate progress indicator; the desktop app also reports scanning and completed/total file counts while comparing.

To put dot-prefixed folders and files first for one comparison, choose **Session > Session Settings… > Handling > Sorting** and select **First**; **Use global default** follows the global option. In the desktop app, set **Tools > Options > Colors, Fonts > Folder views > Dot-prefixed names first** for the global default. VS Code comparison preferences are stored separately from desktop settings. See [Folder Compare: Name sorting](../../docs/manual/folder-compare.md#name-sorting).

## Saved sessions

The extension stores named and recent sessions in VS Code global state, with separate libraries for folder and file comparisons.
Recent entries are refreshed for matching paths and limited to 50 per library.
Automatic recent-session updates do not overwrite named sessions. Names are
matched case-insensitively, and locked sessions must be unlocked or saved under
a different name before changing their saved paths or settings.

## Support

Report problems or request features in the
[CompareCraft issue tracker](https://github.com/Antebios/comparecraft/issues).
Include your operating system, VS Code version, CompareCraft version, and the
relevant error from the **CompareCraft** Output channel. Review logs for private
file paths or content before sharing them.
