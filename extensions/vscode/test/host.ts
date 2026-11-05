import * as vscode from "vscode";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { EmbeddedPanel, EmbeddedPanels } from "../src/embedded";
import { pathKey } from "../src/embeddedCore";

export async function run(): Promise<void> {
  const directory = process.env.COMPARECRAFT_TEST_DIRECTORY;
  const node = process.env.COMPARECRAFT_TEST_NODE;
  assert.ok(directory && node, "Integration runner must provide an isolated directory and Node executable");
  const extension = vscode.extensions.all.find(
    (candidate) => candidate.packageJSON.name === "comparecraft",
  );
  assert.ok(extension, "Development extension must be installed");
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const id of [
    "compareSelected", "compareSelectedDesktop", "compareSelectedEmbedded",
    "selectLeft", "compareWithLeft", "clearLeft", "compareFileWith", "compareFolderWith",
    "compareParentFolderWith", "openDesktop", "locateDesktop",
    "openSavedFolderSession",
    "compareWithSaved", "compareWithClipboard", "selectLeftText", "compareTextWithLeft", "compareActiveDiff",
    "gitCompareHead", "gitCompareIndex", "gitCompareHeadIndex", "gitCompareRevision",
    "gitResolveConflict", "gitResolveConflictEmbedded", "gitStageResolved", "configureGitTools", "removeGitTools", "checkBackend"
  ]) assert.ok(commands.includes(`comparecraft.${id}`), `Registered command: ${id}`);
  assert.equal(vscode.workspace.isTrusted, true);
  const config = vscode.workspace.getConfiguration("comparecraft");
  assert.equal(config.get("defaultMode"), "embedded");
  await config.update("defaultMode", "desktop", vscode.ConfigurationTarget.Global);
  await config.update("desktopPath", node, vscode.ConfigurationTarget.Global);

  const output = path.join(directory, "launched.json");
  const left = path.join(directory, "left with spaces.cjs");
  const right = path.join(directory, "-right with spaces.txt");
  const leftFolder = path.join(directory, "left folder");
  const rightFolder = path.join(directory, "right folder");
  const launcher = `require("fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)))`;
  await writeFile(left, launcher);
  await writeFile(right, "right");
  await mkdir(leftFolder);
  await mkdir(rightFolder);
  await writeFile(path.join(leftFolder, "index.js"), launcher);

  async function verifyLaunch(command: string, args: unknown[], expected: string): Promise<void> {
    await writeFile(output, "null");
    await vscode.commands.executeCommand(command, ...args);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await readFile(output, "utf8") !== "null") {
        assert.deepEqual(JSON.parse(await readFile(output, "utf8")), [await realpath(expected)]);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`No process output from ${command}`);
  }

  try {
    const l = vscode.Uri.file(left), r = vscode.Uri.file(right);
    await verifyLaunch("comparecraft.compareSelectedDesktop", [l, [l, r]], right);
    await vscode.commands.executeCommand("comparecraft.selectLeft", l);
    await verifyLaunch("comparecraft.compareWithLeft", [r], right);

    const lf = vscode.Uri.file(leftFolder), rf = vscode.Uri.file(rightFolder);
    await vscode.commands.executeCommand("comparecraft.selectLeft", lf);
    await verifyLaunch("comparecraft.compareWithLeft", [rf], rightFolder);
    await verifyLaunch("comparecraft.compareWithLeft", [r], right);
    await verifyLaunch("comparecraft.compareSelected", [lf, [lf, rf]], rightFolder);
    await vscode.commands.executeCommand("comparecraft.clearLeft");
    console.log("PASS: actual VS Code activation, 26 registered commands, Explorer multi-selection, file/folder launches, independent left selections, default desktop dispatch and clear.");

    const helper = process.env.COMPARECRAFT_TEST_BACKEND;
    if (helper) {
      await config.update("backendPath", helper, vscode.ConfigurationTarget.Global);
      const result = await vscode.commands.executeCommand<{ executable: string; version: string; protocolVersion: number } | undefined>("comparecraft.checkBackend");
      assert.ok(result, `Check Embedded Backend failed for ${helper}; see the CompareCraft output channel`);
      assert.equal(await realpath(result.executable), await realpath(helper));
      assert.equal(result.protocolVersion, 1);
      console.log(`PASS: Check Embedded Backend started ${helper} (version ${result.version}) and completed a sample comparison.`);
      await embeddedPanels(extension.exports as { embedded: EmbeddedPanels }, directory);
    } else {
      console.log("SKIP: Check Embedded Backend and embedded panels (set COMPARECRAFT_BACKEND to a helper executable).");
    }
  } finally {
    await config.update("backendPath", undefined, vscode.ConfigurationTarget.Global);
    await config.update("desktopPath", undefined, vscode.ConfigurationTarget.Global);
    await config.update("defaultMode", undefined, vscode.ConfigurationTarget.Global);
  }
}

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, timeout = 20000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function readText(file: string): Promise<string> {
  return until(`a readable ${path.basename(file)}`, () => readFile(file, "utf8").then(text => ({ text }), (error: NodeJS.ErrnoException) => {
    if (error.code === "EBUSY" || error.code === "EPERM") return undefined;
    throw error;
  }), 10000).then(result => result.text);
}

