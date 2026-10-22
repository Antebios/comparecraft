import * as vscode from "vscode";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ComparisonController, type ComparisonHost } from "./controller";
import { discoverBackend, discoverDesktop, InstallationError } from "./discovery";
import { BackendManager } from "./backend";
import { launchDesktop } from "./process";
import { assertSavedResources } from "./resources";
import { SnapshotStore } from "./snapshots";
import { Git } from "./git";
import { GitWorkflows, type GitHost } from "./gitWorkflows";
import { applySettings, inspectSettings, proposedSettings, removeSettings, type ConfigScope, type ToolKinds, type ToolRecord } from "./gitTools";
import type { ContentInput, LaunchMode, SideInput } from "./contracts";

const DOWNLOAD = vscode.Uri.parse("https://github.com/Antebios/comparecraft/releases");
const TOOL_RECORDS = "comparecraft.gitToolRecords";

interface GitExtensionApi { readonly git: { readonly path: string } }
interface GitExtensionExports { getAPI(version: 1): GitExtensionApi }

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("CompareCraft");
  context.subscriptions.push(output);
  const snapshots = new SnapshotStore(path.join(context.globalStorageUri.fsPath, "snapshots"));
  void snapshots.sweep().then(
    removed => { if (removed.length) output.appendLine(`Removed ${removed.length} finished snapshot session(s).`); },
    error => output.appendLine(`Snapshot cleanup skipped: ${error instanceof Error ? error.message : String(error)}`)
  );

  function assertSupported(): void {
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before launching CompareCraft.");
    if (vscode.env.uiKind === vscode.UIKind.Web || vscode.env.remoteName) {
      throw new Error("CompareCraft currently supports local desktop workspaces only. Remote SSH, WSL, Dev Containers, and browser-only VS Code are not supported yet.");
    }
    if (vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme !== "file")) {
      throw new Error("CompareCraft requires a local filesystem workspace.");
    }
  }

  const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

  async function dirtyDocument(filePath: string): Promise<vscode.TextDocument | undefined> {
    let target = filePath;
    try { target = await realpath(filePath); } catch { /* deleted files keep their path */ }
    for (const document of vscode.workspace.textDocuments) {
      if (!document.isDirty || document.uri.scheme !== "file") continue;
      let candidate = document.uri.fsPath;
      try { candidate = await realpath(candidate); } catch { /* unsaved deleted document */ }
      if (samePath(candidate, target)) return document;
    }
    return undefined;
  }

  let gitInstance: Git | undefined;
  async function git(): Promise<Git> {
    if (gitInstance) return gitInstance;
    let executable = "git";
    try {
      const extension = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
      const api = extension ? (extension.isActive ? extension.exports : await extension.activate()).getAPI(1) : undefined;
      if (api?.git.path) executable = api.git.path;
    } catch (error) {
      output.appendLine(`Built-in Git extension unavailable, using git from PATH: ${error instanceof Error ? error.message : String(error)}`);
    }
    gitInstance = new Git(executable);
    return gitInstance;
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
        "Embedded CompareCraft is not available yet. Open this comparison in the installed desktop app instead?",
        { modal: true }, "Open in Desktop App"
      ) === "Open in Desktop App";
    },
    async assertSaved(resources) {
      await assertSavedResources(resources, vscode.workspace.textDocuments
        .filter(document => document.isDirty && document.uri.scheme === "file")
        .map(document => document.uri.fsPath));
    },
    async bufferText(filePath) {
      return (await dirtyDocument(filePath))?.getText();
    },
    async createSnapshots() {
      return snapshots.create();
    },
    async launch(args, tracking) {
      assertSupported();
      const configured = vscode.workspace.getConfiguration("comparecraft").inspect<string>("desktopPath");
      // Never honor a workspace-supplied executable, even if injected programmatically.
      const executable = await discoverDesktop({ override: configured?.globalValue ?? configured?.defaultValue ?? "" });
      output.appendLine(`Launching ${executable} (${args.length === 0 ? "home" : tracking ? "tracked comparison" : "comparison"})`);
      const closed = tracking ? () => {
        void (async () => {
          try { await tracking.session?.release(); } catch (error) {
            output.appendLine(`Snapshot cleanup deferred: ${error instanceof Error ? error.message : String(error)}`);
          }
          try { await tracking.onClosed?.(); } catch (error) { await report(error); }
        })();
      } : undefined;
      const pid = await launchDesktop(executable, args, error => { void report(error); }, closed);
      if (pid !== undefined) await tracking?.session?.attach(pid);
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
      throw new Error("This command requires local file/folder resources. For selections use Compare Selection with Clipboard or Select Text as Left.");
    } else {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (input instanceof vscode.TabInputTextDiff) {
        throw new Error("The active tab is a diff. Use CompareCraft: Open Active Diff in Desktop App.");
      }
      if (input && !(input instanceof vscode.TabInputText)) {
        throw new Error("Choose a text tab or an Explorer resource. Custom and merge editors are not supported by this command.");
      }
      const uri = input instanceof vscode.TabInputText ? input.uri : vscode.window.activeTextEditor?.document.uri;
      uris = uri ? [uri] : [];
    }
    if (uris.some(uri => uri.scheme !== "file")) {
      throw new Error("This command compares files and folders on disk. For untitled or virtual documents use Select Text as Left, Compare with Clipboard, or Open Active Diff.");
    }
    return uris.map(uri => uri.fsPath);
  }

  function documentName(document: vscode.TextDocument): string {
    const base = path.posix.basename(document.uri.path) || "Untitled";
    return path.extname(base) ? base : `${base}.txt`;
  }

  /** The active editor's selections, or its whole current buffer when nothing is selected. */
  function editorText(): ContentInput {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error("Open a text editor first.");
    const document = editor.document;
    const name = documentName(document);
    const selections = editor.selections.filter(selection => !selection.isEmpty).sort((a, b) => a.start.compareTo(b.start));
    if (selections.length === 0) {
      return { kind: "content", name, title: `${name} (current buffer)`, content: document.getText() };
    }
    const lines = selections.map(selection => selection.start.line === selection.end.line
      ? `${selection.start.line + 1}` : `${selection.start.line + 1}-${selection.end.line + 1}`).join(", ");
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    return { kind: "content", name, title: `${name} (selection, lines ${lines})`, content: selections.map(s => document.getText(s)).join(eol) };
  }

  let leftText: ContentInput | undefined;

  async function compareWithSaved(): Promise<void> {
    assertSupported();
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.uri.scheme !== "file") throw new Error("Compare with Saved needs an editor for a file on disk.");
    const name = documentName(document);
    if (!document.isDirty) {
      void vscode.window.showInformationMessage(`${name} has no unsaved changes.`);
      return;
    }
    let saved: SideInput;
    try {
      if (!(await stat(document.uri.fsPath)).isFile()) throw new Error(`${document.uri.fsPath} is not a file.`);
      // Read-only: saving the disk side from the desktop app would conflict with the unsaved buffer.
      saved = { kind: "path", path: document.uri.fsPath, title: `${name} (saved on disk)`, readOnly: true };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      saved = { kind: "content", name, title: `${name} (not on disk)`, content: "" };
    }
    await controller.compareInputs([saved, { kind: "content", name, title: `${name} (unsaved buffer)`, content: document.getText() }]);
  }

  async function compareWithClipboard(): Promise<void> {
    assertSupported();
    const text = editorText();
    const clipboard = await vscode.env.clipboard.readText();
    if (!clipboard) throw new Error("The clipboard does not contain text.");
    await controller.compareInputs([text, { kind: "content", name: `clipboard${path.extname(text.name)}`, title: "Clipboard", content: clipboard }]);
  }

  function gitRef(uri: vscode.Uri): string {
    try {
      const query = JSON.parse(uri.query) as { ref?: unknown };
      if (query.ref === "") return "index";
      if (query.ref === "~" || query.ref === "HEAD") return "HEAD";
      if (typeof query.ref === "string") return query.ref.length > 12 && /^[0-9a-f]+$/.test(query.ref) ? query.ref.slice(0, 7) : query.ref;
    } catch { /* not a built-in Git URI */ }
    return "git";
  }

  async function diffSide(uri: vscode.Uri): Promise<SideInput> {
    const document = await vscode.workspace.openTextDocument(uri);
    const base = path.posix.basename(uri.path) || "document";
    if (uri.scheme === "file" && !document.isDirty) {
      try {
        if ((await stat(uri.fsPath)).isFile()) return { kind: "path", path: uri.fsPath, title: base };
      } catch { /* fall back to the document content */ }
    }
    const label = uri.scheme === "file" ? "unsaved buffer" : uri.scheme === "untitled" ? "untitled" : uri.scheme === "git" ? gitRef(uri) : uri.scheme;
    return { kind: "content", name: path.extname(base) ? base : `${base}.txt`, title: `${base} (${label})`, content: document.getText() };
  }

  async function compareActiveDiff(): Promise<void> {
    assertSupported();
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputTextDiff)) throw new Error("Open a text diff editor first.");
    await controller.compareInputs([await diffSide(input.original), await diffSide(input.modified)]);
  }

  const gitHost: GitHost = {
    assertSupported,
    bufferText: filePath => host.bufferText(filePath),
    async isDirty(filePath) { return Boolean(await dirtyDocument(filePath)); },
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
    if (uri.scheme !== "file") throw new Error("Git commands need a local working-tree file.");
    return uri.fsPath;
  }

  async function gitToolExecutable(): Promise<string> {
    const configured = vscode.workspace.getConfiguration("comparecraft").inspect<string>("desktopPath");
    const desktop = await discoverDesktop({ override: configured?.globalValue ?? configured?.defaultValue ?? "" });
    const console = path.join(path.dirname(desktop), process.platform === "win32" ? "ccomp.exe" : "ccomp");
    try {
      if ((await stat(console)).isFile()) return console;
    } catch { /* older or platform layouts without the console launcher */ }
    return desktop;
  }

  function executableSetting(key: "desktopPath" | "backendPath"): string {
    const configured = vscode.workspace.getConfiguration("comparecraft").inspect<string>(key);
    // Never honor a workspace-supplied executable, even if injected programmatically.
    return configured?.globalValue ?? configured?.defaultValue ?? "";
  }

  const backend = new BackendManager(
    async () => {
      assertSupported();
      return discoverBackend({ override: executableSetting("backendPath"), desktopOverride: executableSetting("desktopPath") });
    },
    {
      client: { name: "comparecraft-vscode", version: String(context.extension.packageJSON.version ?? "0.0.0") },
      requiredMethods: ["path.info", "text.load", "text.diff", "text.merge"],
      log: line => output.appendLine(line)
    }
  );
  context.subscriptions.push(
    { dispose: () => { void backend.dispose(); } },
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("comparecraft.backendPath") || event.affectsConfiguration("comparecraft.desktopPath")) void backend.reset();
    })
  );

  async function checkBackend(): Promise<{ executable: string; version: string; protocolVersion: number }> {
    assertSupported();
    const client = await backend.get();
    const started = Date.now();
    const diff = await client.request<{ identical: boolean }>("text.diff", { left: ["CompareCraft", "check"], right: ["CompareCraft", "check!"] });
    if (diff.identical !== false) throw new Error("The CompareCraft backend returned an unexpected comparison result.");
    const { server, protocolVersion, capabilities } = client.info;
    const summary = `CompareCraft backend ${server.version} (protocol ${protocolVersion}) is working: ${client.executable}`;
    output.appendLine(`${summary}; methods: ${capabilities.methods.join(", ")}; sample diff took ${Date.now() - started} ms.`);
    void vscode.window.showInformationMessage(summary);
    return { executable: client.executable, version: server.version, protocolVersion };
  }

  async function repositoryRoots(): Promise<string[]> {
    const g = await git();
    const folders = [
      ...(vscode.window.activeTextEditor?.document.uri.scheme === "file" ? [path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)] : []),
      ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)
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
    assertSupported();
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
      cwd = (await import("node:os")).homedir();
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
    output.appendLine(`Configured Git tools (${scopeItem.scope}) for ${cwd}: ${record.entries.map(entry => entry.key).join(", ")}`);
    void vscode.window.showInformationMessage("CompareCraft is configured. Run git mergetool or git difftool in a terminal. Undo with CompareCraft: Remove Git Tool Configuration.");
  }

  async function removeGitTools(): Promise<void> {
    assertSupported();
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

  function register(id: string, callback: (first: unknown, selected: unknown) => Promise<unknown>): void {
    context.subscriptions.push(vscode.commands.registerCommand(`comparecraft.${id}`, async (first: unknown, selected: unknown) => {
      try { return await callback(first, selected); } catch (error) { await report(error); return undefined; }
    }));
  }
  for (const [id, mode] of [
    ["compareSelected", undefined], ["compareSelectedDesktop", "desktop"], ["compareSelectedEmbedded", "embedded"]
  ] as const satisfies readonly (readonly [string, LaunchMode | undefined])[]) {
    register(id, async (first, selected) => controller.compare(paths(first, selected), mode));
  }
  register("selectLeft", async (first, selected) => controller.selectLeft(paths(first, selected)));
  register("compareWithLeft", async (first, selected) => controller.compareWithLeft(paths(first, selected)));
  register("clearLeft", async () => {
    leftText = undefined;
    await vscode.commands.executeCommand("setContext", "comparecraft.hasLeftText", false);
    await controller.clearLeft();
  });
  register("compareFileWith", async (first, selected) => controller.compareWithPicker(paths(first, selected), "file"));
  register("compareFolderWith", async (first, selected) => controller.compareWithPicker(paths(first, selected), "folder"));
  register("compareParentFolderWith", async (first, selected) => controller.compareParent(paths(first, selected)));
  register("openDesktop", async () => controller.openDesktop());
  register("locateDesktop", async () => locateDesktop());

  register("compareWithSaved", async () => compareWithSaved());
  register("compareWithClipboard", async () => compareWithClipboard());
  register("selectLeftText", async () => {
    leftText = editorText();
    await vscode.commands.executeCommand("setContext", "comparecraft.hasLeftText", true);
    vscode.window.setStatusBarMessage(`CompareCraft left text: ${leftText.title}`, 5000);
  });
  register("compareTextWithLeft", async () => {
    if (!leftText) throw new Error("Select left text first using CompareCraft: Select Text as Left.");
    assertSupported();
    await controller.compareInputs([leftText, editorText()]);
  });
  register("compareActiveDiff", async () => compareActiveDiff());

  register("gitCompareHead", async first => (await workflows()).compareHeadWorking(gitTarget(first)));
  register("gitCompareIndex", async first => (await workflows()).compareIndexWorking(gitTarget(first)));
  register("gitCompareHeadIndex", async first => (await workflows()).compareHeadIndex(gitTarget(first)));
  register("gitCompareRevision", async first => (await workflows()).compareRevision(gitTarget(first)));
  register("gitResolveConflict", async first => (await workflows()).resolveConflict(gitTarget(first)));
  register("gitStageResolved", async first => { await (await workflows()).stageResolved(gitTarget(first)); });
  register("configureGitTools", async () => configureGitTools());
  register("removeGitTools", async () => removeGitTools());
  register("checkBackend", async () => checkBackend());
}
