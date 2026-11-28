/**
 * Activation shared by the Node extension host (VS Code desktop, and remote windows: SSH, WSL, Dev
 * Containers, Codespaces) and browser VS Code. Host-specific services come from `Platform`; what each
 * environment allows comes from `policy.ts`.
 */
import * as vscode from "vscode";
import { ComparisonController, type ComparisonHost } from "./controller";
import type { ContentInput, LaunchMode, PathInput, SideInput } from "./contracts";
import { EmbeddedPanels, specFromInputs } from "./embedded";
import { pairViewKind, parseSpec, type EmbeddedSpec } from "./embeddedCore";
import { ComparisonEngine } from "./engine";
import { errorText, InstallationError, UnavailableError } from "./errors";
import { sessionSpec } from "./folderSessions";
import { basename, extname, pathKey } from "./paths";
import type { Platform } from "./platform";
import { contextKeys, denial, hostLabel, type HostState, type Operation } from "./policy";
import { pathOf, setNativePaths } from "./uris";
import { WasmEngine } from "./wasmEngine";

const DOWNLOAD = vscode.Uri.parse("https://github.com/Antebios/comparecraft/releases");
const GIT_COMMANDS = [
  "gitCompareHead", "gitCompareIndex", "gitCompareHeadIndex", "gitCompareRevision", "gitResolveConflict",
  "gitResolveConflictEmbedded", "gitStageResolved", "configureGitTools", "removeGitTools"
];

/** Result of CompareCraft: Check Embedded Backend; `executable` and `protocolVersion` only for the helper. */
export interface EngineCheck {
  readonly engine: "helper" | "wasm";
  readonly version: string;
  readonly executable?: string;
  readonly protocolVersion?: number;
  readonly environment: string;
}

/** Returned only in test runs (`ExtensionMode.Test`); nothing is exported to other extensions. */
export interface TestApi {
  readonly embedded: EmbeddedPanels;
  readonly engine: ComparisonEngine;
  denial(operation: Operation, paths?: readonly string[]): { reason: string; fix?: "trust" } | undefined;
}