/** Binary, picture and table pairs open their read-only views; a patch file opens the patch view. */
async function fileViews(panels: EmbeddedPanels, directory: string): Promise<void> {
  const write = async (name: string, data: string | Buffer) => {
    const file = path.join(directory, name);
    await writeFile(file, data);
    return file;
  };
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const pairs = {
    hex: [await write("one.bin", Buffer.from([0, 1, 2, 3, 0, 255])), await write("two.bin", Buffer.from([0, 1, 9, 3, 0]))],
    picture: [await write("one.png", Buffer.from(pixel, "base64")), await write("two.png", Buffer.from(pixel, "base64"))],
    table: [await write("one.csv", "id,name\n1,a\n2,b\n"), await write("two.csv", "id,name\n1,a\n2,c\n")],
  } as const;
  const expected = { hex: "hex_align", picture: "pix_compare", table: "compare_tables" } as const;
  const opened = (before: Set<unknown>) => until("a new panel", () => panels.all.find(item => !before.has(item)));
  if (!(await panels.supportsView("hex"))) {
    const before = new Set(panels.all);
    await vscode.commands.executeCommand("comparecraft.compareSelectedEmbedded", vscode.Uri.file(pairs.hex[0]), pairs.hex.map(file => vscode.Uri.file(file)));
    const panel = await opened(before);
    assert.equal(panel.state.spec.kind ?? "text", "text", "older helpers keep the text comparison");
    panel.panel.dispose();
    console.log("SKIP: the configured helper has no T012 view methods; verified the text fallback. Point COMPARECRAFT_BACKEND at a newer helper to test the views.");
    return;
  }
  for (const kind of ["hex", "picture", "table"] as const) {
    const before = new Set(panels.all);
    await vscode.commands.executeCommand("comparecraft.compareSelectedEmbedded", vscode.Uri.file(pairs[kind][0]), pairs[kind].map(file => vscode.Uri.file(file)));
    const panel = await opened(before);
    assert.equal(panel.state.spec.kind, kind);
    await until(`the ${kind} view to compare through the helper`, () => panel.received.includes(expected[kind]), 20000)
      .catch(error => { console.log(JSON.stringify({ kind, received: panel.received })); throw error; });
    assert.ok(panel.panel.title.startsWith(`${kind[0]!.toUpperCase()}${kind.slice(1)}: `), panel.panel.title);
    panel.panel.dispose();
  }
  const panel = panels.open({ kind: "patch", paths: [await write("fix.patch", "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n")], titles: [], readOnly: [true], options: {} });
  await until("the patch view to load its file", () => panel.received.includes("load_text"));
  assert.equal(panel.panel.title, "Patch: fix.patch");
  const view = (cmd: string, args: Record<string, unknown>) => panel.handle("invoke", { cmd, args });
  assert.deepEqual([...Buffer.from(await view("read_bytes", { path: pairs.hex[0], offset: 4, len: 10 }) as string, "base64")], [0, 255]);
  assert.match((await view("read_data_url", { path: pairs.picture[0] }) as { url: string }).url, /^data:image\/png;base64,/);
  await assert.rejects(view("read_bytes", { path: pairs.hex[0], offset: -1, len: 1 }), /Invalid offset/);
  await assert.rejects(view("hex_align", { left: "relative.bin", right: pairs.hex[1] }), /must be absolute/);
  await panel.handle("openTab", { kind: "edit", paths: [pairs.table[0]] });
  await until("Text Edit to open VS Code's editor", () => vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase() === pairs.table[0].toLowerCase() || undefined);
  panel.panel.dispose();
  console.log("PASS: binary, picture and table pairs open read-only hex/picture/table views through the helper; patch files, byte reads, data URLs and Text Edit (VS Code editor) work.");
}

