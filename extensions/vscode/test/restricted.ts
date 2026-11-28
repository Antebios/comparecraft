// Restricted Mode (untrusted workspace) checks, run by scripts/test-integration.cjs in a VS Code window
// that opens its folder without trust.
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestApi } from "../src/activate";

export async function run(): Promise<void> {
  const record = (value: string) => (process.env.COMPARECRAFT_TEST_RESULT ? writeFile(process.env.COMPARECRAFT_TEST_RESULT, value) : Promise.resolve());
  try {
    await runChecks();
  } catch (error) {
    await record("fail");
    throw error;
  }
  await record("pass");
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

async function runChecks(): Promise<void> {
  const directory = process.env.COMPARECRAFT_TEST_DIRECTORY;
  assert.ok(directory, "The runner provides the untrusted folder");
  assert.equal(vscode.workspace.isTrusted, false, "the folder opens in Restricted Mode");
  const extension = vscode.extensions.all.find(candidate => candidate.packageJSON.name === "comparecraft");
  assert.ok(extension, "Development extension must be installed");
  await extension.activate();
  const api = extension.exports as TestApi;
  const commands = await vscode.commands.getCommands(true);
  for (const id of ["compareSelectedEmbedded", "compareWithClipboard", "gitCompareHead", "openDesktop", "checkBackend"]) {
    assert.ok(commands.includes(`comparecraft.${id}`), id);
  }

  // Read-only comparisons work; saving, Git (repository configuration can run programs) and the
  // desktop app need trust.
  for (const operation of ["save", "git", "desktop"] as const) assert.equal(api.denial(operation)?.fix, "trust", operation);
  assert.equal(api.denial("folder"), undefined);

  const helper = process.env.COMPARECRAFT_TEST_BACKEND;
  const config = vscode.workspace.getConfiguration("comparecraft");
  if (helper) await config.update("backendPath", helper, vscode.ConfigurationTarget.Global);
  try {
    const check = await vscode.commands.executeCommand<{ engine: string; environment: string } | undefined>("comparecraft.checkBackend");
    assert.ok(check, "Check Embedded Backend works in Restricted Mode");
    assert.equal(check.environment, "VS Code desktop (Restricted Mode)");
    const a = path.join(directory, "a.txt"), b = path.join(directory, "b.txt");
    await writeFile(a, "one\ntwo\n");
    await writeFile(b, "one\nthree\n");
    const before = new Set(api.embedded.all);
    await vscode.commands.executeCommand("comparecraft.compareSelectedEmbedded", vscode.Uri.file(a), [vscode.Uri.file(a), vscode.Uri.file(b)]);
    const panel = await until("the embedded comparison", () => api.embedded.all.find(item => !before.has(item)));
    await until("the comparison to load", () => panel.received.includes("diff_texts"));
    const loaded = await panel.handle("invoke", { cmd: "load_text", args: { path: a } }) as { readOnly: boolean; lines: string[] };
    assert.deepEqual(loaded.lines, ["one", "two"]);
    assert.equal(loaded.readOnly, true, "sides load read-only");
    assert.deepEqual(await panel.handle("capabilities", {}), { desktop: false, revealInOS: true, restricted: true });
    // Enforced in the extension, not only in the view: a direct write request is refused.
    await assert.rejects(panel.handle("invoke", { cmd: "save_text", args: { path: a, lines: ["changed"], finalNewline: true } }), /Restricted Mode/);
    assert.equal(await readFile(a, "utf8"), "one\ntwo\n");
    panel.panel.dispose();

    // Folder comparisons are read-only and stay available where the helper is installed.
    const left = path.join(directory, "left"), right = path.join(directory, "right");
    await mkdir(left);
    await mkdir(right);
    await writeFile(path.join(left, "x.txt"), "x");
    if (check.engine === "helper") {
      const before2 = new Set(api.embedded.all);
      await vscode.commands.executeCommand("comparecraft.compareSelectedEmbedded", vscode.Uri.file(left), [vscode.Uri.file(left), vscode.Uri.file(right)]);
      const folder = await until("the folder comparison", () => api.embedded.all.find(item => !before2.has(item)));
      assert.equal(folder.state.spec.kind, "folder");
      folder.panel.dispose();
    } else {
      assert.match(await api.embedded.folderUnsupported([left, right]) ?? "", /isn't installed here/);
    }
    console.log(`PASS: Restricted Mode compares read-only with the ${check.engine} engine, ${check.engine === "helper" ? "shows folders" : "explains folders need the helper"}, and refuses saving, Git and the desktop app.`);
  } finally {
    if (helper) await config.update("backendPath", undefined, vscode.ConfigurationTarget.Global);
  }
}
