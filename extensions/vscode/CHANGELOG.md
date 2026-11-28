# Changelog

The extension is released together with the CompareCraft desktop app and uses
the same version numbers. Earlier changes are listed in the
[GitHub releases](https://github.com/Antebios/comparecraft/releases).

## Unreleased

### Added

- CompareCraft works in remote windows (Remote - SSH, WSL, Dev Containers):
  comparisons, folder comparisons and Git commands run on the remote computer.
- Restricted Mode: comparisons open read-only. Saving, Git commands and the
  desktop app become available when you trust the folder, without reopening tabs.
- Virtual workspaces, such as a GitHub repository opened without cloning: files
  are compared and saved through VS Code, and folders are compared from a
  temporary copy (up to 20,000 files and 512 MB).
- VS Code for the Web (vscode.dev, github.dev): text, Hex, Table and Picture
  comparisons with CompareCraft's WebAssembly engine.
- The extension package for each platform includes the comparison helper, so
  the desktop app is now optional. Other platforms compare files with the
  WebAssembly engine.

### Changed

- **Check Embedded Backend** reports which engine compares (bundled helper,
  desktop helper, configured helper or WebAssembly) and the environment.
- Commands that aren't available in the current environment explain why, for
  example the desktop app in a remote window.

## 0.6.0

### Added

- Text comparisons wrap long lines. The default follows VS Code's
  `editor.wordWrap` setting; **↵ Wrap**, **View > Word Wrap** or `Alt+Z` changes
  it for one tab.
- Drag across text to select part of a line or several lines, then copy exactly
  that text to the other side with **Copy to Left** / **Copy to Right**, or to the
  clipboard with `Ctrl+C`.
- Folder comparisons color each folder separately on each side by what it
  contains, with a two-tone icon and a description on hover.
- Folder comparisons leave out items ignored by `.gitignore` files and mark
  identical left-only and right-only files as moved or renamed (**⇌**). Both
  options are in Session Settings and on by default.
- Hold Shift and drag files or folders from the Explorer or an editor tab onto a
  comparison side to replace it.

### Changed

- Shortcuts that a focused CompareCraft tab uses no longer also run VS Code
  commands (for example `Ctrl+R` no longer opens Open Recent, and `F5` no longer
  starts debugging). `Ctrl+Shift+P` always opens the Command Palette.

### Fixed

- With a desktop app from 0.5.0 or earlier, folder comparisons keep working: the
  options that app doesn't support are turned off and shown disabled, and a
  notice suggests updating CompareCraft.
- **Edit > Copy** in VS Code copies the same text as `Ctrl+C` after a long drag
  selection in a text comparison.
