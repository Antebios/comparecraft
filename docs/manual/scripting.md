# Scripting

Scripts let you automate CompareCraft without opening a window. A script is a plain text file with one command on each line. It can load two folders, choose which items to work on, copy, move, delete, rename or synchronize files, save snapshots and write reports. Scripts are useful for scheduled backups, nightly reports, build checks and other repeated jobs.

This page explains how scripts work. For the full list of commands, see [Script Command Reference](script-reference.md). For details of the report commands, see [Reports](reports.md).

## A first script

Save this as `compare.txt`:

```text
# Compare two folders and write a summary of the differences
load "%1" "%2"
expand all
folder-report layout:summary options:display-mismatches output-to:differences.txt
```

Run it from a terminal:

```sh
ccomp @compare.txt ~/projects/site ~/backup/site
```

CompareCraft loads the two folders given as parameters `%1` and `%2`, expands all subfolders, and writes the differences to `differences.txt` in the current directory. While the script runs, each line is printed to the console:

```text
>> # Compare two folders and write a summary of the differences
>> load "/home/me/projects/site" "/home/me/backup/site"
Load comparison: /home/me/projects/site <-> /home/me/backup/site
>> expand all
>> folder-report layout:summary options:display-mismatches output-to:differences.txt
>> 
Script completed in 0.00 seconds
```

## Running a script

Start a script with `@` followed by the script file name. Any further arguments are passed to the script as parameters:

```text
ccomp @<script file> [parameter1 ... parameter9] [-silent]
comparecraft @<script file> [parameter1 ... parameter9] [-silent]
```