async function embeddedPanels(api: { embedded: EmbeddedPanels }, tempDirectory: string): Promise<void> {
  assert.ok(api?.embedded, "Test-mode activation exposes embedded panels");
  const directory = await realpath(tempDirectory);
  const panels = api.embedded;
  const a = path.join(directory, "embedded a.txt"), b = path.join(directory, "embedded b.txt");
  await writeFile(a, "one\ntwo\n");
  await writeFile(b, "one\nTWO\n");

  // A real webview loads the bundle under the CSP, loads both sides, and diffs through the helper.
  await vscode.commands.executeCommand("comparecraft.compareSelectedEmbedded", vscode.Uri.file(a), [vscode.Uri.file(a), vscode.Uri.file(b)]);
  const panel = await until("an embedded panel", () => panels.all[0]);
  await until("the webview to load both sides and diff them", () =>
    panel.received.filter(item => item === "load_text").length >= 2 && panel.received.includes("diff_texts"));
  assert.deepEqual(panel.received.slice(0, 1), ["init"]);
  const realB = await realpath(b);
  await until("webview state", () => panel.state.spec.paths.length === 2 && pathKey(panel.state.spec.paths[1]!) === pathKey(realB))
    .catch(error => { console.log(JSON.stringify({ b: realB, state: panel.state, received: panel.received })); throw error; });
  assert.equal(panel.panel.title, "embedded a.txt ↔ embedded b.txt");

  // Concurrent panels are independent.
  await vscode.commands.executeCommand("comparecraft.compareSelectedEmbedded", vscode.Uri.file(b), [vscode.Uri.file(b), vscode.Uri.file(a)]);
  const second = await until("a second panel", () => panels.count === 2 && panels.all.find(item => item !== panel));
  await until("the second webview to load", () => second.received.includes("diff_texts"));
  console.log("PASS: two concurrent embedded panels loaded the webview bundle, both files, and helper diffs.");

  // Guarded writes through VS Code documents. `c` is not shown by the view, so it never reloads it.
  const c = path.join(directory, "embedded c.txt");
  await writeFile(c, "alpha\r\nbeta\r\n");
  const invoke = (cmd: string, args: Record<string, unknown>) => panel.handle("invoke", { cmd, args });
  const textSession = { id: "text-session", name: "Saved text comparison", kind: "text", paths: [a, b],
    options: {}, modified: Date.now(), saved: true };
  await invoke("save_session", { session: textSession });
  assert.deepEqual(await invoke("find_session", { name: textSession.name.toUpperCase() }), textSession);
  assert.ok((await invoke("list_sessions", {}) as typeof textSession[]).some(session => session.id === textSession.id));
  assert.equal(panels.folderSessions().some(session => session.id === textSession.id), false);
  await invoke("delete_session", { id: textSession.id });
  assert.equal(await invoke("find_session", { name: textSession.name }), null);
  console.log("PASS: existing embedded text sessions save, find, list and delete independently of folder sessions.");
  const loaded = await invoke("load_text", { path: c }) as { lines: string[]; eol: string; finalNewline: boolean };
  assert.deepEqual([loaded.lines, loaded.eol, loaded.finalNewline], [["alpha", "beta"], "CRLF", true]);
  await invoke("save_text", { path: c, lines: ["alpha", "BETA"], finalNewline: true });
  assert.equal(await readText(c), "alpha\r\nBETA\r\n");
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(c));
  assert.equal(document.isDirty, false);

  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, new vscode.Position(0, 0), "edited ");
  assert.ok(await vscode.workspace.applyEdit(edit));
  await assert.rejects(invoke("save_text", { path: c, lines: ["stale"], finalNewline: true }), /changed in VS Code or on disk/);
  assert.equal(document.getText(), "edited alpha\r\nBETA\r\n");
  assert.equal(await readText(c), "alpha\r\nBETA\r\n");

  const reloaded = await invoke("load_text", { path: c }) as { lines: string[] };
  assert.deepEqual(reloaded.lines, ["edited alpha", "BETA"], "the unsaved VS Code buffer is the comparison source");
  await invoke("save_text", { path: c, lines: ["edited alpha", "BETA", "gamma"], finalNewline: true });
  assert.equal(await readText(c), "edited alpha\r\nBETA\r\ngamma\r\n");
  assert.equal(document.isDirty, false);

  await until("the external write to succeed", () => writeFile(c, "changed on disk\r\n").then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "EBUSY" || error.code === "EPERM") return false;
    throw error;
  }), 10000);
  await until("VS Code to reload the externally changed file", () => document.getText() === "changed on disk\r\n", 10000);
  await assert.rejects(invoke("save_text", { path: c, lines: ["stale"], finalNewline: true }), /changed in VS Code or on disk/);
  assert.equal(await readText(c), "changed on disk\r\n");

  const created = path.join(directory, "embedded new.txt");
  await invoke("save_text", { path: created, lines: ["new"], finalNewline: true });
  assert.equal(await readText(created), "new\n");
  await assert.rejects(invoke("compare_folders", {}), /Invalid left folder/);
  await assert.rejects(panel.handle("openUrl", { url: "file:///etc/passwd" }), /Refusing/);
  console.log("PASS: embedded saves go through VS Code documents, keep CRLF, use unsaved buffers, and reject stale writes after editor or disk changes.");

  // A merge panel shows three read-only sides, writes only its result file, and never replaces unsaved
  // edits made to that file in another editor (the merge view does not show that buffer).
  const result = path.join(directory, "merge result.txt");
  await writeFile(result, "<<<<<<< ours\r\nx\r\n=======\r\ny\r\n>>>>>>> theirs\r\n");
  const merge = panels.open({ kind: "merge", paths: ["", "", "", result], titles: ["Current", "Incoming", "Base", "Result"], readOnly: [true, true, true, false], options: { content: [["x"], ["y"], ["base"]] } });
  assert.equal(merge.panel.options.retainContextWhenHidden, true, "hidden panels keep merge choices and baselines");
  await until("the merge webview to load its result and merge through the helper", () => merge.received.includes("merge_texts") && merge.received.includes("load_text"));
  assert.equal(merge.panel.title, "Merge: merge result.txt");
  const mergeInvoke = (cmd: string, args: Record<string, unknown>) => merge.handle("invoke", { cmd, args });
  await assert.rejects(mergeInvoke("save_text", { path: c, lines: ["no"], finalNewline: true }), /only write its result file/);
  const resultDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(result));
  const elsewhere = new vscode.WorkspaceEdit();
  elsewhere.insert(resultDocument.uri, new vscode.Position(0, 0), "typed ");
  assert.ok(await vscode.workspace.applyEdit(elsewhere));
  await assert.rejects(mergeInvoke("save_text", { path: result, lines: ["x"], finalNewline: true }), /unsaved changes in another VS Code editor/);
  // Even if the view re-reads the dirty buffer (Refresh), the merge must not replace it.
  await mergeInvoke("load_text", { path: result });
  await assert.rejects(mergeInvoke("save_text", { path: result, lines: ["x"], finalNewline: true }), /unsaved changes in another VS Code editor/);
  assert.ok(resultDocument.getText().startsWith("typed "));
  await vscode.commands.executeCommand("workbench.action.files.revert", resultDocument.uri).then(undefined, () => undefined);
  if (resultDocument.isDirty) {
    const undo = new vscode.WorkspaceEdit();
    undo.delete(resultDocument.uri, new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 6)));
    assert.ok(await vscode.workspace.applyEdit(undo));
    assert.ok(await resultDocument.save());
  }
  await mergeInvoke("load_text", { path: result });
  await mergeInvoke("save_text", { path: result, lines: ["x", "y"], finalNewline: true });
  assert.equal(await readText(result), "x\r\ny\r\n");
  merge.panel.dispose();
  console.log("PASS: embedded merge writes only its result, keeps CRLF, and refuses to replace unsaved edits from another editor.");

  await fileViews(panels, directory);
  await folderViews(panels, directory);
  await folderUi(panels, directory);

  // Backend failures are reported to the view, not swallowed.
  const config = vscode.workspace.getConfiguration("comparecraft");
  const helper = config.get<string>("backendPath");
  await config.update("backendPath", path.join(directory, "missing-backend.exe"), vscode.ConfigurationTarget.Global);
  await assert.rejects(invoke("diff_texts", { left: ["a"], right: ["b"], rules: {} }));
  await config.update("backendPath", helper, vscode.ConfigurationTarget.Global);
  const diff = await invoke("diff_texts", { left: ["a"], right: ["b"], rules: {} }) as { identical: boolean };
  assert.equal(diff.identical, false);
  console.log("PASS: a missing backend fails the request visibly and the configured helper recovers.");

  panels.dispose();
  await until("panels to close", () => panels.count === 0);
  console.log("PASS: embedded panels closed on dispose.");
}

