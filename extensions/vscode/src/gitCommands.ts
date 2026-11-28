/** Git comparisons, conflict resolution and Git tool configuration (Node extension hosts only). */
import * as vscode from "vscode";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import path from "node:path";
import { discoverDesktop } from "./discovery";
import { UnavailableError } from "./errors";
import { Git } from "./git";
import { applySettings, inspectSettings, proposedSettings, removeSettings, type ConfigScope, type ToolKinds, type ToolRecord } from "./gitTools";
import { GitWorkflows, type GitHost } from "./gitWorkflows";
import { samePath } from "./paths";
import type { GitIntegration, GitServices } from "./platform";

const TOOL_RECORDS = "comparecraft.gitToolRecords";

interface GitExtensionApi { readonly git: { readonly path: string } }
interface GitExtensionExports { getAPI(version: 1): GitExtensionApi }

/** Machine-level executable settings; a workspace never supplies an executable. */
export function executableSetting(key: "desktopPath" | "backendPath"): string {
  const configured = vscode.workspace.getConfiguration("comparecraft").inspect<string>(key);
  return configured?.globalValue ?? configured?.defaultValue ?? "";
}

export function registerGitCommands(services: GitServices): GitIntegration {
  const { context, controller, register, require, log } = services;

  let gitInstance: Git | undefined;
  async function git(): Promise<Git> {
    if (gitInstance) return gitInstance;
    let executable = "git";
    try {
      const extension = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
      const api = extension ? (extension.isActive ? extension.exports : await extension.activate()).getAPI(1) : undefined;
      if (api?.git.path) executable = api.git.path;
    } catch (error) {
      log(`Built-in Git extension unavailable, using git from PATH: ${error instanceof Error ? error.message : String(error)}`);
    }
    gitInstance = new Git(executable);
    return gitInstance;
  }

  const gitHost: GitHost = {
    assertSupported: () => require("git"),
    bufferText: file => services.bufferText(file),
    isDirty: file => services.isDirty(file),
    async confirm(message, detail, action) {
      return await vscode.window.showWarningMessage(message, { modal: true, detail }, action) === action;
    },
    async pickRevision(entries) {
      const item = await vscode.window.showQuickPick(
        entries.map(entry => ({ label: `${entry.short} ${entry.subject}`, description: `${entry.date} ${entry.author}`, entry })),
        { title: "Compare working file with revision", matchOnDescription: true }
      );
      return item?.entry;
    },
    async offerStage(message) {
      return await vscode.window.showInformationMessage(message, "Stage Resolved File") === "Stage Resolved File";
    },
    notify(message) { void vscode.window.showInformationMessage(message); },
    warn(message) { void vscode.window.showWarningMessage(message); }
  };
  let workflowsInstance: GitWorkflows | undefined;
  async function workflows(): Promise<GitWorkflows> {
    workflowsInstance ??= new GitWorkflows(await git(), (inputs, options) => controller.compareInputs(inputs, options), gitHost);
    return workflowsInstance;
  }

  /** The working-tree file of a Git command, after checking that Git may run for it. */
  function gitTarget(first: unknown): string {
    let uri: vscode.Uri | undefined;
    if (first instanceof vscode.Uri) uri = first;
    else if (first && typeof first === "object" && "resourceUri" in first && first.resourceUri instanceof vscode.Uri) uri = first.resourceUri;
    else if (first === undefined) {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      // The merge editor's tab input (with a `result` URI) is not part of the stable API typings.
      const merge = input && typeof input === "object" && "result" in input && input.result instanceof vscode.Uri ? input.result : undefined;
      uri = merge ?? (input instanceof vscode.TabInputTextDiff ? input.modified
        : vscode.window.activeTextEditor?.document.uri);
    }
    if (!uri) throw new Error("Select a file in Explorer, Source Control, or an editor.");
    if (uri.scheme === "untitled") throw new Error("Git commands need a working-tree file.");
    const file = services.pathOf(uri);
    require("git", [file]);
    return file;
  }

  async function gitToolExecutable(): Promise<string> {
    const desktop = await discoverDesktop({ override: executableSetting("desktopPath") });
    const console = path.join(path.dirname(desktop), process.platform === "win32" ? "ccomp.exe" : "ccomp");
    try {
      if ((await stat(console)).isFile()) return console;
    } catch { /* older or platform layouts without the console launcher */ }
    return desktop;
  }

  async function repositoryRoots(): Promise<string[]> {
    const g = await git();
    const folders = [
      ...(vscode.window.activeTextEditor?.document.uri.scheme === "file" ? [path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)] : []),
      ...(vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === "file").map(folder => folder.uri.fsPath)
    ];
    const roots: string[] = [];
    for (const folder of folders) {
      const root = await g.root(folder);
      if (root && !roots.some(existing => samePath(existing, root))) roots.push(root);
    }
    return roots;
  }

  function toolRecords(): ToolRecord[] {
    return context.globalState.get<ToolRecord[]>(TOOL_RECORDS, []);
  }

  async function configureGitTools(): Promise<void> {
    require("git");
    // Git tools start the desktop app, so it must run on this computer.
    require("desktop");
    if (!services.desktop) throw new UnavailableError("The CompareCraft desktop app isn't available here.");
    const g = await git();
    const scopeItem = await vscode.window.showQuickPick([
      { label: "This repository", description: "Recommended: writes the repository's .git/config", scope: "local" as ConfigScope },
      { label: "Global", description: "Every repository for your user account (~/.gitconfig)", scope: "global" as ConfigScope }
    ], { title: "Where should CompareCraft be configured as a Git tool?" });
    if (!scopeItem) return;
    let cwd: string;
    if (scopeItem.scope === "local") {
      const roots = await repositoryRoots();
      if (roots.length === 0) throw new Error("Open a file or folder inside a Git repository first.");
      const chosen = roots.length === 1 ? roots[0] : (await vscode.window.showQuickPick(roots, { title: "Choose the repository" }));
      if (!chosen) return;
      cwd = chosen;
    } else {
      if (!(await gitHost.confirm(
        "Change your global Git configuration?",
        "This affects git mergetool and git difftool in every repository for your user account. Repository scope is recommended.",
        "Change Global Configuration"
      ))) return;
      cwd = homedir();
    }
    const kindItem = await vscode.window.showQuickPick([
      { label: "Merge tool and diff tool", kinds: "both" as ToolKinds },
      { label: "Merge tool only", kinds: "merge" as ToolKinds },
      { label: "Diff tool only", kinds: "diff" as ToolKinds }
    ], { title: "Which Git tools should use CompareCraft?" });
    if (!kindItem) return;
    const settings = proposedSettings(await gitToolExecutable(), kindItem.kinds);
    const existing = await inspectSettings(g, cwd, scopeItem.scope, settings);
    const detail = existing.map(value => `${value.key} = ${value.proposed}` + (
      value.current === undefined ? "" : value.current === value.proposed ? " (unchanged)" : `\n    replaces: ${value.current}`
    )).join("\n") + "\n\nPrevious values are recorded so Remove Git Tool Configuration can restore them. " +
      "Git still asks whether each merge succeeded (trustExitCode=false). CompareCraft never stages, commits, or continues for you.";
    if (!(await gitHost.confirm(
      `Configure CompareCraft for Git (${scopeItem.scope === "local" ? cwd : "global"})?`, detail, "Apply"
    ))) return;
    const records = toolRecords();
    const index = records.findIndex(record => record.scope === scopeItem.scope && samePath(record.cwd, cwd));
    const record = await applySettings(g, cwd, scopeItem.scope, settings, index >= 0 ? records[index] : undefined);
    await context.globalState.update(TOOL_RECORDS, [...records.filter((_, i) => i !== index), record]);
    log(`Configured Git tools (${scopeItem.scope}) for ${cwd}: ${record.entries.map(entry => entry.key).join(", ")}`);
    void vscode.window.showInformationMessage("CompareCraft is configured. Run git mergetool or git difftool in a terminal. Undo with CompareCraft: Remove Git Tool Configuration.");
  }

  async function removeGitTools(): Promise<void> {
    require("git");
    const records = toolRecords();
    if (records.length === 0) {
      void vscode.window.showInformationMessage("No CompareCraft Git tool configuration was recorded by this extension.");
      return;
    }
    const item = await vscode.window.showQuickPick(records.map(record => ({
      label: record.scope === "global" ? "Global" : path.basename(record.cwd),
      description: record.scope === "global" ? "~/.gitconfig" : record.cwd,
      detail: record.entries.map(entry => entry.key).join(", "),
      record
    })), { title: "Remove CompareCraft Git tool configuration" });
    if (!item) return;
    if (!(await gitHost.confirm(
      "Remove CompareCraft Git tool settings?",
      "Each setting is restored to its earlier value (or unset) only if it still has CompareCraft's value. Settings you changed afterwards are left as they are.",
      "Remove"
    ))) return;
    const result = await removeSettings(await git(), item.record);
    await context.globalState.update(TOOL_RECORDS, records.filter(record => record !== item.record &&
      !(record.scope === item.record.scope && samePath(record.cwd, item.record.cwd))));
    const skipped = result.skipped.length ? ` Left unchanged because they were modified later: ${result.skipped.join(", ")}.` : "";
    void vscode.window.showInformationMessage(`Restored ${result.restored.length} Git setting(s).${skipped}`);
  }

  register("gitCompareHead", async first => (await workflows()).compareHeadWorking(gitTarget(first)));
  register("gitCompareIndex", async first => (await workflows()).compareIndexWorking(gitTarget(first)));
  register("gitCompareHeadIndex", async first => (await workflows()).compareHeadIndex(gitTarget(first)));
  register("gitCompareRevision", async first => (await workflows()).compareRevision(gitTarget(first)));
  register("gitResolveConflict", async first => (await workflows()).resolveConflict(gitTarget(first)));
  register("gitResolveConflictEmbedded", async first => (await workflows()).resolveConflict(gitTarget(first), "embedded"));
  register("gitStageResolved", async first => { await (await workflows()).stageResolved(gitTarget(first)); });
  register("configureGitTools", async () => configureGitTools());
  register("removeGitTools", async () => removeGitTools());

  return {
    async afterMergeSaved(file) {
      await (await workflows()).afterEmbeddedSave(file);
    }
  };
}
