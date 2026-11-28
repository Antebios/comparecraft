import * as vscode from "vscode";

interface Entry {
  type: vscode.FileType;
  data?: Uint8Array;
  mtime: number;
}

/** In-memory file system provider standing in for virtual workspaces (GitHub repositories and the like). */
export class MemoryFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly entries = new Map<string, Entry>([["/", { type: vscode.FileType.Directory, mtime: Date.now() }]]);

  constructor(readonly scheme: string) {}

  uri(path: string): vscode.Uri {
    return vscode.Uri.from({ scheme: this.scheme, path });
  }

  /** Adds a file (creating its folders); strings are UTF-8. */
  put(path: string, content: string | Uint8Array, mtime = Date.UTC(2024, 0, 1)): vscode.Uri {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const folder = `/${parts.slice(0, i).join("/")}`;
      if (!this.entries.has(folder)) this.entries.set(folder, { type: vscode.FileType.Directory, mtime });
    }
    this.entries.set(`/${parts.join("/")}`, { type: vscode.FileType.File, data: typeof content === "string" ? new TextEncoder().encode(content) : content, mtime });
    return this.uri(`/${parts.join("/")}`);
  }

  text(path: string): string {
    return new TextDecoder().decode(this.entries.get(path)?.data);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const entry = this.entries.get(uri.path);
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: entry.type, ctime: entry.mtime, mtime: entry.mtime, size: entry.data?.length ?? 0 };
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const prefix = uri.path === "/" ? "/" : `${uri.path}/`;
    return [...this.entries].filter(([path]) => path !== uri.path && path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map(([path, entry]) => [path.slice(prefix.length), entry.type]);
  }

  createDirectory(uri: vscode.Uri): void {
    this.entries.set(uri.path, { type: vscode.FileType.Directory, mtime: Date.now() });
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const entry = this.entries.get(uri.path);
    if (!entry?.data) throw vscode.FileSystemError.FileNotFound(uri);
    return entry.data;
  }

  writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void {
    const exists = this.entries.has(uri.path);
    if (!exists && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
    if (exists && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
    this.entries.set(uri.path, { type: vscode.FileType.File, data: content, mtime: Date.now() });
    this.emitter.fire([{ type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
  }

  delete(uri: vscode.Uri): void {
    this.entries.delete(uri.path);
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
    const entry = this.entries.get(oldUri.path);
    if (!entry) throw vscode.FileSystemError.FileNotFound(oldUri);
    this.entries.delete(oldUri.path);
    this.entries.set(newUri.path, entry);
  }
}
