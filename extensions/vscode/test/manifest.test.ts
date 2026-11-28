import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const manifest = JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf8"));
const { resolveVSCodeExecutable } =
  require("../../scripts/vscode-executable.cjs") as {
    resolveVSCodeExecutable: (executable: string, platform?: string) => string;
  };
const childProcess: typeof import("node:child_process") = require("node:child_process");

test("VS Code executable resolution preserves existing paths and non-macOS platforms", () => {
  assert.equal(
    resolveVSCodeExecutable(process.execPath, "darwin"),
    process.execPath,
  );
  assert.equal(
    resolveVSCodeExecutable("/missing/code", "linux"),
    "/missing/code",
  );
  assert.equal(
    resolveVSCodeExecutable("C:\\missing\\Code.exe", "win32"),
    "C:\\missing\\Code.exe",
  );
});

test("VS Code executable resolution reads a renamed macOS binary from the bundle manifest", (context) => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "comparecraft-vscode-bundle-"),
  );
  try {
    const contents = path.join(directory, "Visual Studio Code.app", "Contents");
    const executable = path.join(contents, "MacOS", "Electron");
    const resolved = path.join(contents, "MacOS", "Code");
    mkdirSync(path.dirname(resolved), { recursive: true });
    writeFileSync(resolved, "");
    context.mock.method(
      childProcess,
      "execFileSync",
      (command: string, args: string[]) => {
        assert.equal(command, "/usr/bin/plutil");
        assert.deepEqual(args, [
          "-extract",
          "CFBundleExecutable",
          "raw",
          "-o",
          "-",
          path.join(contents, "Info.plist"),
        ]);
        return "Code\n";
      },
    );
    assert.equal(resolveVSCodeExecutable(executable, "darwin"), resolved);
    rmSync(resolved);
    assert.throws(
      () => resolveVSCodeExecutable(executable, "darwin"),
      /bundle executable not found/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manifest runs beside the workspace, has a browser entry, and supports untrusted and virtual workspaces in limited form", () => {
  for (const script of ["build", "test", "build:engine", "build:web", "test:web", "package:targets"]) assert.ok(manifest.scripts[script], script);
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.equal(manifest.main, "./out/src/extension.js");
  assert.equal(manifest.browser, "./out/web/extension.js");
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, "limited");
  assert.deepEqual(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations, ["comparecraft.desktopPath", "comparecraft.backendPath"]);
  assert.equal(manifest.capabilities.virtualWorkspaces.supported, "limited");
  // Context keys that show the menus for the current host and trust state are set at startup.
  assert.ok(manifest.activationEvents.includes("onStartupFinished"));
});

test("all context menu commands exist and executable settings cannot be workspace settings", () => {
  const commands = new Set(manifest.contributes.commands.map((command: { command: string }) => command.command));
  assert.equal(commands.size, 27);
  assert.ok(commands.has("comparecraft.openSavedFolderSession"));
  const menus: Record<string, { command?: string; submenu?: string; when?: string }[]> = manifest.contributes.menus;
  for (const entries of Object.values(menus)) {
    for (const entry of entries) if (entry.command) assert.ok(commands.has(entry.command), entry.command);
  }
  for (const id of ["explorer/context", "editor/context", "editor/title/context"]) {
    assert.ok(menus[id]?.some(entry => entry.submenu === "comparecraft.comparisons" && entry.when?.includes("resourceScheme in comparecraft.schemes")));
  }
  const git = menus["comparecraft.comparisons"]?.find(entry => entry.submenu === "comparecraft.git");
  assert.match(git?.when ?? "", /comparecraft\.git && resourceScheme in comparecraft\.localSchemes/);
  for (const entry of [...menus["scm/resourceState/context"] ?? [], ...menus["comparecraft.scm"] ?? []]) assert.match(entry.when ?? "", /scmProvider == git.*comparecraft\.git/);
  // Desktop launches are hidden where the policy denies them (remote, browser, Restricted Mode).
  for (const id of ["comparecraft.compareSelectedDesktop", "comparecraft.openDesktop", "comparecraft.locateDesktop", "comparecraft.compareActiveDiff", "comparecraft.gitResolveConflict", "comparecraft.configureGitTools"]) {
    const entries = Object.values(menus).flat().filter(entry => entry.command === id);
    assert.ok(entries.length > 0 && entries.every(entry => entry.when?.includes("comparecraft.desktop")), id);
  }
  assert.deepEqual(menus["scm/resourceState/context"]?.map(entry => entry.submenu), ["comparecraft.scm"]);
  for (const id of ["comparecraft.gitResolveConflictEmbedded", "comparecraft.gitResolveConflict", "comparecraft.gitStageResolved"]) {
    assert.ok(menus["comparecraft.scm"]?.some(entry => entry.command === id && entry.when?.includes("scmResourceGroup == merge")), id);
  }
  for (const entry of menus["comparecraft.comparisons"] ?? []) {
    if (entry.command?.match(/Selected|selectLeft$|compareWithLeft|FileWith|FolderWith/)) assert.match(entry.when ?? "", /resourceScheme in comparecraft\.schemes/, entry.command);
  }
  const settings = manifest.contributes.configuration.properties;
  assert.equal(settings["comparecraft.defaultMode"].default, "embedded");
  assert.equal(settings["comparecraft.desktopPath"].scope, "machine");
  assert.equal(settings["comparecraft.backendPath"].scope, "machine");
});
