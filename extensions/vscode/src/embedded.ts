import * as vscode from "vscode";
import {
  dialogFilters, DocumentGuard, FOLDER_METHODS, isFileView, joinLines, parseSpec, readBytes, readDataUrl, requireAbsolute, requireLines, requireObject, requireString,
  deleteEmbeddedSession, readEmbeddedSessions, supportedFolderOptions, textFileFromBuffer, titleOf, unsupportedCommand, unsupportedFolderOptions, upsertEmbeddedSession,
  type EmbeddedSessionRecord, type EmbeddedSpec, type TextFileResult
} from "./embeddedCore";
import type { ComparisonEngine } from "./engine";
import { BackendError, errorText, UnavailableError } from "./errors";
import { randomBase64, randomHex, utf8, type FileAccess } from "./fileAccess";
import { FOLDER_SESSIONS_KEY, parseFolderSession, type FolderSession } from "./folderSessions";
import { diskVerdict } from "./folderReceipts";
import { basename, dirname, isAbsolutePath, joinPath, pathKey, withinFolder } from "./paths";
import type { Denial, Operation } from "./policy";
import { droppedPaths, pathOf, toUri } from "./uris";
import type { CopyProgress } from "./virtualFolders";

export { specFromInputs } from "./embeddedCore";

export const VIEW_TYPE = "comparecraft.textCompare";
const SETTINGS_KEY = "comparecraft.embeddedSettings";
const SESSIONS_KEY = "comparecraft.embeddedSessions";

/** Folder copies for folders the helper can't read directly (virtual workspaces; see virtualFolders.ts). */
export interface FolderCopies {
  side(owner: string, side: "left" | "right"): string;
  copy(owner: string, side: "left" | "right", source: string, progress: CopyProgress): Promise<string>;
  refresh(owner: string, sources: readonly [string, string], rels: readonly string[], progress: CopyProgress): Promise<void>;
  release(owner: string): Promise<void>;
}

/** What the webview may offer (see `capabilities` requests); enforcement stays in this host. */
export interface WebviewCapabilities {
  readonly desktop: boolean;
  readonly revealInOS: boolean;
  readonly restricted: boolean;
}

export interface EmbeddedHost {
  log(message: string): void;
  /** Why an operation isn't available for these paths here (see policy.ts), or undefined. */
  denial(operation: Operation, paths?: readonly string[]): Denial | undefined;
  /** Offers to open a view the embedded panel does not provide in the desktop app; `reason` says why. */
  openInDesktop(kind: string, paths: readonly string[], reason?: string): Promise<void>;
  /** Called after a merge result is written; offers explicit review and staging. */
  afterMergeSaved(file: string): Promise<void>;
  /** Copies of virtual folders for the helper; undefined where no helper can run (browser VS Code). */
  readonly folderCopies?: FolderCopies;
}

const assertAllowed = (denial: Denial | undefined): void => {
  if (denial) throw new UnavailableError(denial.reason, denial.fix);
};

/** Whether VS Code wraps lines by default (`editor.wordWrap` other than "off"). */
export const editorWordWrap = () => vscode.workspace.getConfiguration("editor").get<string>("wordWrap", "off") !== "off";

const FOLDER_OPTION_NAMES: Record<string, string> = { respectGitignore: ".gitignore handling", detectMoves: "moved-file detection" };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const eolOf = (document: vscode.TextDocument): "\n" | "\r\n" => document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";

/** Owns every embedded comparison panel, including panels restored after a window reload. */
export class EmbeddedPanels implements vscode.Disposable {
  private readonly panels = new Set<EmbeddedPanel>();
  private sessionWrites: Promise<void> = Promise.resolve();
  private readonly origins = new Map<EmbeddedPanel, { token: string; parent: EmbeddedPanel; paths: string[]; epoch: number }>();
  private disposing = false;

