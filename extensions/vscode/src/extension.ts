import * as vscode from "vscode";
import { realpath, stat } from "node:fs/promises";
import { ComparisonController, type ComparisonHost } from "./controller";
import { discoverDesktop, InstallationError } from "./discovery";
import { launchDesktop } from "./process";
import { assertSavedResources } from "./resources";
import type { LaunchMode } from "./contracts";

const DOWNLOAD = vscode.Uri.parse("https://github.com/Antebios/comparecraft/releases");

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("CompareCraft");
  context.subscriptions.push(output);

  function assertSupported(): void {
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before launching CompareCraft.");
    if (vscode.env.uiKind === vscode.UIKind.Web || vscode.env.remoteName) {
      throw new Error("CompareCraft Phase 1 supports local desktop workspaces only. Remote SSH, WSL, Dev Containers, and browser-only VS Code are not supported yet.");
    }
    if (vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme !== "file")) {
      throw new Error("CompareCraft requires a local filesystem workspace.");
    }
  }

  async function locateDesktop(): Promise<void> {
    assertSupported();
    const selected = await vscode.window.showOpenDialog({
      title: "Locate CompareCraft desktop executable",
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      ...(process.platform === "win32" ? { filters: { Executables: ["exe"] } } : {})
    });
    const uri = selected?.[0];
    if (!uri) return;
    if (uri.scheme !== "file") throw new Error("Choose a locally installed executable.");
    await discoverDesktop({ override: uri.fsPath });
    await vscode.workspace.getConfiguration("comparecraft").update("desktopPath", uri.fsPath, vscode.ConfigurationTarget.Global);
    await vscode.window.showInformationMessage("CompareCraft desktop executable saved. Retry your comparison.");
  }

  async function report(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    if (error instanceof InstallationError) {
      const action = await vscode.window.showErrorMessage(message, "Locate Executable", "Download CompareCraft");
      if (action === "Locate Executable") {
        try { await locateDesktop(); } catch (failure) { await report(failure); }
      } else if (action === "Download CompareCraft") {
        if (!(await vscode.env.openExternal(DOWNLOAD))) {
          output.appendLine(`Could not open ${DOWNLOAD.toString()}`);
          await vscode.window.showErrorMessage(`Could not open ${DOWNLOAD.toString()}. Open the release page in your browser.`);
        }
      }
    } else {
      await vscode.window.showErrorMessage(`CompareCraft: ${message}`);
    }
  }

  const host: ComparisonHost = {
    assertSupported,
    async resource(value) {
      const resolved = await realpath(value);
      const info = await stat(resolved);
      if (!info.isDirectory() && !info.isFile()) throw new Error(`Not a regular file or folder: ${value}`);
      return { path: resolved, kind: info.isDirectory() ? "folder" : "file" };
    },
    async pick(kind, title) {
      const picked = await vscode.window.showOpenDialog({
        title, canSelectFiles: kind === "file", canSelectFolders: kind === "folder", canSelectMany: false
      });
      const uri = picked?.[0];
      if (uri && uri.scheme !== "file") throw new Error("Select a local file or folder.");
      return uri?.fsPath;
    },
    defaultMode() {
      const mode = vscode.workspace.getConfiguration("comparecraft").get<string>("defaultMode", "embedded");
      if (mode !== "embedded" && mode !== "desktop") throw new Error("Invalid comparecraft.defaultMode. Choose embedded or desktop.");
      return mode;
    },
    async confirmDesktop() {
      return await vscode.window.showInformationMessage(
        "Embedded CompareCraft is not available in Phase 1. Open this comparison in the installed desktop app instead?",
        { modal: true }, "Open in Desktop App"
      ) === "Open in Desktop App";
    },
    async assertSaved(resources) {
      await assertSavedResources(resources, vscode.workspace.textDocuments
        .filter(document => document.isDirty && document.uri.scheme === "file")
        .map(document => document.uri.fsPath));
    },
    async launch(args) {
      assertSupported();
      const configured = vscode.workspace.getConfiguration("comparecraft").inspect<string>("desktopPath");
      // Never honor a workspace-supplied executable, even if injected programmatically.
      const executable = await discoverDesktop({ override: configured?.globalValue ?? configured?.defaultValue ?? "" });
      output.appendLine(`Launching ${executable} (${args.length === 0 ? "home" : "comparison"})`);
      await launchDesktop(executable, args, error => { void report(error); });
    },
    async setHasLeft(value) { await vscode.commands.executeCommand("setContext", "comparecraft.hasLeft", value); },
    notify(message) { vscode.window.setStatusBarMessage(message, 5000); }
  };
  const controller = new ComparisonController(host);

  function paths(first: unknown, selected: unknown): string[] {
    let uris: vscode.Uri[];
    if (first instanceof vscode.Uri) {
      uris = Array.isArray(selected) && selected.length > 0 && selected.every(item => item instanceof vscode.Uri) &&
        selected.some(item => item.toString() === first.toString()) ? selected : [first];
    } else if (first !== undefined) {
      throw new Error("This command requires local file/folder resources, not a diff, selection, or virtual document.");
    } else {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (input && !(input instanceof vscode.TabInputText)) {
        throw new Error("Choose a saved text tab or an Explorer resource. Existing diff and custom editor forwarding is not supported in Phase 1.");
      }
      const uri = input instanceof vscode.TabInputText ? input.uri : vscode.window.activeTextEditor?.document.uri;
      uris = uri ? [uri] : [];
    }
    if (uris.some(uri => uri.scheme !== "file")) throw new Error("Phase 1 supports local saved files and folders only. Virtual documents and untitled buffers are not supported yet.");
    return uris.map(uri => uri.fsPath);
  }

  function register(id: string, callback: (first: unknown, selected: unknown) => Promise<void>): void {
    context.subscriptions.push(vscode.commands.registerCommand(`comparecraft.${id}`, async (first: unknown, selected: unknown) => {
      try { await callback(first, selected); } catch (error) { await report(error); }
    }));
  }
  for (const [id, mode] of [
    ["compareSelected", undefined], ["compareSelectedDesktop", "desktop"], ["compareSelectedEmbedded", "embedded"]
  ] as const satisfies readonly (readonly [string, LaunchMode | undefined])[]) {
    register(id, async (first, selected) => controller.compare(paths(first, selected), mode));
  }
  register("selectLeft", async (first, selected) => controller.selectLeft(paths(first, selected)));
  register("compareWithLeft", async (first, selected) => controller.compareWithLeft(paths(first, selected)));
  register("clearLeft", async () => controller.clearLeft());
  register("compareFileWith", async (first, selected) => controller.compareWithPicker(paths(first, selected), "file"));
  register("compareFolderWith", async (first, selected) => controller.compareWithPicker(paths(first, selected), "folder"));
  register("compareParentFolderWith", async (first, selected) => controller.compareParent(paths(first, selected)));
  register("openDesktop", async () => controller.openDesktop());
  register("locateDesktop", async () => locateDesktop());
}
