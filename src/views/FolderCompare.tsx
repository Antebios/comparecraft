import { message, open as openDialog } from "@tauri-apps/plugin-dialog";
import { createEffect, createMemo, createSignal, For, Index, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import {
  api,
  errText,
  fmtSize,
  fmtTime,
  joinPath,
  type Action,
  type ActionResult,
  type FNode,
  type FolderOptions,
  type FolderResult,
  type Status,
  type ContentVerdict,
  type Summary,
  type ViewKind,
  type ReportRequest,
} from "../api";
import { Btn, Modal, PathBar, ROW_H, useViewport } from "../components/common";
import { showContextMenu } from "../components/ContextMenu";
import { externalCommands, shellWords, sideOf } from "../components/external";
import { promptText } from "../components/Prompt";
import { displayKeys, isEnabled, IS_MAC, registerCommands, type Command, type MenuRef } from "../commands";
import { backupSpec, rememberFilter, setSetting, settings } from "../settings";
import { openAuto, openTab, persistSession, setSessionsVersion, tabTitle, updateTab, type Tab } from "../store";
import { folderInfo } from "../components/InfoDialog";
import { ReportDialog, type ReportKind } from "../components/ReportDialog";
import { saveSession as saveNamedSession, sessionCommands } from "./sessionMenu";
import FolderSettingsDialog, { defaultViewSettings, filterText, parseFilterText, type FolderViewSettings, type SettingsTab } from "./folderSettings";
import {
  AlignDialog,
  AttributesDialog,
  confirmReplace,
  ContentsDialog,
  ContentsResults,
  DeleteDialog,
  ExcludeDialog,
  FolderDialog,
  NewFolderDialog,
  qcText,
  RenameDialog,
  SideDialog,
  TouchDialog,
  type ContentMode,
  type Counts,
  type SideCount,
  type SideName,
  type Structure,
} from "./folderOps";

/** Display filter status bits. */
const BIT = { same: 0x1, leftOrphan: 0x4, rightOrphan: 0x8, leftNewer: 0x40, rightNewer: 0x80, diff: 0x200 } as const;
const ALL_BITS = 0x2cd;
/** Display filter favorites, in the order of the reference View menu. */
const PRESETS: [string, number, string][] = [
  ["all", 0x2cd, "Show All"],
  ["diffs", 0x2cc, "Show Differences"],
  ["same", 0x1, "Show Same"],
  ["noorphans", 0x2c1, "Show No Orphans"],
  ["diffsnoorph", 0x2c0, "Show Differences but No Orphans"],
  ["orphans", 0xc, "Show Orphans"],
  ["lnewer", 0x40, "Show Left Newer"],
  ["rnewer", 0x80, "Show Right Newer"],
  ["lnewerorph", 0x44, "Show Left Newer and Left Orphans"],
  ["rnewerorph", 0x88, "Show Right Newer and Right Orphans"],
  ["lorphans", 0x4, "Show Left Orphans"],
  ["rorphans", 0x8, "Show Right Orphans"],
];
const TOGGLES: [string, number, string][] = [
  ["tog-same", BIT.same, "Same"],
  ["tog-lorph", BIT.leftOrphan, "Left Orphans"],
  ["tog-rorph", BIT.rightOrphan, "Right Orphans"],
  ["tog-lnewer", BIT.leftNewer, "Left Newer"],
  ["tog-rnewer", BIT.rightNewer, "Right Newer"],
  ["tog-diff", BIT.diff, "Differences (no newer side)"],
];
/** Folder handling (one radio group in the reference View menu). */
type FolderMode = "showall" | "structure" | "filesonly" | "flatten";
const FOLDER_MODES: [FolderMode, string][] = [
  ["showall", "Always Show Folders"],
  ["structure", "Compare Files and Folder Structure"],
  ["filesonly", "Only Compare Files"],
  ["flatten", "Ignore Folder Structure"],
];

const IS_WINDOWS = navigator.userAgent.includes("Windows");

export const defaultOptions = (): FolderOptions => ({
  criteria: "timesize",
  timeToleranceSecs: 2,
  include: "*",
  exclude: ".git/;node_modules/",
  ignoreCaseNames: IS_WINDOWS || IS_MAC,
  followSymlinks: false,
  ...(settings.folderDefaults ?? {}),
  align: [],
});

interface Flat {
  node: FNode;
  depth: number;
}

const STATUS_GLYPH: Record<string, string> = { same: "=", similar: "≈", diff: "≠", left: "◧", right: "◨", error: "!" };
const other = (s: SideName): SideName => (s === "left" ? "right" : "left");
const parentRel = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const extOf = (name: string) => (name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".")) : "");