  constructor(readonly context: vscode.ExtensionContext, readonly engine: ComparisonEngine, readonly files: FileAccess, readonly host: EmbeddedHost) {
    context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state) => {
        try {
          const spec = parseSpec(state);
          if (spec.kind === "folder") await this.validateFolder(spec);
          this.attach(panel, spec.kind === "folder" ? spec : { ...spec, output: null });
          if (spec.kind === "merge" && spec.output) void this.offerMergedText(spec);
        } catch (error) {
          host.log(`Discarded an embedded comparison that could not be restored: ${errorText(error)}`);
          void vscode.window.showWarningMessage(`CompareCraft could not restore the comparison: ${errorText(error)}`);
          panel.dispose();
        }
      }
    }), vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("editor.wordWrap")) this.broadcastSettings();
    }));
  }

  get count(): number {
    return this.panels.size;
  }

  /** Open panels; used by integration tests. */
  get all(): EmbeddedPanel[] {
    return [...this.panels];
  }

  get isDisposing(): boolean {
    return this.disposing;
  }

  listSessions(): EmbeddedSessionRecord[] {
    return readEmbeddedSessions(this.context.globalState.get<unknown>(SESSIONS_KEY));
  }

  findSession(name: string): EmbeddedSessionRecord | null {
    const key = name.toLowerCase();
    return this.listSessions().find(session => session.saved && session.name.toLowerCase() === key) ?? null;
  }

  saveSession(value: unknown): Promise<void> {
    const write = this.sessionWrites.then(async () => {
      const current = this.context.globalState.get<unknown>(SESSIONS_KEY);
      const next = upsertEmbeddedSession(current, value);
      await this.context.globalState.update(SESSIONS_KEY, next);
    });
    this.sessionWrites = write.catch(() => {});
    return write;
  }

  deleteSession(id: string): Promise<void> {
    const write = this.sessionWrites.then(async () => {
      const current = this.context.globalState.get<unknown>(SESSIONS_KEY);
      await this.context.globalState.update(SESSIONS_KEY, deleteEmbeddedSession(current, id));
    });
    this.sessionWrites = write.catch(() => {});
    return write;
  }

  /** Throws when this environment can't compare the spec's folders inside VS Code. */
  async validateFolder(spec: EmbeddedSpec): Promise<void> {
    const reason = await this.folderUnsupported(spec.paths);
    if (reason) throw new UnavailableError(reason);
    for (const file of spec.paths.filter(Boolean)) {
      if ((await this.files.stat(requireAbsolute(file)))?.type !== "folder") throw new Error(`Not a folder: ${file}`);
    }
  }

  /** Why folders can't be compared here (no helper, an old helper, browser VS Code), or undefined. */
  async folderUnsupported(paths: readonly string[] = []): Promise<string | undefined> {
    const denied = this.host.denial("folder", paths);
    if (denied) return denied.reason;
    if (paths.some(file => file && !this.files.isLocal(file)) && !this.host.folderCopies) return "Folder comparison needs folders on disk.";
    const helper = await this.engine.helper();
    if (!helper) {
      return "Folder comparison in VS Code needs the CompareCraft helper (comparecraft-backend), which isn't installed here. Install the CompareCraft desktop app, or set comparecraft.backendPath.";
    }
    return helper.supports(...FOLDER_METHODS) ? undefined : "Update CompareCraft: the installed backend lacks embedded folder comparison support.";
  }

  async supportsFolder(): Promise<boolean> {
    return !(await this.folderUnsupported());
  }

  /** What the webview of a panel showing `paths` may offer. */
  capabilities(paths: readonly string[]): WebviewCapabilities {
    return {
      desktop: !this.host.denial("desktop", paths),
      revealInOS: !this.host.denial("revealInOS", paths),
      restricted: Boolean(this.host.denial("save")),
    };
  }

  /** Tells every panel that trust or other capabilities changed. */
  broadcastCapabilities(): void {
    for (const panel of this.panels) panel.notify("host-capabilities", this.capabilities(panel.state.spec.paths));
  }

  private warnedFolderOptions = false;

  /**
   * Leaves out folder options the helper doesn't accept: an older desktop install rejects unknown
   * fields, which would fail every folder comparison. Warns once when an enabled option is dropped.
   */
  async folderOptions(options: Record<string, unknown>): Promise<Record<string, unknown>> {
    const backend = await this.engine.helper();
    if (!backend) throw new UnavailableError((await this.folderUnsupported()) ?? "Folder comparison needs the CompareCraft helper.");
    const { options: kept, dropped } = supportedFolderOptions(options, backend.info.capabilities.folderOptions);
    const enabled = dropped.filter(key => options[key] === true);
    if (enabled.length && !this.warnedFolderOptions) {
      this.warnedFolderOptions = true;
      const names = enabled.map(key => FOLDER_OPTION_NAMES[key] ?? key).join(" and ");
      this.host.log(`The CompareCraft backend ${backend.info.server.version} does not accept folder options: ${dropped.join(", ")}.`);
      void vscode.window.showWarningMessage(
        `The installed CompareCraft desktop app (${backend.info.server.version}) is older than this extension, so ${names} ${enabled.length > 1 ? "are" : "is"} off in folder comparisons. Update CompareCraft to use ${enabled.length > 1 ? "them" : "it"}.`
      );
    }
    return kept;
  }

  /** Folder Session Settings options the installed helper doesn't accept; the webview shows them disabled. */
  async unsupportedFolderOptions(): Promise<string[]> {
    const backend = await this.engine.helper();
    return backend ? unsupportedFolderOptions(backend.info.capabilities.folderOptions) : [];
  }

  folderSessions(): FolderSession[] {
    const value = this.context.globalState.get<unknown>(FOLDER_SESSIONS_KEY) ?? [];
    if (!Array.isArray(value)) throw new Error("Invalid stored folder session library.");
    return value.map(parseFolderSession).sort((a, b) => b.modified - a.modified);
  }

  private storageWrite: Promise<void> = Promise.resolve();
  updateSessions(update: (sessions: FolderSession[]) => FolderSession[]): Promise<void> {
    const write = this.storageWrite.then(() =>
      this.context.globalState.update(FOLDER_SESSIONS_KEY, update(this.folderSessions())));
    this.storageWrite = write.catch(error => this.host.log(`Folder session persistence failed: ${errorText(error)}`));
    return write;
  }

  broadcastSettings(): void {
    for (const panel of this.panels) panel.notify("settings-changed", null);
  }

  bindOrigin(parent: EmbeddedPanel, child: EmbeddedPanel): string {
    const bases = parent.state.spec.paths, paths = child.state.spec.paths;
    if (parent.state.spec.kind !== "folder" || paths.length !== 2 ||
      !paths.every((file, side) => withinFolder(bases[side] ?? "", file))) {
      throw new Error("The file comparison does not belong to this folder panel.");
    }
    if (this.origins.size >= 256) throw new Error("Too many originating file comparisons. Close some child panels first.");
    const token = randomHex(24);
    this.origins.set(child, { token, parent, paths: [...paths], epoch: parent.folderEpoch });
    return token;
  }

  releaseOrigins(panel: EmbeddedPanel): void {
    for (const [child, origin] of this.origins) {
      if (child === panel || origin.parent === panel) {
        origin.parent.notify("folder-origin-disposed", { token: origin.token });
        this.origins.delete(child);
      }
    }
  }

  async completeOrigin(child: EmbeddedPanel): Promise<void> {
    const origin = this.origins.get(child);
    if (!origin || origin.epoch !== origin.parent.folderEpoch || !this.panels.has(origin.parent)) return;
    const spec = child.state.spec;
    if (!origin.paths.every((file, side) => pathKey(file) === pathKey(spec.paths[side] ?? ""))) return;
    const sequence = child.completionSequence;
    try {
      const verdict = await diskVerdict(spec, <T>(method: string, params: Record<string, unknown>) => this.engine.request<T>(method, params));
      if (this.origins.get(child) !== origin || origin.epoch !== origin.parent.folderEpoch || child.completionSequence !== sequence) return;
      origin.parent.notify("folder-comparison", { token: origin.token, receipt: {
        paths: [...origin.paths], result: { status: verdict === "same" || verdict === "sameBinary" ? "same" :
          verdict === "similar" ? "similar" : "diff", content: verdict }
      } });
    } catch (error) {
      this.host.log(`Saved-disk comparison failed: ${errorText(error)}`);
      if (this.origins.get(child) === origin && origin.epoch === origin.parent.folderEpoch && child.completionSequence === sequence) {
        origin.parent.notify("folder-comparison", { token: origin.token, receipt: { paths: [...origin.paths], result: { status: "error", error: errorText(error) } } });
      }
    }
  }

  open(spec: EmbeddedSpec): EmbeddedPanel {
    // Kept alive while hidden: a reload would lose merge choices and undo history, and would re-read
    // files as their new baseline, hiding edits made in other tabs from the stale-write check.
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, titleOf(spec), vscode.ViewColumn.Active, { enableFindWidget: false, retainContextWhenHidden: true });
    return this.attach(panel, spec);
  }

  private attach(panel: vscode.WebviewPanel, spec: EmbeddedSpec): EmbeddedPanel {
    const embedded = new EmbeddedPanel(this, panel, spec);
    this.panels.add(embedded);
    panel.onDidDispose(() => this.panels.delete(embedded));
    return embedded;
  }

  /** Offers unsaved merged text from a merge that was closed or reloaded; resolution choices are not kept. */
  async offerMergedText(spec: EmbeddedSpec): Promise<void> {
    if (!spec.output) return;
    const choice = await vscode.window.showWarningMessage(
      `CompareCraft: "${titleOf(spec)}" had unsaved merge changes that cannot be restored as choices.`, "Open Merged Text as Untitled"
    );
    if (choice === "Open Merged Text as Untitled") {
      const document = await vscode.workspace.openTextDocument({ content: spec.output.join("\n") });
      await vscode.window.showTextDocument(document, { preview: false });
    }
  }

  /** Offers to recover unsaved side text from a comparison that was closed. */
  async offerRestore(spec: EmbeddedSpec): Promise<void> {
    const restore = spec.restore;
    if (!restore || (!restore[0] && !restore[1])) return;
    const choice = await vscode.window.showWarningMessage(
      `CompareCraft: "${titleOf(spec)}" was closed with unsaved changes.`, "Restore Comparison", "Open as Untitled"
    );
    if (choice === "Restore Comparison") {
      this.open(spec);
    } else if (choice === "Open as Untitled") {
      for (const lines of restore) {
        if (!lines) continue;
        const document = await vscode.workspace.openTextDocument({ content: lines.join("\n") });
        await vscode.window.showTextDocument(document, { preview: false });
      }
    }
  }

  dispose(): void {
    this.disposing = true;
    for (const panel of [...this.panels]) panel.panel.dispose();
  }
}

