# Console Program

`ccomp` is the console version of CompareCraft. It takes the same arguments as `comparecraft` (see [Command Line](command-line.md)), but it always runs as a console program and waits until the work is done before it returns. Its exit code tells the calling program what happened.

Use `ccomp` when another program needs the result or needs to wait:

- shell scripts and Windows batch files
- scheduled tasks and CI pipelines
- version control tools that open a diff or merge program and wait for it
- the Windows console. The graphical `comparecraft` program on Windows has no console, so it cannot print messages or report a useful exit code there.

`ccomp` is installed next to the `comparecraft` program.

## What ccomp does

`ccomp` handles a request in one of two ways.

The following requests run inside `ccomp` itself. No window opens, messages are printed to the console, and the exit code is the result:

| Request | Example |
|---|---|
| Run a script | `ccomp @sync.txt /data /backup` |
| Quick compare | `ccomp -qc a.txt b.txt` |
| Automatic merge | `ccomp -automerge mine.txt theirs.txt base.txt out.txt` |
| Help | `ccomp -h` |

Every other request opens a new CompareCraft window, and `ccomp` waits until that window is closed:

| Request | Example |
|---|---|
| Compare two files or folders | `ccomp old.txt new.txt` |
| Three-way merge | `ccomp mine.txt theirs.txt base.txt merged.txt` |
| Open a session | `ccomp Website` |
| Automatic merge with conflicts and `-reviewconflicts` | `ccomp -automerge -reviewconflicts mine.txt theirs.txt base.txt out.txt` |

The window is always a new one, even if CompareCraft is already running. When you close it, `ccomp` exits with the window's exit code.

!!! note "comparecraft versus ccomp"
    `comparecraft old.txt new.txt` hands the comparison to the running CompareCraft window (or starts one) and returns at once. `ccomp old.txt new.txt` opens a separate window and does not return until you close it. Use `ccomp` whenever the next step depends on the comparison being finished.

## How ccomp finds CompareCraft

When `ccomp` needs to open a window, it looks for the CompareCraft program in this order:

1. The program named in the `COMPARECRAFT_GUI` environment variable.
2. `comparecraft` or `CompareCraft` (with `.exe` on Windows) in the same folder as `ccomp`.
3. `comparecraft` on the `PATH`.

If the program cannot be started, `ccomp` prints `ccomp: unable to start …` and exits with code 103. Set `COMPARECRAFT_GUI` if CompareCraft is installed somewhere unusual:

```sh
export COMPARECRAFT_GUI=/opt/comparecraft/bin/comparecraft
```

```bat
set COMPARECRAFT_GUI=D:\Tools\CompareCraft\CompareCraft.exe
```

## Reading standard input

Give `-` instead of a path to compare text that is piped into `ccomp`. The input is read once into a temporary file, which is used for the comparison and deleted when `ccomp` exits.

```sh
curl -s https://example.com/config.json | ccomp -qc - config.json
```

```sh
git show HEAD~1:README.md | ccomp -title1="README.md (previous)" - README.md
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (script completed, merge without conflicts) |
| 1 | Quick compare: binary same |
| 2 | Quick compare: rules-based same |
| 11 | Quick compare: binary differences |
| 12 | Quick compare: similar |
| 13 | Quick compare: rules-based differences |
| 14 | Automatic merge: conflicts detected, output written with conflict markers (`-force`) |
| 100 | Error (invalid arguments, unknown switch, missing file, script error with `option stop-on-error`) |
| 101 | Automatic merge: conflicts detected, output not written |
| 102 | `ccomp` could not wait for the CompareCraft window |
| 103 | `ccomp` could not find or start the CompareCraft application |
| 105 | Script file could not be loaded |
| 106 | Unknown script command or invalid arguments |
| 107 | Script comparison could not be loaded |

When the arguments cannot be parsed (for example, an unknown switch), `ccomp` prints `ccomp:` followed by the problem, then the usage text, and exits with code 100.

## Examples for Linux and macOS

Check whether two files are the same:

```sh
ccomp -qc expected/output.txt build/output.txt
case $? in
  1|2) echo "Files are the same" ;;
  12)  echo "Files differ only in whitespace or case" ;;
  11|13) echo "Files differ" ;;
  *)   echo "Comparison failed" ;;
esac
```

Merge automatically, and open the merge view only when there are conflicts:

```sh
ccomp -automerge -reviewconflicts mine.cfg theirs.cfg base.cfg merged.cfg
```

Run a script with two parameters and no console output:

```sh
ccomp @/home/me/scripts/backup.txt /home/me/work /mnt/backup/work -silent
echo "Script finished with exit code $?"
```

Open a comparison and continue only after the window has been closed:

```sh
ccomp before.sql after.sql
echo "Review finished"
```

## Examples for Windows cmd

In `cmd.exe` and batch files, the exit code is in `%ERRORLEVEL%`:

```bat
@echo off
ccomp -qc "C:\Release\app.cfg" "D:\Deploy\app.cfg"
if %ERRORLEVEL% EQU 1 goto same
if %ERRORLEVEL% EQU 2 goto same
if %ERRORLEVEL% GEQ 100 goto failed
echo The files differ.
goto end
:same
echo The files are the same.
goto end
:failed
echo The comparison failed.
:end
```

Run a nightly script and log the result:

```bat
ccomp @"C:\Scripts\nightly.txt" "D:\Projects" "\\server\backup\Projects" -silent
echo %DATE% %TIME% exit code %ERRORLEVEL% >> C:\Scripts\nightly-history.txt
```

## Examples for PowerShell

In PowerShell, the exit code is in `$LASTEXITCODE`:

```powershell
& ccomp -qc .\expected.json .\actual.json
switch ($LASTEXITCODE) {
    { $_ -in 1, 2 }      { "Same" }
    12                   { "Similar (whitespace or case only)" }
    { $_ -in 11, 13 }    { "Different" }
    default              { "Error $LASTEXITCODE" }
}
```

Run a script and stop the pipeline on failure:

```powershell
& ccomp '@C:\Scripts\report.txt' 'C:\Work\v1' 'C:\Work\v2'
if ($LASTEXITCODE -ne 0) { throw "Report script failed with exit code $LASTEXITCODE" }
```

!!! tip "Quoting the @ sign in PowerShell"
    In PowerShell, `@` at the start of an argument has a special meaning. Put the script argument in quotes, as in `'@C:\Scripts\report.txt'`.