/** Case-insensitive file-name glob (`*`, `?`). */
function globMatch(mask: string, name: string): boolean {
  const re = new RegExp("^" + mask.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
  return re.test(name);
}

/** Status bit of an item for the display filter. */
function statusBit(n: FNode, st: Status, ignoreUnimportant: boolean): number {
  if (st === "same" || (st === "similar" && ignoreUnimportant)) return BIT.same;
  if (st === "left") return BIT.leftOrphan;
  if (st === "right") return BIT.rightOrphan;
  if (n.newer === "left") return BIT.leftNewer;
  if (n.newer === "right") return BIT.rightNewer;
  return BIT.diff;
}

/** Status of a paired folder from its children (as the comparison engine computes it). */
function rollup(children: Status[]): Status {
  if (children.some((s) => s === "diff" || s === "left" || s === "right" || s === "error")) return "diff";
  return children.some((s) => s === "similar") ? "similar" : "same";
}

/** Recomputes paired-folder statuses and the summary after items were re-compared in place. */
function recompute(root: FNode): Summary {
  const sum: Summary = { files: 0, same: 0, similar: 0, diff: 0, leftOnly: 0, rightOnly: 0, errors: 0 };
  const walk = (n: FNode, top: boolean) => {
    n.children?.forEach((c) => walk(c, false));
    if (top) return;
    const paired = !!n.left && !!n.right;
    if (n.dir) {
      if (paired && n.error) sum.errors++;
      else if (paired) n.status = rollup((n.children ?? []).map((c) => c.status));
    } else if (!paired) {
      sum.files++;
      n.left ? sum.leftOnly++ : sum.rightOnly++;
    } else {
      sum.files++;
      if (n.status === "same") sum.same++;
      else if (n.status === "similar") sum.similar++;
      else if (n.status === "error") sum.errors++;
      else sum.diff++;
    }
  };
  walk(root, true);
  root.status = rollup((root.children ?? []).map((c) => c.status));
  return sum;
}

/**
 * Row popup in the order of the reference Folder Compare popup (TDirActions
 * merged with TDirBaseActions); entries whose visibility rules fail are dropped.
 */
const ROW_MENU: MenuRef[] = [
  "cto-x", "cto-text", "cto-hex", "cto-table", "cto-picture", "cto-cancel", "-",
  "open-folder", "close-folder", "open-subfolders", "close-subfolders", "set-base", "set-base-other", "open", "open-with",
  "quick-compare", "compare-to", "align-with", "-",
  "compare-contents", "copy-side", "move-side", "copy-folder", "move-folder", "delete", "rename", "attributes", "touch",
  "exclude", "new-folder", "copy-names", "ignored", "refresh-sel", "report", "-",
  "sync-menu",
];
const BACKGROUND_MENU: MenuRef[] = ["cto-cancel", "-", "refresh", "full-refresh", "-", "new-folder", "-", "select-all", "expand", "collapse", "-", "legend"];

export default function FolderCompare(props: { tab: Tab; active: boolean }) {
  const tab = () => props.tab;
  const [opts, setOpts] = createStore<FolderOptions>({
    ...defaultOptions(),
    ...((tab().options.folder as Partial<FolderOptions> | undefined) ?? {}),
    ...(tab().filters ? { include: tab().filters! } : {}),
  });
  const [result, setResult] = createSignal<FolderResult | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [mask, setMask] = createSignal<number>((tab().options.displayFilter as number | undefined) ?? ALL_BITS);
  const [folderMode, setFolderModeRaw] = createSignal<FolderMode>(
    opts.flatten ? "flatten" : ((tab().options.folderMode as FolderMode | undefined) ?? "structure"),
  );
  const [ignoreUnimportant, setIgnoreUnimportant] = createSignal((tab().options.ignoreUnimportant as boolean | undefined) ?? true);
  const [suppress, setSuppress] = createSignal(false);
  const [peek, setPeek] = createSignal(false);
  const [viewSet, setViewSet] = createSignal<FolderViewSettings>({ ...defaultViewSettings(), ...((tab().options.folderView as Partial<FolderViewSettings> | undefined) ?? {}) });
  const [logOpen, setLogOpen] = createSignal(false);
  const [logLines, setLogLines] = createSignal<{ t: number; text: string }[]>([]);
  const log = (text: string) => setLogLines((l) => [...l, { t: Date.now(), text }].slice(-Math.max(50, settings.logMaxMessages)));
  const [sel, setSel] = createSignal<Set<string>>(new Set());
  const [anchor, setAnchor] = createSignal<string | null>(null);
  // Side(s) the selection applies to: a click selects one side, Ctrl+click on the other side or Select All both.
  const [selSide, setSelSide] = createSignal<SideName | "both">("left");
  const [ignored, setIgnored] = createSignal<Set<string>>(new Set());
  const [history, setHistory] = createSignal<{ back: string[][]; fwd: string[][] }>({ back: [], fwd: [] });
  const [syncOpen, setSyncOpen] = createSignal(tab().kind === "sync");
  const [message_, setMessageRaw] = createSignal("");
  const setMessage = (m: string) => {
    setMessageRaw(m);
    if (m) log(m);
  };
  const [syncMode, setSyncMode] = createSignal<string | undefined>(undefined);
  const [legend, setLegend] = createSignal(false);
  const [findName, setFindName] = createSignal("");
  const [dialog, setDialog] = createSignal<(() => JSX.Element) | null>(null);
  const [quietExclude, setQuietExclude] = createSignal(false);
  const closeDialog = () => setDialog(null);
  const show = (d: () => JSX.Element) => setDialog(() => d);

  let scroller!: HTMLDivElement;
  const vp = useViewport(() => scroller);

  const left = () => tab().paths[0] ?? "";
  const right = () => tab().paths[1] ?? "";
  const rootOf = (s: SideName) => (s === "left" ? left() : right());
  const isSync = tab().kind === "sync";
  const idle = () => !!result() && !busy();
  const basesDiffer = () => !!left() && !!right() && left() !== right();

  /** Options sent to the backend: folder mode and Suppress Filters / Peek applied. */
  const compareOptions = (): FolderOptions => ({
    ...opts,
    align: [...(opts.align ?? [])],
    otherFilters: [...(opts.otherFilters ?? [])],
    flatten: folderMode() === "flatten",
    ...(suppress() || peek() ? { include: "*", exclude: "", includeFolders: "", otherFilters: [], excludeHidden: false } : {}),
  });
  const flatMode = () => folderMode() === "flatten";
  let loadedOnce = false;

  async function refresh() {
    if (!left() || !right()) {
      setResult(null);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await api.compareFolders(left(), right(), compareOptions());
      setResult(r);
      if (!loadedOnce) {
        loadedOnce = true;
        if (tab().expandAll) expandAll(r.root);
        else if (viewSet().expandOnLoad) expandAll(r.root, viewSet().expandDiffsOnly);
      }
      log(`Compared ${left()} ↔ ${right()}: ${r.summary.files} files, ${r.summary.diff} different, ${r.summary.leftOnly + r.summary.rightOnly} orphans`);
    } catch (e) {
      setError(errText(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  onMount(async () => {
    await refresh();
    if (left() && right()) void persistSession(tab());
  });

  /** Changes the base folders, recording the previous pair for Back. */
  function setBases(paths: string[], record = true) {
    if (paths[0] === left() && paths[1] === right()) return;
    if (record) setHistory((h) => ({ back: [...h.back, [left(), right()]], fwd: [] }));
    updateTab(tab().id, { paths });
    setSel(new Set<string>());
    setExpanded(new Set<string>());
    setIgnored(new Set<string>());
    void refresh().then(() => persistSession(tab()));
  }
  const setPath = (i: 0 | 1, p: string) => setBases(i === 0 ? [p, right()] : [left(), p]);
  function goBack() {
    const h = history();
    const prev = h.back[h.back.length - 1];
    if (!prev) return;
    setHistory({ back: h.back.slice(0, -1), fwd: [[left(), right()], ...h.fwd] });
    setBases(prev, false);
  }
  function goForward() {
    const h = history();
    const next = h.fwd[0];
    if (!next) return;
    setHistory({ back: [...h.back, [left(), right()]], fwd: h.fwd.slice(1) });
    setBases(next, false);
  }
  const parentDir = (p: string) => {
    const t = p.replace(/[\\/]+$/, "");
    const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
    return i <= 0 ? (t.startsWith("/") ? "/" : t) : t.slice(0, i) + (/^[A-Za-z]:$/.test(t.slice(0, i)) ? "\\" : "");
  };
  const upLevel = (sides: SideName[]) => setBases([sides.includes("left") ? parentDir(left()) : left(), sides.includes("right") ? parentDir(right()) : right()]);

  function saveOpts() {
    updateTab(tab().id, { options: { ...tab().options, folder: JSON.parse(JSON.stringify(opts)) } });
  }
  const saveViewState = () =>
    updateTab(tab().id, {
      options: { ...tab().options, displayFilter: mask(), folderMode: folderMode(), ignoreUnimportant: ignoreUnimportant(), folderView: { ...viewSet() } },
    });
  createEffect(on([mask, folderMode, ignoreUnimportant, viewSet], saveViewState, { defer: true }));

  function setFolderMode(m: FolderMode) {
    const wasFlat = flatMode();
    setFolderModeRaw(m);
    setOpts("flatten", m === "flatten");
    saveOpts();
    if (wasFlat !== (m === "flatten")) {
      setSel(new Set<string>());
      setIgnored(new Set<string>());
      void refresh();
    }
  }
  function toggleSuppress() {
    setSuppress(!suppress());
    void refresh();
  }
  function togglePeek() {
    setPeek(!peek());
    void refresh();
  }

  // Automatic refresh (Session Settings › Handling).
  createEffect(() => {
    const secs = viewSet().autoRefreshSecs;
    if (!secs) return;
    const id = window.setInterval(() => {
      if (!busy() && !dialog() && !syncOpen()) void refresh();
    }, secs * 1000);
    onCleanup(() => clearInterval(id));
  });

  function expandAll(root?: FNode, diffsOnly = false) {
    const s = new Set<string>();
    const walk = (n: FNode) => {
      if (n.dir) {
        if (n.rel && (!diffsOnly || (n.status !== "same" && n.status !== "similar"))) s.add(n.rel);
        n.children?.forEach(walk);
      }
    };
    walk(root ?? result()!.root);
    setExpanded(s);
  }

  const nodeByRel = createMemo(() => {
    const m = new Map<string, FNode>();
    const walk = (n: FNode) => {
      m.set(n.rel, n);
      n.children?.forEach(walk);
    };
    if (result()) walk(result()!.root);
    return m;
  });

  /** Status after "Ignored" marks: ignored items count as same and folders roll up again. */
  const effStatus = createMemo<Map<string, Status> | null>(() => {
    const ign = ignored();
    const r = result();
    if (!r || !ign.size) return null;
    const m = new Map<string, Status>();
    const walk = (n: FNode): Status => {
      const kids = (n.children ?? []).map(walk);
      const s: Status = ign.has(n.rel) ? "same" : n.dir && n.left && n.right && !n.error ? rollup(kids) : n.status;
      m.set(n.rel, s);
      return s;
    };
    walk(r.root);
    return m;
  });
  const statusOf = (n: FNode): Status => effStatus()?.get(n.rel) ?? n.status;

  const flat = createMemo<Flat[]>(() => {
    const r = result();
    if (!r) return [];
    const m = suppress() ? ALL_BITS : mask();
    const mode = folderMode();
    const iu = ignoreUnimportant();
    const exp = expanded();
    const out: Flat[] = [];
    const memo = new Map<FNode, boolean>();
    const matchesSelf = (n: FNode) => (statusBit(n, statusOf(n), iu) & m) !== 0;
    // Files match by status; folders as set by the folder handling mode.
    const visibleNode = (n: FNode): boolean => {
      const hit = memo.get(n);
      if (hit !== undefined) return hit;
      let v: boolean;
      if (!n.dir) v = matchesSelf(n);
      else if (mode === "showall" || suppress()) v = true;
      else {
        const kids = n.children ?? [];
        const orphan = statusOf(n) === "left" || statusOf(n) === "right";
        v = kids.some(visibleNode) || (mode !== "filesonly" && (orphan || !kids.length) && matchesSelf(n));
      }
      memo.set(n, v);
      return v;
    };
    const walk = (n: FNode, depth: number) => {
      for (const c of n.children ?? []) {
        if (!visibleNode(c)) continue;
        out.push({ node: c, depth });
        if (c.dir && exp.has(c.rel)) walk(c, depth + 1);
      }
    };
    walk(r.root, 0);
    return out;
  });

  const windowRows = createMemo(() => {
    const rows = flat();
    const { start, end } = vp.range(rows.length);
    const items: { i: number; f: Flat }[] = [];
    for (let i = start; i < end; i++) items.push({ i, f: rows[i] });
    return items;
  });

  /* ---------- Selection model ---------- */

  const sidesOn = (): SideName[] => (selSide() === "both" ? ["left", "right"] : [selSide() as SideName]);
  const selectedNodes = () => [...sel()].map((r) => nodeByRel().get(r)).filter((n): n is FNode => !!n);
  /**
   * Selected items that operations act on. As in the reference, an opened folder
   * selected together with some of its children is left out (only the children count).
   */
  const effSel = createMemo(() => {
    const s = sel();
    const ancestors = new Set<string>();
    for (const r of s) for (let p = parentRel(r); p; p = parentRel(p)) ancestors.add(p);
    const exp = expanded();
    return selectedNodes().filter((n) => !(n.dir && exp.has(n.rel) && ancestors.has(n.rel)));
  });
  const sideItems = (side: SideName) => (sidesOn().includes(side) ? effSel().filter((n) => n[side]) : []);
  const treeBytes = (n: FNode, side: SideName): number => (n.dir ? (n.children ?? []).reduce((a, c) => a + (c[side] ? treeBytes(c, side) : 0), 0) : n[side]?.size ?? 0);
  const counts = createMemo<Counts>(() => {
    const c = (side: SideName): SideCount => {
      const items = sideItems(side);
      return { files: items.filter((n) => !n.dir).length, folders: items.filter((n) => n.dir).length, bytes: items.reduce((a, n) => a + treeBytes(n, side), 0) };
    };
    return { left: c("left"), right: c("right") };
  });
  const nFiles = () => counts().left.files + counts().right.files;
  const nFolders = () => counts().left.folders + counts().right.folders;
  const anySide = () => nFiles() + nFolders() > 0;
  const single = () => (effSel().length === 1 ? effSel()[0] : undefined);
  /** Side of a single selected item: the selected side where it exists. */
  const singleSide = (): SideName | undefined => {
    const n = single();
    if (!n) return undefined;
    return sidesOn().find((s) => n[s]) ?? (n.left ? "left" : "right");
  };

  /** Path of a node on a side; ancestor names come from that side (they can differ by case or alignment). */
  function sidePath(n: FNode, side: SideName): string {
    const fp = side === "left" ? n.leftPath : n.rightPath;
    if (fp !== undefined) return joinPath(rootOf(side), fp);
    const parts = n.rel.split("/");
    const names: string[] = [];
    for (let i = 1; i <= parts.length; i++) {
      const a = nodeByRel().get(parts.slice(0, i).join("/"));
      names.push(a?.[side]?.name ?? a?.[other(side)]?.name ?? parts[i - 1]);
    }
    return joinPath(rootOf(side), names.join("/"));
  }
  const parentPath = (n: FNode, side: SideName) => {
    if (n.leftPath !== undefined || n.rightPath !== undefined) {
      const fp = (side === "left" ? n.leftPath : n.rightPath) ?? n.leftPath ?? n.rightPath!;
      return joinPath(rootOf(side), parentRel(fp));
    }
    const p = parentRel(n.rel);
    return p ? sidePath(nodeByRel().get(p)!, side) : rootOf(side);
  };
  /** Where an item from `src` lands on `dst`: over the existing counterpart, otherwise under its own name. */
  const targetPath = (n: FNode, src: SideName, dst: SideName) => (n[dst] ? sidePath(n, dst) : joinPath(parentPath(n, dst), n[src]!.name));

  function toggle(rel: string) {
    const s = new Set(expanded());
    s.has(rel) ? s.delete(rel) : s.add(rel);
    setExpanded(s);
  }
  function setSubtree(nodes: FNode[], open: boolean) {
    const s = new Set(expanded());
    const walk = (n: FNode) => {
      if (!n.dir) return;
      open ? s.add(n.rel) : s.delete(n.rel);
      n.children?.forEach(walk);
    };
    nodes.forEach(walk);
    setExpanded(s);
  }

  function click(e: MouseEvent, rel: string, index: number) {
    const side: SideName = sideOf(e) === 0 ? "left" : "right";
    // Right-click keeps an existing selection on that side so its popup acts on all of it.
    if (e.button === 2 && sel().has(rel) && (selSide() === "both" || selSide() === side)) return;
    if (e.button === 2) {
      setSelSide(side);
      setSel(new Set([rel]));
      return void setAnchor(rel);
    }
    const add = e.ctrlKey || e.metaKey;
    if (add && sel().size && selSide() !== side) setSelSide("both");
    else if (!add) setSelSide(side);
    const s = new Set(add ? sel() : []);
    if (e.shiftKey && anchor()) {
      const rows = flat();
      const a = rows.findIndex((r) => r.node.rel === anchor());
      const [lo, hi] = a < index ? [a, index] : [index, a];
      for (let i = lo; i <= hi; i++) s.add(rows[i].node.rel);
    } else if (add && sel().has(rel) && selSide() !== "both") s.delete(rel);
    else {
      s.add(rel);
      setAnchor(rel);
    }
    setSel(s);
    if (cmpFrom() && e.button === 0 && !add && !e.shiftKey && cmpTarget()) compareToX();
  }

  /* ---------- Opening ---------- */

  /** Paths for a compare launched from the selection: one item on both sides, or two items. */
  function pairPaths(): string[] | null {
    const items = effSel();
    if (items.length === 1) {
      const n = items[0];
      return [n.left ? sidePath(n, "left") : "", n.right ? sidePath(n, "right") : ""];
    }
    if (items.length === 2) {
      const [a, b] = items;
      const sa: SideName = a.left && (selSide() !== "right" || !a.right) ? "left" : "right";
      const sb: SideName = b.right && (selSide() !== "left" || !b.left) ? "right" : "left";
      return [sidePath(a, sa), sidePath(b, sb)];
    }
    return null;
  }

  function openNode(n: FNode, kind?: ViewKind) {
    const paths = [n.left ? sidePath(n, "left") : "", n.right ? sidePath(n, "right") : ""];
    if (n.dir) return void openTab({ kind: kind ?? "folder", paths, options: { folder: { ...JSON.parse(JSON.stringify(opts)), align: [] } } });
    void openAuto(paths, kind);
  }
  function activate(n: FNode) {
    if (n.dir) return toggle(n.rel);
    openNode(n);
  }
  function openSelected() {
    const items = effSel();
    if (items.length === 2 && items.every((n) => !n.dir) && items.some((n) => !n.right) && items.some((n) => !n.left)) return void openAuto(pairPaths()!);
    items.slice(0, 20).forEach((n) => openNode(n));
  }
  function openWith(kind: ViewKind) {
    const p = pairPaths();
    if (p) void openAuto(p, kind);
  }

  async function quickCompare() {
    const p = pairPaths();
    if (!p || p.some((x) => !x)) return;
    setBusy(true);
    try {
      const code = await api.quickCompare(p[0], p[1], "rules");
      await message(`${p[0]}\n${p[1]}\n\n${qcText(code)}`, { title: "Quick Compare", kind: code === 1 || code === 2 ? "info" : "warning" });
    } finally {
      setBusy(false);
    }
  }

  /* ---------- Compare To (disjoint compare) ----------
   * As in the reference: Compare To marks the selected item and switches the
   * pointer to "help" (arrow with question mark); clicking another item of the
   * same kind (file or folder, either side) opens the comparison in a new tab.
   * The item from the lower side index goes left. While pending, the popup and
   * Actions menu offer "Compare to <name>", "Compare in <view>" for files, and
   * Cancel (also Esc). */

  const [cmpFrom, setCmpFrom] = createSignal<{ rel: string; side: SideName; dir: boolean; name: string } | null>(null);
  /** The selected item a pending Compare To can pair with (CanCompareToSel). */
  const cmpTarget = (): { n: FNode; side: SideName } | null => {
    const p = cmpFrom();
    const n = single();
    const side = selSide();
    if (!p || !n || side === "both" || !n[side]) return null;
    if (n.rel === p.rel && side === p.side) return null;
    return !!n.dir === p.dir ? { n, side } : null;
  };
  function compareTo() {
    const n = single();
    const side = singleSide();
    if (!n || !side || !n[side]) return;
    const name = n[side]!.name;
    setCmpFrom({ rel: n.rel, side, dir: !!n.dir, name });
    setMessage(`Compare To: click the ${n.dir ? "folder" : "file"} to compare “${name}” with, or press Esc to cancel.`);
  }
  function cancelCompareTo() {
    if (!cmpFrom()) return;
    setCmpFrom(null);
    setMessage("");
  }
  function compareToX(kind?: ViewKind) {
    const p = cmpFrom();
    const t = cmpTarget();
    cancelCompareTo();
    if (!p || !t) return;
    const src = nodeByRel().get(p.rel);
    if (!src?.[p.side]) return setMessage(`“${p.name}” is no longer in the comparison.`);
    const a = sidePath(src, p.side);
    const b = sidePath(t.n, t.side);
    const paths = t.side === "left" && p.side === "right" ? [b, a] : [a, b];
    if (p.dir) return void openTab({ kind: "folder", paths, options: { folder: { ...JSON.parse(JSON.stringify(opts)), align: [] } } });
    void openAuto(paths, kind);
  }

  /* ---------- Align With ---------- */

  const alignedEntry = (n: FNode) => (opts.align ?? []).findIndex((a) => a.parent === parentRel(n.rel) && a.left === n.left?.name && a.right === n.right?.name);
  function setAlign(list: NonNullable<FolderOptions["align"]>) {
    setOpts("align", list);
    saveOpts();
    void refresh();
  }
  function alignWith() {
    const items = effSel();
    if (items.length === 1 && alignedEntry(items[0]) >= 0) return setAlign((opts.align ?? []).filter((_, i) => i !== alignedEntry(items[0])));
    if (items.length === 2) {
      const l = items.find((n) => n.status === "left"), r = items.find((n) => n.status === "right");
      if (l && r && l.dir === r.dir && parentRel(l.rel) === parentRel(r.rel))
        return setAlign([...(opts.align ?? []), { parent: parentRel(l.rel), left: l.left!.name, right: r.right!.name }]);
    }
    const n = single();
    if (!n || (n.status !== "left" && n.status !== "right")) return setMessage("Align With needs an orphan item, or a left and a right orphan in the same folder.");
    const mine: SideName = n.status;
    const parent = parentRel(n.rel);
    const siblings = (parent ? nodeByRel().get(parent)?.children : result()?.root.children) ?? [];
    const cands = siblings.filter((c) => c.status === other(mine) && c.dir === n.dir).map((c) => c[other(mine)]!.name);
    show(() => (
      <AlignDialog
        name={n[mine]!.name}
        candidates={cands}
        onClose={closeDialog}
        onPick={(name) => {
          closeDialog();
          const entry = mine === "left" ? { parent, left: n.left!.name, right: name } : { parent, left: name, right: n.right!.name };
          setAlign([...(opts.align ?? []), entry]);
        }}
      />
    ));
  }

  /* ---------- File operations ---------- */

  async function execute(actions: Action[], useTrash = true) {
    if (!actions.length) return setMessage("Nothing to do.");
    setBusy(true);
    try {
      report(await api.executeActions(actions, useTrash, backupSpec(settings.backupOnCopy)));
    } catch (e) {
      setMessage(errText(e));
    } finally {
      setBusy(false);
    }
    await refresh();
  }

  function report(res: ActionResult[]) {
    const failed = res.filter((r) => !r.ok);
    for (const r of res) log(`${r.op} ${r.rel}: ${r.ok ? "ok" : r.error}`);
    setMessage(failed.length ? `${failed.length} operation(s) failed: ${failed.map((f) => `${f.rel}: ${f.error}`).join("; ")}` : `${res.length} operation(s) completed.`);
    if (failed.length) void message(failed.slice(0, 20).map((f) => `${f.rel}: ${f.error}`).join("\n"), { title: "CompareCraft", kind: "error" });
  }

  /**
   * Asks before overwriting files. `needs` decides which targets warrant a prompt;
   * returns the actions to run, or null when cancelled.
   */
  async function confirmOverwrites(actions: Action[], needs: (a: Action, target: { size: number; modified: number | null }) => boolean) {
    const files = actions.filter((a) => !a.dir);
    const infos = await api.itemInfo(files.map((a) => a.to));
    const srcInfos = await api.itemInfo(files.map((a) => a.from!));
    const skip = new Set<Action>();
    let all: "yes" | "no" | null = null;
    for (let i = 0; i < files.length; i++) {
      const t = infos[i];
      if (!t.exists || t.dir || !needs(files[i], t)) continue;
      if (all === "yes") continue;
      if (all === "no") {
        skip.add(files[i]);
        continue;
      }
      const a = await confirmReplace({ path: files[i].to, size: t.size, modified: t.modified }, { path: files[i].from!, size: srcInfos[i].size, modified: srcInfos[i].modified });
      if (a === "cancel") return null;
      if (a === "no" || a === "noall") skip.add(files[i]);
      if (a === "yesall") all = "yes";
      if (a === "noall") all = "no";
    }
    return actions.filter((a) => !skip.has(a));
  }

  async function sideOp(move: boolean, to: SideName) {
    const src = other(to);
    const actions: Action[] = effSel()
      .filter((n) => n[src])
      .map((n) => ({ op: move ? "move" : "copy", from: sidePath(n, src), to: targetPath(n, src, to), rel: n.rel, dir: n.dir, size: treeBytes(n, src) }));
    // Copying over a newer file needs confirmation.
    if (!settings.confirmOverwriteNewer) return void (await execute(actions));
    const ok = await confirmOverwrites(actions, (a, t) => {
      const n = nodeByRel().get(a.rel);
      return (t.modified ?? 0) > (n?.[src]?.modified ?? 0);
    });
    if (ok) await execute(ok);
  }

  const zero: SideCount = { files: 0, folders: 0, bytes: 0 };
  const hasCount = (c: SideCount) => c.files + c.folders > 0;
  /** Items of one side regardless of the clicked side (explicit Copy to Right/Left use their source side). */
  const sourceCounts = (side: SideName): SideCount => {
    const items = effSel().filter((n) => n[side]);
    return { files: items.filter((n) => !n.dir).length, folders: items.filter((n) => n.dir).length, bytes: items.reduce((a, n) => a + treeBytes(n, side), 0) };
  };

  /**
   * Copy/Move to Side. With an explicit direction (Copy to Right/Left) the copy
   * dialog can be turned off ("Don't show again"), as in the reference.
   */
  function sideDialog(move: boolean, to?: SideName) {
    if (to && !effSel().some((n) => n[other(to)])) return;
    if (to && !move && !settings.confirmCopy) return void sideOp(false, to);
    if (to && move && !settings.confirmMove) return void sideOp(true, to);
    const cnt: Counts = to ? ({ [other(to)]: sourceCounts(other(to)), [to]: zero } as Counts) : counts();
    show(() => (
      <SideDialog
        move={move}
        counts={cnt}
        to={to}
        onClose={closeDialog}
        onStart={(dir, dontShow) => {
          closeDialog();
          if (dontShow) setSetting("confirmCopy", false);
          void sideOp(move, dir);
        }}
      />
    ));
  }
  // Copy to Right/Left act on their source side's items even when the other side was clicked.
  const canCopyTo = (to: SideName) => idle() && basesDiffer() && effSel().some((n) => n[other(to)]);
  const sideCaption = (move: boolean) => {
    const verb = move ? "Move" : "Copy";
    const l = hasCount(counts().left), r = hasCount(counts().right);
    return l === r ? `${verb} to Side…` : l ? `${verb} to Right` : `${verb} to Left`;
  };
  const sideDirection = (): SideName | undefined => {
    const l = hasCount(counts().left), r = hasCount(counts().right);
    return l === r ? undefined : l ? "right" : "left";
  };

  function deleteDialog(permanent: boolean) {
    const del = (sides: SideName[], useTrash: boolean) => {
      const actions: Action[] = sides.flatMap((s) => sideItems(s).map((n) => ({ op: "delete" as const, to: sidePath(n, s), rel: n.rel, dir: n.dir, size: treeBytes(n, s) })));
      void execute(actions, useTrash && !permanent);
    };
    if (!settings.confirmDelete) return del(sidesOn().filter((s) => sideItems(s).length), settings.useTrash);
    show(() => (
      <DeleteDialog
        counts={counts()}
        permanent={permanent}
        onClose={closeDialog}
        onStart={(sides, useTrash) => {
          closeDialog();
          del(sides, useTrash);
        }}
      />
    ));
  }

  function renameDialog() {
    const names = sidesOn().flatMap((s) => sideItems(s).map((n) => n[s]!.name));
    show(() => (
      <RenameDialog
        names={names}
        onClose={closeDialog}
        onStart={(fn) => {
          closeDialog();
          const actions: Action[] = [];
          for (const s of sidesOn())
            for (const n of sideItems(s)) {
              const to = fn(n[s]!.name);
              if (to && to !== n[s]!.name && !/[\\/]/.test(to)) actions.push({ op: "rename", from: sidePath(n, s), to: joinPath(parentPath(n, s), to), rel: n.rel, dir: n.dir, size: 0 });
            }
          // Rename deeper items first so their parent paths stay valid.
          actions.sort((a, b) => b.rel.split("/").length - a.rel.split("/").length);
          void execute(actions);
        }}
      />
    ));
  }

  async function attributesDialog() {
    const paths = sidesOn().flatMap((s) => sideItems(s).map((n) => sidePath(n, s)));
    const infos = await api.itemInfo(paths);
    show(() => (
      <AttributesDialog
        counts={counts()}
        modes={infos.map((i) => i.mode)}
        windows={IS_WINDOWS}
        onClose={closeDialog}
        onStart={(mode, mask) => {
          closeDialog();
          void execute(paths.map((p, i) => ({ op: "chmod", to: p, rel: p, dir: infos[i].dir, size: 0, mode, mask })));
        }}
      />
    ));
  }

  function touchDialog() {
    show(() => (
      <TouchDialog
        counts={counts()}
        canCopy={effSel().some((n) => n.left && n.right)}
        onClose={closeDialog}
        onStart={({ sides, recursive, time }) => {
          closeDialog();
          const actions: Action[] = [];
          for (const s of sides)
            for (const n of sideItems(s)) {
              if (time === null && !n[other(s)]) continue;
              actions.push({ op: "touch", to: sidePath(n, s), rel: n.rel, dir: n.dir, size: 0, recursive, ...(time === null ? { from: sidePath(n, other(s)) } : { time }) });
            }
          void execute(actions);
        }}
      />
    ));
  }

  function newFolderDialog() {
    const n = single();
    const sides: SideName[] = sidesOn();
    // Inside an opened folder, otherwise next to the selected item, otherwise in the base folder.
    const where = sides.map((s) => (!n ? rootOf(s) : n.dir && expanded().has(n.rel) ? sidePath(n, s) : parentPath(n, s)));
    show(() => (
      <NewFolderDialog
        where={where}
        onClose={closeDialog}
        onStart={(name) => {
          closeDialog();
          void execute(where.map((w) => ({ op: "mkdir", to: joinPath(w, name), rel: name, dir: true, size: 0 })));
        }}
      />
    ));
  }

  /** Files of a single extension get the Exclude dialog; anything else is excluded directly. */
  const excludeType = () => {
    const items = effSel();
    if (!items.length || items.some((n) => n.dir)) return null;
    const exts = new Set(items.map((n) => extOf(n.name).toLowerCase()));
    return exts.size === 1 ? [...exts][0] : null;
  };
  function addExcludes(masks: string[]) {
    const cur = opts.exclude.split(";").map((m) => m.trim()).filter(Boolean);
    setOpts("exclude", [...cur, ...masks.filter((m) => !cur.includes(m))].join(";"));
    saveOpts();
    setSel(new Set<string>());
    void refresh();
  }
  const nameMask = (n: FNode, onlyHere: boolean) => {
    const nm = n.left?.name ?? n.right!.name;
    const rel = n.leftPath ?? n.rightPath ?? n.rel;
    const m = onlyHere ? `/${rel.slice(0, rel.length - n.name.length)}${nm}` : nm;
    return n.dir ? `${m}/` : m;
  };
  function exclude() {
    const items = effSel();
    const ext = excludeType();
    if (ext === null || quietExclude()) return addExcludes(items.map((n) => nameMask(n, false)));
    show(() => (
      <ExcludeDialog
        names={items.map((n) => n.name)}
        ext={ext}
        onClose={closeDialog}
        onStart={(byType, onlyHere, dontShow) => {
          closeDialog();
          if (dontShow) setQuietExclude(true);
          if (!byType) return addExcludes(items.map((n) => nameMask(n, onlyHere)));
          const typeMask = ext ? `*${ext}` : "*.";
          addExcludes(onlyHere ? [...new Set(items.map((n) => `/${parentRel(n.rel) ? parentRel(n.rel) + "/" : ""}${typeMask}`))] : [typeMask]);
        }}
      />
    ));
  }

  function folderDialog(move: boolean) {
    const side: SideName = hasCount(counts().left) ? "left" : "right";
    show(() => (
      <FolderDialog
        move={move}
        counts={counts()}
        side={side}
        initial={parentDir(rootOf(side))}
        onClose={closeDialog}
        onStart={async (s, dest, structure) => {
          closeDialog();
          const items = sideItems(s);
          const rels = items.map((n) => n.rel);
          // "Relative" keeps the structure below the deepest folder the items have in common.
          let common = rels.length ? parentRel(rels[0]) : "";
          for (const r of rels) while (common && !(r + "/").startsWith(common + "/")) common = parentRel(common);
          const sub = (n: FNode, st: Structure) => {
            const full = sidePath(n, s).slice(rootOf(s).replace(/[\\/]+$/, "").length + 1).replace(/\\/g, "/");
            if (st === "flat") return n[s]!.name;
            if (st === "base") return full;
            return common ? full.split("/").slice(common.split("/").length).join("/") : full;
          };
          const actions: Action[] = items.map((n) => ({ op: move ? "move" : "copy", from: sidePath(n, s), to: joinPath(dest, sub(n, structure)), rel: n.rel, dir: n.dir, size: treeBytes(n, s) }));
          const ok = await confirmOverwrites(actions, () => true);
          if (ok) await execute(ok);
        }}
      />
    ));
  }

  /** Files below the selection that exist on both sides. */
  const pairedFiles = (nodes: FNode[]) => {
    const out: FNode[] = [];
    const walk = (n: FNode) => (n.dir ? n.children?.forEach(walk) : n.left && n.right && out.push(n));
    nodes.forEach(walk);
    return out;
  };

  /** Replaces nodes in a copy of the result tree and recomputes folder statuses and the summary. */
  function patchTree(update: (byRel: Map<string, FNode>, root: FNode) => void) {
    const r = result();
    if (!r) return;
    const root = structuredClone(r.root) as FNode;
    const byRel = new Map<string, FNode>();
    const walk = (n: FNode) => (byRel.set(n.rel, n), n.children?.forEach(walk));
    walk(root);
    update(byRel, root);
    const summary = recompute(root);
    setResult({ root, summary });
  }

  async function compareContents(mode: ContentMode, showResults: boolean) {
    const files = pairedFiles(effSel());
    if (!files.length) return setMessage("No files exist on both sides.");
    setBusy(true);
    const codes: { rel: string; code: number }[] = [];
    try {
      for (let i = 0; i < files.length; i += 8) {
        const batch = files.slice(i, i + 8);
        const res = await Promise.all(batch.map((n) => api.quickCompare(sidePath(n, "left"), sidePath(n, "right"), mode).catch(() => 100)));
        batch.forEach((n, k) => codes.push({ rel: n.rel, code: res[k] }));
        setMessage(`Comparing contents… ${codes.length}/${files.length}`);
      }
    } finally {
      setBusy(false);
    }
    const st = (c: number): Status => (c === 1 || c === 2 ? "same" : c === 12 ? "similar" : c === 11 || c === 13 ? "diff" : "error");
    const verdict = (c: number): ContentVerdict | undefined => {
      if (c === 1) return "sameBinary";
      if (c !== 2 && c !== 11 && c !== 12 && c !== 13) return undefined;
      if (c === 11 || mode !== "rules") return "differentBinary";
      return c === 2 ? "same" : c === 12 ? "similar" : "different";
    };
    patchTree((byRel) => {
      for (const { rel, code } of codes) {
        const n = byRel.get(rel);
        if (!n) continue;
        n.status = st(code);
        n.content = verdict(code);
        n.newer = n.status === "diff" ? n.newer ?? ((n.left!.modified ?? 0) > (n.right!.modified ?? 0) ? "left" : (n.right!.modified ?? 0) > (n.left!.modified ?? 0) ? "right" : undefined) : undefined;
      }
    });
    const same = codes.filter((c) => c.code === 1 || c.code === 2).length;
    setMessage(`Compared ${codes.length} file(s): ${same} same, ${codes.length - same} different.`);
    if (showResults)
      show(() => (
        <ContentsResults
          rows={codes}
          onClose={closeDialog}
          onOpen={(rel) => {
            const n = nodeByRel().get(rel);
            if (n) openNode(n);
          }}
        />
      ));
  }

  async function refreshSelection() {
    const rels = effSel().map((n) => n.rel);
    if (!rels.length) return;
    if (flatMode()) return refresh();
    setBusy(true);
    try {
      const nodes = await api.compareItems(left(), right(), rels, compareOptions());
      patchTree((byRel) => {
        rels.forEach((rel, i) => {
          const parent = byRel.get(parentRel(rel));
          if (!parent?.children) return;
          const at = parent.children.findIndex((c) => c.rel === rel);
          if (at < 0) return;
          const fresh = nodes[i];
          if (fresh) parent.children[at] = fresh;
          else parent.children.splice(at, 1);
        });
      });
      setMessage(`Refreshed ${rels.length} item(s).`);
    } catch (e) {
      setMessage(errText(e));
    } finally {
      setBusy(false);
    }
  }

  /** Actions › File Compare Report: the viewer's report dialog when all files share a viewer, otherwise the generic one. */
  async function fileReport() {
    const files = effSel().filter((n) => !n.dir);
    setBusy(true);
    let kind: ReportKind = "files";
    try {
      const kinds = await Promise.all(files.map((n) => api.pathInfo(sidePath(n, n.left ? "left" : "right")).then((i) => i.kind).catch(() => "")));
      if (kinds.length && kinds.every((k) => k === kinds[0]) && ["text", "hex", "table", "picture"].includes(kinds[0])) kind = kinds[0] as ReportKind;
    } finally {
      setBusy(false);
    }
    const request = (): ReportRequest => ({
      type: "files",
      files: files.map((n) => [n.rel, n.left ? sidePath(n, "left") : null, n.right ? sidePath(n, "right") : null]),
      leftBase: left(),
      rightBase: right(),
      forced: null,
    });
    show(() => <ReportDialog kind={kind} title={tabTitle(tab())} request={request} onClose={closeDialog} />);
  }

  /** Session › Folder Compare Report: the whole comparison, honouring the view's expansion. */
  function folderReport() {
    const request = (): ReportRequest => ({
      type: "folder",
      root: result()!.root,
      leftBase: left(),
      rightBase: right(),
      options: JSON.parse(JSON.stringify(opts)),
      expanded: flatMode() ? [] : [...expanded()],
    });
    const cols = [settings.folderColumns.size && "size", settings.folderColumns.modified && "timestamp"].filter(Boolean) as string[];
    show(() => <ReportDialog kind="folder" title={tabTitle(tab())} request={request} columns={cols} onClose={closeDialog} />);
  }

  async function browseBase(i: 0 | 1) {
    const p = await openDialog({ directory: true, multiple: false, defaultPath: (i === 0 ? left() : right()) || undefined });
    if (typeof p !== "string") return;
    setBases(i === 0 ? [p, right()] : [left(), p]);
  }


  function toggleIgnored() {
    const rels = effSel().map((n) => n.rel);
    const s = new Set(ignored());
    const allIgnored = rels.every((r) => s.has(r));
    for (const r of rels) allIgnored ? s.delete(r) : s.add(r);
    setIgnored(s);
  }

  function swap() {
    setOpts("align", (opts.align ?? []).map((a) => ({ parent: a.parent, left: a.right, right: a.left })));
    setBases([right(), left()]);
  }

  /* ---------- Navigation and search ---------- */

  const cursor = () => (anchor() ? flat().findIndex((r) => r.node.rel === anchor()) : -1);

  function selectIndex(i: number, extend = false) {
    const rows = flat();
    if (!rows.length) return;
    i = Math.max(0, Math.min(rows.length - 1, i));
    const rel = rows[i].node.rel;
    if (extend && anchor()) {
      const s = new Set(sel());
      s.add(rel);
      setSel(s);
    } else {
      setSel(new Set([rel]));
      // Land on the side that has an item, so actions apply to something.
      const n = rows[i].node;
      const s = selSide();
      if (s !== "both" && !n[s]) setSelSide(s === "left" ? "right" : "left");
    }
    setAnchor(rel);
    const top = i * ROW_H;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW_H > scroller.scrollTop + vp.height()) scroller.scrollTop = top + ROW_H - vp.height();
  }

  function selectRel(rel: string) {
    const parts = rel.split("/");
    const exp = new Set(expanded());
    for (let i = 1; i < parts.length; i++) exp.add(parts.slice(0, i).join("/"));
    setExpanded(exp);
    if (!flat().some((r) => r.node.rel === rel)) setMask(ALL_BITS);
    const i = flat().findIndex((r) => r.node.rel === rel);
    if (i >= 0) {
      selectIndex(i);
      scroller.scrollTop = Math.max(0, i * ROW_H - vp.height() / 3);
    }
  }

  const allNodes = createMemo(() => {
    const out: FNode[] = [];
    const walk = (n: FNode) => n.children?.forEach((c) => (out.push(c), walk(c)));
    if (result()) walk(result()!.root);
    return out;
  });

  function nextDiff(dir: 1 | -1) {
    const nodes = allNodes();
    const at = anchor() ? nodes.findIndex((n) => n.rel === anchor()) : dir === 1 ? -1 : nodes.length;
    const isDiff = (n: FNode) => {
      const st = statusOf(n);
      if (n.dir) return st === "left" || st === "right";
      return st !== "same" && !(st === "similar" && ignoreUnimportant());
    };
    for (let i = at + dir; i >= 0 && i < nodes.length; i += dir) if (isDiff(nodes[i])) return selectRel(nodes[i].rel);
    if (settings.nextDiffWrap) {
      const n = (dir === 1 ? nodes : [...nodes].reverse()).find(isDiff);
      if (n) {
        if (settings.nextDiffShowMessage) setMessage("Wrapped around.");
        return selectRel(n.rel);
      }
    }
    if (settings.nextDiffShowMessage) setMessage(dir === 1 ? "No more differences below." : "No more differences above.");
  }

  function findNext(dir: 1 | -1) {
    const q = findName().toLowerCase();
    if (!q) return void askFind();
    const nodes = allNodes();
    const at = anchor() ? nodes.findIndex((n) => n.rel === anchor()) : dir === 1 ? -1 : nodes.length;
    for (let step = 1; step <= nodes.length; step++) {
      const n = nodes[(((at + dir * step) % nodes.length) + nodes.length) % nodes.length];
      const name = (n.left?.name ?? n.right?.name ?? "").toLowerCase();
      if (q.includes("*") || q.includes("?") ? globMatch(q, name) : name.includes(q)) return selectRel(n.rel);
    }
    setMessage(`No file name matches “${findName()}”.`);
  }

  async function askFind() {
    const q = await promptText("Find Filename", "File name or mask (e.g. *.rs):", findName());
    if (q) {
      setFindName(q);
      findNext(1);
    }
  }

  const saveSession = () => saveNamedSession(tab(), setMessage);

  async function copyNames() {
    const text = sidesOn().flatMap((s) => sideItems(s).map((n) => sidePath(n, s))).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setMessage(`Copied ${text.split("\n").length} path(s) to the clipboard.`);
    } catch (err) {
      setMessage(`Clipboard unavailable: ${errText(err)}`);
    }
  }

  function selectWhere(pred: (n: FNode) => boolean, side: SideName | "both") {
    setSel(new Set(flat().filter((r) => pred(r.node)).map((r) => r.node.rel)));
    setSelSide(side);
  }

  const openSync = (mode?: string) => (setSyncMode(mode), setSyncOpen(true));

  /** Opens the Session Settings dialog (also reached from the Filters and Rules toolbar buttons). */
  function settingsDialog(page: SettingsTab = "specs") {
    show(() => (
      <FolderSettingsDialog
        tab={page}
        options={JSON.parse(JSON.stringify(opts))}
        view={viewSet()}
        paths={[left(), right()]}
        sessionName={tab().sessionName}
        onClose={closeDialog}
        onApply={async ({ options, view, paths, scope }) => {
          const flattenChanged = !!options.flatten !== flatMode();
          setOpts({ ...options, flatten: flatMode() });
          setViewSet(view);
          saveOpts();
          if (scope === "defaults") {
            const { align: _a, flatten: _f, ...rest } = JSON.parse(JSON.stringify(options)) as FolderOptions;
            setSetting("folderDefaults", rest);
            log("Saved as session defaults.");
          } else if (scope === "saved" && tab().sessionName) {
            const all = await api.listSessions();
            const ex = all.find((x) => x.saved && x.name === tab().sessionName);
            if (ex) {
              await api.saveSession({ ...ex, paths: [...paths], options: JSON.parse(JSON.stringify(tab().options)), modified: Date.now() });
              setSessionsVersion((v) => v + 1);
              log(`Updated saved session “${ex.name}”.`);
            }
          }
          if (flattenChanged) setFolderMode(options.flatten ? "flatten" : "structure");
          if (paths[0] !== left() || paths[1] !== right()) setBases(paths);
          else void refresh();
        }}
      />
    ));
  }

  /** Filters combo: "*.c;-obj/" style text of include and exclude masks. */
  const [filterEdit, setFilterEdit] = createSignal<string | null>(null);
  function applyFilterText(text: string) {
    const t = text.trim() || "*.*";
    const { include, exclude } = parseFilterText(t);
    setOpts({ include, exclude });
    saveOpts();
    rememberFilter(t);
    setFilterEdit(null);
    void refresh();
  }

  /** User-defined Open With applications (Tools › Options › Open With). */
  function runOpenWith(command: string) {
    const items = effSel();
    const files = sidesOn().flatMap((s) => sideItems(s).map((n) => sidePath(n, s)));
    const n = items.length === 1 ? items[0] : undefined;
    const p1 = n?.left ? sidePath(n, "left") : files[0] ?? "";
    const p2 = n?.right ? sidePath(n, "right") : files[1] ?? "";
    const words = shellWords(command).flatMap((w) => (w === "%F" ? files : [w.replaceAll("%1", p1).replaceAll("%2", p2).replaceAll("%F", files.join(" "))]));
    if (!words.length) return;
    log(`Open With: ${words.join(" ")}`);
    api.spawnCommand(words[0], words.slice(1)).catch((e) => setMessage(`Open With failed: ${errText(e)}`));
  }

  /* ---------- Commands ---------- */

  const presetCmd = ([id, bits, label]: [string, number, string]): Command => ({
    id: `show-${id}`, menu: "View", hidden: true, label, checked: () => !suppress() && mask() === bits, run: () => setMask(bits),
  });
  const toggleCmd = ([id, bit, label]: [string, number, string]): Command => ({
    id, menu: "View", group: "toggles", label, checked: () => (mask() & bit) !== 0, run: () => setMask(mask() ^ bit),
  });
  const modeCmd = ([m, label]: [FolderMode, string]): Command => ({
    id: `mode-${m}`, menu: "View", group: "mode", label, checked: () => folderMode() === m, enabled: () => !busy(), run: () => setFolderMode(m),
  });
  const owCmd = (id: string, label: string, kind: ViewKind, dirs: boolean): Command => ({
    id, menu: "Actions", hidden: true, label, visible: () => (dirs ? nFolders() > 0 && !nFiles() : nFiles() > 0 && !nFolders()), enabled: () => !!pairPaths(), run: () => openWith(kind),
  });
  const singleFolder = () => (single()?.dir ? single() : undefined);
  const ext = externalCommands(() => (single() && singleSide() ? sidePath(single()!, singleSide()!) : undefined), setMessage).map(
    (c): Command => ({ ...c, menu: "Actions", hidden: true, label: c.id === "open-default" ? "Associated Application" : c.label }),
  );
  const syncCmd = (id: string, label: string, keys?: string): Command => ({ id, menu: "Actions", hidden: true, label, keys, enabled: () => idle() && basesDiffer(), run: () => openSync(id) });

  const cmds: Command[] = [
    // Session
    ...sessionCommands({
      tab,
      title: isSync ? "Folder Sync" : "Folder Compare",
      notify: setMessage,
      info: { enabled: () => !!result(), groups: () => folderInfo(result()!.root, opts.criteria === "timesize") },
    }),
    ...(isSync
      ? []
      : [{ id: "session-report", menu: "Session" as const, group: "report", label: "Folder Compare Report…", enabled: idle, run: folderReport }]),
    { id: "merge-bases", menu: "Session", group: "using", label: "Merge Base Folders", visible: () => !isSync, enabled: basesDiffer, run: () => openTab({ kind: "fmerge", paths: [left(), right(), "", left()] }) },
    { id: "sync-bases", menu: "Session", group: "using", label: isSync ? "Compare Base Folders" : "Sync Base Folders", enabled: () => !!left() && !!right(), run: () => openTab({ kind: isSync ? "folder" : "sync", paths: [left(), right()], options: JSON.parse(JSON.stringify(tab().options)) }) },
    { id: "browse-base", menu: "Session", group: "nav", label: "Browse for Folder", submenu: () => ["browse-left", "browse-right"], run: () => {} },
    { id: "browse-left", menu: "Session", hidden: true, label: "Left Side…", run: () => browseBase(0) },
    { id: "browse-right", menu: "Session", hidden: true, label: "Right Side…", run: () => browseBase(1) },
    { id: "settings", menu: "Session", group: "session", label: "Session Settings…", run: () => settingsDialog("specs") },
    { id: "swap", menu: "Session", group: "files", label: "Swap Sides", run: swap },
    { id: "back", menu: "Session", group: "nav", label: "Back", keys: "Alt+Left", enabled: () => history().back.length > 0, run: goBack },
    { id: "forward", menu: "Session", group: "nav", label: "Forward", keys: "Alt+Right", enabled: () => history().fwd.length > 0, run: goForward },
    { id: "up-level", menu: "Session", group: "nav", label: "Up One Level", submenu: () => ["up-both", "up-left", "up-right"], run: () => {} },
    { id: "up-both", menu: "Session", hidden: true, label: "Both Sides", enabled: () => !!left() && !!right(), run: () => upLevel(["left", "right"]) },
    { id: "up-left", menu: "Session", hidden: true, label: "Left Side", enabled: () => !!left(), run: () => upLevel(["left"]) },
    { id: "up-right", menu: "Session", hidden: true, label: "Right Side", enabled: () => !!right(), run: () => upLevel(["right"]) },

    // Pending Compare To (dynamic items placed first, as in the reference)
    { id: "cto-x", menu: "Actions", group: "cto", label: "Compare To", caption: () => `Compare to ${cmpFrom()?.name ?? ""}`, visible: () => !!cmpTarget(), run: () => compareToX() },
    ...(
      [["text", "Text Compare"], ["hex", "Hex Compare"], ["table", "Table Compare"], ["picture", "Picture Compare"]] as const
    ).map(([kind, title]): Command => ({
      id: `cto-${kind}`, menu: "Actions", group: "cto", label: `Compare in ${title}`, visible: () => !!cmpTarget() && !cmpFrom()!.dir, run: () => compareToX(kind),
    })),
    {
      id: "cto-cancel", menu: "Actions", group: "cto", label: "Cancel Compare To", keys: "Esc",
      caption: () => `Cancel "Compare to ${cmpFrom()?.name ?? ""}"`, visible: () => !!cmpFrom(), run: cancelCompareTo,
    },

    // Actions (TDirActions/TDirBaseActions order)
    { id: "open-folder", menu: "Actions", group: "open", label: "Open Folder", visible: () => !!singleFolder() && !expanded().has(single()!.rel), isDefault: () => true, run: () => toggle(single()!.rel) },
    { id: "close-folder", menu: "Actions", group: "open", label: "Close Folder", visible: () => !!singleFolder() && expanded().has(single()!.rel), isDefault: () => true, run: () => toggle(single()!.rel) },
    { id: "open-subfolders", menu: "Actions", group: "open", label: "Open Subfolders", visible: () => !nFiles() && nFolders() > 0, run: () => setSubtree(effSel(), true) },
    { id: "close-subfolders", menu: "Actions", group: "open", label: "Close Subfolders", visible: () => !nFiles() && nFolders() > 0, run: () => setSubtree(effSel(), false) },
    {
      id: "set-base", menu: "Actions", group: "open", label: "Set as Base Folder",
      caption: () => (nFolders() === 2 ? "Set as Base Folders" : "Set as Base Folder"),
      visible: () => !nFiles() && nFolders() >= 1 && nFolders() <= 2,
      run: () => {
        // One item: each selected side moves to it. Several: selections fill the left, then right, base in order.
        if (effSel().length === 1) {
          const lf = sideItems("left")[0], rf = sideItems("right")[0];
          return setBases([lf ? sidePath(lf, "left") : left(), rf ? sidePath(rf, "right") : right()]);
        }
        const paths = (["left", "right"] as SideName[]).flatMap((s) => sideItems(s).map((n) => sidePath(n, s)));
        setBases([paths[0] ?? left(), paths[1] ?? right()]);
      },
    },
    {
      id: "set-base-other", menu: "Actions", group: "open", label: "Set as Base on Other Side",
      visible: () => !nFiles() && nFolders() === 1,
      run: () => {
        const s = counts().left.folders ? "left" : "right";
        const p = sidePath(sideItems(s)[0], s);
        setBases(s === "left" ? [left(), p] : [p, right()]);
      },
    },
    {
      id: "open", menu: "Actions", group: "open", label: "Open",
      caption: () => (nFolders() ? "Open in New View" : "Open"),
      visible: () => (nFiles() > 0) !== (nFolders() > 0),
      isDefault: () => !nFolders(),
      run: openSelected,
    },
    {
      id: "open-with", menu: "Actions", group: "open", label: "Open With",
      submenu: () => [
        "open-default", "reveal", "-", "ow-folder", "ow-sync", "ow-text", "ow-hex", "ow-table", "ow-picture",
        ...(settings.openWith.length ? ["-" as const] : []),
        ...settings.openWith.map((a, i): Command => ({ id: `ow-user-${i}`, menu: "Actions", label: a.name, enabled: () => effSel().length > 0, run: () => runOpenWith(a.command) })),
      ],
      run: () => {},
    },
    ...ext,
    owCmd("ow-folder", "Folder Compare", "folder", true),
    owCmd("ow-sync", "Folder Sync", "sync", true),
    owCmd("ow-text", "Text Compare", "text", false),
    owCmd("ow-hex", "Hex Compare", "hex", false),
    owCmd("ow-table", "Table Compare", "table", false),
    owCmd("ow-picture", "Picture Compare", "picture", false),
    {
      id: "quick-compare", menu: "Actions", group: "open", label: "Quick Compare",
      visible: () => !nFolders() && (effSel().length === 2 || (effSel().length === 1 && !!single()?.left && !!single()?.right)),
      enabled: idle, run: quickCompare,
    },
    { id: "compare-to", menu: "Actions", group: "open", label: "Compare To…", keys: "F7", visible: () => effSel().length === 1, run: compareTo },
    {
      id: "align-with", menu: "Actions", group: "open", label: "Align With…", keys: "F6",
      caption: () => (single() && alignedEntry(single()!) >= 0 ? "Unalign" : effSel().length === 2 ? "Align With" : "Align With…"),
      visible: () => effSel().length >= 1 && effSel().length <= 2,
      enabled: () => idle() && (effSel().every((n) => n.status === "left" || n.status === "right") || (!!single() && alignedEntry(single()!) >= 0)),
      run: alignWith,
    },

    { id: "compare-contents", menu: "Actions", group: "ops", label: "Compare Contents…", enabled: () => idle() && effSel().length > 0, run: () => show(() => <ContentsDialog counts={counts()} onClose={closeDialog} onStart={(m, s) => (closeDialog(), void compareContents(m, s))} />) },
    { id: "copy-side", menu: "Actions", group: "ops", label: "Copy to Side…", caption: () => sideCaption(false), enabled: () => idle() && basesDiffer() && anySide(), run: () => sideDialog(false, sideDirection()) },
    { id: "move-side", menu: "Actions", group: "ops", label: "Move to Side…", caption: () => sideCaption(true), enabled: () => idle() && basesDiffer() && anySide(), run: () => sideDialog(true, sideDirection()) },
    { id: "copy-folder", menu: "Actions", group: "ops", label: "Copy to Folder…", enabled: () => idle() && anySide(), run: () => folderDialog(false) },
    { id: "move-folder", menu: "Actions", group: "ops", label: "Move to Folder…", enabled: () => idle() && anySide(), run: () => folderDialog(true) },
    { id: "delete", menu: "Actions", group: "ops", label: "Delete…", altKeys: ["Del"], enabled: () => idle() && anySide(), run: () => deleteDialog(false) },
    { id: "rename", menu: "Actions", group: "ops", label: "Rename…", keys: "F2", enabled: () => idle() && anySide(), run: renameDialog },
    { id: "attributes", menu: "Actions", group: "ops", label: "Attributes…", enabled: () => idle() && anySide(), run: () => void attributesDialog() },
    { id: "touch", menu: "Actions", group: "ops", label: "Touch…", enabled: () => idle() && anySide(), run: touchDialog },
    { id: "exclude", menu: "Actions", group: "ops", label: "Exclude", caption: () => (excludeType() !== null && !quietExclude() ? "Exclude…" : "Exclude"), enabled: () => idle() && effSel().length > 0, run: exclude },
    { id: "new-folder", menu: "Actions", group: "ops", label: "New Folder…", keys: "Ins", enabled: () => idle() && effSel().length <= 1, run: newFolderDialog },
    { id: "copy-names", menu: "Actions", group: "ops", label: "Copy Filename", enabled: anySide, run: copyNames },
    { id: "ignored", menu: "Actions", group: "ops", label: "Ignored", enabled: () => effSel().length > 0, checked: () => effSel().length > 0 && effSel().every((n) => ignored().has(n.rel)), run: toggleIgnored },
    { id: "refresh-sel", menu: "Actions", group: "ops", label: "Refresh Selection", keys: "Shift+F5", enabled: () => idle() && effSel().length > 0, run: refreshSelection },
    { id: "report", menu: "Actions", group: "ops", label: "File Compare Report…", visible: () => nFiles() > 0 && !nFolders(), enabled: idle, run: fileReport },
    {
      id: "sync-menu", menu: "Actions", group: "sync", label: "Synchronize",
      submenu: () => ["update-right", "update-left", "update-both", "mirror-right", "mirror-left"],
      run: () => {},
    },
    syncCmd("update-right", "Update Right…"),
    syncCmd("update-left", "Update Left…"),
    syncCmd("update-both", "Update Both…"),
    syncCmd("mirror-right", "Mirror to Right…", "Shift+Ctrl+R"),
    syncCmd("mirror-left", "Mirror to Left…", "Shift+Ctrl+L"),
    // Shortcut-only actions (MenuAllowed = False in the reference).
    { id: "copy-right", menu: "Actions", hidden: true, label: "Copy to Right", keys: "Ctrl+R", enabled: () => canCopyTo("right"), run: () => sideDialog(false, "right") },
    { id: "copy-left", menu: "Actions", hidden: true, label: "Copy to Left", keys: "Ctrl+L", enabled: () => canCopyTo("left"), run: () => sideDialog(false, "left") },
    { id: "move-right", menu: "Actions", hidden: true, label: "Move to Right", enabled: () => canCopyTo("right"), run: () => sideDialog(true, "right") },
    { id: "move-left", menu: "Actions", hidden: true, label: "Move to Left", enabled: () => canCopyTo("left"), run: () => sideDialog(true, "left") },
    { id: "delete-perm", menu: "Actions", hidden: true, label: "Delete Permanently", keys: "Shift+Del", enabled: () => idle() && anySide(), run: () => deleteDialog(true) },

    // Edit
    { id: "expand", menu: "Edit", group: "tree", label: "Expand All", enabled: () => !!result(), run: () => expandAll() },
    { id: "collapse", menu: "Edit", group: "tree", label: "Collapse All", run: () => setExpanded(new Set<string>()) },
    { id: "select-all", menu: "Edit", group: "sel", label: "Select All", keys: "Ctrl+A", run: () => selectWhere(() => true, "both") },
    { id: "select-files", menu: "Edit", group: "sel", label: "Select All Files", keys: "Shift+Ctrl+A", run: () => selectWhere((n) => !n.dir, "both") },
    { id: "select-newer", menu: "Edit", group: "sel", label: "Select Newer", submenu: () => ["newer-left", "newer-right", "newer-both"], run: () => {} },
    { id: "newer-left", menu: "Edit", hidden: true, label: "Left", run: () => selectWhere((n) => statusOf(n) === "diff" && n.newer === "left", "left") },
    { id: "newer-right", menu: "Edit", hidden: true, label: "Right", run: () => selectWhere((n) => statusOf(n) === "diff" && n.newer === "right", "right") },
    { id: "newer-both", menu: "Edit", hidden: true, label: "Both", run: () => selectWhere((n) => statusOf(n) === "diff" && !!n.newer, "both") },
    { id: "select-orphans", menu: "Edit", group: "sel", label: "Select Orphans", submenu: () => ["orph-left", "orph-right", "orph-both"], run: () => {} },
    { id: "orph-left", menu: "Edit", hidden: true, label: "Left", run: () => selectWhere((n) => statusOf(n) === "left", "left") },
    { id: "orph-right", menu: "Edit", hidden: true, label: "Right", run: () => selectWhere((n) => statusOf(n) === "right", "right") },
    { id: "orph-both", menu: "Edit", hidden: true, label: "Both", run: () => selectWhere((n) => statusOf(n) === "left" || statusOf(n) === "right", "both") },
    { id: "invert-sel", menu: "Edit", group: "sel", label: "Invert Selection", run: () => selectWhere((n) => !sel().has(n.rel), selSide()) },
    { id: "refresh", menu: "Edit", group: "refresh", label: "Refresh", keys: "F5", run: refresh },
    { id: "full-refresh", menu: "Edit", group: "refresh", label: "Full Refresh", keys: "Ctrl+F5", run: () => (setIgnored(new Set<string>()), refresh()) },

    // Search
    { id: "next-diff", menu: "Search", group: "diff", label: "Next Difference", keys: "Ctrl+N", run: () => nextDiff(1) },
    { id: "prev-diff", menu: "Search", group: "diff", label: "Previous Difference", keys: "Ctrl+P", run: () => nextDiff(-1) },
    { id: "find", menu: "Search", group: "find", label: "Find Filename…", keys: "Ctrl+F", run: askFind },
    { id: "find-next", menu: "Search", group: "find", label: "Find Next", keys: "F3", run: () => findNext(1) },
    { id: "find-prev", menu: "Search", group: "find", label: "Find Previous", keys: "Shift+F3", run: () => findNext(-1) },

    // View
    {
      id: "show-favorites", menu: "View", group: "filters", label: "Show",
      submenu: () => ["show-all", "show-diffs", "show-same", "show-noorphans", "show-diffsnoorph", "show-orphans", "-",
        "show-lnewer", "show-rnewer", "show-lnewerorph", "show-rnewerorph", "show-lorphans", "show-rorphans"],
      run: () => {},
    },
    ...PRESETS.map(presetCmd),
    { id: "show-all-key", menu: "View", hidden: true, label: "Show All", keys: "Ctrl+1", run: () => setMask(ALL_BITS) },
    { id: "show-diffs-key", menu: "View", hidden: true, label: "Show Differences", keys: "Ctrl+2", run: () => setMask(0x2cc) },
    { id: "show-same-key", menu: "View", hidden: true, label: "Show Same", keys: "Ctrl+3", run: () => setMask(0x1) },
    ...TOGGLES.map(toggleCmd),
    { id: "suppress-filters", menu: "View", group: "suppress", label: "Suppress Filters", checked: suppress, run: toggleSuppress },
    { id: "ignore-unimportant", menu: "View", group: "suppress", label: "Ignore Unimportant Differences", checked: ignoreUnimportant, run: () => setIgnoreUnimportant(!ignoreUnimportant()) },
    ...FOLDER_MODES.map(modeCmd),
    {
      id: "columns", menu: "View", group: "panes", label: "Columns", submenu: () => ["col-size", "col-modified"], run: () => {},
    },
    { id: "col-size", menu: "View", hidden: true, label: "Size", checked: () => settings.folderColumns.size, run: () => setSetting("folderColumns", { ...settings.folderColumns, size: !settings.folderColumns.size }) },
    { id: "col-modified", menu: "View", hidden: true, label: "Modified", checked: () => settings.folderColumns.modified, run: () => setSetting("folderColumns", { ...settings.folderColumns, modified: !settings.folderColumns.modified }) },
    { id: "legend", menu: "View", group: "panes", label: "Legend", keys: "Ctrl+Alt+L", run: () => setLegend(true) },
    { id: "log", menu: "View", group: "panes", label: "Log", checked: logOpen, run: () => setLogOpen(!logOpen()) },
    { id: "expand-all", menu: "View", group: "expand", label: "Expand All", run: () => expandAll() },
    { id: "collapse-all", menu: "View", group: "expand", label: "Collapse All", run: () => setExpanded(new Set<string>()) },

    // Keyboard navigation
    { id: "down", menu: "Search", hidden: true, label: "Next Row", keys: "Down", run: () => selectIndex(cursor() + 1) },
    { id: "up", menu: "Search", hidden: true, label: "Previous Row", keys: "Up", run: () => selectIndex(cursor() - 1) },
    { id: "sdown", menu: "Search", hidden: true, label: "Extend Selection Down", keys: "Shift+Down", run: () => selectIndex(cursor() + 1, true) },
    { id: "sup", menu: "Search", hidden: true, label: "Extend Selection Up", keys: "Shift+Up", run: () => selectIndex(cursor() - 1, true) },
    { id: "pgdn", menu: "Search", hidden: true, label: "Page Down", keys: "PgDn", run: () => selectIndex(cursor() + Math.floor(vp.height() / ROW_H)) },
    { id: "pgup", menu: "Search", hidden: true, label: "Page Up", keys: "PgUp", run: () => selectIndex(cursor() - Math.floor(vp.height() / ROW_H)) },
    { id: "first", menu: "Search", hidden: true, label: "First Row", keys: "Home", run: () => selectIndex(0) },
    { id: "last", menu: "Search", hidden: true, label: "Last Row", keys: "End", run: () => selectIndex(flat().length - 1) },
    // Enter runs the bold default item: open/close a single folder, otherwise open.
    { id: "activate", menu: "Actions", hidden: true, label: "Open", keys: "Enter", enabled: () => effSel().length > 0, run: () => (singleFolder() ? toggle(single()!.rel) : openSelected()) },
    { id: "side-left", menu: "Search", hidden: true, label: "Select Left Side", keys: "Ctrl+Left", run: () => setSelSide("left") },
    { id: "side-right", menu: "Search", hidden: true, label: "Select Right Side", keys: "Ctrl+Right", run: () => setSelSide("right") },
    {
      id: "expand-one", menu: "Edit", hidden: true, label: "Expand Folder", keys: "Right",
      run: () => { const n = flat()[cursor()]?.node; if (n?.dir && !expanded().has(n.rel)) toggle(n.rel); },
    },
    {
      id: "collapse-one", menu: "Edit", hidden: true, label: "Collapse Folder", keys: "Left",
      run: () => {
        const n = flat()[cursor()]?.node;
        if (!n) return;
        if (n.dir && expanded().has(n.rel)) return toggle(n.rel);
        const parent = parentRel(n.rel);
        if (parent) selectRel(parent);
      },
    },
  ];
  registerCommands(tab().id, cmds);

  /** Runs a command of this view by id if it is enabled (toolbar buttons). */
  const runCmd = (id: string) => {
    const c = cmds.find((x) => x.id === id);
    if (c && isEnabled(c, tab().id)) void c.run();
  };
  const cmdOn = (id: string) => {
    const c = cmds.find((x) => x.id === id);
    return !!c && isEnabled(c, tab().id);
  };

  /* ---------- Rendering ---------- */

  const sideCells = (n: FNode, side: SideName, depth: number) => {
    const s = n[side];
    const cls = () => {
      if (!s) return "missing";
      const st = statusOf(n);
      if (st === "left" || st === "right") return "orphan";
      if (st === "diff") return n.newer ? (n.newer === side ? "newer" : "older") : "diff";
      if (st === "similar") return "similar";
      if (st === "error") return "error";
      return "";
    };
    return (
      <div class={`fside ${cls()}`} classList={{ selc: sel().has(n.rel) && sidesOn().includes(side), ign: ignored().has(n.rel), cto: cmpFrom()?.rel === n.rel && cmpFrom()?.side === side }}>
        <span class="fname" style={{ "padding-left": `${depth * 16 + 4}px` }}>
          <Show when={s}>
            <Show when={n.dir} fallback={<span class="ficon">📄</span>}>
              <span class="twisty" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), toggle(n.rel))}>
                {expanded().has(n.rel) ? "▾" : "▸"}
              </span>
              <span class="ficon">📁</span>
            </Show>
          </Show>
          {s?.name ?? ""}
          <Show when={s && flatMode() && (side === "left" ? n.leftPath : n.rightPath)?.includes("/")}>
            <span class="fdir"> — {parentRel((side === "left" ? n.leftPath : n.rightPath)!)}</span>
          </Show>
        </span>
        <Show when={settings.folderColumns.size}>
          <span class="fsize">{s && !n.dir ? fmtSize(s.size) : ""}</span>
        </Show>
        <Show when={settings.folderColumns.modified}>
          <span class="ftime">{s ? fmtTime(s.modified) : ""}</span>
        </Show>
      </div>
    );
  };

  return (
    <div class="view">
      <div class="toolbar">
        <Btn title="Expand all" onClick={() => expandAll()} disabled={!result()}>⊞ Expand</Btn>
        <Btn title="Collapse all" onClick={() => setExpanded(new Set<string>())}>⊟ Collapse</Btn>
        <span class="sep" />
        <div class="seg">
          {([[ALL_BITS, "All"], [0x2cc, "Diffs"], [0x1, "Same"], [0xc, "Orphans"], [0x2c1, "No Orphans"]] as [number, string][]).map(([bits, label]) => (
            <Btn title={PRESETS.find((p) => p[1] === bits)![2]} active={!suppress() && mask() === bits} onClick={() => setMask(bits)}>
              {label}
            </Btn>
          ))}
        </div>
        <span class="sep" />
        <Btn title="Copy to Left" kbd={displayKeys("Ctrl+L")} onClick={() => runCmd("copy-left")} disabled={!cmdOn("copy-left")}>⇐ Copy</Btn>
        <Btn title="Copy to Right" kbd={displayKeys("Ctrl+R")} onClick={() => runCmd("copy-right")} disabled={!cmdOn("copy-right")}>Copy ⇒</Btn>
        <Btn title="Delete…" kbd={displayKeys("Del")} onClick={() => runCmd("delete")} disabled={!cmdOn("delete")}>🗑 Delete</Btn>
        <span class="sep" />
        <Btn title="Synchronize folders" onClick={() => openSync()} disabled={!result()}>⇆ Sync…</Btn>
        <Btn title="Comparison rules (Session Settings)" onClick={() => settingsDialog("comparison")}>⚖ Rules</Btn>
        <Btn title="Swap sides" onClick={swap}>⇄ Swap</Btn>
        <Btn title="Refresh" kbd="F5" onClick={refresh}>⟳ Refresh</Btn>
        <Btn title="Save as named session" kbd={displayKeys("Shift+Ctrl+S")} onClick={saveSession}>
          ★ Save Session
        </Btn>
      </div>
      <div class="filterbar">
        <label class="filter-combo" title="File filters: masks separated by ';'. Prefix a mask with '-' to exclude it; end it with '/' for folders.">
          Filters:
          <input
            list={`filters-${tab().id}`}
            value={filterEdit() ?? filterText(opts)}
            disabled={suppress() || peek()}
            onInput={(e) => setFilterEdit(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyFilterText(e.currentTarget.value);
              else if (e.key === "Escape") (setFilterEdit(null), e.currentTarget.blur());
            }}
            onChange={(e) => applyFilterText(e.currentTarget.value)}
          />
          <datalist id={`filters-${tab().id}`}>
            <For each={[...new Set([...settings.filterHistory, ...settings.filterPresets.map((p) => p.mask)])]}>{(f) => <option value={f} />}</For>
          </datalist>
        </label>
        <Btn title="Edit file filters (Session Settings › Name Filters)" onClick={() => settingsDialog("names")}>⛃ Filters</Btn>
        <Btn title="Peek: temporarily show items excluded by the file filters" active={peek()} onClick={togglePeek}>👁 Peek</Btn>
        <Show when={suppress() || peek()}>
          <span class="badge warn">{suppress() ? "Filters suppressed" : "Peeking at excluded items"}</span>
        </Show>
        <Show when={(opts.otherFilters ?? []).some((f) => f.enabled !== false) && !suppress() && !peek()}>
          <span class="badge">+{(opts.otherFilters ?? []).filter((f) => f.enabled !== false).length} other filter(s)</span>
        </Show>
        <Show when={folderMode() === "flatten"}>
          <span class="badge">Ignoring folder structure</span>
        </Show>
        <span class="spacer" />
        <Show when={mask() !== ALL_BITS && !suppress()}>
          <span class="muted small">{PRESETS.find((p) => p[1] === mask())?.[2] ?? "Custom display filter"}</span>
        </Show>
      </div>
      <div class="paths two">
        <PathBar folder value={left()} title={tab().titles?.[0]} onCommit={(p) => setPath(0, p)} />
        <PathBar folder value={right()} title={tab().titles?.[1]} onCommit={(p) => setPath(1, p)} />
      </div>
      <div class="fheader">
        <For each={[0, 1]}>
          {(i) => (
            <>
              <Show when={i === 1}>
                <div class="fstatus" />
              </Show>
              <div class="fside">
                <span class="fname">Name</span>
                <Show when={settings.folderColumns.size}>
                  <span class="fsize">Size</span>
                </Show>
                <Show when={settings.folderColumns.modified}>
                  <span class="ftime">Modified</span>
                </Show>
              </div>
            </>
          )}
        </For>
      </div>
      <div
        class="fscroll"
        classList={{ picking: !!cmpFrom() }}
        ref={scroller}
        onMouseDown={(e) => {
          // A click on the empty area clears the selection; New Folder then targets the clicked side's base folder.
          if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.filler) {
            setSel(new Set<string>());
            setSelSide(sideOf(e) === 0 ? "left" : "right");
          }
        }}
        onContextMenu={(e) => showContextMenu(e, tab().id, BACKGROUND_MENU)}
        onScroll={(e) => vp.setScrollTop(e.currentTarget.scrollTop)}>
        <Show when={error()}>
          <div class="banner err">{error()}</div>
        </Show>
        <Show when={!left() || !right()}>
          <div class="empty">Choose a left and right folder to compare.</div>
        </Show>
        <div data-filler="1" style={{ height: `${flat().length * ROW_H}px`, position: "relative" }}>
          <Index each={windowRows()}>
            {(item) => {
              const n = () => item().f.node;
              return (
                <div
                  class={`frow fs-${statusOf(n())}${sel().has(n().rel) ? " sel" : ""}${item().i % 2 ? " odd" : ""}${n().dir && !settings.folderColorFolders ? " plain-dir" : ""}`}
                  style={{ top: `${item().i * ROW_H}px` }}
                  onMouseDown={(e) => (e.stopPropagation(), click(e, n().rel, item().i))}
                  onDblClick={() => activate(n())}
                  onContextMenu={(e) => showContextMenu(e, tab().id, ROW_MENU)}
                  title={n().error ?? n().rel}
                >
                  {sideCells(n(), "left", item().f.depth)}
                  <div class="fstatus">{ignored().has(n().rel) ? "◌" : STATUS_GLYPH[statusOf(n())]}</div>
                  {sideCells(n(), "right", item().f.depth)}
                </div>
              );
            }}
          </Index>
        </div>
      </div>
      <Show when={logOpen()}>
        <div class="log-pane">
          <div class="log-head">
            Log <span class="spacer" />
            <button class="link-btn" onClick={() => setLogLines([])}>Clear</button>
            <button class="link-btn" onClick={() => setLogOpen(false)}>✕</button>
          </div>
          <div class="log-body" ref={(el) => createEffect(() => (logLines(), queueMicrotask(() => (el.scrollTop = el.scrollHeight))))}>
            <For each={logLines()}>{(l) => <div><span class="muted">{new Date(l.t).toLocaleTimeString()}</span> {l.text}</div>}</For>
          </div>
        </div>
      </Show>
      <div class="statusbar">
        <Show when={result()} fallback={<span>{busy() ? "Comparing…" : ""}</span>}>
          {(r) => (
            <span>
              {busy() ? "Working… " : ""}
              {r().summary.files} files · <span class="st-same">{r().summary.same} same</span> ·{" "}
              {r().summary.similar ? <><span class="st-sim">{r().summary.similar} similar</span> · </> : null}
              <span class="st-diff">{r().summary.diff} different</span> · <span class="st-orphan">{r().summary.leftOnly} left-only · {r().summary.rightOnly} right-only</span>
              {r().summary.errors ? ` · ${r().summary.errors} errors` : ""}
            </span>
          )}
        </Show>
        <span class="muted">{message_()}</span>
        <span class="spacer" />
        <span class="muted">
          {anySide() ? `Selected: left ${counts().left.files + counts().left.folders}, right ${counts().right.files + counts().right.folders}` : ""}
        </span>
      </div>
      <Show when={dialog()}>{(d) => d()()}</Show>
      <Show when={legend()}>
        <Modal title="Legend" onClose={() => setLegend(false)}>
          <div class="legend">
            <div class="fside newer"><span class="fname">file.txt</span><span>Different; this side is newer (or no timestamp winner)</span></div>
            <div class="fside older"><span class="fname">file.txt</span><span>Different; this side is older</span></div>
            <div class="fside orphan"><span class="fname">file.txt</span><span>Orphan: exists on this side only</span></div>
            <div class="fside similar"><span class="fname">file.txt</span><span>Similar: only unimportant differences</span></div>
            <div class="fside"><span class="fname">file.txt</span><span>Same</span></div>
            <div class="fside error"><span class="fname">file.txt</span><span>Error reading or comparing</span></div>
            <div class="fside ign"><span class="fname">file.txt</span><span>Ignored (treated as same)</span></div>
            <p class="muted">Status column: = same · ≈ similar · ≠ different · ◧ left only · ◨ right only · ! error · ◌ ignored</p>
          </div>
        </Modal>
      </Show>
      <Show when={syncOpen()}>
        <SyncDialog
          left={left()}
          right={right()}
          mode={syncMode()}
          options={{ ...opts, align: [...(opts.align ?? [])] }}
          scope={effSel().map((n) => n.rel)}
          onClose={() => setSyncOpen(false)}
          onDone={(res) => {
            report(res);
            setSyncOpen(false);
            void refresh();
          }}
        />
      </Show>
    </div>
  );
}