export function activateCompareCraft(context: vscode.ExtensionContext, createPlatform: (log: (line: string) => void) => Platform): TestApi | undefined {
  const output = vscode.window.createOutputChannel("CompareCraft");
  context.subscriptions.push(output);
  const log = (line: string) => output.appendLine(line);
  const platform = createPlatform(log);
  setNativePaths(platform.kind === "node");
  if (platform.dispose) context.subscriptions.push({ dispose: () => { void platform.dispose?.(); } });

  const state = (): HostState => ({
    kind: platform.kind === "web" ? "web" : vscode.env.remoteName ? "remote" : "desktop",
    remoteName: vscode.env.remoteName,
    trusted: vscode.workspace.isTrusted
  });
  const denialFor = (operation: Operation, paths: readonly string[] = []) => denial(state(), operation, paths);
  function require(operation: Operation, paths: readonly string[] = []): void {
    const denied = denialFor(operation, paths);
    if (denied) throw new UnavailableError(denied.reason, denied.fix);
  }

  async function updateContext(): Promise<void> {
    const schemes = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.scheme);
    for (const [key, value] of Object.entries(contextKeys(state(), schemes))) {
      await vscode.commands.executeCommand("setContext", `comparecraft.${key}`, value);
    }
  }
  void updateContext();

  const engine = new ComparisonEngine({
    files: platform.files,
    helper: platform.helper,
    wasm: async () => WasmEngine.load(await platform.wasmBytes()),
    log
  });

  async function report(error: unknown): Promise<void> {
    const message = errorText(error);
    log(message);
    if (error instanceof UnavailableError) {
      const choice = await vscode.window.showWarningMessage(`CompareCraft: ${message}`, ...(error.fix === "trust" ? ["Manage Workspace Trust"] : []));
      if (choice === "Manage Workspace Trust") await vscode.commands.executeCommand("workbench.trust.manage");
    } else if (error instanceof InstallationError) {
      const actions = platform.desktop && !denialFor("desktop") ? ["Locate Executable", "Download CompareCraft"] : ["Download CompareCraft"];
      const action = await vscode.window.showErrorMessage(message, ...actions);
      if (action === "Locate Executable") {
        try { await locateDesktop(); } catch (failure) { await report(failure); }
      } else if (action === "Download CompareCraft") {
        if (!(await vscode.env.openExternal(DOWNLOAD))) {
          log(`Could not open ${DOWNLOAD.toString()}`);
          await vscode.window.showErrorMessage(`Could not open ${DOWNLOAD.toString()}. Open the release page in your browser.`);
        }
      }
    } else {
      await vscode.window.showErrorMessage(`CompareCraft: ${message}`);
    }
  }

  const realpath = (file: string) => platform.files.realpath(file).catch(() => file);

  async function dirtyDocument(file: string): Promise<vscode.TextDocument | undefined> {
    const target = pathKey(await realpath(file));
    for (const document of vscode.workspace.textDocuments) {
      if (!document.isDirty || document.uri.scheme === "untitled") continue;
      if (pathKey(await realpath(pathOf(document.uri))) === target) return document;
    }
    return undefined;
  }

  function desktop() {
    if (!platform.desktop) throw new UnavailableError(denialFor("desktop")?.reason ?? "The CompareCraft desktop app isn't available here.");
    return platform.desktop;
  }

  async function locateDesktop(): Promise<void> {
    require("desktop");
    await desktop().locate();
  }

  /**
   * Two files whose type is binary, table, or picture open in the matching read-only view.
   * Text files, in-memory content, and files with unsaved VS Code edits keep the editable text comparison.
   */
  async function fileView(inputs: readonly SideInput[]): Promise<EmbeddedSpec | undefined> {
    if (inputs.length !== 2 || !inputs.every((input): input is PathInput => input.kind === "path")) return undefined;
    try {
      const infos = await Promise.all(inputs.map(input => engine.request<{ exists: boolean; isDir: boolean; kind: string }>("path.info", { path: input.path })));
      const kind = pairViewKind(infos);
      if (!kind) return undefined;
      for (const input of inputs) {
        if (await dirtyDocument(input.path)) {
          vscode.window.setStatusBarMessage(`CompareCraft: ${basename(input.path)} has unsaved changes, so it is compared as text.`, 8000);
          return undefined;
        }
      }
      return parseSpec({ kind, paths: inputs.map(input => input.path), titles: inputs.map(input => input.title ?? null) });
    } catch (error) {
      log(`Could not detect the file type; comparing as text: ${errorText(error)}`);
      return undefined;
    }
  }

  const host: ComparisonHost = {
    checkDesktop(paths) {
      require("desktop", paths);
      desktop();
    },
    async offerEmbedded(error) {
      const actions = ["Compare in VS Code", ...(error.fix === "trust" ? ["Manage Workspace Trust"] : [])];
      const choice = await vscode.window.showInformationMessage(error.message, { modal: true }, ...actions);
      if (choice === "Manage Workspace Trust") await vscode.commands.executeCommand("workbench.trust.manage");
      return choice === "Compare in VS Code";
    },
    async resource(value) {
      const resolved = await platform.files.realpath(value);
      const info = await platform.files.stat(resolved);
      if (!info) throw new Error(`Not found: ${value}`);
      if (info.type === "other") throw new Error(`Not a regular file or folder: ${value}`);
      return { path: resolved, kind: info.type };
    },
    async pick(kind, title) {
      const picked = await vscode.window.showOpenDialog({
        title, canSelectFiles: kind === "file", canSelectFolders: kind === "folder", canSelectMany: false
      });
      return picked?.[0] ? pathOf(picked[0]) : undefined;
    },
    defaultMode() {
      const mode = vscode.workspace.getConfiguration("comparecraft").get<string>("defaultMode", "embedded");
      if (mode !== "embedded" && mode !== "desktop") throw new Error("Invalid comparecraft.defaultMode. Choose embedded or desktop.");
      return mode;
    },
    async confirmDesktop() {
      return await vscode.window.showInformationMessage(
        "This comparison requires a desktop process (for example a Git tool waiting for completion). Open it in the installed desktop app instead?",
        { modal: true }, "Open in Desktop App"
      ) === "Open in Desktop App";
    },
    async openEmbedded(inputs) {
      const types = await Promise.all(inputs.map(async input => input.kind === "path" ? (await platform.files.stat(input.path))?.type : undefined));
      if (types.some(type => type === "folder")) {
        if (inputs.length !== 2 || !types.every(type => type === "folder") || !inputs.every(input => input.kind === "path")) {
          throw new Error("Folder comparisons require two folders, not files or editor content.");
        }
        const spec = parseSpec({ kind: "folder", paths: inputs.map(input => input.kind === "path" ? input.path : ""),
          titles: inputs.map(input => input.title ?? null) });
        const unsupported = await embedded.folderUnsupported(spec.paths);
        if (unsupported) {
          if (platform.desktop && !denialFor("desktop", spec.paths)) {
            await embedded.host.openInDesktop("folder", spec.paths, unsupported);
            return;
          }
          throw new UnavailableError(unsupported);
        }
        await embedded.validateFolder(spec);
        embedded.open(spec);
        return;
      }
      const view = await fileView(inputs);
      if (view) {
        embedded.open(view);
        return;
      }
      const spec = await specFromInputs(inputs, async file => (await engine.request<{ lines: string[] }>("text.load", { path: file })).lines);
      embedded.open(spec);
    },
    async assertSaved(resources) {
      await desktop().assertSaved(resources, vscode.workspace.textDocuments
        .filter(document => document.isDirty && document.uri.scheme !== "untitled")
        .map(document => pathOf(document.uri)));
    },
    async bufferText(file) {
      return (await dirtyDocument(file))?.getText();
    },
    async createSnapshots() {
      return desktop().createSnapshots();
    },
    async launch(args, tracking) {
      require("desktop");
      await desktop().launch(args, tracking, error => { void report(error); });
    },
    async setHasLeft(value) { await vscode.commands.executeCommand("setContext", "comparecraft.hasLeft", value); },
    notify(message) { vscode.window.setStatusBarMessage(message, 5000); }
  };
  const controller = new ComparisonController(host);

  /** Paths of the command's resources: the Explorer selection, or the active editor's file. */
  function paths(first: unknown, selected: unknown): string[] {
    let uris: vscode.Uri[];
    if (first instanceof vscode.Uri) {
      uris = Array.isArray(selected) && selected.length > 0 && selected.every(item => item instanceof vscode.Uri) &&
        selected.some(item => item.toString() === first.toString()) ? selected : [first];
    } else if (first !== undefined) {
      throw new Error("This command requires file or folder resources. For selections use Compare Selection with Clipboard or Select Text as Left.");
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
    if (uris.some(uri => uri.scheme === "untitled")) {
      throw new Error("This command compares saved files and folders. For untitled documents use Select Text as Left or Compare with Clipboard.");
    }
    return uris.map(pathOf);
  }

  function documentName(document: vscode.TextDocument): string {
    const base = basename(document.uri.path) || "Untitled";
    return extname(base) ? base : `${base}.txt`;
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
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.uri.scheme === "untitled") throw new Error("Compare with Saved needs an editor for a saved file.");
    const name = documentName(document);
    if (!document.isDirty) {
      void vscode.window.showInformationMessage(`${name} has no unsaved changes.`);
      return;
    }
    const file = pathOf(document.uri);
    const info = await platform.files.stat(file);
    if (info && info.type !== "file") throw new Error(`${file} is not a file.`);
    // Read-only: saving the disk side from the desktop app would conflict with the unsaved buffer.
    const saved: SideInput = info
      ? { kind: "path", path: file, title: `${name} (saved on disk)`, readOnly: true }
      : { kind: "content", name, title: `${name} (not on disk)`, content: "" };
    await controller.compareInputs([saved, { kind: "content", name, title: `${name} (unsaved buffer)`, content: document.getText() }]);
  }

  async function compareWithClipboard(): Promise<void> {
    const text = editorText();
    const clipboard = await vscode.env.clipboard.readText();
    if (!clipboard) throw new Error("The clipboard does not contain text.");
    await controller.compareInputs([text, { kind: "content", name: `clipboard${extname(text.name)}`, title: "Clipboard", content: clipboard }]);
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
    const base = basename(uri.path) || "document";
    const file = pathOf(uri);
    if (uri.scheme === "file" && !document.isDirty && platform.files.isLocal(file)) {
      if ((await platform.files.stat(file).catch(() => undefined))?.type === "file") return { kind: "path", path: file, title: base };
    }
    const label = uri.scheme === "file" ? "unsaved buffer" : uri.scheme === "untitled" ? "untitled" : uri.scheme === "git" ? gitRef(uri) : uri.scheme;
    return { kind: "content", name: extname(base) ? base : `${base}.txt`, title: `${base} (${label})`, content: document.getText() };
  }

  async function compareActiveDiff(): Promise<void> {
    require("desktop");
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputTextDiff)) throw new Error("Open a text diff editor first.");
    await controller.compareInputs([await diffSide(input.original), await diffSide(input.modified)], { mode: "desktop" });
  }

  if (platform.helper) {
    const helper = platform.helper;
    context.subscriptions.push(
      { dispose: () => { void helper.dispose(); } },
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("comparecraft.backendPath") || event.affectsConfiguration("comparecraft.desktopPath")) void helper.reset();
      })
    );
  }

  let afterMergeSaved: (file: string) => Promise<void> = async () => undefined;
  const embedded = new EmbeddedPanels(context, engine, platform.files, {
    log,
    denial: denialFor,
    folderCopies: platform.folderCopies,
    async openInDesktop(kind, paths, reason) {
      require("desktop", paths);
      const app = desktop();
      const choice = await vscode.window.showInformationMessage(
        reason ?? (kind === "folder" ? "Open this folder comparison in the installed CompareCraft desktop app?" :
          `The ${kind} view is not available in embedded CompareCraft. Open it in the installed desktop app?`),
        { modal: true, ...(reason ? { detail: "Open it in the installed desktop app instead?" } : {}) }, "Open in Desktop App"
      );
      if (choice !== "Open in Desktop App") return;
      if (kind === "folder") {
        if (paths.length !== 2 || paths.some(file => !file)) throw new Error("Choose both folders before opening the desktop comparison.");
        const resources = await Promise.all(paths.map(file => host.resource(file)));
        if (resources.some(resource => resource.kind !== "folder")) throw new Error("Choose two folders for this desktop comparison.");
        await host.assertSaved(resources);
      }
      await host.launch(paths.length === 0 ? [] : app.viewArguments(kind, paths));
    },
    async afterMergeSaved(file) {
      try {
        await afterMergeSaved(file);
      } catch (error) {
        await report(error);
      }
    }
  });
  context.subscriptions.push(embedded);

  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void updateContext();
      embedded.broadcastCapabilities();
      vscode.window.setStatusBarMessage("CompareCraft: the workspace is trusted. Refresh open comparisons (F5) to edit them.", 8000);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void updateContext())
  );

  async function checkBackend(): Promise<EngineCheck> {
    const environment = hostLabel(state());
    const helper = platform.helper;
    // Look for a helper again: one may have been installed since the last request.
    if (helper && !(await helper.find())) await helper.reset();
    const sample = { left: ["CompareCraft", "check"], right: ["CompareCraft", "check!"] };
    const started = Date.now();
    const client = await engine.helper();
    let result: EngineCheck;
    if (client) {
      const diff = await client.request<{ identical: boolean }>("text.diff", sample);
      if (diff.identical !== false) throw new Error("The CompareCraft backend returned an unexpected comparison result.");
      const { server, protocolVersion, capabilities } = client.info;
      const source = (await helper?.find())?.source;
      const origin = source === "bundled" ? "bundled with the extension" : source === "setting" ? "from comparecraft.backendPath" : "installed with the desktop app";
      const summary = `CompareCraft backend ${server.version} (protocol ${protocolVersion}, ${origin}) is working: ${client.executable}`;
      log(`${summary}; methods: ${capabilities.methods.join(", ")}; sample diff took ${Date.now() - started} ms. Environment: ${environment}.`);
      void vscode.window.showInformationMessage(summary);
      result = { engine: "helper", executable: client.executable, version: server.version, protocolVersion, environment };
    } else {
      const wasm = await engine.wasm();
      const diff = wasm.call<{ identical: boolean }>("text.diff", sample);
      if (diff.identical !== false) throw new Error("The CompareCraft WebAssembly engine returned an unexpected comparison result.");
      const folders = platform.kind === "web" ? "Folder comparison isn't available in VS Code in a browser." : "Folder comparison needs the CompareCraft helper, which isn't installed here.";
      const summary = `CompareCraft is comparing with its WebAssembly engine ${wasm.info.version} in ${environment}. ${folders}`;
      log(`${summary} Methods: ${wasm.info.methods.join(", ")}; module ${wasm.size} bytes; sample diff took ${Date.now() - started} ms.`);
      void vscode.window.showInformationMessage(summary);
      result = { engine: "wasm", version: wasm.info.version, environment };
    }
    return result;
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
  register("openSavedFolderSession", async () => {
    require("folder");
    const sessions = embedded.folderSessions().filter(session => session.saved);
    if (!sessions.length) {
      await vscode.window.showInformationMessage("CompareCraft: No saved folder sessions. Save a session from a folder comparison first.");
      return;
    }
    const picked = await vscode.window.showQuickPick(sessions.map(session => ({
      label: session.name, description: session.locked ? "Locked" : undefined,
      detail: session.paths.join(" ↔ "), session
    })), { title: "Open Saved Folder Session", matchOnDetail: true });
    if (!picked) return;
    const spec = sessionSpec(picked.session);
    await embedded.validateFolder(spec);
    embedded.open(spec);
  });
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
    await controller.compareInputs([leftText, editorText()]);
  });
  register("compareActiveDiff", async () => compareActiveDiff());
  register("checkBackend", async () => checkBackend());

  if (platform.registerGit) {
    afterMergeSaved = platform.registerGit({
      context, controller, desktop: platform.desktop, register, require, report, log, pathOf,
      bufferText: file => host.bufferText(file),
      isDirty: async file => Boolean(await dirtyDocument(file))
    }).afterMergeSaved;
  } else {
    // Browser VS Code has no Git executable; the commands explain why instead of failing as unknown.
    for (const id of GIT_COMMANDS) register(id, async () => require("git"));
  }

  // Integration tests drive embedded panels and check the policy directly.
  return context.extensionMode === vscode.ExtensionMode.Test ? { embedded, engine, denial: denialFor } : undefined;
}