/** One webview comparison. VS Code documents are the source of truth for every editable side. */
export class EmbeddedPanel {
  folderEpoch = 0;
  completionSequence = 0;
  private completionTimer: ReturnType<typeof setTimeout> | undefined;
  private isDisposed = false;
  readonly guard = new DocumentGuard();
  /** Requests received from the webview (invoke commands by name), oldest first; for diagnostics and tests. */
  readonly received: string[] = [];
  private spec: EmbeddedSpec;
  private dirty: [boolean, boolean] = [false, false];
  private readonly saving = new Set<string>();
  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly deferred: (() => void)[] = [];
  /** Identifies this panel's copies of virtual folders. */
  private readonly copyOwner = randomHex(8);

  constructor(private readonly owner: EmbeddedPanels, readonly panel: vscode.WebviewPanel, spec: EmbeddedSpec) {
    this.spec = spec;
    if (spec.restore) this.dirty = [!!spec.restore[0], !!spec.restore[1]];
    const media = vscode.Uri.joinPath(owner.context.extensionUri, "media", "webview");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    this.disposables.push(
      panel.webview.onDidReceiveMessage(message => void this.onMessage(message)),
      vscode.workspace.onDidChangeTextDocument(event => this.documentChanged(event.document)),
      vscode.workspace.onDidSaveTextDocument(document => {
        if (this.spec.paths.some(file => file && pathKey(file) === pathKey(pathOf(document.uri)))) this.scheduleCompletion();
      }),
      panel.onDidDispose(() => this.disposed())
    );
    this.updateTitle();
    void this.render(media);
  }

