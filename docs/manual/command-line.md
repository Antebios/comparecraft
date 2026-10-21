# Command Line

CompareCraft can be started from a terminal, a shortcut, a batch file or a version control tool. You can use the command line to open a comparison of files or folders, start a three-way merge, run a quick compare that only returns an exit code, merge files automatically, or run a script.

There are two programs:

- `comparecraft` is the normal graphical application. It hands the request to CompareCraft and returns right away.
- `ccomp` is the console version. It takes the same arguments, but it runs quick compares, automatic merges and scripts in the console. For anything else it opens a window and waits until you close it. Use `ccomp` in batch files, CI pipelines and version control tools. See [Console Program](console.md).

## Syntax

```text
comparecraft [options] [left] [right] [center] [output]
ccomp        [options] [left] [right] [center] [output]
```

The paths you give decide what is opened:

| Arguments | What opens |
|---|---|
| (none) | The home view |
| `<folder>` | A folder comparison with that folder on the left |
| `<file>` | The file, in the viewer for its file type |
| `<folder> <folder>` | A folder comparison (with `-sync`: a folder synchronization) |
| `<file> <file>` | A file comparison in the viewer for that file type |
| `<left> <right> <center>` | A three-way text merge; `<center>` is the common ancestor |
| `<left> <right> <center> <output>` | A three-way text merge that saves to `<output>` |
| `<folder> <folder> <folder> [<folder>]` | A [Folder Merge](folder-merge.md) of left, right and base folders, into the output folder |
| `<session name>` | The saved session with that name |
| `-` | Standard input, read into a temporary file (can be used in place of any path) |
| `@<script> [params]` | Runs a script without opening a window (see [Scripting](scripting.md)) |

Some notes on how arguments are read:

- Relative paths are resolved against the current directory.
- A snapshot file (`.ccsnap`) can be used in place of either folder in a folder comparison.
- A single argument that is not an existing file or folder, and has no path separator, is taken as the name of a saved session (see [Sessions](sessions.md)).
- When two files are given, the viewer is chosen from the file type:
    - Picture Compare for picture files (`png`, `jpg`, `jpeg`, `jpe`, `jfif`, `gif`, `bmp`, `dib`, `webp`, `ico`, `svg`, `avif`, `tif`, `tiff`, `tga`, `pnm`, `pbm`, `pgm`, `ppm`, `pam`, `qoi`).
    - Table Compare for `csv`, `tsv` and `tab` files.
    - Hex Compare for files with binary content.
    - Text Compare for everything else.
    - Use `-fv` to pick a different viewer.

`comparecraft` runs as a single instance. If CompareCraft is already running, the new comparison opens as a tab in the existing window and the command returns right away. Use `-solo` to force a new window.

## Writing switches

- Switches start with `-` (for example `-ro`). `--ro` also works, and on Windows so does `/ro`.
- Switch names are not case-sensitive: `-ReadOnly` and `-readonly` are the same switch.
- Values follow `=` or `:`, so `-title1=Old` and `-title1:Old` are the same. Quotes around a value are removed: `-title1="Release 1.0"`.
- Switches and paths can be given in any order.
- An unknown switch is an error. The program prints the usage text and exits with code 100.

## Switches

### General

| Switch | Description |
|---|---|
| `-h`, `-?`, `-help` | Prints the usage text. |
| `-fv=<type>`, `-fileviewer=<type>` | Opens the paths in a specific viewer (see below). |
| `-solo` | Always opens a new application window instead of reusing the running one. |
| `-silent` | For scripts: suppresses all console output. |
| `-filters=<masks>` | Name filter for a folder comparison, for example `-filters="*.rs;-target/"` (see [Filters](filters.md)). |
| `-expandall` | Expands all folders of a folder comparison. |
| `-sync` | Opens two folders in Folder Sync instead of Folder Compare. |
| `-nobackups` | Saves without creating `.bak` backup files. |
| `-savetarget=<file>` | Saves the right-hand side to `<file>` instead of overwriting the right file. |

### File-manager actions

| Switch | Description |
| --- | --- |
| `-cc-select-left <file>` | Remember exactly one left file. |
| `-cc-select-left-folder <folder>` | Remember exactly one left folder independently. |
| `-cc-compare-staged <right-file>` | Compare to the staged file, then clear only that selection. |
| `-cc-compare-staged-folder <right-folder>` | Compare to the staged folder, then clear only that selection. |
| `-cc-clear-left` | Clear the staged file without changing the staged folder. |
| `-cc-clear-left-folder` | Clear the staged folder without changing the staged file. |
| `-cc-compare <left> <right>` | Compare exactly two files or two folders; retain staged selections. |
| `-cc-merge <left-file> <right-file>` | Open the existing two-file merge workflow. |
| `-cc-sync <left-folder> <right-folder>` | Open Folder Sync; do not perform immediate synchronization. |

