import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const MARKER = ".comparecraft-snapshot.json";
const HOUR = 60 * 60 * 1000;

interface Marker {
  readonly version: 1;
  readonly createdAt: number;
  readonly pid?: number;
}

export interface SweepOptions {
  readonly now?: number;
  /** Sessions that never recorded a desktop process are kept this long (launch may be in progress in another window). */
  readonly unattachedGraceMs?: number;
  /** Hard limit, also guarding against process-ID reuse. */
  readonly maxAgeMs?: number;
  readonly isAlive?: (pid: number) => boolean;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Keeps the original extension so the desktop app picks a matching viewer. */
export function snapshotName(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/"));
  const clean = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  return clean || "snapshot.txt";
}

async function makeWritable(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeWritable(full);
    else await chmod(full, 0o644).catch(() => undefined);
  }
}

export class SnapshotSession {
  private released = false;
  private marker: Marker;

  constructor(readonly directory: string, createdAt: number) {
    this.marker = { version: 1, createdAt };
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(path.join(this.directory, MARKER), JSON.stringify(this.marker));
  }

  /** Writes an immutable snapshot for one side; content is never used as a write-back destination. */
  async write(side: string, name: string, content: string | Uint8Array): Promise<string> {
    if (this.released) throw new Error("Snapshot session was already released.");
    const directory = path.join(this.directory, side);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, snapshotName(name));
    await writeFile(file, content, { flag: "wx" });
    await chmod(file, 0o444);
    return file;
  }

  /** Records the desktop process that owns these snapshots so other windows keep them while it runs. */
  async attach(pid: number): Promise<void> {
    if (this.released) return;
    this.marker = { ...this.marker, pid };
    try {
      await writeFile(path.join(this.directory, MARKER), JSON.stringify(this.marker));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await removeOwned(this.directory);
  }
}

async function removeOwned(directory: string): Promise<void> {
  try {
    await makeWritable(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

export class SnapshotStore {
  constructor(readonly root: string, private readonly now: () => number = Date.now) {}

  async create(): Promise<SnapshotSession> {
    const createdAt = this.now();
    const session = new SnapshotSession(path.join(this.root, `${createdAt}-${randomBytes(6).toString("hex")}`), createdAt);
    await session.init();
    return session;
  }

  /**
   * Removes only directories carrying this extension's marker whose desktop process has ended,
   * that never attached a process within the grace period, or that exceed the hard age limit.
   */
  async sweep(options: SweepOptions = {}): Promise<string[]> {
    const now = options.now ?? this.now();
    const grace = options.unattachedGraceMs ?? 24 * HOUR;
    const maxAge = options.maxAgeMs ?? 7 * 24 * HOUR;
    const alive = options.isAlive ?? isProcessAlive;
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.root, entry.name);
      let marker: Partial<Marker>;
      try {
        marker = JSON.parse(await readFile(path.join(directory, MARKER), "utf8")) as Partial<Marker>;
      } catch {
        continue; // Not provably ours.
      }
      if (marker.version !== 1 || typeof marker.createdAt !== "number") continue;
      const age = Math.max(0, now - marker.createdAt);
      const expired = age > maxAge ||
        (typeof marker.pid === "number" ? !alive(marker.pid) : age > grace);
      if (!expired) continue;
      await removeOwned(directory);
      removed.push(directory);
    }
    return removed;
  }
}
