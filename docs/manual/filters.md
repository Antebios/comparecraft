# Filters

Filters decide which files and folders take part in a folder comparison or folder sync. Use them to leave out build output, version control folders, temporary files, or anything else you do not want to compare.

There are two kinds of filters:

- **Name filters** select items by their file or folder name.
- **Other filters** exclude files by their date, size or content.

By default, a new folder comparison includes everything except folders named `.git` and `node_modules`.

## The Filters box

The quickest way to filter is the **Filters:** box on the filter bar of Folder Compare and Folder Sync.

1. Click in the **Filters:** box.
2. Type one or more masks separated by `;`.
3. Press `Enter`. The comparison is refreshed with the new filter.

Press `Esc` to cancel your changes. To include every file again, enter `*`.

The drop-down list of the box offers the filters you used recently and the masks of your name filter presets. The number of recent filters remembered is set by **Most recently used list size:** on the [Tweaks page of the Options](options.md#tweaks).

### Mask syntax

| Mask | Meaning |
| --- | --- |
| `*.txt` | Include files ending in `.txt` |
| `*.c;*.h` | Include files ending in `.c` or `.h` |
| `-*.bak` | Exclude files ending in `.bak` |
| `-obj/` | Exclude folders named `obj` (a mask ending in `/` or `\` is a folder) |
| `*.cs;-bin/;-obj/` | Include `.cs` files, but leave out the `bin` and `obj` folders |

- `*` matches any number of characters, and `?` matches exactly one character.
- `*.` matches names without an extension. Note that `*.*` matches only names that contain a dot.
- Masks are not case-sensitive.
- Masks without a leading `-` are include masks and apply to files. Folders are not affected by include masks, so files in subfolders are still found.
- A mask that starts with `-` is an exclude mask.

## Peek at excluded items

Click **👁 Peek** on the filter bar to see what your filters are hiding. While Peek is on, the items excluded by the file filters are shown too, and the filter bar shows the badge "Peeking at excluded items". Click **👁 Peek** again to hide them.

## Suppress filters

Choose **View > Suppress Filters** to turn all filters off for the moment, without losing them. The filter bar shows the badge "Filters suppressed". Choose the command again to turn the filters back on.

While Peek or Suppress Filters is on, the **Filters:** box cannot be edited.

## Name Filters

For more control, click **⛃ Filters** on the filter bar. The **Session Settings** dialog opens on the **Name Filters** tab, which has four boxes:

| Box | What it does |
| --- | --- |
| **Include files:** | Only files that match one of these masks are compared. Empty means all files. |
| **Exclude files:** | Files that match one of these masks are left out. |
| **Include folders:** | Only folders that match one of these masks are compared. Empty means all folders. |
| **Exclude folders:** | Folders that match one of these masks are left out, with everything inside them. |

Enter one mask per line, or separate masks with `;`. The wildcards are `*` and `?`.

An exclude mask that contains a path separator is anchored to the base folder. For example, `/src/gen` in **Exclude folders:** leaves out only the `gen` folder inside the `src` folder at the top of the comparison, but not other folders named `gen`.

Below the boxes:

- **Clear** empties all four boxes.
- **Load preset…** fills the boxes from one of your name filter presets.
- **Add To Presets…** saves the current filters as a preset. Enter a **Name:** and click **OK**. A preset with the same name is replaced.

Click **OK** or **Apply** to use the filters. At the bottom of the dialog you choose whether the filters apply to this view only, also become the defaults for new folder comparisons, or are also stored in the saved session. See [Session settings in Folder Compare](folder-compare.md#session-settings).

### Name filter presets

Presets are named filters that you can reuse. CompareCraft comes with these presets:

| Name | Mask |
| --- | --- |
| Source code | `*.c;*.cpp;*.h;*.hpp;*.cs;*.java;*.js;*.ts;*.tsx;*.py;*.rs;*.go` |
| Web | `*.html;*.htm;*.css;*.js;*.ts;*.json` |
| Exclude VCS folders | `*.*;-.git\;-.svn\;-.hg\` |
| Exclude build output | `*.*;-node_modules\;-target\;-dist\;-build\;-bin\;-obj\` |

To add, change or delete presets, or to restore these defaults, use **Name filter presets** on the [Tweaks page of the Options](options.md#tweaks). The **Misc** tab of the Session Settings dialog also lists the presets.

## Other Filters

The **Other Filters** tab of the Session Settings dialog excludes files by date, size or content. Each filter in the list has a checkbox, so you can turn it off without deleting it. A turned-off filter is shown with "(off)" in front of its description. The list shows "(no filters)" when there are none.

- **New…** creates a filter.
- **Edit…** (or double-click) changes the selected filter.
- **Clone…** creates a new filter based on the selected one.
- **Delete** removes the selected filter.

When other filters are active, the filter bar shows a badge such as "+2 other filter(s)".

### Create an other filter

Click **New…** and choose the kind of filter in the **Other Filter** editor:

- **Date modified**: **Exclude files** **older than** or **newer than** a number of **days ago** (30 by default) or a specific date.
- **Size**: **Exclude files** **smaller than** or **larger than** a size, in bytes, KB, MB or GB.
- **Content**: **Exclude files** **containing** or **not containing** a text. Options: **Match case**, **Whole words** and **Regular expression**.

Click **OK** to add the filter.

Other filters apply to files only. Folders are not removed by them.

### Protected operating system files

Turn on **Exclude protected operating system files (Recommended)** to leave out files that are marked as both hidden and system files. This applies to Windows; it is off by default.

## Filters and snapshots

When you save a snapshot of a folder with **Tools > Save Snapshot…**, items excluded by the filters are left out unless you turn on **Items excluded by file filters**. See [Save Snapshot](options.md#save-snapshot).