Only one context action can be supplied at a time. Place `--` before literal paths beginning with a dash.
Paths and staged item types are revalidated before launch. A failed comparison leaves staging intact.

### Viewer types

`-fv` accepts these viewer names. Case, spaces, hyphens and underscores are ignored, so `-fv="Hex Compare"`, `-fv=hexcompare` and `-fv=hex` all work.

| Viewer | Short forms |
|---|---|
| Text Compare | `text` |
| Text Merge | `merge` |
| Text Edit | `edit` |
| Text Patch | `patch` |
| Hex Compare | `hex` |
| Table Compare | `table`, `datacompare` |
| Picture Compare | `picture`, `mediacompare` |
| Folder Compare | `folder` |
| Folder Sync | `sync` |
| Folder Merge | `foldermerge`, `fmerge` |

If the name is not recognised, CompareCraft prints an error and uses Text Compare.

### Titles and display paths

| Switch | Description |
|---|---|
| `-title1=<text>` … `-title4=<text>` | Title shown above the left, right, center and output panes. |
| `-lefttitle=`, `-righttitle=`, `-centertitle=`, `-outputtitle=` | The same titles, set by side name. |
| `-vcs1=<path>` … `-vcs4=<path>` | Display path for a side. It is shown when no title is given. This is useful for temporary files created by a version control tool. |

Titles are helpful when the files are temporary copies:

```sh
comparecraft -title1="main (HEAD)" -title2="Working copy" /tmp/git-blob-1234 src/app.c
```

### Read-only

| Switch | Description |
|---|---|
| `-ro`, `-readonly` | All sides are read-only. |
| `-ro1`, `-lro`, `-leftreadonly` | The left side is read-only. |
| `-ro2`, `-rro`, `-rightreadonly` | The right side is read-only. |
| `-ro3` | The center pane is read-only. |
| `-ro4` | The output pane is read-only. |

### Comparing and merging without a window

| Switch | Description |
|---|---|
| `-qc[=<type>]`, `-quickcompare[=<type>]` | Compares two files and reports the result only as an exit code. `<type>` is `size`, `crc` or `binary`. Without a type the comparison is rules-based. |
| `-automerge` | Merges three files without opening a window, unless there are conflicts. |
| `-force` | With `-automerge`: writes the output even if there are conflicts, with conflict markers. |
| `-iu`, `-ignoreunimportant` | With `-automerge`: changes that differ only in case or whitespace are not treated as changes. |
| `-reviewconflicts` | With `-automerge`: if there are conflicts, opens the merge view so you can resolve them. |
| `-mergeoutput=<file>` | Merge output file (instead of a fourth path). |
| `-center=<file>` | Merge center (common ancestor) file (instead of a third path). |

## Examples

Compare two files:

```sh
comparecraft old/report.txt new/report.txt
```

Compare two folders, show only C sources and expand all folders:

```sh
comparecraft -filters="*.c;*.h" -expandall ~/src/v1 ~/src/v2
```

Synchronize two folders:

```sh
comparecraft -sync ~/Documents /media/backup/Documents
```

Compare a folder with a snapshot saved earlier:

```sh
comparecraft ~/Documents ~/snapshots/Documents_2026-10-01.ccsnap
```

Open two binary files in Hex Compare even though they have a text extension:

```sh
comparecraft -fv=hex dump1.txt dump2.txt
```

Three-way merge: `mine.txt` and `theirs.txt` were both changed from `base.txt`, and the result is saved to `merged.txt`:

```sh
comparecraft mine.txt theirs.txt base.txt merged.txt
```

The same merge written with switches:

```sh
comparecraft mine.txt theirs.txt -center=base.txt -mergeoutput=merged.txt
```

Compare the output of a command with a file (standard input is read into a temporary file):

```sh
ls -l /etc | comparecraft - etc-listing.txt
```

Open a saved session called `Website`:

```sh
comparecraft Website
```

Open a comparison where the left side is read-only:

```sh
comparecraft -ro1 reference.cfg current.cfg
```

## Quick compare

`-qc` compares two files without opening a window and returns the result as an exit code. Use `ccomp` for this, because it waits for the result and returns the exit code (see [Console Program](console.md)).

```sh
ccomp -qc expected.txt actual.txt
echo $?
```

| Type | How the files are compared |
|---|---|
| `-qc` | Rules-based. Files whose text is the same, apart from encoding, byte order mark, line endings or a final newline, count as the same. Files that differ only in case, whitespace or blank lines count as similar. If either file is binary, the files are compared byte by byte. |
| `-qc=binary` | Byte-by-byte comparison. |
| `-qc=crc` | Compares the CRC checksums of the files. |
| `-qc=size` | Compares the file sizes. If the sizes are the same, the contents are compared as well. |

