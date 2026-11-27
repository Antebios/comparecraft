import type { FNode, Status } from "./api";

export type FolderSide = "left" | "right";
/** Color of a folder on one side; "diff" covers newer and different files, as in the reference tool. */
export type FolderTone = "same" | "diff" | "orphan" | "older" | "similar" | "error";
export interface FolderLook {
  main: FolderTone;
  /** A second state shown in the icon corner: orphans or older files next to the main state. */
  second?: FolderTone;
  /** Legend text, worded as in the reference tool's legend. */
  text: string;
}
export type FolderLooks = Partial<Record<FolderSide, FolderLook>>;

const NEWER = 1;
const DIFF = 2;
const ORPHAN = 4;
const OLDER = 8;
const SIMILAR = 16;

/** What a side of a folder contains, from its file and folder flags. */
export function lookOf(flags: number): FolderLook {
  const changed = flags & (NEWER | DIFF);
  if (changed) {
    const what = changed === NEWER ? "newer" : changed === DIFF ? "difference" : "newer/difference";
    if (flags & ORPHAN) return { main: "diff", second: "orphan", text: `Contains ${what} and orphan files` };
    if (flags & OLDER) return { main: "diff", second: "older", text: `Contains ${what} and older files` };
    return { main: "diff", text: `Contains ${what} files` };
  }
  if (flags & ORPHAN) {
    return flags & OLDER ? { main: "orphan", second: "older", text: "Contains orphan and older files" } : { main: "orphan", text: "Contains orphan files" };
  }
  if (flags & OLDER) return { main: "older", text: "Contains older files" };
  if (flags & SIMILAR) return { main: "similar", text: "Contains files with only unimportant differences" };
  return { main: "same", text: "Only contains same files" };
}

/**
 * Colors each folder per side by what that side contains, like the reference tool: newer or different
 * files make it red, else orphans present on that side purple, else files older on that side gray.
 * Items that exist only on the other side do not count. `statusOf` gives the effective statuses.
 */
export function folderLooks(root: FNode, statusOf: (n: FNode) => Status): Map<string, FolderLooks> {
  const out = new Map<string, FolderLooks>();
  /** Flags of a node for the left and right side. */
  const walk = (n: FNode): [number, number] => {
    const st = statusOf(n);
    if (!n.dir) {
      switch (st) {
        case "left": return [ORPHAN, 0];
        case "right": return [0, ORPHAN];
        case "similar": return [SIMILAR, SIMILAR];
        case "error": return [DIFF, DIFF];
        case "diff": return n.newer === "left" ? [NEWER, OLDER] : n.newer === "right" ? [OLDER, NEWER] : [DIFF, DIFF];
        default: return [0, 0];
      }
    }
    let [l, r] = [0, 0];
    for (const c of n.children ?? []) {
      const [cl, cr] = walk(c);
      if (c.left) l |= cl;
      if (c.right) r |= cr;
    }
    if (n === root) return [l, r];
    const looks: FolderLooks = {};
    const paired = !!n.left && !!n.right;
    if (!paired) {
      // A folder on one side only is itself an orphan there, even when empty.
      const look: FolderLook = { main: "orphan", text: "Orphan folder: exists on this side only" };
      if (n.left) (looks.left = look), (l = ORPHAN);
      else (looks.right = look), (r = ORPHAN);
    } else if (st === "error") {
      looks.left = looks.right = { main: "error", text: n.error ?? "Error reading the folder" };
      l = r = DIFF;
    } else if (st === "same" || st === "similar") {
      // Paired folders roll up their children's statuses; "same" also covers items marked Ignored.
      l = r = st === "similar" ? SIMILAR : 0;
      looks.left = looks.right = lookOf(l);
    } else {
      looks.left = lookOf(l);
      looks.right = lookOf(r);
    }
    out.set(n.rel, looks);
    return [l, r];
  };
  walk(root);
  return out;
}

/** CSS color variable of a folder tone. */
export const TONE_VAR: Record<FolderTone, string> = {
  same: "--folder-fg",
  diff: "--diff-fg",
  orphan: "--orphan-fg",
  older: "--older-fg",
  similar: "--unimp-fg",
  error: "--diff-fg",
};
