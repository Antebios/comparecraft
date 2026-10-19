# Folder Sync

Folder Sync makes one folder match another, or brings two folders up to date with each other. Before anything changes, CompareCraft shows every action it is going to take, so you can check the plan first.

## Start a folder sync

There are several ways to open the **Folder Sync** dialog:

- In a [Folder Compare](folder-compare.md), click **⇆ Sync…** on the toolbar.
- In a Folder Compare, choose **Actions > Synchronize** and then a sync mode. The dialog opens with that mode selected.
- On the Home view, click the **Folder Sync** card, or choose **Session > New Folder Sync**. This opens a folder comparison with the Folder Sync dialog on top.
- In a Folder Compare, right-click a folder that exists on both sides and choose **Open With > Folder Sync** to sync that pair of subfolders in a new tab.

!!! tip "Compare first"
    The easiest way to sync is to open a Folder Compare of the two folders, look at the differences, and then click **⇆ Sync…**. If you close the Folder Sync dialog, you can always open it again with **⇆ Sync…**.

## Sync modes

Choose one of these modes at the top of the dialog:

| Mode | What it does |
| --- | --- |
| Update Right → | Copy newer and orphan files from left to right. |
| ← Update Left | Copy newer and orphan files from right to left. |
| ← Update Both → | Copy newer and orphan files in both directions. |
| Mirror to Right → | Make right identical to left: replace different items, copy left orphans, delete right orphans. |
| ← Mirror to Left | Make left identical to right: replace different items, copy right orphans, delete left orphans. |

The **Update** modes never delete anything. The **Mirror** modes delete items that exist only on the target side, so use them with care.

The Folder Compare keyboard shortcuts `Shift+Ctrl+R` and `Shift+Ctrl+L` open the dialog in **Mirror to Right** and **Mirror to Left** mode.

## Check the preview

When you choose a mode, CompareCraft works out the plan and lists every action in a table:

- **Action**: what will happen, such as **Copy**, **Delete** or **Create**. Actions on folders are marked "folder" (for example "Delete folder").
- **Item**: the item, relative to the base folder.
- **Target**: where the action takes place.
- **Size**: the size of the item.

Below the table, the dialog shows the number of actions and how much data will be copied. If there is nothing to do, it says "Folders are already in sync for this mode."

The sync uses the comparison settings of the folder comparison, including its [filters](filters.md) and comparison criteria. Items that are excluded by the filters are not synchronized.

## Run the sync

1. Choose the mode and check the preview.
2. If you opened the dialog with items selected, **Selected items only** limits the sync to those items (and everything inside selected folders). Turn it off to sync everything.
3. Leave **Delete to trash** on to move deleted items to the trash, or turn it off to delete them permanently. Its starting value comes from **Use recycle bin (trash) by default** in the [Options](options.md#file-operations).
4. Click **Start Sync**.

When the sync finishes, the folder comparison is refreshed. The results are written to the log (**View > Log**).

!!! warning "Mirror deletes files"
    **Mirror to Right** and **Mirror to Left** delete orphans on the target side. Check the preview carefully, and keep **Delete to trash** on if you want to be able to recover deleted files.

## Backups

If **Before replacing files with copy or move** is turned on in the [Backups options](options.md#backups), CompareCraft makes a backup of each file before the sync replaces it.

## Sync from the command line

You can also open a folder sync from a terminal, or run syncs without the window from a script. See [Command Line](command-line.md) and [Scripting](scripting.md).
