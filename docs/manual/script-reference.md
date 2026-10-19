# Script Command Reference

This page lists every command you can use in a CompareCraft script. For script syntax, parameters, variables, logging, error handling and complete examples, see [Scripting](scripting.md). The report commands are described in more depth in [Reports](reports.md).

Commands and keywords are not case-sensitive. In the syntax lines:

- `[ ]` marks optional parts.
- `|` separates alternatives.
- `< >` marks a value you supply.

Arguments with spaces must be quoted.

## Command overview

| Command | Purpose |
|---|---|
| `log` | Write a log file |
| `option` | Set error handling and confirmation behaviour |
| `criteria` | Choose how files in folder comparisons are compared |
| `filter` | Choose which files and folders are included |
| `load` | Load two folders, two files or a saved session |
| `expand`, `collapse` | Expand or collapse folders |
| `select` | Select items in the folder comparison |
| `compare` | Re-compare the selected files by content |
| `copy`, `move` | Copy or move selected items to the other side |
| `copyto`, `moveto` | Copy or move selected items to another folder |
| `delete` | Delete selected items |
| `rename` | Rename selected items |
| `touch` | Change the modification time of selected files |
| `sync` | Synchronize the loaded folders |
| `snapshot` | Save a snapshot of a loaded folder |
| `folder-report` | Report on the loaded folder comparison |
| `file-report` | Report on file comparisons |
| `text-report`, `hex-report`, `data-report`, `table-report`, `picture-report` | Report on file comparisons with a specific viewer |
| `beep` | Sound the terminal bell |

## log

Starts writing a log file.

```text
log [none|normal|verbose] [[append:]<file>]
```

| Argument | Description |
|---|---|
| `none` | Nothing is written to the file except its first line. The console still shows normal messages. |
| `normal` | Default. Records the script lines, messages, warnings and errors. |
| `verbose` | Also records each file that is copied, moved, deleted, renamed or touched. These lines are shown on the console too. |
| `<file>` | Log file. The default is `Log.txt` in the current directory. Folders are created as needed. |
| `append:<file>` | Adds to the file instead of replacing it. |

- The log begins with a line naming the CompareCraft version.
- Each line starts with the date and time.
- Lines from before the `log` command are included.
- If the file cannot be opened, the script stops with exit code 100.

```text
log verbose append:"logs/nightly %date%.log"
```

## option

Sets how the script handles errors and confirmations.

```text
option stop-on-error | confirm:prompt | confirm:yes-to-all | confirm:no-to-all
```

| Value | Description |
|---|---|
| `stop-on-error` | Stop at the first script error and exit with code 100. Without it, script errors are reported and the script continues. |
| `confirm:prompt` | Default. Operations that overwrite or delete go ahead (scripts never wait for input). |
| `confirm:yes-to-all` | Operations that overwrite or delete go ahead. |
| `confirm:no-to-all` | Copies and moves onto existing items are skipped, and nothing is deleted. |

Several values can be given in one command. Any other value is an error (exit code 106).

```text
option stop-on-error confirm:no-to-all
```

## criteria

Sets how files are compared in folder comparisons. If folders are already loaded, they are compared again.

```text
criteria [timestamp[:<N>sec][;IgnoreDST]] [size] [crc|binary|rules-based] [timezone:ignore] [follow-symlinks]
```

| Value | Description |
|---|---|
| `timestamp` | Compare the modification time and size. Files with different times are shown as newer or older. |
| `timestamp:<N>sec` | Treat times up to N seconds apart as equal, for example `timestamp:2sec`. |
| `timestamp;IgnoreDST` | Treat times exactly one hour apart as equal (daylight saving time shifts). Combine with a tolerance as `timestamp:2sec;IgnoreDST`. |
| `size` | Compare the size only. |
| `crc` | Compare the CRC checksums of the file contents. |
| `binary` | Compare the file contents byte by byte. |
| `rules-based` | Compare the contents as text, so that differences in line endings or encoding do not count. Files that differ only in case, whitespace or blank lines count as similar. |
| `timezone:ignore` | Treat times that are a whole number of hours apart (up to 24) as equal. |
| `follow-symlinks` | Follow symbolic links to folders and files instead of comparing the links. |

- Each `criteria` command replaces the previous settings.
- If `timestamp` is given, files are compared by time and size, and `crc`, `binary` and `rules-based` are ignored.
- With no comparison method given, the default applies: time and size with a 2-second tolerance.
- An unknown value prints a warning and is ignored.

```text
criteria timestamp:2sec;IgnoreDST
criteria rules-based
```

## filter

