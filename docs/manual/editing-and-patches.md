# Editing Files and Viewing Patches

Besides comparing files, CompareCraft has two single-file views: **Text Edit** for making quick changes to a text file, and **Text Patch** for reading patch files (`.diff` and `.patch`).

## Edit a text file

To open a file in Text Edit:

- Choose **Tools > Edit Text File…** and select the file.
- In a [Text Compare](text-compare.md), choose **File > Open With > Text Edit** to edit the file of the current side.

Text Edit opens in a new tab. It shows the file path at the top, the text in the middle and, in the status bar, the cursor position ("Ln 12, Col 5").

To open another file in the same tab, type its path in the path bar and press `Enter`. If the current file has unsaved changes, CompareCraft asks "Discard unsaved changes?" first.

### Save and reload

| Toolbar | File menu | Keys | What it does |
| --- | --- | --- | --- |
| 💾 Save | Save | `Ctrl+S` | Saves the file |
| Save As… | Save As… | `Shift+Ctrl+S` | Saves the text under a new name |
| ⟳ Reload | Reload | `F5` | Reads the file from disk again |

A **●** badge in the path bar shows that the file has unsaved changes. Reloading a changed file asks "Discard unsaved changes and reload?"

When saving, CompareCraft keeps the encoding, byte order mark and line ending style of the file (a file with mixed line endings is saved with LF line endings). If **Before saving in file views** is turned on in the [Backups options](options.md#backups), a backup copy is made first.

The tab width used to display tab characters is the **Tab size:** setting on the [Text Editing page of the Options](options.md#text-editing).

## View a patch

A patch (or diff) file lists the changes between two versions of one or more files, as produced by version control tools. Text Patch displays it in a readable form. It is read-only.

To open a patch:

- Choose **Tools > View Patch…** and select the file. The file dialog shows **Patch files** (`.diff` and `.patch`) by default; choose **All files** to see other files.
- In a [Text Compare](text-compare.md), choose **File > Open With > Text Patch** to view the file of the current side as a patch.

You can also type the path of a patch file in the path bar ("Patch file (.diff, .patch)…") and press `Enter`.

### The patch window

- The **file list** on the left lists every file changed by the patch, with the number of added (+) and removed (−) lines. Click a file to jump to its changes.
- The **patch text** on the right, with added lines, removed lines and the headers of each change (hunk) shown in different colors.
- The **status bar** shows how many files the patch contains.

### Move between files

| Toolbar | Search menu | Keys |
| --- | --- | --- |
| ▼ Next File | Next File | `Ctrl+N` |
| ▲ Prev File | Previous File | `Ctrl+P` |

**⟳ Reload** (`F5`, **File > Reload**) reads the patch file again.