async function folderViews(panels: EmbeddedPanels, directory: string): Promise<void> {
  const left = path.join(directory, "embedded-folder-left"), right = path.join(directory, "embedded-folder-right");
  await mkdir(left);
  await mkdir(right);
  const a = path.join(left, "item.txt"), b = path.join(right, "item.txt");
  await writeFile(a, "same\n");
  await writeFile(b, "same\n");
  await writeFile(path.join(left, "excluded.bin"), Buffer.from([0, 1]));
  const before = new Set(panels.all);
  await vscode.commands.executeCommand("comparecraft.compareSelectedEmbedded", vscode.Uri.file(left), [vscode.Uri.file(left), vscode.Uri.file(right)]);
  const parent = await until("an embedded folder panel", () => panels.all.find(panel => !before.has(panel)));
  assert.equal(parent.state.spec.kind, "folder");
  await until("folder webview to scan through the real helper", () => parent.received.includes("compare_folders"), 30000);
  assert.match(parent.panel.title, /^Folder:/);
  const invoke = (cmd: string, args: Record<string, unknown>) => parent.handle("invoke", { cmd, args });
  const options = { criteria: "size", timeToleranceSecs: 2, include: "*.txt", exclude: "", ignoreCaseNames: true, followSymlinks: false };
  const scan = await invoke("compare_folders", { left, right, options }) as { summary: { files: number; same: number } };
  assert.equal(scan.summary.files, 1);
  assert.equal(scan.summary.same, 1);
  assert.equal(await invoke("quick_compare", { left: a, right: b, mode: "binary" }), 1);
  const nestedLeft = path.join(left, "nested"), nestedRight = path.join(right, "nested");
  await mkdir(nestedLeft);
  await mkdir(nestedRight);
  await writeFile(path.join(nestedLeft, "item.txt"), "nested\n");
  await writeFile(path.join(nestedRight, "item.txt"), "nested\n");
  let existing = new Set(panels.all);
  await parent.handle("openTab", { kind: "folder", paths: [nestedLeft, nestedRight], options: {} });
  const nested = await until("nested folder panel", () => panels.all.find(panel => !existing.has(panel)));
  await until("nested folder scan", () => nested.received.includes("compare_folders"));
  assert.deepEqual(nested.state.spec.paths, [nestedLeft, nestedRight]);
  nested.panel.dispose();
  existing = new Set(panels.all);
  await parent.handle("openTab", { kind: "folder", paths: [nestedLeft, ""], options: {} });
  const orphan = await until("orphan folder chooser", () => panels.all.find(panel => !existing.has(panel)));
  await until("orphan panel initialization", () => orphan.received.includes("init"));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(orphan.received.includes("compare_folders"), false, "an empty side is a chooser, not a scan of an empty path");
  orphan.panel.dispose();
  await assert.rejects(parent.handle("openTab", { kind: "folder", paths: [a, right], options: {} }), /Not a folder/);
  for (const command of ["execute_actions", "plan_sync", "compare_folder_merge", "make_report", "save_snapshot", "rename_item", "touch_items", "save_text"]) {
    await assert.rejects(invoke(command, {}), /not available/);
  }
  const session = { id: `test-${Date.now()}`, name: "Integration folder", kind: "folder", paths: [left, right],
    options: { comparisonPresets: { activePresetId: "builtin:all:binary", pinnedPresetIds: [] } }, modified: Date.now(), saved: true };
  await invoke("save_session", { session });
  const found = await invoke("find_session", { name: session.name.toUpperCase() }) as typeof session;
  assert.deepEqual(found.paths, session.paths);
  assert.deepEqual(found.options, session.options);
  await assert.rejects(invoke("save_session", { session: { ...session, kind: "text" } }), /Only folder/);
  await invoke("save_session", { session: { ...session, locked: true } });
  await assert.rejects(invoke("save_session", { session: { ...session, options: { changed: true } } }), /locked/);
  await assert.rejects(invoke("save_session", { session: { ...session, name: "Renamed while locked", locked: false } }), /locked/);
  await invoke("save_session", { session: { ...session, locked: false } });
  assert.equal((await invoke("find_session", { name: session.name }) as { locked?: boolean }).locked, false);
  const recent = { ...session, id: "folder-recent-one", saved: false };
  await invoke("save_session", { session: recent });
  await invoke("save_session", { session: { ...recent, id: "folder-recent-two" } });
  const listed = await invoke("list_sessions", {}) as typeof session[];
  assert.equal(listed.filter(item => !item.saved && item.paths[0] === left && item.paths[1] === right).length, 1);
  assert.ok(listed.some(item => item.saved && item.id === session.id));
  const storage = panels.context.globalState;
  const update = storage.update.bind(storage);
  storage.update = () => Promise.reject(new Error("simulated persistence failure"));
  try {
    await assert.rejects(invoke("save_session", { session }), /simulated persistence failure/);
  } finally {
    storage.update = update;
  }
  const messages: { event: string; payload: unknown }[] = [];
  const notify = parent.notify.bind(parent);
  parent.notify = (event, payload) => { messages.push({ event, payload }); notify(event, payload); };
  const opened = new Set(panels.all);
  const origin = await parent.handle("openTab", { kind: "text", paths: [a, b], titles: [], readOnly: [], options: {}, origin: true }) as { originToken: string };
  assert.ok(origin.originToken);
  const child = await until("originating text child", () => panels.all.find(panel => !opened.has(panel)));
  await until("saved-disk result delivered to parent", () => messages.find(message => message.event === "folder-comparison"), 30000);
  const first = messages.find(message => message.event === "folder-comparison")!.payload as { token: string; receipt: { result: { status: string; content?: string } } };
  assert.equal(first.token, origin.originToken);
  assert.equal(first.receipt.result.status, "same");
  assert.equal(first.receipt.result.content, "same");
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(a));
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, new vscode.Position(0, 0), "unsaved ");
  assert.ok(await vscode.workspace.applyEdit(edit));
  messages.length = 0;
  await child.handle("invoke", { cmd: "load_text", args: { path: a } });
  await until("disk result after unsaved reload", () => messages.find(message => message.event === "folder-comparison"), 30000);
  const unsaved = messages.find(message => message.event === "folder-comparison")!.payload as typeof first;
  assert.equal(unsaved.receipt.result.status, "same", "unsaved text is not a disk verdict");
  messages.length = 0;
  assert.ok(await document.save());
  await until("saved changed verdict", () => messages.find(message => message.event === "folder-comparison" &&
    (message.payload as typeof first).receipt.result.content === "different"), 30000);
  await assert.rejects(parent.handle("openTab", { kind: "text", paths: [a, path.join(directory, "elsewhere.txt")], options: {}, origin: true }), /does not belong/);
  await invoke("delete_session", { id: session.id });
  parent.panel.dispose();
  await child.handle("invoke", { cmd: "load_text", args: { path: a } });
  child.panel.dispose();
  console.log("PASS: embedded folder tree/filter/preset transport, read-only host gates, sessions and disk-only child results; child survives parent closure.");
}

