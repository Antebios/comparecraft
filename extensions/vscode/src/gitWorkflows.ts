import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ConflictError, conflictPlan, hasConflictMarkers, isBinary, stageSignature } from "./conflicts";
import type { CompareOptions } from "./controller";
import type { SideInput } from "./contracts";
import type { Git, RepositoryFile, RevisionEntry } from "./git";

export interface GitHost {
  assertSupported(): void;
  bufferText(filePath: string): Promise<string | undefined>;
  isDirty(filePath: string): Promise<boolean>;
  /** Modal confirmation; resolves true only when the named action is chosen. */
  confirm(message: string, detail: string, action: string): Promise<boolean>;
  pickRevision(entries: readonly RevisionEntry[]): Promise<RevisionEntry | undefined>;
  /** Non-modal offer after the merge window closes; true when the user chooses to stage. */
  offerStage(message: string): Promise<boolean>;
  notify(message: string): void;
  warn(message: string): void;
}

export type Compare = (inputs: readonly SideInput[], options?: CompareOptions) => Promise<boolean>;

interface PendingResolution {
  readonly signature: string;
  readonly mtimeMs: number;
}

const empty = (name: string, title: string): SideInput => ({ kind: "content", name, title, content: "" });

export class GitWorkflows {
  private readonly pending = new Map<string, PendingResolution>();

  constructor(private readonly git: Git, private readonly compare: Compare, private readonly host: GitHost) {}

  private key(file: RepositoryFile): string {
    return process.platform === "win32" ? file.absolute.toLowerCase() : file.absolute;
  }

  private async revision(file: RepositoryFile, spec: string, label: string): Promise<SideInput> {
    const name = path.posix.basename(file.relative);
    const content = await this.git.blob(file.root, spec);
    return content === undefined
      ? empty(name, `${name} (not in ${label})`)
      : { kind: "content", name, title: `${name} (${label})`, content };
  }

