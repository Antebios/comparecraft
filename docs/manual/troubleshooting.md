# Troubleshooting and FAQ

This page answers common questions about CompareCraft.

## Files show as different but their contents are the same

In Folder Compare, files are compared by size and timestamp by default. Two files with the same contents count as different when their timestamps differ by more than the tolerance (2 seconds), for example after a copy that did not keep the original timestamps.

- To check the contents of particular files, select them and choose **Actions > Compare Contents…**. See [Compare contents](folder-compare.md#compare-contents).
- To always compare contents, open **Session > Session Settings…**, go to the **Comparison** tab and turn on **Compare contents**. See [Comparison criteria](folder-compare.md#comparison-criteria).
- If the timestamps differ by exactly one hour or by whole hours, turn on **Ignore daylight saving time differences** or **Ignore timezone differences** in the same tab.

## Files show as the same but they are different

Folder Compare does not open files unless you ask it to compare contents. Two files with the same size and timestamp count as the same, even if their contents differ. Turn on **Compare contents** as described above, or use **Actions > Compare Contents…** with **Binary comparison**.

## Text Compare shows differences in blue

Blue differences are unimportant: by default, differences in whitespace and character case are unimportant. They are still differences, so the files are not identical. To make them count as important, click **⚙ Rules** and clear the corresponding boxes. See [Comparison rules](text-compare.md#comparison-rules).

## Line endings and encodings

Text Compare compares the text of each line. A file with Windows line endings (CRLF) and a file with Unix line endings (LF) show no line differences if the text is the same. The encoding and line ending of each file are shown below its path. See [Encodings and line endings](text-compare.md#encodings-and-line-endings).

Because the files differ byte by byte, a binary comparison still reports them as different. Quick compare on the Home view tells you whether files are "binary same" or only "the same according to comparison rules".

## A text file opens as binary

CompareCraft treats a file as binary when it contains a zero byte in its first 8 KB, unless the file starts with a UTF-16 byte order mark. Such files open in Hex Compare when CompareCraft chooses the viewer automatically. If one of the files in a Text Compare looks binary, a banner offers **Open in Hex Compare**.

To force a viewer, start the comparison from the matching card on the Home view, or, in Folder Compare, right-click the file and choose the viewer from the **Open With** submenu.

## Large files

Hex Compare aligns files of up to 256 MB. Larger files are always compared byte by byte by position, and a banner says so. See [Alignment](hex-compare.md#alignment).

## Windows or macOS warns about the download

The downloads are not code-signed yet.

- On Windows, if SmartScreen warns you, choose **More info**, then **Run anyway**.
- On macOS, the first time you start CompareCraft, right-click it in Applications and choose **Open**.

## Script or quick compare output does not appear on Windows

On Windows, the `comparecraft` program has no console, so the output of scripts and quick compares is not shown. Use the console version, `ccomp.exe`, which is installed next to `comparecraft`. It takes the same arguments, prints its output to the console and returns the result as its exit code. See [Console Program](console.md).

`ccomp` looks for `comparecraft` in its own folder and then on the `PATH`. If it cannot find it, set the environment variable `COMPARECRAFT_GUI` to the full path of the CompareCraft program.

## A new comparison opens in the existing window

CompareCraft runs as a single instance. When it is already running, a comparison started from the command line or a file manager opens as a new tab in the existing window, and the command returns immediately. To wait until the comparison window is closed, for example in a build script or a version control tool, use `ccomp`.

## Reset the settings

- Choose **Tools > Restore Factory Defaults…** to reset all options, colors, shortcuts and presets. Your sessions are kept.
- If CompareCraft does not start properly, close it and delete `settings.json` from the settings folder.

See [Settings and Data Locations](settings-and-data.md) for where the settings folder is.

## A keyboard shortcut does not work

Shortcuts belong to a view, and many commands are only available when something is selected. Press `Shift+F1` to see the shortcuts of the current view. If you have changed shortcuts, check the [Toolbars, Shortcuts page of the Options](options.md#toolbars-shortcuts), which warns when a shortcut is assigned to more than one command.

## Features that are not available yet

The following are not implemented yet:

- folder merge and three-way folder compare
- source-control integration
- media, registry and version-information compare; picture metadata compare
- archives as folders; FTP/SFTP and cloud locations

## Report a problem

Report bugs and suggest features in the [CompareCraft issue tracker](https://github.com/Antebios/comparecraft/issues). Include your operating system, the CompareCraft version (**Help > About CompareCraft**) and the steps to reproduce the problem.
