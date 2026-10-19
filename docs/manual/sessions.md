# Sessions

A session is a comparison that CompareCraft remembers: which kind of view it is, the files or folders being compared, and the settings of the view, such as the comparison rules and filters. Sessions let you reopen a comparison later with one click.

There are two kinds of sessions:

- **Recent** sessions are recorded automatically every time you open a comparison.
- **Saved** sessions are comparisons you have saved under a name of your choice.

## Recent sessions

Every comparison you open is added to the **Recent** list on the Home view, with the most recent first. If you open the same files or folders in the same kind of view again, the existing entry is updated instead of a new one being added.

CompareCraft keeps the 50 most recent sessions. Older ones are removed automatically. Saved sessions are never removed automatically.

## Save a session

1. Open the comparison and set it up the way you want it.
2. Choose **Session > Save Session…** or press `Shift+Ctrl+S`. In Folder Compare and Text Compare you can also click **★ Save Session** on the toolbar.
3. Enter a name in the **Save Session** dialog and click **OK**.

The session appears under **Saved sessions** on the Home view, and its name is shown in the tab title.

You can save sessions from Folder Compare, Folder Sync, Text Compare, Text Merge and Table Compare.

## Open a session

- On the Home view, click the name of a session in the **Saved sessions** or **Recent** list. Hover over an entry to see its paths.
- In Text Compare, Table Compare, Hex Compare and Picture Compare, click **☰ Sessions ▾** on the toolbar to choose from the saved sessions of the same kind. The list says "(No saved sessions)" if there are none.
- From a terminal, give the session name as the only argument: `comparecraft "My project"`. Upper and lower case do not matter. See [Command Line](command-line.md).

Each list entry shows the kind of comparison, the name and the time it was last saved.

## Delete a session

Click the **✕** button at the end of the entry on the Home view, then confirm when CompareCraft asks "Delete session "name"?".

## Change the settings of a saved session

Open the session, change the settings and save it again with **Session > Save Session…**.

In Folder Compare and Folder Sync, the **Session Settings** dialog can also update the saved session directly: choose **Also update saved session** at the bottom of the dialog before clicking **OK**. You can also choose **Also update session defaults** to make the settings the starting point for every new folder comparison. See [Session settings in Folder Compare](folder-compare.md#session-settings).

## Restore your tabs at startup

CompareCraft can reopen the tabs you had open when you last closed it. On the [Startup page of the Options](options.md#startup), set:

- **On exit, save workspace as:** to **Last used tabs**, and
- **When starting, load workspace:** to **Last used tabs**.

## Move sessions to another computer

Saved sessions can be included when you export your settings with **Tools > Export Settings…**, and brought back with **Tools > Import Settings…**. See [Export and Import Settings](options.md#export-and-import-settings).

The sessions are stored in the file `sessions.json` in the CompareCraft settings folder. See [Settings and Data Locations](settings-and-data.md).
