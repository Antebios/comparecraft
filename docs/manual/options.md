# Options

Choose **Tools > Options…** to change how CompareCraft looks and behaves. (On macOS you can also press `⌘,`.)

The Options dialog lists its pages on the left. To find a setting quickly, type a word in the **Search options** box at the top; only the pages that match are listed.

Click **OK** to save your changes and close the dialog, **Apply** to save them and keep the dialog open, or **Cancel** to close the dialog without saving.

The **Tools** menu also contains the related commands [File Formats](#file-formats), [Profiles](#profiles), [Export Settings and Import Settings](#export-and-import-settings), [Restore Factory Defaults](#restore-factory-defaults) and [Save Snapshot](#save-snapshot), described at the end of this page.

## Startup

### Workspace

The workspace is the set of comparison tabs you have open.

| Setting | Default | Description |
| --- | --- | --- |
| **When starting, load workspace:** | (none) | Choose **Last used tabs** to reopen the tabs that were open when CompareCraft was last closed, or the name of a saved workspace to open it. |
| **On exit, save workspace as:** | (none) | Choose **Last used tabs** to remember the open tabs when CompareCraft closes, or the name of a saved workspace to update it. |

To restore your tabs at every start, set both to **Last used tabs**. Named workspaces are saved with **Session > Save Workspace As…**; see [Workspaces](sessions.md#workspaces).

### Quick compare (Home view)

These settings change what happens when you compare two files with **Quick compare** on the Home view.

- **Show quick compare results for two files before opening a view** (off by default): instead of opening a comparison right away, CompareCraft first shows whether the files are the same. Choose how:
    - **Binary comparison**: the files are compared byte by byte.
    - **Rules-based comparison** (default): the files are compared using the comparison rules, so files with only unimportant differences can be reported as similar.
- **Open view automatically if files are different** (on by default): if the files differ, the comparison opens without an extra click.

The binary and rules choices and **Open view automatically if files are different** are available only when the first setting is on.

### File manager integration

On Linux, CompareCraft can add commands to the file manager. The page says "Adds CompareCraft commands to the Nautilus (Files) scripts menu and the Dolphin context menu." Check the commands you want:

- **Compare (two selected items)**
- **Sync folders**
- **Merge (three selected files)**
- **Edit text file**

In Nautilus (Files), the commands appear in the **Scripts** menu, in a **CompareCraft** submenu. In Dolphin, they appear in the context menu, in a **CompareCraft** submenu.

On other systems the page says "Not available on this platform. Use “Open With → CompareCraft” from your file manager."

## Tabs

| Setting | Default | Description |
| --- | --- | --- |
| **Open new tab next to active tab** | Off | New tabs open right after the current tab instead of at the end. |
| **Closing last tab closes the window** | Off | Closing the last comparison tab also closes CompareCraft. |
| **Warn when closing a tab with unsaved changes** | On | Asks for confirmation before a tab with unsaved changes is closed. |
| **Hide tab bar when no comparison tabs are open** | Off | Hides the tab bar while only the Home view is open. |

## Colors, Fonts

### Theme

**Theme:** **Follow system** (default), **Light** or **Dark**.

### Colors

Click a color to change it. Once a color has been changed, a **Default** link appears next to it to restore the original color.

- **Different / newer text**
- **Older text**
- **Orphan text**
- **Orphan background**
- **Same text**
- **Unimportant difference text**
- **Difference background**
- **Unimportant background**
- **Selection background**

### Folder views

- **Alternate row background (stripes)** (off by default): shows every other row with a slightly different background.
- **Color folders to reflect content** (on by default): colors each folder by the state of the items inside it, so you can see which folders contain differences.

### Fonts

| Setting | Range | Default |
| --- | --- | --- |
| **Interface font size:** | 9 to 24 px | 13 px |
| **Editor font:** | Any installed font name; empty means the default monospace font | (default monospace) |
| **Editor font size:** | 8 to 28 px | 12 px |

The editor font is used for the text of files in the comparison views.

## Text Editing

| Setting | Range | Default | Description |
| --- | --- | --- | --- |
| **Context lines (Show Context):** | 0 to 50 | 3 | The number of unchanged lines shown above and below each difference when a text comparison shows context. |
| **Tab size:** | 1 to 16 | 4 | The width of a tab character, in spaces. |

## Next Difference

These settings change how **Next Difference** and **Previous Difference** behave.

- **Go to first difference when loading** (off by default): in Text Compare, the first difference is selected as soon as the files are loaded.

When there are no more differences:

- **Wrap around** (off by default): continues from the other end of the file or folder list.
- **Show a message** (on by default): shows a message such as "No more differences below." or "Wrapped around to the first difference." in the status bar.

## Backups

CompareCraft can keep a copy of a file before overwriting it.

### Back up files

- **Before replacing files with copy or move** (off by default): applies to copy, move and sync operations in Folder Compare and Folder Sync.
- **Before saving in file views** (off by default): applies when you save a file in Text Compare or Text Edit. In Text Compare, this is the starting value of **File > Create Backup on Save**.

### Backup name

Choose how backup copies are named. For a file called `name.ext`, the choices are:

- `name~.ext` (same folder)
- `name.ext~` (same folder)
- `name.ext.bak` (same folder), the default
- `~name.ext` (same folder)
- `name.bak` (same folder)
- `name.bak.ext` (same folder)
- **In this folder:** puts backups in a folder you choose. Type the path or click **Browse…**.

## File Operations

### Confirmations

Each of these asks for confirmation before the operation is carried out. All are on by default.

- **Confirm copy**
- **Confirm move**
- **Confirm delete**
- **Confirm overwriting newer files**: asks before a copy replaces a file that is newer than the one being copied.

### Delete

**Use recycle bin (trash) by default** (on by default): deleted files go to the recycle bin (trash) so they can be restored. Turn it off to delete files permanently.

## Archive Types

This page lists the archive types CompareCraft knows: Zip (`*.zip;*.jar;*.war`), Tar (`*.tar`), Gzip (`*.gz;*.tgz`) and 7-Zip (`*.7z`). Archives are compared as files. Browsing archive contents as folders is not supported yet.

## Toolbars, Shortcuts

### Toolbar

**Show toolbar in views** (on by default) shows or hides the toolbar of the comparison views. You can also use **View > Toolbar**.

### Shortcuts

The table lists commands with their **Menu**, **Command** name and **Shortcut**. Only the commands of the kinds of views that are currently open are listed, so open a view of the kind you want to change first. Type in the **Search commands** box to find a command.

To change a shortcut:

1. Select the command in the table.
2. Click the **Shortcut:** box. It shows "Press keys…".
3. Press the key combination you want. Press `Esc` to cancel.

If the new shortcut is already used, a message such as "Also assigned to Edit › Copy" warns you.

- **Remove** removes the shortcut from the command.
- **Default** restores the command's original shortcut.

The [Keyboard Shortcuts](shortcuts.md) page lists the default shortcuts.

## Open With

Here you add your own applications to the **Open With** menu of Folder Compare (and the **File > Open With** menu of Text Compare), for example another editor.

- **New…** adds an application. Enter a **Name:** and a **Command:**, then click **Save**.
- **Edit…** changes the selected application.
- **Clone…** creates a copy of the selected application, named "(copy)".
- **Delete** removes the selected application.

In the command, use these placeholders:

| Placeholder | Replaced with |
| --- | --- |
| `%1` | The left file |
| `%2` | The right file |
| `%F` | All selected files |

For example: `code --diff %1 %2`.

## Tweaks

### Interface

- **Show hints (tooltips)** (on by default): shows tooltips when you hover over buttons.
- **ESC closes file views** (off by default): pressing `Esc` closes the current tab, unless it is a Folder Compare or Folder Sync tab.

### Metrics

| Setting | Range | Default | Description |
| --- | --- | --- | --- |
| **Log panel maximum messages:** | 50 to 100000 | 1000 | The number of messages kept in the log of a folder view. |
| **Most recently used list size:** | 1 to 100 | 20 | The number of recent filters remembered in the Filters box. |

### Name filter presets

The presets offered in the **Filters:** box and in **Load preset…** of the Session Settings. See [Filters](filters.md#name-filter-presets).

- To add a preset, type a name in the **Name** box and a mask in the second box (for example `*.c;*.h;-tmp\`), then click **Add**.
- To change a preset, select it, change the name or mask and click **Update**.
- **Delete** removes the selected preset.
- **Defaults** restores the presets that come with CompareCraft.

## File Formats

**Tools > File Formats…** shows how CompareCraft decides which view opens a file. The formats are checked in this order:

| Format | Masks | View |
| --- | --- | --- |
| Picture | `*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp;*.ico;*.svg;*.avif;*.tif;*.tiff;*.tga;*.pnm;*.pbm;*.pgm;*.ppm;*.qoi` | Picture Compare |
| Table | `*.csv;*.tsv;*.tab` | Table Compare |
| Binary | (content contains NUL or control bytes) | Hex Compare |
| Text | everything else | Text Compare |

The text comparison rules (whitespace, case and so on) are not set here, but in each view with **Session > Session Settings** or the **Rules** button.

## Profiles

A profile stores every program option, color and shortcut under a name. Switching profiles replaces the current options.

Choose **Tools > Profiles…**:

- To create a profile from your current options, type a name in the **New profile name** box and click **Save Current As**.
- To switch to a profile, select it and click **Use Profile**.
- To delete a profile, select it and click **Delete**.

## Export and Import Settings

Use these commands to back up your settings or move them to another computer.

### Export Settings

1. Choose **Tools > Export Settings…**.
2. Choose what to export: **Program options**, **Colors and theme**, **Keyboard shortcuts**, **Name filter presets**, **Open With applications** and **Saved sessions**. With **Saved sessions** checked, you can choose which sessions to include.
3. Click **Export…** and choose where to save the file. The suggested name is `comparecraft-settings.json`.

### Import Settings

1. Choose **Tools > Import Settings…**.
2. Click **Browse…** and select a settings file that was exported from CompareCraft.
3. Choose which groups of settings to import. If the file contains saved sessions, check **Saved sessions** to import them as well. Check **Delete all existing sessions** to replace your current sessions instead of adding to them.
4. Click **Import**.

## Restore Factory Defaults

**Tools > Restore Factory Defaults…** resets all options, colors, shortcuts and name filter presets to the way they were when CompareCraft was installed. CompareCraft asks for confirmation first. Saved sessions are kept.

## Save Snapshot

A snapshot is a file that records the contents of a folder: the names, sizes and modification times of its files. You can later compare a folder with the snapshot, for example to see what has changed since a backup, even if the original folder is no longer available.

1. Choose **Tools > Save Snapshot…**.
2. Under **Folder**, choose the folder to record: **Left base folder** or **Right base folder** (when a Folder Compare or Folder Sync tab is open), or **Other:** with a folder path (type it or click **Browse…**).
3. Under **Snapshot file**, click **Browse…** to choose the file name, or leave it empty to choose it when saving. The suggested name is `snapshot.ccsnap`.
4. Under **Include**, choose what to record:
    - **CRCs (allows content comparison against the snapshot)**: also records a checksum of each file, so file contents can be compared against the snapshot. This takes longer.
    - **Empty folders** (on by default).
    - **Items excluded by file filters**: also records items that the folder comparison's filters hide.
5. Click **Save**.

To compare with a snapshot, open a Folder Compare and enter the path of the `.ccsnap` file as one of the two folders.
