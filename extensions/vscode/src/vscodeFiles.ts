/** `FileAccess` through VS Code's file system providers: any URI scheme, in every extension host. */
import * as vscode from "vscode";
import type { EntryType, FileAccess, FileInfo } from "./fileAccess";
import { pathKey } from "./paths";
import { toUri } from "./uris";

/** Whole-file reads cached for paged readers (the hex view reads 4 MB pages). */
const CACHE_ENTRIES = 2;
const CACHE_MAX_BYTES = 64 << 20;

const entryType = (type: vscode.FileType): EntryType =>
  type & vscode.FileType.Directory ? "folder" : type & vscode.FileType.File ? "file" : "other";

const missing = (error: unknown): boolean =>
  error instanceof vscode.FileSystemError && (error.code === "FileNotFound" || error.code === "EntryNotFound");

export class VscodeFiles implements FileAccess {
  private readonly cache: { key: string; stamp: string; bytes: Uint8Array }[] = [];

  isLocal(): boolean {
    return false;
  }

  async stat(path: string): Promise<FileInfo | undefined> {
    const uri = toUri(path);
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    const readOnly = Boolean((stat.permissions ?? 0) & vscode.FilePermission.Readonly) || vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false;
    return { type: entryType(stat.type), size: stat.size, mtime: stat.mtime || null, readOnly };
  }

  async readFile(path: string): Promise<Uint8Array> {
    return vscode.workspace.fs.readFile(toUri(path));
  }

  async read(path: string, offset: number, length: number): Promise<Uint8Array> {
    const stat = await vscode.workspace.fs.stat(toUri(path));
    const key = pathKey(path), stamp = `${stat.size}:${stat.mtime}`;
    let entry = this.cache.find(item => item.key === key && item.stamp === stamp);
    if (!entry) {
      entry = { key, stamp, bytes: await this.readFile(path) };
      const index = this.cache.findIndex(item => item.key === key);
      if (index >= 0) this.cache.splice(index, 1);
      if (entry.bytes.length <= CACHE_MAX_BYTES) {
        this.cache.unshift(entry);
        this.cache.length = Math.min(this.cache.length, CACHE_ENTRIES);
      }
    }
    return entry.bytes.subarray(Math.min(offset, entry.bytes.length), Math.min(offset + length, entry.bytes.length));
  }

  async list(path: string): Promise<[string, EntryType][]> {
    return (await vscode.workspace.fs.readDirectory(toUri(path))).map(([name, type]) => [name, entryType(type)]);
  }

  async create(path: string, data: Uint8Array): Promise<void> {
    const uri = toUri(path);
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: false, ignoreIfExists: false, contents: data });
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code could not create ${uri.toString(true)}; it may already exist.`);
  }

  async realpath(path: string): Promise<string> {
    return path;
  }
}
