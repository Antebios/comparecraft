import * as vscode from "vscode";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";

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
    "gitResolveConflict", "gitStageResolved", "configureGitTools", "removeGitTools"
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
    console.log("PASS: actual VS Code activation, 24 registered commands, Explorer multi-selection, file/folder launches, independent left selections, default desktop dispatch and clear.");
  } finally {
    await config.update("desktopPath", undefined, vscode.ConfigurationTarget.Global);
    await config.update("defaultMode", undefined, vscode.ConfigurationTarget.Global);
  }
}