  private async working(file: RepositoryFile): Promise<SideInput> {
    const name = path.posix.basename(file.relative);
    const text = await this.host.bufferText(file.absolute);
    if (text !== undefined) return { kind: "content", name, title: `${name} (unsaved buffer)`, content: text };
    try {
      if (!(await stat(file.absolute)).isFile()) throw new ConflictError(`${file.absolute} is not a file.`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return empty(name, `${name} (deleted in working tree)`);
      throw error;
    }
    return { kind: "path", path: file.absolute, title: `${name} (working tree)` };
  }

  private async resolve(filePath: string): Promise<RepositoryFile> {
    this.host.assertSupported();
    return this.git.file(filePath);
  }

  private async assertNotConflicted(file: RepositoryFile): Promise<void> {
    if ((await this.git.unmerged(file.root, file.relative)).length > 0) {
      throw new ConflictError(`${file.relative} has unresolved conflicts. Use CompareCraft: Resolve Conflict in Desktop App.`);
    }
  }

  async compareHeadWorking(filePath: string): Promise<void> {
    const file = await this.resolve(filePath);
    await this.compare([await this.revision(file, `HEAD:${file.relative}`, "HEAD"), await this.working(file)]);
  }

  async compareHeadIndex(filePath: string): Promise<void> {
    const file = await this.resolve(filePath);
    await this.assertNotConflicted(file);
    await this.compare([
      await this.revision(file, `HEAD:${file.relative}`, "HEAD"),
      await this.revision(file, `:0:${file.relative}`, "index")
    ]);
  }

  async compareIndexWorking(filePath: string): Promise<void> {
    const file = await this.resolve(filePath);
    await this.assertNotConflicted(file);
    await this.compare([await this.revision(file, `:0:${file.relative}`, "index"), await this.working(file)]);
  }

  async compareRevision(filePath: string): Promise<void> {
    const file = await this.resolve(filePath);
    const history = await this.git.log(file.root, file.relative);
    if (history.length === 0) throw new ConflictError(`${file.relative} has no committed history.`);
    const chosen = await this.host.pickRevision(history);
    if (!chosen) return;
    await this.compare([await this.revision(file, `${chosen.hash}:${file.relative}`, chosen.short), await this.working(file)]);
  }

  /**
   * Opens a merge with read-only current/incoming/base snapshots from the actual index stages and
   * the working-tree file as the result. Never stages, continues, or aborts Git operations.
   * Desktop mode stages after the window closes; the embedded panel offers it after each save.
   */
  async resolveConflict(filePath: string, mode: "desktop" | "embedded" = "desktop"): Promise<void> {
    const file = await this.resolve(filePath);
    if (await this.host.isDirty(file.absolute)) {
      throw new ConflictError(mode === "embedded"
        ? `Save or revert unsaved changes in ${file.relative} first. The merge writes its result to that file.`
        : `Save or revert unsaved changes in ${file.relative} first. The desktop app writes the merge result to that file.`);
    }
    const entries = await this.git.unmerged(file.root, file.relative);
    const plan = conflictPlan(file.relative, entries);
    const read = async (object: string) => {
      const result = await this.git.blob(file.root, object);
      if (!result) throw new ConflictError(`Git object ${object} for ${file.relative} is missing.`);
      return result;
    };
    const current = await read(plan.current.object);
    const incoming = await read(plan.incoming.object);
    const base = plan.base ? await read(plan.base.object) : undefined;
    if ([current, incoming, base].some(content => content && isBinary(content))) {
      throw new ConflictError(`${file.relative} is a binary conflict. CompareCraft text merge cannot resolve it; choose a side with Git. Git state was not changed.`);
    }
    const operation = await this.git.operation(file.root);
    const name = path.posix.basename(file.relative);
    const signature = stageSignature(entries);
    const mtimeMs = (await stat(file.absolute)).mtimeMs;
    const inputs: SideInput[] = [
      { kind: "content", name, title: operation.current, content: current },
      { kind: "content", name, title: operation.incoming, content: incoming },
      base ? { kind: "content", name, title: "Base: common ancestor", content: base }
        : empty(name, "Base: none (added on both sides)"),
      { kind: "path", path: file.absolute, title: `Result: ${file.relative}` }
    ];
    if (mode === "embedded") {
      if (await this.compare(inputs, { mode: "embedded" })) this.pending.set(this.key(file), { signature, mtimeMs });
      return;
    }
    const launched = await this.compare(inputs, { mode: "desktop", onClosed: () => this.afterMerge(file) });
    if (launched) this.pending.set(this.key(file), { signature, mtimeMs });
  }

  /** After the embedded merge saved its result: offer review and an explicit stage, unless markers remain. */
  async afterEmbeddedSave(filePath: string): Promise<void> {
    const file = await this.resolve(filePath);
    const entries = await this.git.unmerged(file.root, file.relative);
    if (entries.length === 0) return;
    const content = await readFile(file.absolute);
    if (!isBinary(content) && hasConflictMarkers(content.toString("utf8"))) {
      this.host.warn(`${file.relative} was saved with conflict markers. Resolve the remaining conflicts before staging.`);
      return;
    }
    if (await this.host.offerStage(`Saved ${file.relative}. Review the result, then stage it to mark the conflict resolved.`)) {
      await this.stageResolved(file.absolute);
    }
  }

  private async afterMerge(file: RepositoryFile): Promise<void> {
    const pending = this.pending.get(this.key(file));
    const entries = await this.git.unmerged(file.root, file.relative);
    if (entries.length === 0) {
      this.pending.delete(this.key(file));
      this.host.notify(`${file.relative} is no longer in conflict in the index.`);
      return;
    }
    if (pending && stageSignature(entries) !== pending.signature) {
      this.pending.delete(this.key(file));
      this.host.warn(`The Git conflict state of ${file.relative} changed while CompareCraft was open. Review the file before staging.`);
      return;
    }
    let modified = true;
    try {
      modified = !pending || (await stat(file.absolute)).mtimeMs !== pending.mtimeMs;
    } catch {
      modified = false;
    }
    if (!modified) {
      this.host.notify(`CompareCraft closed without changing ${file.relative}. The conflict remains unresolved.`);
      return;
    }
    if (await this.host.offerStage(`CompareCraft closed. Review ${file.relative}, then stage it to mark the conflict resolved.`)) {
      await this.stageResolved(file.absolute);
    }
  }

  /** Explicit, revalidated staging of a resolved conflict. Never commits or continues the operation. */
  async stageResolved(filePath: string): Promise<boolean> {
    const file = await this.resolve(filePath);
    const entries = await this.git.unmerged(file.root, file.relative);
    if (entries.length === 0) {
      throw new ConflictError(`${file.relative} is not an unresolved conflict. Stage ordinary changes from Source Control.`);
    }
    const pending = this.pending.get(this.key(file));
    if (pending && pending.signature !== stageSignature(entries)) {
      this.pending.delete(this.key(file));
      throw new ConflictError(`The Git conflict state of ${file.relative} changed since CompareCraft opened it. Re-run Resolve Conflict before staging.`);
    }
    if (await this.host.isDirty(file.absolute)) {
      throw new ConflictError(`Save ${file.relative} before staging; Git stages the file on disk, not the editor buffer.`);
    }
    const content = await readFile(file.absolute);
    if (!isBinary(content) && hasConflictMarkers(content.toString("utf8")) && !(await this.host.confirm(
      `${file.relative} still contains conflict markers.`,
      "Staging marks the conflict as resolved in the index. Stage anyway?",
      "Stage Anyway"
    ))) return false;
    const operation = await this.git.operation(file.root);
    if (!(await this.host.confirm(
      `Stage ${file.relative} as resolved?`,
      `This runs git add for this file only. CompareCraft will not commit, continue, or abort the ${operation.kind === "unknown" ? "operation" : operation.kind}.`,
      "Stage Resolved File"
    ))) return false;
    // Revalidate right before mutating, in case Git or the editor changed state while confirming.
    if (stageSignature(await this.git.unmerged(file.root, file.relative)) !== stageSignature(entries) ||
        await this.host.isDirty(file.absolute)) {
      throw new ConflictError(`${file.relative} changed while confirming. Nothing was staged; review and retry.`);
    }
    await this.git.add(file.root, file.relative);
    this.pending.delete(this.key(file));
    this.host.notify(`Staged ${file.relative}. Continue the ${operation.kind === "unknown" ? "operation" : operation.kind} from Source Control or the terminal when ready.`);
    return true;
  }
}
