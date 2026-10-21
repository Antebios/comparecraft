# Settings and Data Locations

CompareCraft keeps your options and sessions in a settings folder in your user profile. This page explains where that folder is and what it contains.

## The settings folder

| System | Folder |
| --- | --- |
| Linux | `~/.config/comparecraft/` |
| macOS | `~/Library/Application Support/comparecraft/` |
| Windows | `%APPDATA%\comparecraft\` |

On Linux, if the `XDG_CONFIG_HOME` environment variable is set, the folder is `comparecraft` inside that folder instead of inside `~/.config`.

## Use a different folder

Set the environment variable `COMPARECRAFT_CONFIG_DIR` to the path of a folder to make CompareCraft use that folder instead. This is useful for a portable setup, for testing, or to keep separate settings for different purposes.

On Linux and macOS:

```sh
COMPARECRAFT_CONFIG_DIR="$HOME/cc-test" comparecraft
```

On Windows (Command Prompt):

```text
set COMPARECRAFT_CONFIG_DIR=D:\CompareCraft\settings
comparecraft
```

The folder is created when CompareCraft first saves something in it.

## What is stored

| File or folder | Contents |
| --- | --- |
| `settings.json` | All options from Tools > Options, colors, keyboard shortcuts, Open With applications, name filter presets, the recent filters of the Filters box, and the tabs to restore at startup (if enabled). |
| `sessions.json` | Your saved sessions and up to 50 recent sessions. |
| `settings.json.bak` and `sessions.json.bak` | The previous version of each file, kept as a backup every time the file is saved. |
| `Scripts` | An optional folder for script files. A script name given without a folder is also looked up here. See [Scripting](scripting.md). |

Profiles (Tools > Profiles) are not stored in the settings folder, and they are not included when you export settings.

## Snapshots and backups

- **Snapshots** (Tools > Save Snapshot) are saved wherever you choose. The suggested name is `snapshot.ccsnap`.
- **Backup copies** of files are made next to the original file, or in the folder you choose on the [Backups page of the Options](options.md#backups).

## File manager integration files

On Linux, when you turn on the commands under **File manager integration** on the [Startup page of the Options](options.md#startup), CompareCraft creates:

- `~/.local/share/nautilus-python/extensions/comparecraft.py`, the native Files menu provider.
- `shell-integration.json` in the CompareCraft configuration directory, holding enabled action preferences.
- `shell-executable.json`, recording the installed application path used by native providers.
- `context-left.json` and `context-left-folder.json`, independent staged selections, plus per-kind lock files.

The package installs the shared policy library and the Thunar/Dolphin native providers in system library/plugin
directories. They offer no actions unless enabled for the current user. Disabling every command removes the
per-user Files provider and hides actions from the other providers. Old CompareCraft scripts, service menus
and Thunar custom actions are removed when integration is reapplied. XDG data/configuration overrides apply.

## Reset CompareCraft

- To reset all options, colors, shortcuts and presets but keep your sessions, choose **Tools > Restore Factory Defaults…**. See [Restore Factory Defaults](options.md#restore-factory-defaults).
- To remove your sessions as well, close CompareCraft and delete `sessions.json` from the settings folder.
- To start completely fresh, close CompareCraft and delete the whole settings folder.

## Back up and move your settings

The easiest way to copy your settings to another computer is **Tools > Export Settings…** and **Tools > Import Settings…**. See [Export and Import Settings](options.md#export-and-import-settings).

You can also copy `settings.json` and `sessions.json` to the settings folder on the other computer while CompareCraft is closed.
