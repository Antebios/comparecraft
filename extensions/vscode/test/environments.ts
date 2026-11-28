// Integration checks for virtual workspaces and hosts without the helper, run by test/host.ts inside a
// real VS Code (desktop) extension host.
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { TestApi } from "../src/activate";
import type { EmbeddedPanel } from "../src/embedded";
import { MemoryFileSystem } from "./memfs";

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, timeout = 20000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

const opened = (api: TestApi, before: Set<EmbeddedPanel>) => until("a new panel", () => api.embedded.all.find(panel => !before.has(panel)));

/** Files and folders served by file system providers: compared in VS Code, saved through the provider. */
export async function virtualWorkspace(api: TestApi): Promise<void> {
  const memory = new MemoryFileSystem("ccmem");
  const readOnly = new MemoryFileSystem("ccro");
  const registrations = [
    vscode.workspace.registerFileSystemProvider("ccmem", memory, { isCaseSensitive: true }),
    vscode.workspace.registerFileSystemProvider("ccro", readOnly, { isCaseSensitive: true, isReadonly: true })
  ];
  try {
    const a = memory.put("/repo/a.txt", "one\ntwo\n"), b = memory.put("/repo/b.txt", "one\nthree\n");
    const before = new Set(api.embedded.all);
    await vscode.commands.executeCommand("comparecraft.compareSelectedEmbedded", a, [a, b]);
    const panel = await opened(api, before);
    assert.deepEqual(panel.state.spec.paths, [a.toString(), b.toString()]);
    const invoke = (cmd: string, args: Record<string, unknown>) => panel.handle("invoke", { cmd, args });
    const loaded = await invoke("load_text", { path: a.toString() }) as { lines: string[]; readOnly: boolean };
    assert.deepEqual(loaded.lines, ["one", "two"]);
    assert.equal(loaded.readOnly, false);
    const diff = await invoke("diff_texts", { left: ["one", "two"], right: ["one", "three"], rules: {} }) as { identical: boolean };
    assert.equal(diff.identical, false);
    await invoke("save_text", { path: a.toString(), lines: ["one", "saved"], finalNewline: true });
    assert.equal(memory.text("/repo/a.txt"), "one\nsaved\n");
    // A new file is created through the provider, never overwriting an existing one.
    const created = memory.uri("/repo/new.txt").toString();
    await invoke("save_text", { path: created, lines: ["new"], finalNewline: true });
    assert.equal(memory.text("/repo/new.txt"), "new\n");
    assert.deepEqual(await panel.handle("capabilities", {}), { desktop: false, revealInOS: false, restricted: false });
    assert.deepEqual(await panel.handle("dropPaths", { uris: [b.toString()] }), [b.toString()]);
    assert.equal(api.denial("git", [a.toString()])?.reason.includes("working tree on disk"), true);
    await assert.rejects(invoke("load_text", { path: memory.uri("/repo/missing.txt").toString() }), /not found/);
    panel.panel.dispose();

    // Read-only providers show the side read-only; VS Code refuses edits.
    const ro = readOnly.put("/docs/r.txt", "fixed\n");
    const roBefore = new Set(api.embedded.all);
    await vscode.commands.executeCommand("comparecraft.compareSelectedEmbedded", ro, [ro, b]);
    const roPanel = await opened(api, roBefore);
    const roLoaded = await roPanel.handle("invoke", { cmd: "load_text", args: { path: ro.toString() } }) as { readOnly: boolean };
    assert.equal(roLoaded.readOnly, true);
    await assert.rejects(roPanel.handle("invoke", { cmd: "save_text", args: { path: ro.toString(), lines: ["changed"], finalNewline: true } }), /r\.txt is read-only/);
    assert.equal(readOnly.text("/docs/r.txt"), "fixed\n");
    roPanel.panel.dispose();

    // Binary, table and picture files open the read-only views through the WebAssembly engine.
    const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const pairs = {
      hex: [memory.put("/bin/one.bin", new Uint8Array([0, 1, 2, 3])), memory.put("/bin/two.bin", new Uint8Array([0, 1, 9, 3, 4]))],
      table: [memory.put("/csv/one.csv", "id,name\n1,a\n"), memory.put("/csv/two.csv", "id,name\n1,b\n")],
      picture: [memory.put("/img/one.png", pixel), memory.put("/img/two.png", pixel)],
    };
    const expected = { hex: "hex_align", table: "compare_tables", picture: "pix_compare" } as const;
    for (const kind of ["hex", "table", "picture"] as const) {
      const viewBefore = new Set(api.embedded.all);
      await vscode.commands.executeCommand("comparecraft.compareSelectedEmbedded", pairs[kind][0], pairs[kind]);
      const view = await opened(api, viewBefore);
      assert.equal(view.state.spec.kind, kind);
      await until(`the virtual ${kind} view to compare`, () => view.received.includes(expected[kind]));
      view.panel.dispose();
    }
    const hex = await api.engine.request<{ leftSize: number; rightSize: number }>("hex.align", { left: pairs.hex[0]!.toString(), right: pairs.hex[1]!.toString(), align: "complete" });
    assert.deepEqual([hex.leftSize, hex.rightSize], [4, 5]);

    // Folders are compared from read-only copies; results and child comparisons keep the original URIs.
    memory.put("/left/same.txt", "same\n");
    memory.put("/left/changed.txt", "left\n");
    memory.put("/left/only-left.txt", "x\n");
    memory.put("/right/same.txt", "same\n");
    memory.put("/right/changed.txt", "right\n");
    memory.put("/right/sub/only-right.txt", "y\n");
    const left = memory.uri("/left"), right = memory.uri("/right");
    const folderBefore = new Set(api.embedded.all);
    await vscode.commands.executeCommand("comparecraft.compareSelectedEmbedded", left, [left, right]);
    const folder = await opened(api, folderBefore);
    assert.equal(folder.state.spec.kind, "folder");
    const result = await folder.handle("invoke", { cmd: "compare_folders", args: { left: left.toString(), right: right.toString(), options: { criteria: "rules" } } }) as {
      root: { children?: { name: string; status: string }[] }; summary: { same: number; diff: number; leftOnly: number; rightOnly: number };
    };
    const statuses = Object.fromEntries((result.root.children ?? []).map(child => [child.name, child.status]));
    assert.equal(statuses["same.txt"], "same");
    assert.equal(statuses["changed.txt"], "diff");
    assert.equal(statuses["only-left.txt"], "left");
    assert.equal(statuses.sub, "right");
    memory.put("/right/changed.txt", "left\n");
    const items = await folder.handle("invoke", { cmd: "compare_items", args: { left: left.toString(), right: right.toString(), rels: ["changed.txt"], options: { criteria: "rules" } } }) as ({ status: string } | null)[];
    assert.equal(items[0]?.status, "same", "item refreshes copy the current provider contents");
    const child = await folder.handle("openTab", { kind: "text", paths: [memory.uri("/left/changed.txt").toString(), memory.uri("/right/changed.txt").toString()], titles: [], readOnly: [], options: {}, origin: true }) as { originToken: string };
    assert.ok(child.originToken);
    const copies = path.join(api.embedded.context.globalStorageUri.fsPath, "folder-copies");
    assert.ok((await readdir(copies)).length > 0, "the panel owns folder copies");
    folder.panel.dispose();
    await until("folder copies to be released", async () => (await readdir(copies)).every(entry => !entry.startsWith(`${process.pid}-`)) || undefined);
    for (const panel of api.embedded.all.filter(item => !folderBefore.has(item))) panel.panel.dispose();
    console.log("PASS: virtual workspaces compare and save through the provider, honor read-only providers, open hex/table/picture views via WebAssembly, and compare folders from released copies.");
  } finally {
    for (const registration of registrations) registration.dispose();
  }
}