Sets which files and folders are part of folder comparisons. If folders are already loaded, they are compared again. See [Filters](filters.md) for how name filters work in the application.

```text
filter [<mask> ...] [cutoff:[<|>]<days|date>|none] [size:[>|<]<size>|none] [exclude-protected]
```

### Name masks

- Masks can be given as separate arguments or joined with `;` in one argument.
- A mask that starts with `-` excludes matching items.
- A mask that ends with `/` applies to folders.
- A mask that contains `/` in the middle is matched against the path relative to the base folder.
- The masks given in a `filter` command replace all previous name masks.

```text
filter "*.c;*.h;-build/"
filter *.html *.css -*.min.css
```

### Date filter

| Value | Description |
|---|---|
| `cutoff:<N>days` or `cutoff:<N>` | Exclude files older than N days, for example `cutoff:30days`. |
| `cutoff:<date>` | Exclude files older than the date, for example `cutoff:2026-01-01`. |
| `cutoff:>` followed by days or a date | Exclude files newer than that, for example `cutoff:>7days`. |
| `cutoff:none` | Remove the date filter. |

A `<` after `cutoff:` (for example `cutoff:<30days`) means the same as no prefix: older files are excluded.

Dates can be written as `12/31/2026`, `12/31/2026 12:00:00 PM`, `12/31/2026 12:00pm`, `2026-12-31`, `2026-12-31 13:00:00`, `2026/12/31`, `Dec 31, 2026` or `31 Dec 2026`. Quote dates that contain spaces.

### Size filter

| Value | Description |
|---|---|
| `size:<size>` | Exclude files larger than the size, for example `size:10MB`. `size:>10MB` means the same. |
| `size:<` followed by a size | Exclude files smaller than the size, for example `size:<1KB`. |
| `size:none` | Remove the size filter. |

Sizes are in bytes, or use the units `B`, `KB`, `MB`, `GB` or `TB` (1 KB = 1024 bytes). Decimals are allowed, for example `size:1.5MB`.

### Other values

| Value | Description |
|---|---|
| `exclude-protected` | Exclude protected operating system files (hidden system files on Windows). |

An invalid date or size is an error (exit code 106).

```text
# Only text files changed in the last 30 days and not larger than 10 MB
filter *.txt cutoff:30days size:10MB
```

## load

Loads a comparison. This clears the expanded folders and the selection.

```text
load [create:left|right|all] <left> <right>
load <session name>
load <default>
```

| Form | Description |
|---|---|
| `load <left> <right>` | Loads two folders as a folder comparison, or two files as a file comparison. |
| `load create:<side> <left> <right>` | Creates a missing folder on the `left`, `right` or `all` sides before loading. |
| `load <session name>` | Loads the two paths of a saved session, together with its folder comparison settings (criteria and filters). See [Sessions](sessions.md). |
| `load <default>` | Unloads the comparison and resets criteria and filters to their defaults. Type `<default>` literally. |

If a folder does not exist, the script stops with exit code 107 (`Unable to load base folder` for the left side, `Unable to load comparison folder` for the right side). An unknown session name also gives exit code 107.

```text
load "C:\Projects\Site" "\\server\www\Site"
load create:right /home/me/work /media/usb/work
load "Website backup"
```

## expand and collapse

Expand or collapse folders in the loaded folder comparison. Commands such as `select`, `folder-report` and `sync visible` only see items in expanded folders.

```text
expand all | <folder> [<folder> ...]
collapse all | <folder> [<folder> ...]
```

- `all` expands or collapses every folder.
- A folder path is relative to the base folders, for example `src/lib`. Expanding a folder also expands its parent folders.
- Collapsing a folder also collapses its subfolders.

```text
expand all
collapse node_modules .git
```

## select

Selects items in the loaded folder comparison. Each `select` command replaces the previous selection. Only visible items can be selected, so expand folders first.

```text
select <mask> [<mask> ...]
```

A mask has up to three parts, separated by dots, in this order: side, result and type. Any part can be left out:

```text
[side.][result.][type]
```

| Part | Values |
|---|---|
| Side | `left` (or `lt`), `right` (or `rt`), `all` |
| Result | `exact`, `diff`, `newer`, `older`, `orphan`, `all` |
| Type | `files`, `folders`, `all` |

What each result value selects:

| Result | Selects |
|---|---|
| `exact` | Files that are the same (or similar under rules-based comparison). |
| `diff` | Files that differ. With time-based criteria, this means files that differ but are not newer or older on either side. |
| `newer` | Files that are newer on that side (time-based criteria only). |
| `older` | Files that are older on that side (time-based criteria only). |
| `orphan` | Items that exist only on that side. |
| `all` | Everything. |

