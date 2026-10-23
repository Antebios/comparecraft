import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const manifest = JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf8"));

test("manifest declares the isolated build/test scripts and local trusted extension", () => {
  assert.ok(manifest.scripts.build);
  assert.ok(manifest.scripts.test);
  assert.deepEqual(manifest.extensionKind, ["ui"]);
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
  assert.equal(manifest.capabilities.virtualWorkspaces.supported, false);
});

test("all context menu commands exist and executable settings cannot be workspace settings", () => {
  const commands = new Set(manifest.contributes.commands.map((command: { command: string }) => command.command));
  assert.equal(commands.size, 26);
  const menus: Record<string, { command?: string; submenu?: string; when?: string }[]> = manifest.contributes.menus;
  for (const entries of Object.values(menus)) {
    for (const entry of entries) if (entry.command) assert.ok(commands.has(entry.command), entry.command);
  }
  for (const id of ["explorer/context", "editor/context", "editor/title/context"]) {
    assert.ok(menus[id]?.some(entry => entry.submenu === "comparecraft.comparisons" && entry.when?.includes("resourceScheme == file")));
  }
  assert.ok(menus["comparecraft.comparisons"]?.some(entry => entry.submenu === "comparecraft.git"));
  for (const entry of [...menus["scm/resourceState/context"] ?? [], ...menus["comparecraft.scm"] ?? []]) assert.match(entry.when ?? "", /scmProvider == git/);
  assert.deepEqual(menus["scm/resourceState/context"]?.map(entry => entry.submenu), ["comparecraft.scm"]);
  for (const id of ["comparecraft.gitResolveConflictEmbedded", "comparecraft.gitResolveConflict", "comparecraft.gitStageResolved"]) {
    assert.ok(menus["comparecraft.scm"]?.some(entry => entry.command === id && entry.when?.includes("scmResourceGroup == merge")), id);
  }
  for (const entry of menus["comparecraft.comparisons"] ?? []) {
    if (entry.command?.match(/Selected|selectLeft$|compareWithLeft|FileWith|FolderWith/)) assert.match(entry.when ?? "", /resourceScheme == file/, entry.command);
  }
  const settings = manifest.contributes.configuration.properties;
  assert.equal(settings["comparecraft.defaultMode"].default, "embedded");
  assert.equal(settings["comparecraft.desktopPath"].scope, "machine");
  assert.equal(settings["comparecraft.backendPath"].scope, "machine");
});
