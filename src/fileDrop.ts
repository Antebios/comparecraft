import { isEmbedded, message, onFileDrop, type FileDropEvent } from "./host";
import { api, errText } from "./api";
import { openAuto, openTab } from "./store";

/** A dropped file or folder; `dir` is undefined while it is not known yet. */
export interface DropItem {
  path: string;
  dir?: boolean;
  exists?: boolean;
}
export interface DropPoint {
  x: number;
  y: number;
}
export interface DropTarget {
  /** Whether this target takes the items; otherwise the drop goes to an enclosing target. */
  accepts?(items: DropItem[], point: DropPoint): boolean;
  drop(items: DropItem[], point: DropPoint): unknown;
  /** Elements to highlight while the items are over the target; the target itself by default. */
  highlight?(items: DropItem[], point: DropPoint): Element[];
}

const targets = new WeakMap<Element, DropTarget>();

/** Makes an element a drop target for files and folders (use as `ref`). */
export function dropTarget(el: Element, target: DropTarget) {
  targets.set(el, target);
}

export const NO_PATHS_HINT =
  "VS Code doesn't share the paths of files dropped from the system file manager. Hold Shift and drag files from the VS Code Explorer or editor tabs instead, or use Browse (…).";

/** Opens dropped items in a new tab: two items as a comparison, three as a merge. */
export function openDropped(items: DropItem[]) {
  const paths = items.slice(0, 3).map((i) => i.path);
  if (paths.length === 3 && items.slice(0, 3).every((i) => i.dir)) return openTab({ kind: "fmerge", paths: [...paths, paths[0]] });
  return openAuto(paths);
}

/** Error shown when dropped items don't fit an embedded view, which cannot open other tabs. */
const mismatch = (folders: boolean) =>
  folders ? "This comparison compares folders. Drop folders onto it." : "This comparison compares files. Drop files onto it.";

/**
 * A comparison view as a drop target: one item replaces the side under the pointer (or whose path box it
 * is on), several replace the sides in order (left, right, then base). Items of the wrong kind open in
 * a new tab with the matching viewer.
 */
export function sideDrop(o: {
  el: () => Element;
  folders: boolean;
  /** Number of sides that take dropped items, in order: left, right, base. */
  sides: number;
  /** Replaces the given sides (missing entries stay unchanged). */
  apply(paths: (string | undefined)[]): void | Promise<unknown>;
  /** Side under a point when one item is dropped off the path boxes; two halves by default. */
  sideAt?(point: DropPoint): number | undefined;
}): DropTarget {
  const sideAt = (p: DropPoint) => {
    const fromBox = (document.elementFromPoint(p.x, p.y)?.closest(".pathbar[data-side]") as HTMLElement | null)?.dataset.side;
    if (fromBox !== undefined) return Number(fromBox);
    if (o.sideAt) return o.sideAt(p);
    if (o.sides !== 2) return undefined;
    const r = o.el().getBoundingClientRect();
    return p.x < r.left + r.width / 2 ? 0 : 1;
  };
  const fits = (items: DropItem[]) => items.every((i) => i.dir === undefined || (i.exists !== false && i.dir === o.folders));
  const sidesFor = (items: DropItem[], p: DropPoint): number[] => {
    if (items.length > 1) return [...Array(Math.min(items.length, o.sides)).keys()];
    const s = sideAt(p);
    return s === undefined ? [] : [s];
  };
  return {
    highlight(items, p) {
      if (!fits(items)) return [o.el()];
      return sidesFor(items, p).flatMap((s) => [...o.el().querySelectorAll(`.pathbar[data-side="${s}"]`)]);
    },
    async drop(items, p) {
      if (!fits(items)) {
        if (isEmbedded()) return message(mismatch(o.folders), { kind: "warning" });
        return openDropped(items);
      }
      const sides = sidesFor(items, p);
      if (!sides.length) return message("Drop the item onto the path box of the side it should replace.", { kind: "info" });
      const next: (string | undefined)[] = [];
      sides.forEach((s, k) => (next[s] = items[k].path));
      await o.apply(next);
    },
  };
}

function findTarget(items: DropItem[], p: DropPoint): [Element, DropTarget] | undefined {
  // Only what is under the pointer: the outline always shows where a drop goes.
  let el: Element | null = document.elementFromPoint(p.x, p.y);
  for (; el; el = el.parentElement) {
    const t = targets.get(el);
    if (t && (t.accepts?.(items, p) ?? true)) return [el, t];
  }
  return undefined;
}

/** Listens for files dragged onto the window and routes them to the drop target under the pointer. */
export function initFileDrop(): () => void {
  let items: DropItem[] | null = null;
  let lit: Element[] = [];
  let seq = 0;
  const clear = () => {
    lit.forEach((e) => e.classList.remove("drop-target"));
    lit = [];
  };
  const blocked = () => !!document.querySelector(".modal-backdrop");
  const describe = async (paths: string[]): Promise<DropItem[]> =>
    Promise.all(paths.map(async (path) => {
      try {
        const info = await api.pathInfo(path);
        return { path, dir: info.isDir, exists: info.exists };
      } catch {
        return { path, exists: false, dir: false };
      }
    }));
  const show = (p: DropPoint) => {
    clear();
    if (blocked()) return;
    // An embedded drag reveals its items only when dropped: assume one item of either kind.
    const known = items ?? [{ path: "" }];
    const found = findTarget(known, p);
    if (!found) return;
    const [el, t] = found;
    lit = t.highlight ? t.highlight(known, p) : [el];
    lit.forEach((e) => e.classList.add("drop-target"));
  };
  const handle = async (e: FileDropEvent) => {
    const p = { x: e.x, y: e.y };
    if (e.type === "leave") {
      seq++;
      items = null;
      return clear();
    }
    if (e.type === "enter" && e.paths?.length) {
      const mine = ++seq;
      items = e.paths.map((path) => ({ path }));
      void describe(e.paths).then((d) => mine === seq && items && (items = d));
    }
    if (e.type !== "drop") return show(p);
    seq++;
    clear();
    items = null;
    if (blocked()) return;
    if (!e.paths?.length) {
      if (isEmbedded()) await message(NO_PATHS_HINT, { kind: "info" });
      return;
    }
    const dropped = await describe(e.paths);
    const found = findTarget(dropped, p);
    if (!found) return;
    try {
      await found[1].drop(dropped, p);
    } catch (err) {
      await message(`Cannot open the dropped items: ${errText(err)}`, { kind: "error" });
    }
  };
  let stop: (() => void) | undefined;
  let stopped = false;
  void onFileDrop((e) => void handle(e)).then((u) => (stopped ? u() : (stop = u)));
  return () => {
    stopped = true;
    stop?.();
    clear();
  };
}