  /** Current spec including unsaved side text, as last reported by the webview. */
  get state(): { spec: EmbeddedSpec; dirty: [boolean, boolean] } {
    return { spec: this.spec, dirty: [...this.dirty] };
  }

  private async render(media: vscode.Uri): Promise<void> {
    const webview = this.panel.webview;
    try {
      // Browser VS Code serves extension files over HTTP, where the file system API can't check them.
      if (media.scheme === "file") await vscode.workspace.fs.stat(vscode.Uri.joinPath(media, "webview.js"));
    } catch (error) {
      const reason = error instanceof vscode.FileSystemError
        ? "The embedded UI bundle is missing. Run npm run build:webview in the repository root, then reopen the comparison."
        : errorText(error);
      webview.html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"></head><body style="padding:1em">${escapeHtml(`CompareCraft: ${reason}`)}</body></html>`;
      return;
    }
    const nonce = randomBase64(16);
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "webview.css"));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>CompareCraft</title>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  private updateTitle(): void {
    this.panel.title = `${this.dirty[0] || this.dirty[1] ? "● " : ""}${titleOf(this.spec)}`;
  }

  private post(message: unknown): void {
    if (this.isDisposed) return;
    void this.panel.webview.postMessage(message);
  }

  private postEvent(event: string, payload: unknown): void {
    this.post({ type: "event", event, payload });
  }

  notify(event: string, payload: unknown): void {
    this.postEvent(event, payload);
  }

  private async onMessage(message: unknown): Promise<void> {
    if (!isObject(message)) return;
    if (message.type === "state") {
      try {
        const state = requireObject(message.state, "state");
        this.spec = parseSpec(state);
        if (this.spec.kind !== "folder") this.scheduleCompletion();
        const dirty = state.dirty;
        this.dirty = Array.isArray(dirty) ? [dirty[0] === true, dirty[1] === true] : [false, false];
        this.updateTitle();
      } catch (error) {
        this.owner.host.log(`Ignored invalid embedded state: ${errorText(error)}`);
      }
      return;
    }
    if (message.type !== "request" || typeof message.id !== "number" || typeof message.method !== "string") return;
    const params = message.params;
    if (this.received.length < 1000) this.received.push(message.method === "invoke" && isObject(params) && typeof params.cmd === "string" ? params.cmd : message.method);
    try {
      const result = await this.handle(message.method, params);
      this.post({ type: "response", id: message.id, ok: true, result: result ?? null });
    } catch (error) {
      if (!(error instanceof BackendError) && !(error instanceof Error && error.name === "ConflictError")) {
        this.owner.host.log(`Embedded ${message.method} failed: ${errorText(error)}`);
      }
      this.post({ type: "response", id: message.id, ok: false, error: errorText(error) });
    }
    for (const run of this.deferred.splice(0)) run();
  }

  /** Handles one validated webview request. Public so integration tests can drive real documents. */
  async handle(method: string, params: unknown): Promise<unknown> {
    const p = isObject(params) ? params : {};
    switch (method) {
      case "init":
        return this.spec;
      case "capabilities":
        return this.owner.capabilities(this.spec.paths);
      case "invoke":
        return this.invoke(requireString(p.cmd, "command"), isObject(p.args) ? p.args : {});
      case "ask": {
        const ok = typeof p.okLabel === "string" ? p.okLabel : "Yes";
        const text = requireString(p.message, "message");
        const show = p.kind === "error" ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
        return await show(text, { modal: true, detail: typeof p.title === "string" ? p.title : undefined }, ok) === ok;
      }
      case "message": {
        const text = requireString(p.message, "message");
        const show = p.kind === "error" ? vscode.window.showErrorMessage : p.kind === "warning" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
        void show(`CompareCraft: ${text}`);
        return "Ok";
      }
      case "open": {
        const picked = await vscode.window.showOpenDialog({
          title: typeof p.title === "string" ? p.title : undefined,
          canSelectMany: p.multiple === true,
          canSelectFiles: p.directory !== true,
          canSelectFolders: p.directory === true,
          filters: dialogFilters(p.filters),
          defaultUri: typeof p.defaultPath === "string" && isAbsolutePath(p.defaultPath) ? toUri(p.defaultPath) : undefined
        });
        if (!picked?.length) return null;
        return p.multiple === true ? picked.map(pathOf) : pathOf(picked[0]!);
      }
      case "save": {
        const picked = await vscode.window.showSaveDialog({
          title: typeof p.title === "string" ? p.title : undefined,
          filters: dialogFilters(p.filters),
          defaultUri: typeof p.defaultPath === "string" && isAbsolutePath(p.defaultPath) ? toUri(p.defaultPath) : undefined
        });
        return picked ? pathOf(picked) : null;
      }
      case "clipboard.read":
        return vscode.env.clipboard.readText();
      case "clipboard.write":
        return vscode.env.clipboard.writeText(requireString(p.text, "text"));
      case "openUrl": {
        const url = requireString(p.url, "URL");
        if (!/^(https?|mailto):/i.test(url)) throw new Error(`Refusing to open ${url}`);
        return vscode.env.openExternal(vscode.Uri.parse(url));
      }
      case "openPath":
        return vscode.commands.executeCommand("vscode.open", toUri(requireAbsolute(p.path)));
      case "reveal": {
        // Files of a remote host, a virtual workspace or browser VS Code are shown in VS Code's Explorer.
        const file = requireAbsolute(p.path);
        return vscode.commands.executeCommand(this.owner.host.denial("revealInOS", [file]) ? "revealInExplorer" : "revealFileInOS", toUri(file));
      }
      case "close":
        this.panel.dispose();
        return null;
      case "dropPaths":
        return droppedPaths(p.uris);
      case "folderSupport":
        return { unsupported: await this.owner.unsupportedFolderOptions() };
      case "desktopFolder":
        if (this.spec.kind !== "folder") throw new Error("This action requires a folder panel.");
        await this.owner.host.openInDesktop("folder", this.spec.paths);
        return null;
      case "openTab": {
        const kind = requireString(p.kind, "view kind");
        if (kind === "folder") {
          const spec = parseSpec(p);
          await this.owner.validateFolder(spec);
          this.owner.open(spec);
          return null;
        }
        if (kind === "text") {
          return this.openChild(parseSpec({ paths: p.paths, titles: p.titles, readOnly: p.readOnly, options: p.options }), p.origin);
        }
        const paths = Array.isArray(p.paths) ? p.paths.filter((item): item is string => typeof item === "string" && isAbsolutePath(item)) : [];
        if (kind === "edit") {
          // Single-file editing is VS Code's own editor; the desktop Text Edit view is not embedded.
          for (const file of paths.slice(0, 1)) await vscode.commands.executeCommand("vscode.open", toUri(file));
          return null;
        }
        // Every read-only view is available: the helper or the WebAssembly engine compares the files.
        if (isFileView(kind)) return this.openChild(parseSpec({ kind, paths: p.paths, titles: p.titles, options: p.options }), p.origin);
        await this.owner.host.openInDesktop(kind, paths);
        return null;
      }
      default:
        throw new Error(`Unknown embedded request: ${method}`);
    }
  }

  private backendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.owner.engine.request<T>(method, params);
  }

  private openChild(spec: EmbeddedSpec, origin: unknown): { originToken: string } | null {
    if (origin !== undefined && origin !== true) throw new Error("Invalid file comparison origin.");
    if (origin === true && (this.spec.kind !== "folder" || !spec.paths.every((file, side) => withinFolder(this.spec.paths[side] ?? "", file)))) {
      throw new Error("The file comparison does not belong to this folder panel.");
    }
    const child = this.owner.open(spec);
    try {
      if (origin !== true) return null;
      const originToken = this.owner.bindOrigin(this, child);
      child.scheduleCompletion();
      return { originToken };
    } catch (error) {
      child.panel.dispose();
      throw error;
    }
  }

  private scheduleCompletion(): void {
    this.completionSequence++;
    clearTimeout(this.completionTimer);
    this.completionTimer = setTimeout(() => void this.owner.completeOrigin(this), 300);
  }

  private async invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    const state = this.owner.context.globalState;
    switch (command) {
      case "load_text":
        {
          const result = await this.loadText(requireAbsolute(args.path));
          this.scheduleCompletion();
          return result;
        }
      case "save_text": {
        if (this.spec.kind === "folder") throw unsupportedCommand(command);
        const file = requireAbsolute(args.path);
        const merge = this.spec.kind === "merge";
        if (merge && pathKey(file) !== pathKey(this.spec.paths[3] ?? "")) throw new Error("A merge can only write its result file.");
        const info = await this.saveText(args);
        this.scheduleCompletion();
        if (merge) void this.owner.host.afterMergeSaved(file).catch(error => this.owner.host.log(`Merge follow-up failed: ${errorText(error)}`));
        return info;
      }
      case "diff_texts":
        return this.backendRequest("text.diff", {
          left: requireLines(args.left, "left text"), right: requireLines(args.right, "right text"), rules: requireObject(args.rules, "rules")
        });
      case "merge_texts":
        return this.backendRequest("text.merge", {
          base: requireLines(args.base, "base text"), left: requireLines(args.left, "left text"),
          right: requireLines(args.right, "right text"), rules: requireObject(args.rules, "rules")
        });
      case "path_info":
        return this.backendRequest("path.info", { path: requireAbsolute(args.path) });
      case "compare_folders": {
        this.folderEpoch++;
        this.owner.releaseOrigins(this);
        const left = requireAbsolute(args.left, "left folder"), right = requireAbsolute(args.right, "right folder");
        const options = await this.owner.folderOptions(requireObject(args.options, "folder options"));
        const local = await this.localFolders(left, right, "copy");
        return mapFolderErrors(await this.backendRequest("folder.compare", { left: local[0], right: local[1], options }), local, [left, right]);
      }
      case "compare_items": {
        const left = requireAbsolute(args.left, "left folder"), right = requireAbsolute(args.right, "right folder");
        const rels = requireLines(args.rels, "relative items");
        const options = await this.owner.folderOptions(requireObject(args.options, "folder options"));
        const local = await this.localFolders(left, right, rels);
        return mapFolderErrors(await this.backendRequest("folder.compareItems", { left: local[0], right: local[1], rels, options }), local, [left, right]);
      }
      case "quick_compare": {
        const mode = requireString(args.mode, "comparison mode");
        if (!["size", "crc", "binary", "rules"].includes(mode)) throw new Error("Invalid comparison mode.");
        return this.backendRequest("file.quickCompare", { left: requireAbsolute(args.left), right: requireAbsolute(args.right), mode });
      }
      case "read_bytes":
        return readBytes(this.owner.files, requireAbsolute(args.path), requireCount(args.offset, "offset"), requireCount(args.len, "length"));
      case "read_data_url":
        return readDataUrl(this.owner.files, requireAbsolute(args.path));
      case "hex_align": {
        const align = args.align ?? "complete";
        if (align !== "none" && align !== "fast" && align !== "complete") throw new Error("Invalid hex alignment.");
        return this.backendRequest("hex.align", { left: requireAbsolute(args.left, "left path"), right: requireAbsolute(args.right, "right path"), align });
      }
      case "compare_tables":
        return this.backendRequest("table.compare", {
          left: requireAbsolute(args.left, "left path"), right: requireAbsolute(args.right, "right path"), options: requireObject(args.options ?? {}, "table options")
        });
      case "pix_compare": {
        const params: Record<string, unknown> = {
          left: requireAbsolute(args.left, "left path"), right: requireAbsolute(args.right, "right path"),
          options: requireObject(args.options ?? {}, "picture options")
        };
        const leftData = optionalString(args.leftData, "left picture"), rightData = optionalString(args.rightData, "right picture");
        if (leftData !== null) params.leftData = leftData;
        if (rightData !== null) params.rightData = rightData;
        return this.backendRequest("pix.compare", params);
      }
      case "pix_image":
        return this.backendRequest("pix.image", { path: requireAbsolute(args.path) });
      case "load_settings":
        // The embedded UI has no Options dialog: wrapping follows VS Code (per-tab View > Word Wrap still applies).
        return { ...state.get<Record<string, unknown>>(SETTINGS_KEY), textWordWrap: editorWordWrap() };
      case "save_settings":
        await state.update(SETTINGS_KEY, requireObject(args.settings, "settings"));
        this.owner.broadcastSettings();
        return null;
      case "reset_settings":
        await state.update(SETTINGS_KEY, undefined);
        this.owner.broadcastSettings();
        return null;
      case "list_sessions":
        return this.spec.kind === "folder" ? this.owner.folderSessions() : this.owner.listSessions();
      case "find_session":
        return this.spec.kind === "folder"
          ? this.owner.folderSessions().find(session => session.saved && session.name.toLowerCase() === requireString(args.name, "session name").toLowerCase()) ?? null
          : this.owner.findSession(requireString(args.name, "session name"));
      case "take_launch_spec":
        return null;
      case "save_session": {
        if (this.spec.kind !== "folder") {
          await this.owner.saveSession(args.session);
          return null;
        }
        const session = parseFolderSession(args.session);
        await this.owner.updateSessions(sessions => upsertEmbeddedSession(sessions, session).map(parseFolderSession));
        return null;
      }
      case "delete_session": {
        const id = requireString(args.id, "session ID");
        if (this.spec.kind === "folder") await this.owner.updateSessions(sessions => sessions.filter(session => session.id !== id));
        else await this.owner.deleteSession(id);
        return null;
      }
      default:
        throw unsupportedCommand(command);
    }
  }

  /**
   * Folders the helper can read for this comparison: local folders as they are, virtual-workspace
   * folders as owned copies, refreshed whole (`"copy"`) or for the listed items.
   */
  private async localFolders(left: string, right: string, update: "copy" | readonly string[]): Promise<[string, string]> {
    const files = this.owner.files;
    if (files.isLocal(left) && files.isLocal(right)) return [left, right];
    const copies = this.owner.host.folderCopies;
    if (!copies) throw new UnavailableError((await this.owner.folderUnsupported([left, right])) ?? "Folder comparison needs folders on disk.");
    const sides = [left, right] as const;
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: "CompareCraft: reading folders for comparison", cancellable: true
    }, async (progress, token) => {
      const report: CopyProgress = {
        report: (count, bytes) => progress.report({ message: `${count} files (${Math.round(bytes / 1024)} KB)` }),
        cancelled: () => token.isCancellationRequested
      };
      if (update !== "copy") {
        await copies.refresh(this.copyOwner, sides.map((side, index) => files.isLocal(side) ? copies.side(this.copyOwner, index ? "right" : "left") : side) as [string, string],
          update, report);
      }
      const local: string[] = [];
      for (const [index, side] of sides.entries()) {
        const name = index === 0 ? "left" : "right";
        local.push(files.isLocal(side) ? side : update === "copy" ? await copies.copy(this.copyOwner, name, side, report) : copies.side(this.copyOwner, name));
      }
      return local as [string, string];
    });
  }

  private async loadText(file: string): Promise<TextFileResult> {
    let document: vscode.TextDocument | undefined;
    try {
      document = await vscode.workspace.openTextDocument(toUri(file));
    } catch (error) {
      // Binary or very large files: show them read-only with the desktop decoder.
      this.owner.host.log(`VS Code cannot open ${file} as text (${errorText(error)}); loading it read-only.`);
    }
    if (!document) {
      this.guard.forget(file);
      const result = await this.backendRequest<TextFileResult>("text.load", { path: file });
      return { ...result, readOnly: true };
    }
    const text = document.getText();
    this.guard.remember(file, text);
    this.watch(file);
    const info = await this.owner.files.stat(file).catch(() => undefined);
    // Restricted Mode and read-only file systems show the side read-only; saving is also refused below.
    const readOnly = !info || info.readOnly || Boolean(this.owner.host.denial("save", [file]));
    return textFileFromBuffer(file, text, eolOf(document), { size: info?.size ?? utf8(text).length, modified: info?.mtime ?? null, readOnly });
  }

  /**
   * Writes a side through its VS Code document so undo, dirty state, and save participants
   * behave as for any editor edit. Rejects when the document changed after this side loaded it.
   */
  private async saveText(args: Record<string, unknown>): Promise<unknown> {
    const file = requireAbsolute(args.path);
    assertAllowed(this.owner.host.denial("save", [file]));
    const lines = requireLines(args.lines, "lines");
    const finalNewline = args.finalNewline !== false;
    const key = pathKey(file);
    const existing = await this.owner.files.stat(file);
    if (existing && existing.type !== "file") throw new Error(`${file} is not a file.`);
    this.saving.add(key);
    try {
      if (!existing) {
        const text = joinLines(lines, args.eol === "CRLF" ? "\r\n" : "\n", finalNewline);
        await this.owner.files.create(file, utf8(text));
        this.guard.remember(file, text);
        this.watch(file);
      } else {
        const uri = toUri(file);
        const document = await vscode.workspace.openTextDocument(uri);
        const current = document.getText();
        // The merge view never shows the result file's buffer, so it must not replace unsaved edits made there.
        if (this.spec.kind === "merge" && document.isDirty) {
          throw new Error(`${basename(file)} has unsaved changes in another VS Code editor. Save or revert them there, then Refresh this merge before saving.`);
        }
        if (this.guard.has(file)) this.guard.assertUnchanged(file, current);
        else if (document.isDirty) throw new Error(`${basename(file)} has unsaved changes in VS Code. Save or revert them there first.`);
        const text = joinLines(lines, eolOf(document), finalNewline);
        if (text !== current) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(current.length)), text);
          if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code rejected the edit to ${file}.`);
        }
        if (document.isDirty && !(await document.save())) throw new Error(`VS Code could not save ${file}.`);
        const saved = document.getText();
        this.guard.remember(file, saved);
        this.watch(file);
        // Save participants (for example format on save) may change the text; show the result.
        if (saved !== text) this.deferred.push(() => this.postEvent("file-changed", file));
      }
    } finally {
      this.saving.delete(key);
    }
    const info = await this.owner.files.stat(file);
    return { path: file, exists: true, isDir: false, size: info?.size ?? 0, modified: info?.mtime ?? null, kind: "file" };
  }

  private watch(file: string): void {
    const key = pathKey(file);
    if (this.watchers.has(key)) return;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(toUri(dirname(file)), basename(file)));
    const check = () => void this.checkDisk(file);
    watcher.onDidChange(check);
    watcher.onDidCreate(check);
    this.watchers.set(key, watcher);
  }

  private async checkDisk(file: string): Promise<void> {
    if (this.saving.has(pathKey(file))) return;
    try {
      this.documentChanged(await vscode.workspace.openTextDocument(toUri(file)));
    } catch {
      /* not readable as text right now; the next change or a reload reports it */
    }
  }

  private documentChanged(document: vscode.TextDocument): void {
    if (document.uri.scheme === "untitled") return;
    const file = pathOf(document.uri);
    if (this.saving.has(pathKey(file))) return;
    for (const changed of this.guard.changed(file, document.getText())) this.postEvent("file-changed", changed);
  }

  private disposed(): void {
    this.isDisposed = true;
    clearTimeout(this.completionTimer);
    this.owner.releaseOrigins(this);
    void this.owner.host.folderCopies?.release(this.copyOwner).catch(error => this.owner.host.log(`Could not remove folder copies: ${errorText(error)}`));
    for (const disposable of [...this.disposables, ...this.watchers.values()]) disposable.dispose();
    this.watchers.clear();
    if (!this.owner.isDisposing && (this.dirty[0] || this.dirty[1])) {
      void (this.spec.kind === "merge" ? this.owner.offerMergedText(this.spec) : this.owner.offerRestore(this.spec));
    }
  }
}

/** Rewrites helper error messages that name folder copies to name the original folders. */
function mapFolderErrors<T>(result: T, local: readonly string[], original: readonly string[]): T {
  const replacements = local.map((folder, index) => [folder, original[index]!] as const).filter(([folder, source]) => folder !== source);
  if (!replacements.length) return result;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (isObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (key === "error" && typeof item === "string") {
          value[key] = replacements.reduce((text, [folder, source]) => text.split(folder).join(source), item);
        } else visit(item);
      }
    }
  };
  visit(result);
  return result;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

function requireCount(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}.`);
  return value;
}

function optionalString(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, name);
}
