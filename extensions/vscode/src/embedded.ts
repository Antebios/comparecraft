import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { access, constants, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { BackendError, type BackendManager } from "./backend";
import {
  dialogFilters, DocumentGuard, isFileView, joinLines, parseSpec, pathKey, readBytes, readDataUrl, requireAbsolute, requireLines, requireObject, requireString,
  textFileFromBuffer, titleOf, unsupportedCommand, VIEW_METHODS, type EmbeddedSpec, type FileView, type TextFileResult
} from "./embeddedCore";

export { specFromInputs } from "./embeddedCore";

export const VIEW_TYPE = "comparecraft.textCompare";
const SETTINGS_KEY = "comparecraft.embeddedSettings";

export interface EmbeddedHost {
  assertSupported(): void;
  log(message: string): void;
  /** Offers to open a view the embedded panel does not provide in the desktop app; `reason` says why. */
  openInDesktop(kind: string, paths: readonly string[], reason?: string): Promise<void>;
  /** Called after a merge result is written; offers explicit review and staging. */
  afterMergeSaved(file: string): Promise<void>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const eolOf = (document: vscode.TextDocument): "\n" | "\r\n" => document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";

/** Owns every embedded comparison panel, including panels restored after a window reload. */
export class EmbeddedPanels implements vscode.Disposable {
  private readonly panels = new Set<EmbeddedPanel>();
  private disposing = false;

  constructor(readonly context: vscode.ExtensionContext, readonly backend: BackendManager, readonly host: EmbeddedHost) {
    context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state) => {
        try {
          const spec = parseSpec(state);
          this.attach(panel, { ...spec, output: null });
          if (spec.kind === "merge" && spec.output) void this.offerMergedText(spec);
        } catch (error) {
          host.log(`Discarded an embedded comparison that could not be restored: ${errorText(error)}`);
          panel.dispose();
        }
      }
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

  /** True when the installed helper has every method the read-only view needs. */
  async supportsView(kind: FileView): Promise<boolean> {
    const methods = VIEW_METHODS[kind];
    return methods.length === 0 || (await this.backend.get()).supports(...methods);
  }

  open(spec: EmbeddedSpec): EmbeddedPanel {
    this.host.assertSupported();
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
  readonly guard = new DocumentGuard();
  /** Requests received from the webview (invoke commands by name), oldest first; for diagnostics and tests. */
  readonly received: string[] = [];
  private spec: EmbeddedSpec;
  private dirty: [boolean, boolean] = [false, false];
  private readonly saving = new Set<string>();
  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly deferred: (() => void)[] = [];

  constructor(private readonly owner: EmbeddedPanels, readonly panel: vscode.WebviewPanel, spec: EmbeddedSpec) {
    this.spec = spec;
    if (spec.restore) this.dirty = [!!spec.restore[0], !!spec.restore[1]];
    const media = vscode.Uri.joinPath(owner.context.extensionUri, "media", "webview");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    this.disposables.push(
      panel.webview.onDidReceiveMessage(message => void this.onMessage(message)),
      vscode.workspace.onDidChangeTextDocument(event => this.documentChanged(event.document)),
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
      this.owner.host.assertSupported();
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(media, "webview.js"));
    } catch (error) {
      const reason = error instanceof vscode.FileSystemError
        ? "The embedded UI bundle is missing. Run npm run build:webview in the repository root, then reopen the comparison."
        : errorText(error);
      webview.html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"></head><body style="padding:1em">${escapeHtml(`CompareCraft: ${reason}`)}</body></html>`;
      return;
    }
    const nonce = randomBytes(16).toString("base64");
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
    void this.panel.webview.postMessage(message);
  }

  private postEvent(event: string, payload: unknown): void {
    this.post({ type: "event", event, payload });
  }

  private async onMessage(message: unknown): Promise<void> {
    if (!isObject(message)) return;
    if (message.type === "state") {
      try {
        const state = requireObject(message.state, "state");
        this.spec = parseSpec(state);
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
          defaultUri: typeof p.defaultPath === "string" && path.isAbsolute(p.defaultPath) ? vscode.Uri.file(p.defaultPath) : undefined
        });
        if (!picked?.length) return null;
        if (picked.some(uri => uri.scheme !== "file")) throw new Error("Choose a local file.");
        return p.multiple === true ? picked.map(uri => uri.fsPath) : picked[0]!.fsPath;
      }
      case "save": {
        const picked = await vscode.window.showSaveDialog({
          title: typeof p.title === "string" ? p.title : undefined,
          filters: dialogFilters(p.filters),
          defaultUri: typeof p.defaultPath === "string" && path.isAbsolute(p.defaultPath) ? vscode.Uri.file(p.defaultPath) : undefined
        });
        if (!picked) return null;
        if (picked.scheme !== "file") throw new Error("Choose a local file.");
        return picked.fsPath;
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
        return vscode.commands.executeCommand("vscode.open", vscode.Uri.file(requireAbsolute(p.path)));
      case "reveal":
        return vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(requireAbsolute(p.path)));
      case "close":
        this.panel.dispose();
        return null;
      case "openTab": {
        const kind = requireString(p.kind, "view kind");
        if (kind === "text") {
          this.owner.open(parseSpec({ paths: p.paths, titles: p.titles, readOnly: p.readOnly, options: p.options }));
          return null;
        }
        const paths = Array.isArray(p.paths) ? p.paths.filter((item): item is string => typeof item === "string" && path.isAbsolute(item)) : [];
        if (kind === "edit") {
          // Single-file editing is VS Code's own editor; the desktop Text Edit view is not embedded.
          for (const file of paths.slice(0, 1)) await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file));
          return null;
        }
        if (isFileView(kind)) {
          if (await this.owner.supportsView(kind)) {
            this.owner.open(parseSpec({ kind, paths: p.paths, titles: p.titles, options: p.options }));
            return null;
          }
          await this.owner.host.openInDesktop(kind, paths, `The installed CompareCraft backend is too old for the embedded ${kind} view. Update CompareCraft to show it in VS Code.`);
          return null;
        }
        await this.owner.host.openInDesktop(kind, paths);
        return null;
      }
      default:
        throw new Error(`Unknown embedded request: ${method}`);
    }
  }

  private async backendRequest<T>(method: string, params: unknown): Promise<T> {
    return (await this.owner.backend.get()).request<T>(method, params);
  }

  private async invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    const state = this.owner.context.globalState;
    switch (command) {
      case "load_text":
        return this.loadText(requireAbsolute(args.path));
      case "save_text": {
        const file = requireAbsolute(args.path);
        const merge = this.spec.kind === "merge";
        if (merge && pathKey(file) !== pathKey(this.spec.paths[3] ?? "")) throw new Error("A merge can only write its result file.");
        const info = await this.saveText(args);
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
      case "read_bytes":
        return readBytes(requireAbsolute(args.path), requireCount(args.offset, "offset"), requireCount(args.len, "length"));
      case "read_data_url":
        return readDataUrl(requireAbsolute(args.path));
      case "hex_align": {
        const align = args.align ?? "complete";
        if (align !== "none" && align !== "fast" && align !== "complete") throw new Error("Invalid hex alignment.");
        return this.backendRequest("hex.align", { left: requireAbsolute(args.left, "left path"), right: requireAbsolute(args.right, "right path"), align });
      }
      case "compare_tables":
        return this.backendRequest("table.compare", {
          left: requireAbsolute(args.left, "left path"), right: requireAbsolute(args.right, "right path"), options: requireObject(args.options ?? {}, "table options")
        });
      case "pix_compare":
        return this.backendRequest("pix.compare", {
          left: requireAbsolute(args.left, "left path"), right: requireAbsolute(args.right, "right path"),
          options: requireObject(args.options ?? {}, "picture options"),
          leftData: optionalString(args.leftData, "left picture"), rightData: optionalString(args.rightData, "right picture")
        });
      case "pix_image":
        return this.backendRequest("pix.image", { path: requireAbsolute(args.path) });
      case "load_settings":
        return state.get<Record<string, unknown>>(SETTINGS_KEY) ?? {};
      case "save_settings":
        return state.update(SETTINGS_KEY, requireObject(args.settings, "settings"));
      case "reset_settings":
        return state.update(SETTINGS_KEY, undefined);
      case "list_sessions":
        return [];
      case "find_session":
      case "take_launch_spec":
        return null;
      case "save_session":
      case "delete_session":
        return null;
      default:
        throw unsupportedCommand(command);
    }
  }

  private async loadText(file: string): Promise<TextFileResult> {
    let document: vscode.TextDocument | undefined;
    try {
      document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
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
    const info = await stat(file).catch(() => undefined);
    const writable = await access(file, constants.W_OK).then(() => true, () => false);
    return textFileFromBuffer(file, text, eolOf(document), {
      size: info?.size ?? Buffer.byteLength(text), modified: info ? Math.round(info.mtimeMs) : null, readOnly: !writable
    });
  }

  /**
   * Writes a side through its VS Code document so undo, dirty state, and save participants
   * behave as for any editor edit. Rejects when the document changed after this side loaded it.
   */
  private async saveText(args: Record<string, unknown>): Promise<unknown> {
    const file = requireAbsolute(args.path);
    const lines = requireLines(args.lines, "lines");
    const finalNewline = args.finalNewline !== false;
    const key = pathKey(file);
    const exists = await stat(file).then(info => {
      if (!info.isFile()) throw new Error(`${file} is not a file.`);
      return true;
    }, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    this.saving.add(key);
    try {
      if (!exists) {
        const text = joinLines(lines, args.eol === "CRLF" ? "\r\n" : "\n", finalNewline);
        await writeFile(file, text, { encoding: "utf8", flag: "wx" });
        this.guard.remember(file, text);
        this.watch(file);
      } else {
        const uri = vscode.Uri.file(file);
        const document = await vscode.workspace.openTextDocument(uri);
        const current = document.getText();
        // The merge view never shows the result file's buffer, so it must not replace unsaved edits made there.
        if (this.spec.kind === "merge" && document.isDirty) {
          throw new Error(`${path.basename(file)} has unsaved changes in another VS Code editor. Save or revert them there, then Refresh this merge before saving.`);
        }
        if (this.guard.has(file)) this.guard.assertUnchanged(file, current);
        else if (document.isDirty) throw new Error(`${path.basename(file)} has unsaved changes in VS Code. Save or revert them there first.`);
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
    const info = await stat(file);
    return { path: file, exists: true, isDir: false, size: info.size, modified: Math.round(info.mtimeMs), kind: "file" };
  }

  private watch(file: string): void {
    const key = pathKey(file);
    if (this.watchers.has(key)) return;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
    const check = () => void this.checkDisk(file);
    watcher.onDidChange(check);
    watcher.onDidCreate(check);
    this.watchers.set(key, watcher);
  }

  private async checkDisk(file: string): Promise<void> {
    if (this.saving.has(pathKey(file))) return;
    try {
      this.documentChanged(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    } catch {
      /* not readable as text right now; the next change or a reload reports it */
    }
  }

  private documentChanged(document: vscode.TextDocument): void {
    if (document.uri.scheme !== "file" || this.saving.has(pathKey(document.uri.fsPath))) return;
    for (const file of this.guard.changed(document.uri.fsPath, document.getText())) this.postEvent("file-changed", file);
  }

  private disposed(): void {
    for (const disposable of [...this.disposables, ...this.watchers.values()]) disposable.dispose();
    this.watchers.clear();
    if (!this.owner.isDisposing && (this.dirty[0] || this.dirty[1])) {
      void (this.spec.kind === "merge" ? this.owner.offerMergedText(this.spec) : this.owner.offerRestore(this.spec));
    }
  }
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
