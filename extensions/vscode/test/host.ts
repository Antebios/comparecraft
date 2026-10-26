import * as vscode from "vscode";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { EmbeddedPanels } from "../src/embedded";
import { pathKey } from "../src/embeddedCore";

export async function run(): Promise<void> {
  const directory = process.env.COMPARECRAFT_TEST_DIRECTORY;
  const node = process.env.COMPARECRAFT_TEST_NODE;
  assert.ok(directory && node, "Integration runner must provide an isolated directory and Node executable");
  const extension = vscode.extensions.getExtension("antebios.comparecraft");
  assert.ok(extension, "Development extension must be installed");
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const id of [
    "compareSelected", "compareSelectedDesktop", "compareSelectedEmbedded",
    "selectLeft", "compareWithLeft", "clearLeft", "compareFileWith", "compareFolderWith",
    "compareParentFolderWith", "openDesktop", "locateDesktop",
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
  await assert.rejects(invoke("compare_folders", {}), /not available in the embedded comparison/);
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
