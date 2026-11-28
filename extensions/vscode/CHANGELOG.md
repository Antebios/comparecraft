# Changelog

The extension is released together with the CompareCraft desktop app and uses
the same version numbers. Earlier changes are listed in the
[GitHub releases](https://github.com/Antebios/comparecraft/releases).

## Unreleased

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