Quick compare needs exactly two files. Folders, missing files or a different number of paths give exit code 100. The exit codes are listed in [Exit codes](#exit-codes).

## Automatic merge

`-automerge` merges a three-way comparison without opening a window. You need the left file, the right file, the center (common ancestor) file and an output file. The output can be given as a fourth path or with `-mergeoutput`.

```sh
ccomp -automerge mine.txt theirs.txt base.txt merged.txt
```

- If the changes on the two sides do not conflict, the output is written and the exit code is 0.
- If there are conflicts, nothing is written and the exit code is 101. Add `-reviewconflicts` to open the merge view on conflicts instead, so you can resolve them by hand.
- With `-force` the output is always written, and the exit code is 14 when there were conflicts. Each conflict is written with markers that name the left and right files:

```text
<<<<<<< mine.txt
A
=======
Z
>>>>>>> theirs.txt
```

- With `-iu`, changes that differ only in case or whitespace are not treated as changes, so they do not cause conflicts.
- The output keeps the encoding, byte order mark and line endings of the center file.
- If an output file is missing, the merge stops with exit code 100.

## Running scripts

A script argument starts with `@`. The script runs without opening a window. Any arguments after the script name become the script parameters `%1` to `%9`:

```sh
ccomp @nightly.txt /data/projects /mnt/backup/projects
```

Add `-silent` to suppress console output. See [Scripting](scripting.md) for details and [Script Command Reference](script-reference.md) for all commands.

## Exit codes

The following exit codes are returned by quick compare, automatic merge, the console program and scripts.

| Code | Meaning | Returned by |
|---|---|---|
| 0 | Success. No conflicts in an automatic merge; script completed. | `-automerge`, scripts |
| 1 | Binary same: the files are identical. | `-qc` |
| 2 | Rules-based same: only encoding, byte order mark or line ending differences. | `-qc` |
| 11 | Binary differences. | `-qc` |
| 12 | Similar: only case, whitespace or blank line differences. | `-qc` |
| 13 | Rules-based differences. | `-qc` |
| 14 | Conflicts detected; the output was written with conflict markers. | `-automerge -force` |
| 100 | Error: invalid arguments, unknown switch, missing file. In scripts: an error with `option stop-on-error`. | all |
| 101 | Conflicts detected; the merge output was not written. | `-automerge` |
| 102 | `ccomp` could not wait for the CompareCraft window. | `ccomp` |
| 103 | `ccomp` could not find or start the CompareCraft application. | `ccomp` |
| 105 | The script file could not be loaded. | scripts |
| 106 | Unknown script command or invalid arguments. | scripts |
| 107 | The comparison could not be loaded (for example, a folder does not exist). | scripts |

!!! tip "Testing for equal files"
    With `-qc`, codes 1 and 2 mean the files are the same, 11, 12 and 13 mean they differ, and 100 means the comparison could not be done. Decide whether 12 (similar) counts as the same for your task.

## Using CompareCraft with git

Set `ccomp` up as the diff and merge tool for git:

```sh
git config --global diff.tool comparecraft
git config --global difftool.comparecraft.cmd 'ccomp "$LOCAL" "$REMOTE"'
git config --global merge.tool comparecraft
git config --global mergetool.comparecraft.cmd 'ccomp "$LOCAL" "$REMOTE" "$BASE" "$MERGED"'
git config --global mergetool.comparecraft.trustExitCode true
```

Then use git as usual:

```sh
git difftool HEAD~1 -- src/main.c
git mergetool
```

With `git difftool`, each changed file opens in its own window. When you close the window, git moves on to the next file. With `git mergetool`, the merge view opens with your version on the left, the other branch on the right, the common ancestor in the center and the file being merged as the output. Save the output and close the window to finish.

`ccomp` is used instead of `comparecraft` because git needs a program that waits until you have finished. On Windows, give the full path if `ccomp` is not on the `PATH`, for example:

```bat
git config --global difftool.comparecraft.cmd "\"C:/Program Files/CompareCraft/ccomp.exe\" \"$LOCAL\" \"$REMOTE\""
```

## Other version control tools

Most version control clients let you set up an external diff and merge program. Use `ccomp` with these arguments:

| Purpose | Arguments |
|---|---|
| Diff | `"<left file>" "<right file>"` |
| Diff with titles | `-title1="<left title>" -title2="<right title>" "<left file>" "<right file>"` |
| Three-way merge | `"<mine>" "<theirs>" "<base>" "<merged output>"` |
| Merge without a window when possible | `-automerge -reviewconflicts "<mine>" "<theirs>" "<base>" "<merged output>"` |

- Use `-title1`…`-title4` or `-vcs1`…`-vcs4` to show friendly names instead of temporary file paths.
- Use `-ro1` when the left file is a read-only copy of a past revision.