- Both programs run the script in the same way, without opening a window. Use `ccomp` (see [Console Program](console.md)) when you want to see the output or check the exit code. On Windows, the graphical `comparecraft` program has no console, so it cannot show the output there.
- `-silent` suppresses the normal console output (the echoed lines and messages). Error messages are still printed to standard error, and a log file (see [Logging](#logging)) is still written.
- Relative paths in the script, including report and log files, are resolved against the current directory, not against the folder that contains the script.

### The Scripts folder

If the script file is not found relative to the current directory, CompareCraft looks for it in the `Scripts` folder of its settings folder:

| System | Scripts folder |
|---|---|
| Linux | `~/.config/comparecraft/Scripts/` |
| macOS | `~/Library/Application Support/comparecraft/Scripts/` |
| Windows | `%APPDATA%\comparecraft\Scripts\` |

If the `COMPARECRAFT_CONFIG_DIR` environment variable is set, the Scripts folder is inside that folder instead. Scripts kept there can be run from any directory by name:

```sh
ccomp @nightly.txt /data/projects /mnt/backup/projects
```

See [Settings and Data](settings-and-data.md) for more about the settings folder.

## Script file syntax

- One command per line. Commands and keywords are not case-sensitive (`Load`, `LOAD` and `load` are the same).
- Blank lines are ignored.
- A line whose first non-blank character is `#` is a comment. `#` in the middle of a line is not a comment.
- A long command can continue on the next line: end the line with `&` and the next line is joined to it.
- Arguments are separated by spaces. Put an argument that contains spaces in double quotes. Quotes can also be used in the middle of an argument, for example `output-to:"My Reports/today.txt"`. The quotes are removed. There is no escape character.
- Paths can use `/` or `\` as the separator.
- Script files can be saved as UTF-8 (with or without a byte order mark) or UTF-16 with a byte order mark.

```text
# A command split over several lines
folder-report layout:side-by-side &
    options:display-mismatches,column-size,column-timestamp &
    title:"Weekly comparison" &
    output-to:"reports/weekly report.html" output-options:html-color
```

## Variables

Variables are replaced in each line before the line is read, so they can be used anywhere, including inside quotes.

| Variable | Replaced by |
|---|---|
| `%1` … `%9` | Script parameters 1 to 9 from the command line. A missing parameter is replaced by nothing. |
| `%date%` | The current date as `YYYY-MM-DD`, for example `2026-10-19`. |
| `%time%` | The current time as `hh:mm:ss AM/PM`, for example `09:41:07 PM`. |
| `%fn_time%` | The current time in a form usable in file names, `HH-MM-SS` (24-hour clock), for example `21-41-07`. |
| `%NAME%` | The value of the environment variable `NAME`, for example `%HOME%` or `%USERPROFILE%`. |
| `%%` | A single `%` character. |

- A `%NAME%` that is not an environment variable is left unchanged.
- Variables inside parameter values are not replaced. For example, if you pass `backup-%date%` on the command line, the script receives exactly that text.
- Parameters are inserted as plain text. If a parameter may contain spaces, put it in quotes in the script: `load "%1" "%2"`.

```text
# Write a time-stamped report into the user's home folder
log normal "%HOME%/compare-logs/run-%date%_%fn_time%.log"
load "%1" "%2"
expand all
folder-report layout:summary output-to:"%HOME%/compare-logs/report-%date%_%fn_time%.txt"
```

## How a script works

A script works much like a folder comparison in the application, but it is driven by commands:

1. Set options: `criteria` decides how files are compared, `filter` decides which files are included, and `option` controls error handling and confirmations.
2. Load a comparison with `load`, either two folders, two files or a saved session.
3. Expand folders with `expand`. As in the application, only items inside expanded folders are visible, and many commands work only on visible items.
4. Select items with `select`, for example all orphans on the left or all files that differ.
5. Act on the selection with `copy`, `move`, `copyto`, `moveto`, `delete`, `rename`, `touch` or `compare`, or act on the whole comparison with `sync` and `snapshot`.
6. Write reports with `folder-report`, `file-report`, `text-report` and the other report commands.

Criteria and filters stay in effect for later `load` commands, so set them before loading. If they are changed after loading, the comparison is refreshed.

!!! warning "Expand before you select or report"
    `select` only picks visible items, and `folder-report` only lists the contents of expanded folders. Run `expand all` after `load` unless you deliberately want to work with the top level only.

## Logging

The `log` command writes a log file. Each line in the file is time-stamped:

```text
log [none|normal|verbose] [[append:]<file>]
```

- The default level is `normal` and the default file is `Log.txt` in the current directory. Folders in the path are created.
- `append:` adds to an existing log. Otherwise the file is replaced.
- Lines produced before the `log` command (for example the echo of earlier commands) are written to the log as well.
- `verbose` also records each file that is copied, moved, deleted, renamed or touched, and shows these lines on the console.
- `none` writes nothing to the file except the first line.

A verbose log of a synchronization looks like this:

```text
10/19/2026 12:56:03 AM  *** CompareCraft 0.1.0 ***
10/19/2026 12:56:03 AM  >> log verbose append:logs/sync-2026-10-19.log
10/19/2026 12:56:03 AM  >> load "work" "backup"
10/19/2026 12:56:03 AM  Load comparison: /home/me/work <-> /home/me/backup
10/19/2026 12:56:03 AM  >> sync mirror:left->right
10/19/2026 12:56:03 AM  Copied /home/me/work/docs to /home/me/backup
10/19/2026 12:56:03 AM  Deleted /home/me/backup/obsolete.txt
10/19/2026 12:56:03 AM  Copied /home/me/work/plan.txt to /home/me/backup
10/19/2026 12:56:03 AM  Successfully synchronized 3 items.  Completed in 0 seconds.
10/19/2026 12:56:03 AM  >> 
10/19/2026 12:56:03 AM  Script completed in 0.00 seconds
```

## Error handling

There are two kinds of problems:

- **Fatal errors** stop the script at once. They are printed as `Fatal Scripting Error: …`. Examples: an unknown command, invalid arguments, a folder that cannot be loaded, or a log file that cannot be opened.
- **Script errors** are printed as `Script Error: …` and the script continues. Examples: a file that cannot be copied or deleted, a report that cannot be written, or a command that needs a folder comparison when none is loaded.

To stop at the first script error, add `option stop-on-error` at the top of the script. The script then ends with exit code 100.

Warnings, for example for an unsupported criterion, are printed as `Warning: …` and never stop the script.

Error messages are printed to standard error and are also written to the log. The script always ends with `Script completed in N seconds`, even after an error.

### Confirmations

Scripts never ask questions. `option confirm:` controls what happens when a file operation would overwrite or delete something:

| Option | Effect |
|---|---|
| `option confirm:prompt` | Default. Operations go ahead. |
| `option confirm:yes-to-all` | Operations go ahead. |
| `option confirm:no-to-all` | Copies and moves onto existing files or folders are skipped (also in `sync`), and nothing is deleted (`delete` and the deleting part of `sync mirror:` do nothing). |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | The script completed. Script errors do not change the exit code unless `option stop-on-error` is set. |
| 100 | A script error occurred and `option stop-on-error` is set, or a log file could not be opened. |
| 105 | The script file could not be loaded (not found or not readable). |
| 106 | Unknown command or invalid arguments. |
| 107 | The comparison could not be loaded (a folder or session does not exist). |

## Example: nightly folder sync with a report

This script mirrors a working folder to a backup folder, keeps a daily log, and writes a report of what is still different afterwards. Save it as `nightly.txt` in the Scripts folder.

```text
# Mirror the work folder to the backup folder
# Usage: ccomp @nightly.txt <work folder> <backup folder>
log verbose append:logs/sync-%date%.log
option stop-on-error
criteria timestamp:2sec
filter "-*.tmp;-.git/"
load "%1" "%2"
sync mirror:left->right
expand all
folder-report layout:summary options:display-mismatches &
    title:"Backup check %date%" output-to:"reports/backup-%date%.txt"
```

Schedule it with cron on Linux or macOS:

```sh
# Every night at 02:30
30 2 * * * cd /home/me && /usr/bin/ccomp @nightly.txt /home/me/work /mnt/backup/work -silent
```

On Windows, create a scheduled task that runs:

```bat
ccomp.exe @nightly.txt "D:\Work" "\\nas\backup\Work" -silent
```

The report lists any differences left after the sync. If everything worked, all groups are empty:

```text
Backup check 2026-10-19
Produced: 10/19/2026 12:56:03 AM

Mode:  Differences
Filters:  -*.tmp;-.git/
Left base folder: /home/me/work
Right base folder: /home/me/backup

Left Orphan Files (0)  Size Modified
------------------------------------

Right Orphan Files (0) Size Modified
------------------------------------

Left Newer Files (0)   Size Modified
------------------------------------

Right Newer Files (0)  Size Modified
------------------------------------

Difference Files (0)   Size Modified
------------------------------------
```

!!! tip "Try it first"
    `sync mirror:` deletes files on the target side. Run the script on test folders first, or replace the `sync` line with a `folder-report` to see what would change.

## Example: HTML diff reports for a list of files

This script writes an HTML report for one pair of files. Save it as `diff-report.txt`:

```text
# Usage: ccomp @diff-report.txt <old file> <new file> <report.html>
text-report layout:side-by-side options:display-mismatches,line-numbers &
    title:"Changes in %1" output-to:"%3" output-options:html-color "%1" "%2"
```

Call it once for each file in a list. In a Linux or macOS shell:

```sh
while read -r f; do
  ccomp @diff-report.txt "release-1.0/$f" "release-1.1/$f" "reports/$f.html" -silent
done < changed-files.txt
```

In PowerShell:

```powershell
Get-Content changed-files.txt | ForEach-Object {
    & ccomp '@diff-report.txt' "release-1.0\$_" "release-1.1\$_" "reports\$_.html" -silent
}
```

To put all changed files of two folders into a single report, select them in a folder comparison and use `file-report` without paths:

```text
load "%1" "%2"
expand all
select diff.files newer.files older.files
file-report layout:side-by-side options:display-context,line-numbers &
    output-to:"changes.html" output-options:html-color,wrap-word
```

## Example: comparing with a snapshot

A snapshot records the names, sizes, dates and optionally checksums of a folder's contents in a `.ccsnap` file. You can later compare the folder with it to see what has changed, even if the original files have been modified.

A snapshot is saved from a loaded folder comparison. To snapshot a single folder, load it on both sides:

```text
# Usage: ccomp @take-snapshot.txt <folder> <snapshot folder>
load "%1" "%1"
snapshot save left save-crc output:"%2/snapshot-%date%"
```

```sh
ccomp @take-snapshot.txt /srv/www /home/me/snapshots
```

This writes `/home/me/snapshots/snapshot-2026-10-19.ccsnap`; the `.ccsnap` extension is added for you. To see what has changed since then, open the folder and the snapshot from the command line:

```sh
comparecraft /srv/www /home/me/snapshots/snapshot-2026-10-19.ccsnap
```

!!! note "Snapshots in scripts"
    Scripts can save snapshots, but `load` cannot open a `.ccsnap` file. Compare against a snapshot from the command line or in the application.

## Example: checks in a CI pipeline

Use quick compare to check generated files against expected files and fail the build if they differ. Create a diff report as a build artifact when they do:

```sh
#!/bin/sh
status=0
for f in expected/*.txt; do
  name=$(basename "$f")
  ccomp -qc "$f" "output/$name"
  case $? in
    1|2) ;;                                   # same
    *)   echo "MISMATCH: $name"; status=1
         ccomp @diff-report.txt "$f" "output/$name" "artifacts/$name.html" -silent ;;
  esac
done
exit $status
```

A folder-level check with a script, which fails if a required folder is missing (exit code 107) or if any command fails:

```text
# ci-check.txt: ccomp @ci-check.txt <expected folder> <actual folder>
option stop-on-error
criteria rules-based
load "%1" "%2"
expand all
folder-report layout:summary options:display-mismatches output-to:artifacts/folder-diff.txt
```

```sh
ccomp @ci-check.txt test/expected build/output || exit 1
```

!!! tip "Exit codes of reports"
    A report script returns 0 when it ran successfully, even if the report shows differences. To make a build fail on differences, use `ccomp -qc` for each file, or check the report contents.

