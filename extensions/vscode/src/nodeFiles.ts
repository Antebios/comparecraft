/**
 * Node `FileAccess`: files on the extension host's own disk through `fs` (as the helper sees them),
 * URI strings through the VS Code providers. Desktop and remote extension hosts only.
 */
import { access, constants, open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import type { EntryType, FileAccess, FileInfo } from "./fileAccess";
import { isUriString } from "./paths";

export class NodeFiles implements FileAccess {
  constructor(private readonly other: FileAccess) {}

  isLocal(path: string): boolean {
    return !isUriString(path);
  }

  async stat(path: string): Promise<FileInfo | undefined> {
    if (!this.isLocal(path)) return this.other.stat(path);
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return undefined;
      throw error;
    }
    const writable = await access(path, constants.W_OK).then(() => true, () => false);
    return {
      type: info.isDirectory() ? "folder" : info.isFile() ? "file" : "other",
      size: info.size,
      mtime: Math.round(info.mtimeMs),
      readOnly: !writable
    };
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.isLocal(path) ? readFile(path) : this.other.readFile(path);
  }

  async read(path: string, offset: number, length: number): Promise<Uint8Array> {
    if (!this.isLocal(path)) return this.other.read(path, offset, length);
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, offset + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled);
    } finally {
      await handle.close();
    }
  }

  async list(path: string): Promise<[string, EntryType][]> {
    if (!this.isLocal(path)) return this.other.list(path);
    return (await readdir(path, { withFileTypes: true })).map(entry =>
      [entry.name, entry.isDirectory() ? "folder" : entry.isFile() ? "file" : "other"]);
  }

  async create(path: string, data: Uint8Array): Promise<void> {
    if (!this.isLocal(path)) return this.other.create(path, data);
    await writeFile(path, data, { flag: "wx" });
  }

  async realpath(path: string): Promise<string> {
    return this.isLocal(path) ? realpath(path) : this.other.realpath(path);
  }
}
