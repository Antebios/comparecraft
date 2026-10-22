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
    "gitResolveConflict", "gitStageResolved", "configureGitTools", "removeGitTools", "checkBackend"
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
    console.log("PASS: actual VS Code activation, 25 registered commands, Explorer multi-selection, file/folder launches, independent left selections, default desktop dispatch and clear.");

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
