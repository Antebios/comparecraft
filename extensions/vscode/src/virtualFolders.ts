/**
 * Read-only copies of virtual-workspace folders (for example a GitHub repository opened without cloning)
 * so the helper can compare them like folders on disk. Copies keep file sizes and modification times and
 * are bounded; folder results refer to items by relative path, so panels keep the original URIs.
 * Node extension hosts only.
 */
import { mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { UnavailableError } from "./errors";
import type { FileAccess } from "./fileAccess";
import { basename, joinPath } from "./paths";
import { isProcessAlive } from "./snapshots";

export interface SnapshotLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

export const DEFAULT_LIMITS: SnapshotLimits = { maxFiles: 20_000, maxBytes: 512 << 20 };

export interface CopyProgress {
  report(files: number, bytes: number): void;
  cancelled(): boolean;
}

export class CancelledError extends Error {
  constructor() {
    super("The folder copy was cancelled.");
    this.name = "CancelledError";
  }
}

const CONCURRENT_READS = 8;
const INVALID_NAME = process.platform === "win32" ? /[<>:"/\\|?*\u0000-\u001f]|[. ]$/ : /[/\u0000]/;

export class VirtualFolderSnapshots {
  constructor(private readonly root: string, private readonly files: FileAccess, private readonly limits: SnapshotLimits = DEFAULT_LIMITS) {}

  private directory(owner: string): string {
    return path.join(this.root, `${process.pid}-${owner}`);
  }

  /** Local copy of one side of a panel's folder comparison. */
  side(owner: string, side: "left" | "right"): string {
    return path.join(this.directory(owner), side);
  }

  /** Removes copies left behind by extension hosts that are no longer running. */
  async sweep(): Promise<number> {
    let removed = 0;
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const pid = Number(/^(\d+)-/.exec(entry)?.[1]);
      if (Number.isSafeInteger(pid) && pid !== process.pid && !isProcessAlive(pid)) {
        await rm(path.join(this.root, entry), { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }

  /** Replaces the copy of `side` with the folder `source` (a URI string); returns the local folder. */
  async copy(owner: string, side: "left" | "right", source: string, progress: CopyProgress): Promise<string> {
    const target = this.side(owner, side);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await this.copyTree(source, target, { files: 0, bytes: 0 }, progress);
    return target;
  }

  /** Refreshes the copies of items (relative paths) of both sides before comparing them again. */
  async refresh(owner: string, sources: readonly [string, string], rels: readonly string[], progress: CopyProgress): Promise<void> {
    const counts = { files: 0, bytes: 0 };
    for (const [index, source] of sources.entries()) {
      const base = this.side(owner, index === 0 ? "left" : "right");
      for (const rel of rels) {
        if (rel.split("/").some(segment => !segment || segment === "." || segment === "..")) throw new Error(`Invalid item path: ${rel}`);
        const target = path.join(base, ...rel.split("/"));
        await rm(target, { recursive: true, force: true });
        const item = joinPath(source, rel);
        const info = await this.files.stat(item);
        if (info?.type === "folder") {
          await mkdir(target, { recursive: true });
          await this.copyTree(item, target, counts, progress);
        } else if (info?.type === "file") {
          await mkdir(path.dirname(target), { recursive: true });
          await this.copyFile(item, target, counts);
        }
      }
    }
  }

  async release(owner: string): Promise<void> {
    await rm(this.directory(owner), { recursive: true, force: true });
  }

  private async copyTree(source: string, target: string, counts: { files: number; bytes: number }, progress: CopyProgress): Promise<void> {
    const queue: [string, string][] = [[source, target]];
    while (queue.length) {
      const [folder, local] = queue.shift()!;
      const files: [string, string][] = [];
      for (const [name, type] of await this.files.list(folder)) {
        if (progress.cancelled()) throw new CancelledError();
        if (!name || name === "." || name === ".." || INVALID_NAME.test(name)) {
          throw new UnavailableError(`"${name}" in ${basename(folder) || folder} can't be stored as a file name on this computer, so this folder can't be compared here.`);
        }
        const item = joinPath(folder, name), copy = path.join(local, name);
        if (type === "folder") {
          await mkdir(copy).catch(error => { throw collision(error, name); });
          queue.push([item, copy]);
        } else if (type === "file") {
          files.push([item, copy]);
        }
      }
      for (let start = 0; start < files.length; start += CONCURRENT_READS) {
        if (progress.cancelled()) throw new CancelledError();
        await Promise.all(files.slice(start, start + CONCURRENT_READS).map(([item, copy]) => this.copyFile(item, copy, counts)));
        progress.report(counts.files, counts.bytes);
      }
    }
  }

  private async copyFile(item: string, copy: string, counts: { files: number; bytes: number }): Promise<void> {
    const info = await this.files.stat(item);
    if (!info || info.type !== "file") return;
    if (++counts.files > this.limits.maxFiles) {
      throw new UnavailableError(`This folder comparison has more than ${this.limits.maxFiles} files, the most CompareCraft copies from a virtual workspace. Compare a smaller folder, or clone the repository.`);
    }
    counts.bytes += info.size;
    if (counts.bytes > this.limits.maxBytes) {
      throw new UnavailableError(`This folder comparison has more than ${Math.round(this.limits.maxBytes / (1 << 20))} MB of files, the most CompareCraft copies from a virtual workspace. Compare a smaller folder, or clone the repository.`);
    }
    await writeFile(copy, await this.files.readFile(item), { flag: "wx" }).catch(error => { throw collision(error, basename(item)); });
    if (info.mtime) await utimes(copy, new Date(info.mtime), new Date(info.mtime));
  }
}

function collision(error: unknown, name: string): Error {
  if (error instanceof Error && "code" in error && error.code === "EEXIST") {
    return new UnavailableError(`"${name}" differs from another item only in letter case, which this computer's file system can't store, so this folder can't be compared here.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}