/** Without any helper, comparisons use the WebAssembly engine and folder comparison explains what's missing. */
export async function withoutHelper(api: TestApi, directory: string, desktopPath: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("comparecraft");
  const helper = config.get<string>("backendPath");
  // The desktop executable is Node here, so no helper sits next to it.
  await config.update("backendPath", undefined, vscode.ConfigurationTarget.Global);
  await config.update("desktopPath", desktopPath, vscode.ConfigurationTarget.Global);
  try {
    const check = await vscode.commands.executeCommand<{ engine: string; version: string } | undefined>("comparecraft.checkBackend");
    assert.equal(check?.engine, "wasm");
    const a = vscode.Uri.file(path.join(directory, "wasm-a.txt")), b = vscode.Uri.file(path.join(directory, "wasm-b.txt"));
    await vscode.workspace.fs.writeFile(a, new TextEncoder().encode("alpha\nbeta\n"));
    await vscode.workspace.fs.writeFile(b, new TextEncoder().encode("alpha\ngamma\n"));
    const before = new Set(api.embedded.all);
    await vscode.commands.executeCommand("comparecraft.compareSelectedEmbedded", a, [a, b]);
    const panel = await opened(api, before);
    await until("the WebAssembly diff", () => panel.received.includes("diff_texts"));
    const diff = await panel.handle("invoke", { cmd: "diff_texts", args: { left: ["alpha", "beta"], right: ["alpha", "gamma"], rules: {} } }) as { identical: boolean };
    assert.equal(diff.identical, false);
    panel.panel.dispose();
    assert.match(await api.embedded.folderUnsupported([directory, directory]) ?? "", /isn't installed here/);
    console.log("PASS: without a helper, Check Embedded Backend reports the WebAssembly engine, text comparisons work, and folder comparison explains the missing helper.");
  } finally {
    await config.update("backendPath", helper, vscode.ConfigurationTarget.Global);
  }
}
