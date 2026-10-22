import type { StageEntry } from "./git";

export class ConflictError extends Error {}

export interface ConflictPlan {
  readonly base?: StageEntry;
  readonly current: StageEntry;
  readonly incoming: StageEntry;
}

const SYMLINK = "120000";
const SUBMODULE = "160000";

/** Validates unmerged index stages for a three-way text merge without changing Git state. */
export function conflictPlan(relative: string, entries: readonly StageEntry[]): ConflictPlan {
  if (entries.length === 0) {
    throw new ConflictError(`${relative} has no unresolved conflict in the Git index.`);
  }
  const stage = (n: 1 | 2 | 3) => entries.find(entry => entry.stage === n);
  const base = stage(1), current = stage(2), incoming = stage(3);
  if (!current || !incoming) {
    const deleted = !current ? "current" : "incoming";
    throw new ConflictError(
      `${relative} was deleted on the ${deleted} side and modified on the other (modify/delete or rename conflict). ` +
      "CompareCraft cannot three-way merge a missing side. Keep the file with git add or remove it with git rm; Git state was not changed."
    );
  }
  for (const entry of entries) {
    if (entry.mode === SYMLINK || entry.mode === SUBMODULE) {
      throw new ConflictError(`${relative} is a ${entry.mode === SYMLINK ? "symbolic link" : "submodule"} conflict, which CompareCraft cannot merge. Git state was not changed.`);
    }
  }
  return { base, current, incoming };
}

/** Git's own heuristic: a NUL byte in the first 8000 bytes marks binary content. */
export function isBinary(content: Uint8Array): boolean {
  const limit = Math.min(content.length, 8000);
  for (let i = 0; i < limit; i++) if (content[i] === 0) return true;
  return false;
}

/** Detects leftover conflict markers; their absence alone does not prove a correct resolution. */
export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|>{7})(?: |$)/m.test(text) || /^={7}\r?$/m.test(text);
}

export function stageSignature(entries: readonly StageEntry[]): string {
  return entries.map(entry => `${entry.stage}:${entry.mode}:${entry.object}`).join(",");
}