function folderProbe(panel: EmbeddedPanel) {
  const replies = new Map<number, { gutter: string; notice: boolean; summary: string; theme: string; body: string }>();
  let id = 0;
  const listener = panel.panel.webview.onDidReceiveMessage(message => {
    if (message?.type === "folder-test-result") replies.set(message.id, message.value);
  });
  const html = panel.panel.webview.html;
  const nonce = /script[^>]+nonce="([^"]+)"/.exec(html)?.[1];
  assert.ok(nonce, "The real webview has a CSP nonce");
  // Test-only instrumentation of this isolated panel; no production eval/message hook.
  const script = `<script nonce="${nonce}">
    const acquire = window.acquireVsCodeApi;
    let testApi;
    window.acquireVsCodeApi = () => (testApi = acquire());
    window.addEventListener("message", event => {
      const m = event.data;
      if (m?.type !== "folder-test-probe" || !testApi) return;
      const row = [...document.querySelectorAll(".frow")].find(r => r.textContent.includes("item.txt"));
      if (m.action === "open" && row) {
        row.dispatchEvent(new MouseEvent("mousedown", {bubbles:true,button:0}));
        row.dispatchEvent(new MouseEvent("click", {bubbles:true,button:0}));
        row.dispatchEvent(new MouseEvent("dblclick", {bubbles:true,button:0}));
      }
      if (m.action === "compare") document.querySelector(".preset-run-wrap button")?.click();
      if (m.action === "selectAll") window.dispatchEvent(new KeyboardEvent("keydown", {key:"a",code:"KeyA",ctrlKey:${process.platform !== "darwin"},metaKey:${process.platform === "darwin"},bubbles:true}));
      if (m.action === "refresh") {
        [...document.querySelectorAll("button")].find(b => /Refresh/i.test(b.title + " " + b.getAttribute("aria-label")))?.click();
      }
      testApi.postMessage({type:"folder-test-result",id:m.id,value:{
        gutter:row?.querySelector(".fstatus")?.textContent?.trim() ?? "",
        notice:document.body.textContent.includes("Folder comparison reads saved files on disk."),
        summary:document.querySelector(".statusbar")?.textContent ?? "",
        theme:document.body.className,
        body:document.body.innerText.slice(0, 2000)
      }});
    });
  </script>`;
  const instrumented = html.replace("</head>", `${script}</head>`);
  panel.panel.webview.html = instrumented;
  return {
    async request(action = "snapshot") {
      const token = ++id;
      return until(`folder UI probe ${action}`, async () => {
        if (replies.has(token)) return replies.get(token);
        await panel.panel.webview.postMessage({ type: "folder-test-probe", id: token, action });
        return replies.get(token);
      }, 30000);
    },
    reload() { panel.panel.webview.html = instrumented.replace("</body>", `<!-- test reload ${Date.now()} --></body>`); },
    dispose() { listener.dispose(); }
  };
}