- A folder matches a result when every file inside it on that side matches. For `orphan`, the folder itself must exist on one side only.
- The special mask `empty.folders` selects folders that contain no files.
- An invalid mask is an error (exit code 106).

Selection works per side. For example, `left.orphan.files` selects only items on the left side. Commands that act on one side use the selection of that side.

```text
select left.newer.files left.orphan.files
select diff.files
select right.orphan
select empty.folders
select all
```

## compare

Compares the selected files again, by content, and updates their status. Only files that exist on both sides are compared. Selected folders include all files inside them.

```text
compare [crc|binary|rules-based]
```

Without an argument, the current criteria are used. A typical use is to compare quickly by time and size first, and then check only the differing files by content:

```text
criteria timestamp
load "%1" "%2"
expand all
select diff.files newer.files older.files
compare binary
select exact.files
```

The `select exact.files` in the last line now finds files whose timestamps differ but whose contents are identical.

## copy and move

Copy or move the selected items to the other side of the comparison.

```text
copy left->right | right->left
move left->right | right->left
```

- `lt` and `rt` can be used for `left` and `right`, for example `copy lt->rt`.
- The items selected on the source side are copied to the same relative location on the other side. Folders are copied with their contents.
- Existing items on the target side are overwritten, unless `option confirm:no-to-all` is set.

```text
select left.newer.files left.orphan
copy left->right
```

When done, the result is logged, for example `Successfully copied 4 items.  Completed in 0 seconds.`

## copyto and moveto

Copy or move the selected items to another folder.

```text
copyto [left|right|all] [path:relative|base|none] <destination folder>
moveto [left|right|all] [path:relative|base|none] <destination folder>
```

| Argument | Description |
|---|---|
| `left`, `right`, `all` | The side(s) whose selected items are copied. Default: `all`. |
| `path:relative` | Default. Keeps the folder structure below the common parent folder of the selected items. |
| `path:base` | Keeps the full folder structure relative to the base folder. |
| `path:none` | Puts all items directly into the destination folder. |

The destination folder is created if needed.

```text
# Export the left-side files that differ, keeping their folder structure
select left.diff.files left.newer.files left.orphan.files
copyto left path:base "export/%date%"
```

With `path:base`, a selected file `docs/old.txt` is copied to `export/2026-10-19/docs/old.txt`.

## delete

Deletes the selected items.

```text
delete [recyclebin=yes] left|right|all
```

| Argument | Description |
|---|---|
| `left`, `right`, `all` | The side(s) whose selected items are deleted. |
| `recyclebin=yes` | Moves the items to the trash (recycle bin) instead of deleting them permanently. |

With `option confirm:no-to-all`, nothing is deleted.

```text
select right.orphan
delete recyclebin=yes right
```

## rename

Renames the selected items on each side where they are selected.

```text
rename <mask>
rename regexpr <pattern> <replacement>
```

With a mask:

- `*` copies characters from the original name, up to the last occurrence of the next character in the mask.
- `?` copies one character.
- `.` moves on to the extension of the original name.
- Any other character is used as is.

| Mask | Original | New name |
|---|---|---|
| `*.bak` | `notes.md` | `notes.bak` |
| `*.bak` | `archive.tar.gz` | `archive.tar.bak` |
| `???_old.*` | `report.txt` | `rep_old.txt` |

With `regexpr`, `<pattern>` is a regular expression that must match the whole name. In `<replacement>`, `$1` or `\1` inserts the first captured group, and so on.

```text
select left.files
rename regexpr "(.*)\.jpeg" "$1.jpg"
```

- Items whose name would not change are skipped and counted as skipped in the summary.
- If an item with the new name already exists, that item is reported as an error and not renamed.

## touch

Changes the modification time of the selected files.

```text
touch left|right|all:now
touch left|right|all:<date and time>
touch left->right | right->left
```