const SYNC_MODES: { id: string; label: string; help: string }[] = [
  { id: "update-right", label: "Update Right →", help: "Copy newer and orphan files from left to right." },
  { id: "update-left", label: "← Update Left", help: "Copy newer and orphan files from right to left." },
  { id: "update-both", label: "← Update Both →", help: "Copy newer and orphan files in both directions." },
  { id: "mirror-right", label: "Mirror to Right →", help: "Make right identical to left: replace different items, copy left orphans, delete right orphans." },
  { id: "mirror-left", label: "← Mirror to Left", help: "Make left identical to right: replace different items, copy right orphans, delete left orphans." },
];

const OP_LABEL: Record<Action["op"], string> = { copy: "Copy", move: "Move", delete: "Delete", rename: "Rename", mkdir: "Create", touch: "Touch", chmod: "Attributes" };

function SyncDialog(props: { left: string; right: string; mode?: string; options: FolderOptions; scope: string[]; onClose: () => void; onDone: (r: ActionResult[]) => void }) {
  const [mode, setMode] = createSignal(props.mode ?? "update-right");
  const [plan, setPlan] = createSignal<Action[] | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [useTrash, setUseTrash] = createSignal(settings.useTrash);
  // Started from a selection, the reference synchronizes the selected items only.
  const [selOnly, setSelOnly] = createSignal(props.scope.length > 0);
  const [err, setErr] = createSignal("");

  const inScope = (rel: string) => !selOnly() || props.scope.some((s) => rel === s || rel.startsWith(s + "/"));
  const shown = () => (plan() ?? []).filter((a) => inScope(a.rel));

  async function preview() {
    setBusy(true);
    setErr("");
    try {
      setPlan(await api.planSync(props.left, props.right, props.options, mode()));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }
  onMount(preview);

  async function start() {
    const p = shown();
    if (!p.length) return;
    setBusy(true);
    try {
      props.onDone(await api.executeActions(p, useTrash(), backupSpec(settings.backupOnCopy)));
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  }

  const total = () => shown().filter((a) => a.op === "copy").reduce((s, a) => s + a.size, 0);

  return (
    <Modal title="Folder Sync" onClose={props.onClose} wide>
      <div class="sync-modes">
        <For each={SYNC_MODES}>
          {(m) => (
            <label class="sync-mode" title={m.help}>
              <input type="radio" name="sync" checked={mode() === m.id} onChange={() => (setMode(m.id), preview())} /> {m.label}
              <div class="muted small">{m.help}</div>
            </label>
          )}
        </For>
      </div>
      <Show when={err()}>
        <div class="banner err">{err()}</div>
      </Show>
      <div class="sync-plan">
        <Show when={plan()} fallback={<div class="muted">{busy() ? "Planning…" : ""}</div>}>
          <Show when={shown().length} fallback={<div class="muted">Folders are already in sync for this mode.</div>}>
            <table>
              <thead>
                <tr><th>Action</th><th>Item</th><th>Target</th><th>Size</th></tr>
              </thead>
              <tbody>
                <For each={shown().slice(0, 2000)}>
                  {(a) => (
                    <tr class={`op-${a.op}`}>
                      <td>{OP_LABEL[a.op]}{a.dir ? " folder" : ""}</td>
                      <td>{a.rel}</td>
                      <td class="muted">{a.to}</td>
                      <td>{fmtSize(a.size)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>
      </div>
      <div class="modal-actions">
        <Show when={props.scope.length}>
          <label>
            <input type="checkbox" checked={selOnly()} onChange={(e) => setSelOnly(e.currentTarget.checked)} /> Selected items only
          </label>
        </Show>
        <label>
          <input type="checkbox" checked={useTrash()} onChange={(e) => setUseTrash(e.currentTarget.checked)} /> Delete to trash
        </label>
        <span class="spacer" />
        <span class="muted">
          {shown().length} action(s), {fmtSize(total())} to copy
        </span>
        <button onClick={props.onClose}>Cancel</button>
        <button class="primary" disabled={busy() || !shown().length} onClick={start}>Start Sync</button>
      </div>
    </Modal>
  );
}