async function folderUi(panels: EmbeddedPanels, directory: string): Promise<void> {
  const left = path.join(directory, "ui-folder-left"), right = path.join(directory, "ui-folder-right");
  await mkdir(left);
  await mkdir(right);
  const a = path.join(left, "item.txt"), b = path.join(right, "item.txt");
  await writeFile(a, "same\n");
  await writeFile(b, "same\n");
  const parent = panels.open({ kind: "folder", paths: [left, right], titles: [], readOnly: [true, true], options: {} });
  await until("folder panel HTML", () => parent.panel.webview.html.includes('nonce="'));
  const probe = folderProbe(parent);
  const workbench = vscode.workspace.getConfiguration("workbench");
  const theme = workbench.inspect<string>("colorTheme")?.globalValue;
  try {
    try {
      await until("real folder UI row", async () => (await probe.request()).gutter === "=");
    } catch (error) {
      throw new Error(`${String(error)}\nFolder webview: ${(await probe.request()).body}`);
    }
    assert.equal((await probe.request()).notice, true);
    await probe.request("selectAll");
    await until("keyboard selection in the folder UI", async () => /selected/i.test((await probe.request()).summary));
    await workbench.update("colorTheme", "Default Light Modern", vscode.ConfigurationTarget.Global);
    await until("VS Code light theme", async () => (await probe.request()).theme.includes("vscode-light"));
    await workbench.update("colorTheme", "Default High Contrast", vscode.ConfigurationTarget.Global);
    await until("VS Code high contrast theme", async () => (await probe.request()).theme.includes("vscode-high-contrast"));
    await workbench.update("colorTheme", theme, vscode.ConfigurationTarget.Global);
    await probe.request("compare");
    await until("preset to call the real helper", () => parent.received.includes("quick_compare"));
    const before = new Set(panels.all);
    await probe.request("open");
    const child = await until("file child opened by actual row interaction", () => panels.all.find(panel => !before.has(panel)));
    await until("child UI disk comparison", () => child.received.includes("diff_texts"));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(b));
    const replace = async (text: string) => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
      assert.ok(await vscode.workspace.applyEdit(edit));
    };
    await replace("different\n");
    await child.handle("invoke", { cmd: "load_text", args: { path: b } });
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal((await probe.request()).gutter, "=", "unsaved child text does not change the disk gutter");
    assert.ok(await document.save());
    await until("actual gutter to receive saved difference", async () => (await probe.request()).gutter === "≠");
    await replace("same\n");
    assert.ok(await document.save());
    await until("same origin to deliver another saved result", async () => (await probe.request()).gutter === "=");
    const epoch = parent.folderEpoch;
    await probe.request("refresh");
    await until("actual refresh to invalidate origins", () => parent.folderEpoch > epoch);
    const reloadEpoch = parent.folderEpoch;
    probe.reload();
    await until("folder panel reload to rescan", () => parent.folderEpoch > reloadEpoch);
    await until("reloaded metadata tree", async () => ["=", "≠"].includes((await probe.request()).gutter));
    assert.deepEqual(parent.state.spec.paths, [left, right]);
    const session = { id: `ui-${Date.now()}`, name: "UI saved folder", kind: "folder", paths: [left, right],
      options: parent.state.spec.options, modified: Date.now(), saved: true };
    await parent.handle("invoke", { cmd: "save_session", args: { session } });
    const existing = new Set(panels.all);
    const picking = vscode.commands.executeCommand("comparecraft.openSavedFolderSession");
    await new Promise(resolve => setTimeout(resolve, 500));
    await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
    const restored = await until("saved folder Quick Pick to open a panel", () => panels.all.find(panel => !existing.has(panel)));
    await picking;
    assert.equal(restored.state.spec.sessionId, session.id);
    assert.equal(restored.state.spec.sessionName, session.name);
    await until("saved session to recompute tree", () => restored.received.includes("compare_folders"));
    await until("restored session to record a distinct recent", () => panels.folderSessions().some(item =>
      !item.saved && item.id === `recent:${session.id}`));
    assert.ok(panels.folderSessions().some(item => item.saved && item.id === session.id),
      "automatic restoration must not replace the named folder session");
    await parent.handle("invoke", { cmd: "delete_session", args: { id: session.id } });
    restored.panel.dispose();
    child.panel.dispose();
    console.log("PASS: actual folder UI presets, row drill-down, repeated saved-disk gutter callbacks, unsaved isolation, refresh invalidation, panel reload and saved-session Quick Pick.");
  } finally {
    await workbench.update("colorTheme", theme, vscode.ConfigurationTarget.Global);
    probe.dispose();
    parent.panel.dispose();
  }
}