| Form | Description |
|---|---|
| `touch <side>:now` | Sets the time of the selected files on that side to the current time. |
| `touch <side>:<date and time>` | Sets the time to the given date and time (see the date formats under [filter](#filter)). Quote values that contain spaces. |
| `touch left->right` | Copies the modification time of each selected item on the left to the matching item on the right. Items that exist on one side only are skipped. `right->left` works the other way. |

When a folder is selected with the `<side>:` forms, all files inside it are touched.

```text
select all.files
touch "all:2026-10-01 09:00:00"
select left.exact.files
touch left->right
```

## sync

Synchronizes the loaded folders.

```text
sync update:left->right|right->left|all [visible] [create-empty]
sync mirror:left->right|right->left [visible] [create-empty]
```

| Argument | Description |
|---|---|
| `update:left->right` | Copies left orphans and left-newer files to the right. Nothing is deleted. |
| `update:right->left` | The same, from right to left. |
| `update:all` | Updates in both directions: orphans and newer files are copied to the other side. |
| `mirror:left->right` | Makes the right side the same as the left: copies orphans and all differing files to the right, and deletes items that exist only on the right. |
| `mirror:right->left` | The same, from right to left. |
| `visible` | Only synchronizes items in expanded folders. |
| `create-empty` | Also copies empty folders. By default, folders without files are not copied. |

- The criteria in effect decide which files are newer or different. Filters limit which items are synchronized.
- `sync` does not need a selection.
- See [Folder Sync](folder-sync.md) for the same operations in the application.

```text
criteria timestamp:2sec
load "%1" "%2"
sync update:all
```

## snapshot

Saves a snapshot of one side of the loaded folder comparison. A snapshot file (`.ccsnap`) records the names, sizes and modification times of the files and folders. You can compare it with a folder later from the command line or in the application.

```text
snapshot [save|save-version] left|right [save-crc] [no-filters] [include-empty|create-empty] [output:<file>]
```

| Argument | Description |
|---|---|
| `save`, `save-version` | Optional; both save the snapshot. |
| `left`, `right` | The side to save. Required. |
| `save-crc` | Also stores a CRC checksum of each file, so contents can be compared later. |
| `no-filters` | Includes all items, ignoring the current filters. |
| `include-empty`, `create-empty` | Includes folders that contain no files. |
| `output:<file>` | The snapshot file. Default: `<folder name>_<YYYY-MM-DD>.ccsnap` in the current directory. If the name has no extension, `.ccsnap` is added. |

```text
load "%1" "%1"
snapshot save left save-crc output:"snapshots/site-%date%"
```

## folder-report

Writes a report of the loaded folder comparison.

```text
folder-report [layout:<layout>] [options:<option>,...] [title:<title>] output-to:<file|printer|clipboard> [output-options:<option>,...]
```

- Layouts are `side-by-side` (default), `summary` and `xml`.
- The report covers the loaded comparison and lists the contents of expanded folders only. Run `expand all` first for a complete report.
- `folder-report` does not take paths. Use `load` first.

```text
load "%1" "%2"
expand all
folder-report layout:side-by-side options:display-mismatches,column-size,column-timestamp &
    output-to:folders.html output-options:html-color
```

See [Reports](reports.md) for all options and sample output.

## file-report

Writes a report of one or more file comparisons. The viewer type (text, table, hex or picture) is chosen from each file's type, as when opening files in the application.

```text
file-report [layout:<layout>] [options:<option>,...] [title:<title>] output-to:<file|printer|clipboard> [output-options:<option>,...] [<left file> <right file> | <session name>]
```

| Form | What is reported |
|---|---|
| With two file paths | That pair of files. |
| With a session name | The session is loaded first, as with `load`. |
| Without paths, after loading two files | The loaded file pair. |
| Without paths, after loading two folders | Every selected file, one after the other in one report. Selected folders include all files inside them. |

```text
file-report layout:interleaved options:display-mismatches output-to:changes.txt old/app.c new/app.c
```

See [Reports](reports.md) for layouts and options.

## text-report, hex-report, data-report, table-report and picture-report

These work like `file-report`, but always use a specific viewer, whatever the file type:

| Command | Viewer |
|---|---|
| `text-report` | Text Compare |
| `hex-report` | Hex Compare |
| `data-report`, `table-report` | Table Compare |
| `picture-report` | Picture Compare |

```text
text-report layout:patch options:patch-unified output-to:changes.patch old/app.c new/app.c
hex-report layout:side-by-side options:display-mismatches,line-numbers output-to:firmware.txt v1.bin v2.bin
table-report layout:summary output-to:prices.txt prices-old.csv prices-new.csv
picture-report output-to:logo.html output-options:html-color logo-old.png logo-new.png
```

The syntax is the same as for `file-report`. `hex-report` does not accept the `display-context` option. See [Reports](reports.md).

## beep

Sounds the terminal bell, for example to signal the end of a long script.

```text
beep
```

## Unsupported commands

The following commands are recognised but do nothing except report a script error:

| Command | Message |
|---|---|
| `attrib` | `attrib is not supported on this platform` |
| `media-report` | `media-report is not supported` |
| `registry-report` | `registry-report is not supported` |
| `version-report` | `version-report is not supported` |

Any other command name stops the script with `Unknown command` and exit code 106.
