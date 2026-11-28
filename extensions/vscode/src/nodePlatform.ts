/** The Node extension host's services: desktop VS Code and remote windows (SSH, WSL, containers). */
import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LaunchTracking } from "./controller";
import type { LocalResource } from "./contracts";
import { desktopViewArguments } from "./desktopArgs";
import { discoverDesktop, locateBackend } from "./discovery";
import { errorText } from "./errors";
import { executableSetting, registerGitCommands } from "./gitCommands";
import { NodeHelper } from "./helper";
import { NodeFiles } from "./nodeFiles";
import type { DesktopApp, Platform } from "./platform";
import { launchDesktop } from "./process";
import { assertSavedResources } from "./resources";
import { SnapshotStore } from "./snapshots";
import { VirtualFolderSnapshots } from "./virtualFolders";
import { VscodeFiles } from "./vscodeFiles";

const HELPER = process.platform === "win32" ? "comparecraft-backend.exe" : "comparecraft-backend";

export function createNodePlatform(context: vscode.ExtensionContext, log: (line: string) => void): Platform {
  const files = new NodeFiles(new VscodeFiles());
  const storage = context.globalStorageUri.fsPath;
  const snapshots = new SnapshotStore(path.join(storage, "snapshots"));
  void snapshots.sweep().then(
    removed => { if (removed.length) log(`Removed ${removed.length} finished snapshot session(s).`); },
    error => log(`Snapshot cleanup skipped: ${errorText(error)}`)
  );
  const folderCopies = new VirtualFolderSnapshots(path.join(storage, "folder-copies"), files);
  void folderCopies.sweep().catch(error => log(`Folder copy cleanup skipped: ${errorText(error)}`));

  const helper = new NodeHelper(
    () => locateBackend({
      override: executableSetting("backendPath"),
      desktopOverride: executableSetting("desktopPath"),
      bundled: path.join(context.extensionPath, "bin", HELPER)
    }),
    {
      client: { name: "comparecraft-vscode", version: String(context.extension.packageJSON.version ?? "0.0.0") },
      requiredMethods: ["path.info", "text.load", "text.diff", "text.merge"],
      log
    }
  );

  const desktop: DesktopApp = {
    async launch(args: readonly string[], tracking?: LaunchTracking, onError?: (error: unknown) => void) {
      // Never honor a workspace-supplied executable, even if injected programmatically.
      const executable = await discoverDesktop({ override: executableSetting("desktopPath") });
      log(`Launching ${executable} (${args.length === 0 ? "home" : tracking ? "tracked comparison" : "comparison"})`);
      const fail = (error: unknown) => (onError ? onError(error) : log(errorText(error)));
      const closed = tracking ? () => {
        void (async () => {
          try { await tracking.session?.release(); } catch (error) {
            log(`Snapshot cleanup deferred: ${errorText(error)}`);
          }
          try { await tracking.onClosed?.(); } catch (error) { fail(error); }
        })();
      } : undefined;
      const pid = await launchDesktop(executable, args, fail, closed);
      if (pid !== undefined) await tracking?.session?.attach(pid);
    },
    createSnapshots: () => snapshots.create(),
    assertSaved: (resources: readonly LocalResource[], dirtyPaths: readonly string[]) => assertSavedResources(resources, dirtyPaths),
    async locate() {
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
    },
    viewArguments: desktopViewArguments
  };

  return {
    kind: "node",
    files,
    helper,
    desktop,
    folderCopies,
    wasmBytes: () => readFile(path.join(context.extensionPath, "media", "engine", "comparecraft-engine.wasm")).catch(error => {
      throw new Error(`The CompareCraft WebAssembly engine is missing from this extension (${errorText(error)}). Run npm run build:engine in extensions/vscode.`);
    }),
    registerGit: registerGitCommands
  };
}
