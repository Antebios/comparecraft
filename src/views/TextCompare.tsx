import { ask, emit, isEmbedded, listen, open as openDialog, save as saveDialog, readText, writeText } from "../host";
import { settings } from "../settings";
import { batch, createEffect, createMemo, createSignal, For, Index, on, onCleanup, onMount, Show } from "solid-js";
import { api, basename, defaultRules, errText, fmtSize, fmtTime, type DiffResult, type Row, type Rules, type TextFile } from "../api";
import { Btn, Highlighted, Modal, PathBar, ROW_H, useViewport } from "../components/common";
import { showContextMenu } from "../components/ContextMenu";
import { externalCommands, shellWords } from "../components/external";
import FindBar from "../components/FindBar";
import { promptText } from "../components/Prompt";
import { displayKeys, registerCommands, type Command, type MenuRef } from "../commands";
import { openTab, persistSession, updateTab, type Tab } from "../store";
import { textInfo } from "../components/InfoDialog";
import { saveSession as saveNamedSession, sessionCommands } from "./sessionMenu";
import { ReplacementDialog, RulesPanel } from "../components/RulesPanel";
import { SessionButtons } from "../components/SessionTools";

type Side = 0 | 1;
type Filter = "all" | "diffs" | "context" | "same";
/** A manual alignment boundary: left line `l` and right line `r` start a new aligned segment. */
type Cut = { l: number; r: number };

const other = (s: Side): Side => (s === 0 ? 1 : 0);
const keyOf = (s: Side) => (s === 0 ? "l" : "r") as "l" | "r";
const splitLines = (t: string) => {
  const a = t.split(/\r\n|\n|\r/);
  if (a.length > 1 && a[a.length - 1] === "") a.pop();
  return a;
};

async function clipRead(): Promise<string> {
  try {
    return await readText();
  } catch {
    return navigator.clipboard.readText();
  }
}
async function clipWrite(t: string) {
  try {
    await writeText(t);
  } catch {
    await navigator.clipboard.writeText(t);
  }
}

/** Keeps cuts inside the files and strictly increasing on both sides. */
function normCuts(cs: Cut[], nl: number, nr: number): Cut[] {
  const sorted = cs.filter((c) => c.l >= 0 && c.r >= 0 && c.l <= nl && c.r <= nr).sort((x, y) => x.l - y.l || x.r - y.r);
  const out: Cut[] = [];
  let [pl, pr] = [0, 0];
  for (const c of sorted) {
    if (c.l < pl || c.r < pr || (c.l === pl && c.r === pr) || (c.l === nl && c.r === nr)) continue;
    out.push(c);
    [pl, pr] = [c.l, c.r];
  }
  return out;
}

/** Compares each manually aligned segment separately and joins the results. */
async function diffSegments(l: string[], r: string[], rules: Rules, cs: Cut[]): Promise<DiffResult> {
  const pts = normCuts(cs, l.length, r.length);
  if (!pts.length) return api.diffTexts(l, r, rules);
  const b = [{ l: 0, r: 0 }, ...pts, { l: l.length, r: r.length }];
  const parts = await Promise.all(b.slice(1).map((e, i) => api.diffTexts(l.slice(b[i].l, e.l), r.slice(b[i].r, e.r), rules)));
  const out: DiffResult = { rows: [], hunks: [], important: 0, unimportant: 0, sameLines: 0, identical: true };
  parts.forEach((p, i) => {
    const rowOff = out.rows.length;
    const hOff = out.hunks.length;
    for (const row of p.rows)
      out.rows.push({
        ...row,
        l: row.l === undefined ? undefined : row.l + b[i].l,
        r: row.r === undefined ? undefined : row.r + b[i].r,
        h: row.h === undefined ? undefined : row.h + hOff,
      });
    for (const h of p.hunks) out.hunks.push({ ...h, start: h.start + rowOff, end: h.end + rowOff });
    out.important += p.important;
    out.unimportant += p.unimportant;
    out.sameLines += p.sameLines;
    out.identical &&= p.identical;
  });
  return out;
}

/** Content key of a difference section, so "Ignored" survives recomparison. */
function hunkKey(res: DiffResult, h: number, l: string[], r: string[]) {
  const hk = res.hunks[h];
  const a: string[] = [];
  const b: string[] = [];
  for (let i = hk.start; i < hk.end; i++) {
    const row = res.rows[i];
    if (row.l !== undefined) a.push(l[row.l]);
    if (row.r !== undefined) b.push(r[row.r]);
  }
  return JSON.stringify([a, b]);
}

function lowerBound(a: number[], x: number) {
  let lo = 0,
    hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

export default function TextCompare(props: { tab: Tab; active: boolean }) {
  const tab = () => props.tab;
  const [meta, setMeta] = createSignal<[TextFile | null, TextFile | null]>([null, null]);
  const [L, setL] = createSignal<string[]>([]);
  const [R, setR] = createSignal<string[]>([]);
  const [dirty, setDirty] = createSignal<[boolean, boolean]>([false, false]);
  const [errors, setErrors] = createSignal<[string, string]>(["", ""]);
  const [rules, setRules] = createSignal<Rules>({ ...defaultRules(), ...((tab().options.rules as Rules) ?? {}) });
  const [ignoreUnimportant, setIgnoreUnimportant] = createSignal((tab().options.ignoreUnimportant as boolean) ?? false);
  const [result, setResult] = createSignal<DiffResult | null>(null);
  const [filter, setFilter] = createSignal<Filter>("all");
  const [cur, setCur] = createSignal(-1);
  const [selRow, setSelRow] = createSignal(-1);
  const [selSide, setSelSide] = createSignal<Side>(0);
  /** Other end of a line (row range) selection, or -1 when only the caret row is selected. */
  const [selAnchor, setSelAnchor] = createSignal(-1);
  const [cuts, setCuts] = createSignal<Cut[]>([]);
  const [alignFrom, setAlignFrom] = createSignal<{ side: Side; line: number } | null>(null);
  const [ignoredKeys, setIgnoredKeys] = createSignal<Set<string>>(new Set());
  const [replacing, setReplacing] = createSignal<{ from: string; to: string } | null>(null);
  const [editing, setEditing] = createSignal<{ ri: number; side: Side } | null>(null);
  const [showRules, setShowRules] = createSignal(false);
  const [editAll, setEditAll] = createSignal<Side | null>(null);
  const [backup, setBackup] = createSignal(settings.backupOnSave);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  // `b` is each side's disk baseline id when the entry was taken: undoing or redoing across a load
  // or save leaves text that differs from the file, so that side is dirty whatever `d` says.
  const history: { l: string[]; r: string[]; d: [boolean, boolean]; b: [number, number] }[] = [];
  const future: typeof history = [];
  let baseSeq = 0;
  let base: [number, number] = [0, 0];
  const newBase = (s: Side) => {
    base = [...base] as [number, number];
    base[s] = ++baseSeq;
  };
  const [findOpen, setFindOpen] = createSignal(false);
  const [findQuery, setFindQuery] = createSignal("");
  const [findCase, setFindCase] = createSignal(false);
  let findInput: HTMLInputElement | undefined;

  let paneL!: HTMLDivElement;
  let paneR!: HTMLDivElement;
  const vp = useViewport(() => paneL);

  const lines = (s: Side) => (s === 0 ? L() : R());
  const setLines = (s: Side, v: string[]) => (s === 0 ? setL(v) : setR(v));
  const readOnly = (s: Side) => !!tab().readOnly?.[s] || !!meta()[s]?.readOnly;

  async function loadSide(s: Side, path: string, content?: string[]) {
    let file: TextFile | null = null;
    let err = "";
    if (content) {
      setLines(s, content);
    } else if (path) {
      try {
        file = await api.loadText(path);
      } catch (e) {
        err = errText(e);
      }
    }
    // Update from the latest state after the await; both sides may load concurrently.
    batch(() => {
      setCuts([]);
      if (!content) setLines(s, file?.lines ?? []);
      const m = [...meta()] as [TextFile | null, TextFile | null];
      m[s] = file;
      setMeta(m);
      const errs = [...errors()] as [string, string];
      errs[s] = err;
      setErrors(errs);
      const d = [...dirty()] as [boolean, boolean];
      d[s] = false;
      setDirty(d);
      newBase(s);
    });
  }

  let token = 0;
  let timer: number | undefined;
  let goFirst = settings.nextDiffLoadFirst;
  function recompute(immediate = false) {
    clearTimeout(timer);
    const run = async () => {
      const t = ++token;
      setBusy(true);
      try {
        const [l, r] = [L(), R()];
        const res = applyIgnored(await diffSegments(l, r, rules(), cuts()), l, r);
        if (t === token) {
          setResult(res);
          if (goFirst && res.hunks.length) {
            goFirst = false;
            queueMicrotask(() => nextHunk(1));
          }
        }
      } catch (e) {
        setMessage(errText(e));
      } finally {
        if (t === token) setBusy(false);
      }
    };
    if (immediate) void run();
    else timer = window.setTimeout(run, 120);
  }

  /** Marks the user's "Ignored" sections as unimportant. */
  function applyIgnored(res: DiffResult, l: string[], r: string[]): DiffResult {
    const ig = ignoredKeys();
    if (!ig.size) return res;
    res.hunks.forEach((hk, h) => {
      if (!ig.has(hunkKey(res, h, l, r))) return;
      hk.ignored = true;
      if (hk.important) {
        hk.important = false;
        res.important--;
        res.unimportant++;
      }
      for (let i = hk.start; i < hk.end; i++) if (res.rows[i].k !== "same") res.rows[i].k = "unimportant";
    });
    return res;
  }

  onMount(async () => {
    const [lp, rp] = [tab().paths[0] ?? "", tab().paths[1] ?? ""];
    // Text handed over by "Compare Selection to Clipboard" (not persisted).
    const content = tab().options.content as [string[] | null, string[] | null] | undefined;
    // Unsaved side text restored by an embedding host; loaded over the file and kept dirty.
    const restore = tab().options.restore as [string[] | null, string[] | null] | undefined;
    if (content || restore) {
      const { content: _, restore: __, ...rest } = tab().options;
      updateTab(tab().id, { options: rest });
    }
    await Promise.all([loadSide(0, lp, content?.[0] ?? undefined), loadSide(1, rp, content?.[1] ?? undefined)]);
    if (restore) {
      batch(() => {
        if (restore[0]) setL(restore[0]);
        if (restore[1]) setR(restore[1]);
        setDirty([!!restore[0], !!restore[1]]);
      });
    }
    recompute(true);

    if (lp || rp) void persistSession(tab());
  });

  if (isEmbedded()) {
    // The embedding host reports edits to a side's source document made outside this view.
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<string>("file-changed", (e) => void externalChange(e.payload)).then((u) => (disposed ? u() : (unlisten = u)));
    onCleanup(() => {
      disposed = true;
      unlisten?.();
    });
    createEffect(() => {
      const d = dirty();
      const paths = [tab().paths[0] ?? "", tab().paths[1] ?? ""];
      // Sides without a file (revisions, clipboard) are persisted by value so a reload restores them.
      const content = [paths[0] ? null : L(), paths[1] ? null : R()];
      emit("text-state", {
        paths,
        titles: [...tab().titles],
        readOnly: [...tab().readOnly],
        options: content[0] || content[1] ? { ...tab().options, content } : tab().options,
        dirty: d,
        restore: [d[0] ? L() : null, d[1] ? R() : null],
      });
    });
  }

  async function externalChange(path: string) {
    for (const s of [0, 1] as Side[]) {
      if (!path || tab().paths[s] !== path) continue;
      if (dirty()[s]) {
        setMessage(`${basename(path)} changed outside this comparison. Reload before saving this side.`);
        continue;
      }
      await loadSide(s, path);
      recompute(true);
    }
  }

  createEffect(on(rules, (r) => {
    updateTab(tab().id, { options: { ...tab().options, rules: r } });
    recompute();
  }, { defer: true }));
  createEffect(on(ignoreUnimportant, (v) => updateTab(tab().id, { options: { ...tab().options, ignoreUnimportant: v } }), { defer: true }));
  createEffect(() => updateTab(tab().id, { dirty: dirty()[0] || dirty()[1] }));

  // Effective kind of a row given the "ignore unimportant" toggle.
  const kindOf = (row: Row) => (ignoreUnimportant() && row.k === "unimportant" ? "same" : row.k);
  const hunkActive = (h: number) => {
    const r = result();
    return !!r && (!ignoreUnimportant() || r.hunks[h].important);
  };

  const visible = createMemo(() => {
    const res = result();
    if (!res) return [] as number[];
    const f = filter();
    const rows = res.rows;
    const out: number[] = [];
    if (f === "all") {
      for (let i = 0; i < rows.length; i++) out.push(i);
    } else if (f === "same") {
      for (let i = 0; i < rows.length; i++) if (kindOf(rows[i]) === "same") out.push(i);
    } else if (f === "diffs") {
      for (let i = 0; i < rows.length; i++) if (kindOf(rows[i]) !== "same") out.push(i);
    } else {
      const C = settings.contextLines;
      let lastDiff = -Infinity;
      const isDiff = rows.map((r) => kindOf(r) !== "same");
      let nextDiff = Infinity;
      const next: number[] = new Array(rows.length);
      for (let i = rows.length - 1; i >= 0; i--) {
        if (isDiff[i]) nextDiff = i;
        next[i] = nextDiff;
      }
      for (let i = 0; i < rows.length; i++) {
        if (isDiff[i]) lastDiff = i;
        if (i - lastDiff <= C || next[i] - i <= C) out.push(i);
      }
    }
    return out;
  });

  const windowRows = createMemo(() => {
    const vis = visible();
    const { start, end } = vp.range(vis.length);
    const items: { vi: number; ri: number }[] = [];
    for (let i = start; i < end; i++) items.push({ vi: i, ri: vis[i] });
    return items;
  });

  const maxCh = (s: Side) => createMemo(() => lines(s).reduce((m, l) => Math.max(m, l.length), 0));
  const maxL = maxCh(0);
  const maxR = maxCh(1);

  let syncing = false;
  const onScroll = (src: HTMLDivElement, dst: HTMLDivElement) => {
    if (syncing) {
      syncing = false;
      return;
    }
    if (dst.scrollTop !== src.scrollTop || dst.scrollLeft !== src.scrollLeft) {
      syncing = true;
      dst.scrollTop = src.scrollTop;
      dst.scrollLeft = src.scrollLeft;
    }
    vp.setScrollTop(src.scrollTop);
  };

  function scrollToRow(ri: number) {
    const vi = lowerBound(visible(), ri);
    const top = Math.max(0, vi * ROW_H - vp.height() / 3);
    paneL.scrollTop = top;
    paneR.scrollTop = top;
    vp.setScrollTop(top);
  }

  function goHunk(h: number) {
    const res = result();
    if (!res || h < 0 || h >= res.hunks.length) return;
    setCur(h);
    setSelRow(res.hunks[h].start);
    scrollToRow(res.hunks[h].start);
  }

  function nextHunk(dir: 1 | -1) {
    const res = result();
    if (!res) return;
    let h = cur();
    if (h < 0) {
      // Start from the current scroll position.
      const vis = visible();
      const vi = Math.floor(vp.scrollTop() / ROW_H);
      const ri = vis[Math.min(vi, vis.length - 1)] ?? 0;
      h = dir === 1 ? -1 : res.hunks.length;
      for (let i = 0; i < res.hunks.length; i++) {
        if (res.hunks[i].start >= ri) {
          h = dir === 1 ? i - 1 : i;
          break;
        }
      }
    }
    for (let i = h + dir; i >= 0 && i < res.hunks.length; i += dir) {
      if (hunkActive(i)) return goHunk(i);
    }
    if (settings.nextDiffWrap) {
      const n = res.hunks.length;
      for (let k = 0; k < n; k++) {
        const i = dir === 1 ? k : n - 1 - k;
        if (hunkActive(i)) {
          if (settings.nextDiffShowMessage) setMessage("Wrapped around to the " + (dir === 1 ? "first" : "last") + " difference.");
          return goHunk(i);
        }
      }
    }
    if (settings.nextDiffShowMessage) setMessage(dir === 1 ? "No more differences below." : "No more differences above.");
  }

  function snapshot() {
    history.push({ l: L(), r: R(), d: dirty(), b: base });
    if (history.length > 200) history.shift();
    future.length = 0;
  }
  function restore(from: typeof history, to: typeof history) {
    const s = from.pop();
    if (!s) return;
    to.push({ l: L(), r: R(), d: dirty(), b: base });
    batch(() => {
      setL(s.l);
      setR(s.r);
      setDirty([s.d[0] || s.b[0] !== base[0], s.d[1] || s.b[1] !== base[1]]);
    });
    recompute();
  }
  const undo = () => restore(history, future);
  const redo = () => restore(future, history);

  function markDirty(s: Side) {
    const d = [...dirty()] as [boolean, boolean];
    d[s] = true;
    setDirty(d);
  }

  /** Line index on `side` where content should be inserted for row `ri`. */
  function insertionPoint(side: Side, ri: number): number {
    const rows = result()?.rows ?? [];
    const key = side === 0 ? "l" : "r";
    for (let i = ri; i < rows.length; i++) {
      const v = rows[i][key];
      if (v !== undefined) return v;
    }
    return lines(side).length;
  }

  /** Rows of the line selection, or the caret row. */
  const selRange = (): [number, number] => {
    const r = selRow();
    const a = selAnchor();
    if (r < 0) return [0, -1];
    return a < 0 ? [r, r] : [Math.min(a, r), Math.max(a, r)];
  };
  const hasLineSel = () => selAnchor() >= 0 && selRow() >= 0;
  const inSel = (ri: number) => {
    const [a, b] = selRange();
    return ri >= a && ri <= b;
  };
  /** Line indices on side `s` covered by the selected rows. */
  function selLines(s: Side): number[] {
    const rows = result()?.rows ?? [];
    const [a, b] = selRange();
    const out: number[] = [];
    for (let i = a; i <= b; i++) {
      const v = rows[i]?.[keyOf(s)];
      if (v !== undefined) out.push(v);
    }
    return out;
  }
  const curHunk = () => (cur() >= 0 ? cur() : result()?.rows[selRow()]?.h ?? -1);

  /** Replaces a side's lines, keeping manual alignment points in place. */
  function editLines(s: Side, next: string[]) {
    const prev = lines(s);
    if (cuts().length) {
      let a = 0;
      while (a < prev.length && a < next.length && prev[a] === next[a]) a++;
      let e = 0;
      while (e < prev.length - a && e < next.length - a && prev[prev.length - 1 - e] === next[next.length - 1 - e]) e++;
      const delEnd = prev.length - e;
      const delta = next.length - prev.length;
      const k = keyOf(s);
      setCuts(cuts().map((c) => ({ ...c, [k]: c[k] <= a ? c[k] : c[k] >= delEnd ? c[k] + delta : a })));
    }
    setLines(s, next);
    markDirty(s);
  }

  /** Copies rows `a..b` (inclusive) from the other side to side `to`. */
  function copyRows(to: Side, a: number, b: number) {
    const res = result();
    if (!res || a < 0 || b < a) return setMessage("Select a difference first.");
    if (readOnly(to)) return setMessage("Target side is read-only.");
    const from = other(to);
    const src: string[] = [];
    const dstIdx: number[] = [];
    for (let i = a; i <= b; i++) {
      const row = res.rows[i];
      if (row[keyOf(from)] !== undefined) src.push(lines(from)[row[keyOf(from)]!]);
      if (row[keyOf(to)] !== undefined) dstIdx.push(row[keyOf(to)]!);
    }
    if (!src.length && !dstIdx.length) return;
    snapshot();
    const dst = [...lines(to)];
    if (dstIdx.length) dst.splice(dstIdx[0], dstIdx[dstIdx.length - 1] - dstIdx[0] + 1, ...src);
    else dst.splice(insertionPoint(to, b + 1), 0, ...src);
    editLines(to, dst);
    recompute(true);
  }

  /** "Copy to Left/Right": the selected lines, or else the current difference section. */
  function copyHunk(to: Side) {
    if (hasLineSel()) return copyRows(to, ...selRange());
    const res = result();
    const h = curHunk();
    if (!res || h < 0) return setMessage("Select a difference first.");
    copyRows(to, res.hunks[h].start, res.hunks[h].end - 1);
  }

  /** "Copy Line to Left/Right": the selected lines, or else the caret line. */
  const copyLine = (to: Side) => (selRow() < 0 ? setMessage("Select a line first.") : copyRows(to, ...selRange()));

  /** Gutter arrow: copies a whole difference section. */
  function gutterCopy(h: number, to: Side) {
    const hk = result()?.hunks[h];
    if (!hk) return;
    batch(() => {
      setSelAnchor(-1);
      setCur(h);
      setSelRow(hk.start);
      setSelSide(other(to));
    });
    copyRows(to, hk.start, hk.end - 1);
  }

  function commitEdit(text: string) {
    const ed = editing();
    setEditing(null);
    const res = result();
    if (!ed || !res) return;
    const row = res.rows[ed.ri];
    const key = ed.side === 0 ? "l" : "r";
    const arr = [...lines(ed.side)];
    const newLines = text.split(/\r\n|\n|\r/);
    snapshot();
    if (row[key] !== undefined) {
      if (arr[row[key]!] === text) return void history.pop();
      arr.splice(row[key]!, 1, ...newLines);
    } else arr.splice(insertionPoint(ed.side, ed.ri), 0, ...newLines);
    editLines(ed.side, arr);
    recompute(true);
  }

  /** Deletes the selected lines (or the caret line) on the selected side. */
  function deleteLine() {
    const s = selSide();
    const ls = selLines(s);
    if (!ls.length || readOnly(s)) return;
    snapshot();
    const arr = [...lines(s)];
    arr.splice(ls[0], ls[ls.length - 1] - ls[0] + 1);
    editLines(s, arr);
    setSelAnchor(-1);
    recompute(true);
  }

  function insertLine(before = false) {
    const ri = selRow();
    const s = selSide();
    if (ri < 0 || readOnly(s)) return;
    const row = result()?.rows[ri];
    const key = s === 0 ? "l" : "r";
    snapshot();
    const arr = [...lines(s)];
    const at = row && row[key] !== undefined ? row[key]! + (before ? 0 : 1) : insertionPoint(s, ri);
    arr.splice(at, 0, "");
    editLines(s, arr);
    recompute(true);
  }

  function setSidePath(s: Side, p: string, title: string | null = null) {
    const paths = [...tab().paths];
    paths[s] = p;
    const titles = [...(tab().titles ?? [])];
    titles[s] = title;
    updateTab(tab().id, { paths, titles });
  }

  async function saveSide(s: Side, explicit?: string): Promise<boolean> {
    let path = explicit ?? (s === 1 && tab().saveTarget ? tab().saveTarget! : tab().paths[s]);
    if (!path) {
      const p = await saveDialog({});
      if (!p) return false;
      path = p;
      setSidePath(s, p);
    }
    const m = meta()[s];
    try {
      await api.saveText({
        path,
        lines: lines(s),
        encoding: m?.encoding ?? "UTF-8",
        bom: m?.bom ?? false,
        eol: m?.eol === "Mixed" ? "LF" : m?.eol ?? "LF",
        finalNewline: m?.finalNewline ?? true,
        backup: backup() && !tab().noBackups,
        backupKind: settings.backupKind,
        backupDir: settings.backupDir || null,
      });
      const d = [...dirty()] as [boolean, boolean];
      d[s] = false;
      setDirty(d);
      newBase(s);
      setMessage(`Saved ${path}`);
      return true;
    } catch (e) {
      setMessage(`Save failed: ${errText(e)}`);
      return false;
    }
  }

  /** "Save File As…": saves one side under a new name and keeps editing that file. */
  async function saveAs(s: Side) {
    const p = await saveDialog({ defaultPath: tab().paths[s] || undefined });
    if (!p) return;
    if (await saveSide(s, p)) {
      setSidePath(s, p);
      void persistSession(tab());
    }
  }

  async function saveAll() {
    if (dirty()[0]) await saveSide(0);
    if (dirty()[1]) await saveSide(1);
  }

  async function changePath(s: Side, p: string) {
    if (dirty()[s] && !(await ask("Discard unsaved changes on this side?", { kind: "warning" }))) return;
    setSidePath(s, p);
    await loadSide(s, p);
    setCur(-1);
    recompute(true);
    void persistSession(tab());
  }

  async function reload() {
    if ((dirty()[0] || dirty()[1]) && !(await ask("Reload from disk and discard unsaved changes?", { kind: "warning" }))) return;
    await Promise.all([loadSide(0, tab().paths[0] ?? ""), loadSide(1, tab().paths[1] ?? "")]);
    recompute(true);
  }

  function swap() {
    batch(() => {
      const l = L(),
        r = R();
      setL(r);
      setR(l);
      setMeta([meta()[1], meta()[0]]);
      setDirty([dirty()[1], dirty()[0]]);
      base = [base[1], base[0]];
      setErrors([errors()[1], errors()[0]]);
      setCuts(cuts().map((c) => ({ l: c.r, r: c.l })));
      setAlignFrom(null);
      updateTab(tab().id, { paths: [tab().paths[1] ?? "", tab().paths[0] ?? ""], titles: [tab().titles[1] ?? null, tab().titles[0] ?? null] });
    });
    recompute(true);
  }

  function selectRow(ri: number, side: Side = selSide(), extend = false) {
    batch(() => {
      if (!extend) setSelAnchor(-1);
      else if (selAnchor() < 0) setSelAnchor(selRow());
      setSelRow(ri);
      setSelSide(side);
      setCur(result()?.rows[ri]?.h ?? -1);
    });
    if (!visible().includes(ri)) setFilter("all");
    const vi = lowerBound(visible(), ri);
    const top = vi * ROW_H;
    if (top < paneL.scrollTop || top > paneL.scrollTop + vp.height() - ROW_H * 2) scrollToRow(ri);
  }

  /** Up/Down (Shift extends the line selection). */
  function moveSel(dir: 1 | -1, extend = false) {
    const vis = visible();
    if (!vis.length) return;
    const vi = selRow() < 0 ? (dir === 1 ? -1 : vis.length) : lowerBound(vis, selRow());
    const n = Math.max(0, Math.min(vis.length - 1, vi + dir));
    selectRow(vis[n], selSide(), extend);
  }

  /** Moves to the next/previous line that exists on the current side (skipping gaps). */
  function nextExisting(dir: 1 | -1) {
    const rows = result()?.rows ?? [];
    const key = selSide() === 0 ? "l" : "r";
    const vis = visible();
    let vi = lowerBound(vis, Math.max(selRow(), 0));
    if (selRow() < 0) vi = dir === 1 ? -1 : vis.length;
    for (vi += dir; vi >= 0 && vi < vis.length; vi += dir) {
      if (rows[vis[vi]][key] !== undefined) return selectRow(vis[vi]);
    }
  }

  function find(dir: 1 | -1) {
    const q = findQuery();
    const res = result();
    if (!q || !res) return setFindOpen(true);
    const norm = (t: string) => (findCase() ? t : t.toLowerCase());
    const needle = norm(q);
    const n = res.rows.length;
    // Search order: left then right within a row.
    const pos = selRow() < 0 ? (dir === 1 ? -1 : n) : selRow();
    const sides: Side[] = dir === 1 ? [0, 1] : [1, 0];
    const startSideIdx = selRow() < 0 ? -1 : sides.indexOf(selSide());
    for (let step = 0; step <= n; step++) {
      const ri = ((pos + dir * step) % n + n) % n;
      for (let si = 0; si < 2; si++) {
        if (step === 0 && si <= startSideIdx) continue;
        const side = sides[si];
        const idx = res.rows[ri][side === 0 ? "l" : "r"];
        if (idx !== undefined && norm(lines(side)[idx] ?? "").includes(needle)) {
          setMessage("");
          return selectRow(ri, side);
        }
      }
    }
    setMessage(`“${q}” not found.`);
  }

  async function goToLine() {
    const side = selSide();
    const v = await promptText("Go To", `Line number (${side === 0 ? "left" : "right"} side):`);
    const n = Number.parseInt(v ?? "", 10);
    if (!Number.isFinite(n)) return;
    const key = side === 0 ? "l" : "r";
    const ri = result()?.rows.findIndex((r) => r[key] === n - 1) ?? -1;
    if (ri >= 0) selectRow(ri);
    else setMessage(`Line ${n} does not exist.`);
  }

  async function openFile() {
    const p = await openDialog({ multiple: false, directory: false });
    if (typeof p === "string") await changePath(selSide(), p);
  }

  const saveSession = () => saveNamedSession(tab(), setMessage);

  const anyDirty = () => dirty()[0] || dirty()[1];
  const hasSel = () => selRow() >= 0;
  /** Text selected with the mouse, or else the selected lines of the selected side. */
  function selectionText(): string {
    const t = window.getSelection()?.toString() ?? "";
    if (t) return t;
    const s = selSide();
    return selLines(s).map((i) => lines(s)[i] ?? "").join("\n");
  }
  async function copyText() {
    const text = selectionText();
    if (!text) return;
    try {
      await clipWrite(text);
    } catch (err) {
      setMessage(`Clipboard unavailable: ${errText(err)}`);
    }
  }
  async function readClipboard(): Promise<string | null> {
    try {
      return await clipRead();
    } catch (err) {
      setMessage(`Clipboard unavailable: ${errText(err)}`);
      return null;
    }
  }
  async function cutLines() {
    if (readOnly(selSide()) || !selLines(selSide()).length) return;
    await copyText();
    deleteLine();
  }
  /** Pastes clipboard lines over the line selection, or before the caret line. */
  async function paste() {
    const s = selSide();
    if (readOnly(s)) return;
    const t = await readClipboard();
    if (!t) return;
    const ins = splitLines(t);
    const ls = hasLineSel() ? selLines(s) : [];
    const arr = [...lines(s)];
    snapshot();
    if (ls.length) arr.splice(ls[0], ls[ls.length - 1] - ls[0] + 1, ...ins);
    else arr.splice(selRow() >= 0 ? insertionPoint(s, selRow()) : arr.length, 0, ...ins);
    editLines(s, arr);
    setSelAnchor(-1);
    recompute(true);
  }

  /** Increase/Decrease Indent of the selected lines. */
  function indent(dir: 1 | -1) {
    const s = selSide();
    const ls = selLines(s);
    if (readOnly(s) || !ls.length) return;
    const arr = [...lines(s)];
    const tabW = settings.tabSize || 4;
    const unit = arr.some((x) => x.startsWith("\t")) ? "\t" : " ".repeat(tabW);
    let changed = false;
    for (const i of ls) {
      const before = arr[i];
      if (dir > 0) arr[i] = before ? unit + before : before;
      else if (before.startsWith("\t")) arr[i] = before.slice(1);
      else arr[i] = before.slice(Math.min(/^ */.exec(before)![0].length, tabW));
      changed ||= arr[i] !== before;
    }
    if (!changed) return;
    snapshot();
    editLines(s, arr);
    recompute(true);
  }

  /** "Select Section": selects every row of the current difference section. */
  function selectSection() {
    const res = result();
    const h = curHunk();
    if (!res || h < 0) return;
    const hk = res.hunks[h];
    batch(() => {
      setCur(h);
      setSelAnchor(hk.start);
      setSelRow(hk.end - 1);
    });
  }

  /** Opens the selection and the clipboard side by side in a new Text Compare. */
  async function compareToClipboard() {
    const sel = selectionText();
    if (!sel) return;
    const clip = await readClipboard();
    if (clip === null) return;
    openTab({ kind: "text", paths: ["", ""], titles: ["Selection", "Clipboard"], options: { content: [splitLines(sel), splitLines(clip)] } });
  }

  /** "Open Clipboard": replaces the selected side with the clipboard text. */
  async function openClipboard() {
    const s = selSide();
    if (dirty()[s] && !(await ask("Discard unsaved changes on this side?", { kind: "warning" }))) return;
    const t = await readClipboard();
    if (t === null) return;
    setSidePath(s, "", "Clipboard");
    await loadSide(s, "", splitLines(t));
    setCur(-1);
    recompute(true);
  }

  /** "Align With…": the first use marks a line, the second (on the other side) aligns the two lines. */
  function alignWith() {
    const s = selSide();
    const line = result()?.rows[selRow()]?.[keyOf(s)];
    const from = alignFrom();
    if (from && from.side !== s && line !== undefined) return completeAlign(from, { side: s, line });
    if (line === undefined) return setMessage("Select a line to align.");
    setAlignFrom({ side: s, line });
    setMessage(`Align With: click the ${s === 0 ? "right" : "left"} line to align with ${s === 0 ? "left" : "right"} line ${line + 1} (Esc cancels).`);
  }
  function addCuts(a: Cut, b: Cut) {
    const keep = cuts().filter((c) => (c.l <= a.l && c.r <= a.r) || (c.l >= b.l && c.r >= b.r));
    setCuts([...keep, a, b]);
    recompute(true);
  }
  function completeAlign(a: { side: Side; line: number }, b: { side: Side; line: number }) {
    const [l, r] = a.side === 0 ? [a.line, b.line] : [b.line, a.line];
    setAlignFrom(null);
    setSelAnchor(-1);
    addCuts({ l, r }, { l: l + 1, r: r + 1 });
    setMessage(`Aligned left line ${l + 1} with right line ${r + 1}.`);
  }
  /** "Isolate": realigns so the selected lines are by themselves. */
  function isolate() {
    const s = selSide();
    const ls = selLines(s);
    if (!ls.length) return;
    const o = insertionPoint(other(s), selRange()[0]);
    const [a, b] = [ls[0], ls[ls.length - 1] + 1];
    setSelAnchor(-1);
    if (s === 0) addCuts({ l: a, r: o }, { l: b, r: o });
    else addCuts({ l: o, r: a }, { l: o, r: b });
  }

  /** Difference sections touched by the selection. */
  function selHunks(): number[] {
    const res = result();
    if (!res) return [];
    if (!hasLineSel()) return curHunk() >= 0 ? [curHunk()] : [];
    const [a, b] = selRange();
    const hs = new Set<number>();
    for (let i = a; i <= b; i++) if (res.rows[i]?.h !== undefined) hs.add(res.rows[i].h!);
    return [...hs];
  }
  const selIgnored = () => {
    const hs = selHunks();
    return hs.length > 0 && hs.every((h) => !!result()?.hunks[h]?.ignored);
  };
  /** "Ignored": treats the selected difference sections as unimportant (or restores them). */
  function toggleIgnored() {
    const res = result();
    const hs = selHunks();
    if (!res || !hs.length) return;
    const on = !selIgnored();
    const ig = new Set(ignoredKeys());
    for (const h of hs) {
      const k = hunkKey(res, h, L(), R());
      if (on) ig.add(k);
      else ig.delete(k);
    }
    setIgnoredKeys(ig);
    recompute(true);
  }

  /** "Replacement…", prefilled with the first differing text of the current section. */
  function replacement() {
    const res = result();
    const h = curHunk();
    let [from, to] = ["", ""];
    if (res && h >= 0) {
      for (let i = res.hunks[h].start; i < res.hunks[h].end && !from; i++) {
        const row = res.rows[i];
        if (row.l === undefined || row.r === undefined) continue;
        const [ls, rs] = [row.ls?.[0], row.rs?.[0]];
        if (ls) from = L()[row.l].slice(ls[0], ls[1]);
        if (rs) to = R()[row.r].slice(rs[0], rs[1]);
      }
    }
    setReplacing({ from, to });
  }

  /** User-defined Open With applications (%1 / %2 = left / right file, %F = both). */
  function runOpenWith(command: string) {
    const [p1, p2] = [tab().paths[0] ?? "", tab().paths[1] ?? ""];
    const files = [p1, p2].filter(Boolean);
    const words = shellWords(command).flatMap((w) => (w === "%F" ? files : [w.replaceAll("%1", p1).replaceAll("%2", p2).replaceAll("%F", files.join(" "))]));
    if (!words.length) return;
    api.spawnCommand(words[0], words.slice(1)).catch((e) => setMessage(`Open With failed: ${errText(e)}`));
  }

  const sidePath = () => tab().paths[selSide()] || undefined;
  /** Pane popup, in the order of the reference editor's "Edit" popup. */
  const paneMenu = (s: Side): MenuRef[] => [
    "align-with", "isolate", "replacement",
    s === 0 ? "copy-right" : "copy-left",
    s === 0 ? "copy-line-right" : "copy-line-left",
    "indent-inc", "indent-dec", "-",
    "cut", "copy-text", "paste", "delete", "-",
    "select-section", "compare-clipboard", "-",
    "ignored", "-",
    "open", "open-clipboard", "open-with",
    { id: `save-side-${s}`, menu: "File", label: "Save File", enabled: () => dirty()[s] && !readOnly(s), run: () => saveSide(s) },
    { id: `save-as-${s}`, menu: "File", label: "Save File As…", keys: "F12", enabled: () => !readOnly(s), run: () => saveAs(s) },
  ];
  /** Gutter popup: copy commands only. */
  const gutterMenu = (s: Side): MenuRef[] => [s === 0 ? "copy-right" : "copy-left", s === 0 ? "copy-line-right" : "copy-line-left"];

  const filterCmd = (f: Filter, label: string): Command => ({
    id: `show-${f}`, menu: "View", group: "filter", label, checked: () => filter() === f, run: () => setFilter(f),
  });
  registerCommands(tab().id, [
    ...sessionCommands({
      tab,
      title: "Text Compare",
      dirty: anyDirty,
      notify: setMessage,
      report: {
        kind: "text",
        enabled: () => !!result(),
        request: () => ({ type: "pair", kind: "text", left: tab().paths[0] ?? "", right: tab().paths[1] ?? "", view: { left: L(), right: R(), rules: rules() } }),
      },
      info: { enabled: () => !!result(), lines: () => textInfo(result()!) },
    }),
    { id: "settings", menu: "Session", group: "session", label: "Session Settings (Rules)…", checked: showRules, run: () => setShowRules(!showRules()) },
    { id: "swap", menu: "Session", group: "files", label: "Swap Sides", run: swap },
    { id: "reload", menu: "Session", group: "files", label: "Reload", keys: "F5", run: reload },
    { id: "recompare", menu: "Session", group: "files", label: "Recompare", keys: "Ctrl+F5", run: () => recompute(true) },
    { id: "compare-using", menu: "Session", group: "using", label: "Compare Files Using", submenu: () => ["as-hex", "as-table"], run: () => {} },
    { id: "as-hex", menu: "Session", hidden: true, label: "Hex Compare", enabled: () => tab().paths.slice(0, 2).every(Boolean), run: () => openTab({ kind: "hex", paths: [...tab().paths] }) },
    { id: "as-table", menu: "Session", hidden: true, label: "Table Compare", enabled: () => tab().paths.slice(0, 2).every(Boolean), run: () => openTab({ kind: "table", paths: [...tab().paths] }) },
    { id: "as-merge", menu: "Session", group: "using", label: "Merge Files", run: () => openTab({ kind: "merge", paths: [tab().paths[0] ?? "", tab().paths[1] ?? ""] }) },
    { id: "open", menu: "File", group: "open", label: "Open File…", keys: "Ctrl+O", run: openFile },
    { id: "open-clipboard", menu: "File", group: "open", label: "Open Clipboard", keys: "Shift+Ctrl+V", enabled: () => !readOnly(selSide()), run: openClipboard },
    {
      id: "open-with", menu: "File", group: "open", label: "Open With",
      submenu: () => [
        "open-default", "reveal", "-", "ow-edit", "ow-patch",
        ...(settings.openWith.length ? ["-" as const] : []),
        ...settings.openWith.map((a, i): Command => ({ id: `ow-user-${i}`, menu: "File", label: a.name, run: () => runOpenWith(a.command) })),
      ],
      run: () => {},
    },
    { id: "ow-edit", menu: "File", group: "open", hidden: true, label: "Text Edit", enabled: () => !!sidePath(), run: () => openTab({ kind: "edit", paths: [sidePath()!] }) },
    { id: "ow-patch", menu: "File", group: "open", hidden: true, label: "Text Patch", enabled: () => !!sidePath(), run: () => openTab({ kind: "patch", paths: [sidePath()!] }) },
    { id: "save", menu: "File", group: "save", label: "Save", keys: "Ctrl+S", enabled: anyDirty, run: saveAll },
    { id: "save-left", menu: "File", group: "save", label: "Save Left", enabled: () => dirty()[0], run: () => saveSide(0) },
    { id: "save-right", menu: "File", group: "save", label: "Save Right", enabled: () => dirty()[1], run: () => saveSide(1) },
    { id: "save-as", menu: "File", group: "save", label: "Save As…", keys: "F12", enabled: () => !readOnly(selSide()), run: () => saveAs(selSide()) },
    ...externalCommands(sidePath, setMessage),
    { id: "backup", menu: "File", group: "opt", label: "Create Backup on Save", checked: backup, run: () => setBackup(!backup()) },
    { id: "undo", menu: "Edit", group: "undo", label: "Undo", keys: "Ctrl+Z", run: undo },
    { id: "redo", menu: "Edit", group: "undo", label: "Redo", keys: "Ctrl+Y", altKeys: ["Shift+Ctrl+Z"], run: redo },
    { id: "cut", menu: "Edit", group: "clip", label: "Cut", keys: "Ctrl+X", enabled: () => hasSel() && !readOnly(selSide()), run: cutLines },
    { id: "copy-text", menu: "Edit", group: "clip", label: "Copy", keys: "Ctrl+C", run: copyText },
    { id: "paste", menu: "Edit", group: "clip", label: "Paste", keys: "Ctrl+V", enabled: () => !readOnly(selSide()), run: paste },
    { id: "delete", menu: "Edit", group: "clip", label: "Delete", keys: "Del", enabled: () => selLines(selSide()).length > 0 && !readOnly(selSide()) && !editing(), run: deleteLine },
    { id: "select-section", menu: "Edit", group: "sel", label: "Select Section", keys: "Ctrl+D", enabled: () => curHunk() >= 0, run: selectSection },
    { id: "compare-clipboard", menu: "Edit", group: "sel", label: "Compare Selection to Clipboard", enabled: () => hasLineSel(), run: compareToClipboard },
    { id: "align-with", menu: "Edit", group: "align", label: "Align With…", keys: "F7", caption: () => (alignFrom() ? "Align With" : "Align With…"), enabled: hasSel, run: alignWith },
    { id: "isolate", menu: "Edit", group: "align", label: "Isolate", enabled: () => hasLineSel() && selLines(selSide()).length > 0, run: isolate },
    { id: "clear-align", menu: "Edit", group: "align", label: "Clear Manual Alignment", enabled: () => cuts().length > 0, run: () => (setCuts([]), recompute(true)) },
    { id: "cancel-align", menu: "Edit", group: "align", hidden: true, label: "Cancel Align With", keys: "Esc", visible: () => !!alignFrom(), run: () => (setAlignFrom(null), setMessage("")) },
    { id: "replacement", menu: "Edit", group: "align", label: "Replacement…", enabled: () => curHunk() >= 0, run: replacement },
    { id: "ignored", menu: "Edit", group: "align", label: "Ignored", checked: selIgnored, enabled: () => selHunks().length > 0, run: toggleIgnored },
    { id: "copy-left", menu: "Edit", group: "copy", label: "Copy to Left", keys: "Ctrl+L", enabled: () => !readOnly(0), run: () => copyHunk(0) },
    { id: "copy-right", menu: "Edit", group: "copy", label: "Copy to Right", keys: "Ctrl+R", enabled: () => !readOnly(1), run: () => copyHunk(1) },
    { id: "copy-line-left", menu: "Edit", group: "copy", label: "Copy Line to Left", keys: "Shift+Ctrl+L", enabled: () => hasSel() && !readOnly(0), run: () => copyLine(0) },
    { id: "copy-line-right", menu: "Edit", group: "copy", label: "Copy Line to Right", keys: "Shift+Ctrl+R", enabled: () => hasSel() && !readOnly(1), run: () => copyLine(1) },
    { id: "indent-inc", menu: "Edit", group: "copy", label: "Increase Indent", keys: "Shift+Ctrl+I", enabled: () => hasSel() && !readOnly(selSide()), run: () => indent(1) },
    { id: "indent-dec", menu: "Edit", group: "copy", label: "Decrease Indent", keys: "Shift+Ctrl+U", enabled: () => hasSel() && !readOnly(selSide()), run: () => indent(-1) },
    { id: "line-up", menu: "Search", hidden: true, label: "Line Up", keys: "Up", run: () => moveSel(-1) },
    { id: "line-down", menu: "Search", hidden: true, label: "Line Down", keys: "Down", run: () => moveSel(1) },
    { id: "sel-up", menu: "Search", hidden: true, label: "Extend Selection Up", keys: "Shift+Up", run: () => moveSel(-1, true) },
    { id: "sel-down", menu: "Search", hidden: true, label: "Extend Selection Down", keys: "Shift+Down", run: () => moveSel(1, true) },
    { id: "edit-line", menu: "Edit", group: "line", label: "Edit Line", keys: "F2", enabled: () => hasSel() && !readOnly(selSide()), run: () => setEditing({ ri: selRow(), side: selSide() }) },
    { id: "ins-after", menu: "Edit", group: "line", label: "Insert Line After", keys: "Ctrl+Enter", enabled: hasSel, run: () => insertLine(false) },
    { id: "ins-before", menu: "Edit", group: "line", label: "Insert Line Before", keys: "Shift+Ctrl+Enter", enabled: hasSel, run: () => insertLine(true) },
    { id: "edit-left", menu: "Edit", group: "text", label: "Edit Left as Text…", enabled: () => !readOnly(0), run: () => setEditAll(0) },
    { id: "edit-right", menu: "Edit", group: "text", label: "Edit Right as Text…", enabled: () => !readOnly(1), run: () => setEditAll(1) },
    { id: "next-diff", menu: "Search", group: "diff", label: "Next Difference Section", keys: "Ctrl+N", altKeys: ["Shift+Ctrl+N"], run: () => nextHunk(1) },
    { id: "prev-diff", menu: "Search", group: "diff", label: "Previous Difference Section", keys: "Ctrl+P", altKeys: ["Shift+Ctrl+P"], run: () => nextHunk(-1) },
    { id: "next-exists", menu: "Search", group: "line", label: "Next Existing Line", keys: "Alt+Down", run: () => nextExisting(1) },
    { id: "prev-exists", menu: "Search", group: "line", label: "Previous Existing Line", keys: "Alt+Up", run: () => nextExisting(-1) },
    { id: "go-left", menu: "Search", group: "line", label: "Go Left", keys: "Alt+Left", run: () => setSelSide(0) },
    { id: "go-right", menu: "Search", group: "line", label: "Go Right", keys: "Alt+Right", run: () => setSelSide(1) },
    { id: "goto", menu: "Search", group: "line", label: "Go To Line…", keys: "Ctrl+G", run: goToLine },
    { id: "find", menu: "Search", group: "find", label: "Find…", keys: "Ctrl+F", inInputs: true, run: () => (setFindOpen(true), findInput?.focus(), findInput?.select()) },
    { id: "find-next", menu: "Search", group: "find", label: "Find Next", keys: "F3", run: () => find(1) },
    { id: "find-prev", menu: "Search", group: "find", label: "Find Previous", keys: "Shift+F3", run: () => find(-1) },
    filterCmd("all", "Show All"),
    filterCmd("diffs", "Show Differences"),
    filterCmd("context", "Show Context"),
    filterCmd("same", "Show Same"),
    { id: "ignore-unimp", menu: "View", group: "rules", label: "Ignore Unimportant Differences", checked: ignoreUnimportant, run: () => setIgnoreUnimportant(!ignoreUnimportant()) },
  ]);
  const k = (id: string) => {
    const keys: Record<string, string> = { prev: "Ctrl+P", next: "Ctrl+N", cl: "Ctrl+L", cr: "Ctrl+R", undo: "Ctrl+Z", save: "Ctrl+S", f5: "F5" };
    return displayKeys(keys[id]);
  };

  const status = createMemo(() => {
    const r = result();
    if (!r) return busy() ? "Comparing…" : "";
    const imp = r.important;
    const unimp = r.unimportant;
    if (r.identical) return "Files are identical";
    if (imp === 0) return `Only unimportant differences (${unimp} section${unimp === 1 ? "" : "s"})`;
    return `${imp} difference section${imp === 1 ? "" : "s"}${unimp ? `, ${unimp} unimportant` : ""}`;
  });

  const sideInfo = (s: Side) => {
    const m = meta()[s];
    if (!m) return errors()[s] ? <span class="err-text">{errors()[s]}</span> : null;
    return (
      <span class="side-info">
        {fmtSize(m.size)} · {fmtTime(m.modified)} · {m.encoding}
        {m.bom ? " BOM" : ""} · {m.eol}
      </span>
    );
  };

  const selRowData = () => result()?.rows[selRow()];

  const Pane = (p: { side: Side }) => {
    const s = p.side;
    const key = s === 0 ? "l" : "r";
    const spansKey = s === 0 ? "ls" : "rs";
    return (
      <div
        class="tpane"
        ref={(el) => (s === 0 ? (paneL = el) : (paneR = el))}
        onScroll={(e) => onScroll(e.currentTarget, s === 0 ? paneR : paneL)}
      >
        <div
          class="tpane-inner"
          style={{ height: `${visible().length * ROW_H}px`, width: `calc(${(s === 0 ? maxL() : maxR()) + 2}ch + 82px)` }}
        >
          <Index each={windowRows()}>
            {(item) => {
              const row = () => result()!.rows[item().ri];
              const idx = () => row()[key];
              const k = () => kindOf(row());
              const isEditing = () => editing()?.ri === item().ri && editing()?.side === s;
              /**
               * Gutter copy button, as in the reference editor: on the first row of
               * each difference section, or (with a line selection) on the first
               * selected row of the selected pane, which copies only those lines.
               */
              const gutBtn = (): "sec" | "line" | null => {
                const ri = item().ri;
                if (readOnly(other(s))) return null;
                if (hasLineSel() && s === selSide()) return ri === selRange()[0] ? "line" : null;
                const h = row().h;
                return h !== undefined && hunkActive(h) && result()!.hunks[h].start === ri ? "sec" : null;
              };
              return (
                <div
                  class="trow"
                  classList={{
                    [`k-${k()}`]: true,
                    filler: idx() === undefined,
                    cur: row().h !== undefined && row().h === cur(),
                    sel: item().ri === selRow(),
                    rsel: hasLineSel() && s === selSide() && inSel(item().ri),
                    "align-from": alignFrom()?.side === s && alignFrom()?.line === idx(),
                    "kb-target": item().ri === selRow() && s === selSide(),
                  }}
                  style={{ top: `${item().vi * ROW_H}px` }}
                  onMouseDown={(e) => {
                    const ri = item().ri;
                    // Keep a line selection for its context menu.
                    if (e.button === 2 && s === selSide() && inSel(ri)) return;
                    const from = alignFrom();
                    if (from && from.side !== s && idx() !== undefined) return completeAlign(from, { side: s, line: idx()! });
                    if (e.shiftKey && selRow() >= 0 && s === selSide()) {
                      e.preventDefault();
                      if (selAnchor() < 0) setSelAnchor(selRow());
                      setSelRow(ri);
                      return;
                    }
                    batch(() => {
                      setSelAnchor(-1);
                      setSelRow(ri);
                      setSelSide(s);
                      setCur(row().h ?? -1);
                    });
                  }}
                  onDblClick={() => !readOnly(s) && setEditing({ ri: item().ri, side: s })}
                  onContextMenu={(e) => showContextMenu(e, tab().id, paneMenu(s))}
                >
                  <span
                    class="gut"
                    classList={{ [`gm-${k()}`]: k() !== "same" }}
                    onContextMenu={(e) => {
                      setSelSide(s);
                      showContextMenu(e, tab().id, gutterMenu(s));
                    }}
                  >
                    <Show when={gutBtn()}>
                      {(b) => (
                        <button
                          class="gbtn"
                          classList={{ line: b() === "line", left: s === 1 }}
                          tabIndex={-1}
                          title={`${b() === "line" ? "Copy selected lines" : "Copy section"} to ${s === 0 ? "right" : "left"} (${displayKeys(b() === "line" ? (s === 0 ? "Shift+Ctrl+R" : "Shift+Ctrl+L") : s === 0 ? "Ctrl+R" : "Ctrl+L")})`}
                          onMouseDown={(e) => e.stopPropagation()}
                          onDblClick={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (b() === "line") copyRows(other(s), ...selRange());
                            else gutterCopy(row().h!, other(s));
                          }}
                        >
                          {s === 0 ? "▶" : "◀"}
                        </button>
                      )}
                    </Show>
                  </span>
                  <span class="ln">{idx() !== undefined ? idx()! + 1 : ""}</span>
                  <Show
                    when={isEditing()}
                    fallback={
                      <span class="tx">
                        {idx() !== undefined && (
                          <Highlighted
                            text={lines(s)[idx()!] ?? ""}
                            spans={k() === "same" ? undefined : row()[spansKey]}
                            cls={row().k === "unimportant" ? "hl-u" : "hl"}
                          />
                        )}
                      </span>
                    }
                  >
                    <input
                      class="line-edit"
                      value={idx() !== undefined ? lines(s)[idx()!] : ""}
                      ref={(el) => setTimeout(() => el.focus())}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit(e.currentTarget.value);
                        if (e.key === "Escape") setEditing(null);
                        e.stopPropagation();
                      }}
                      onBlur={(e) => editing() && commitEdit(e.currentTarget.value)}
                    />
                  </Show>
                </div>
              );
            }}
          </Index>
        </div>
      </div>
    );
  };

  const isBinary = () => meta()[0]?.binary || meta()[1]?.binary;

  return (
    <div class="view">
      <div class="toolbar">
        <SessionButtons tab={tab()} />
        <Btn title="Previous difference" kbd={k("prev")} onClick={() => nextHunk(-1)}>▲ Prev</Btn>
        <Btn title="Next difference" kbd={k("next")} onClick={() => nextHunk(1)}>▼ Next</Btn>
        <span class="sep" />
        <Btn title="Copy current section to left" kbd={k("cl")} onClick={() => copyHunk(0)} disabled={readOnly(0)}>⇐ Copy to Left</Btn>
        <Btn title="Copy current section to right" kbd={k("cr")} onClick={() => copyHunk(1)} disabled={readOnly(1)}>Copy to Right ⇒</Btn>
        <span class="sep" />
        <Btn title="Insert empty line after selection" kbd="Ctrl+Enter" onClick={() => insertLine()}>+ Line</Btn>
        <Btn title="Delete selected line" kbd="Del" onClick={deleteLine}>− Line</Btn>
        <Btn title="Undo" kbd={k("undo")} onClick={undo}>↶ Undo</Btn>
        <Btn title="Save changed sides" kbd={k("save")} onClick={saveAll} disabled={!dirty()[0] && !dirty()[1]}>💾 Save</Btn>
        <span class="sep" />
        <div class="seg">
          {(["all", "diffs", "context", "same"] as Filter[]).map((f) => (
            <Btn title={`Show ${f}`} active={filter() === f} onClick={() => setFilter(f)}>
              {{ all: "All", diffs: "Diffs", context: "Context", same: "Same" }[f]}
            </Btn>
          ))}
        </div>
        <Btn
          title="Treat unimportant differences (whitespace, blank lines…) as equal"
          active={ignoreUnimportant()}
          onClick={() => setIgnoreUnimportant(!ignoreUnimportant())}
        >
          ≈ Ignore unimportant
        </Btn>
        <Btn title="Comparison rules" onClick={() => setShowRules(!showRules())} active={showRules()}>⚙ Rules</Btn>
        <span class="sep" />
        <Btn title="Swap sides" onClick={swap}>⇄ Swap</Btn>
        <Btn title="Reload files" kbd={k("f5")} onClick={reload}>⟳ Refresh</Btn>
        <Btn title="Save as named session" kbd="Shift+Ctrl+S" onClick={saveSession}>
          ★ Save Session
        </Btn>
      </div>
      <Show when={findOpen()}>
        <FindBar
          query={findQuery()}
          onQuery={setFindQuery}
          matchCase={findCase()}
          onMatchCase={setFindCase}
          onFind={find}
          onClose={() => setFindOpen(false)}
          inputRef={(el) => (findInput = el)}
        />
      </Show>
      <Show when={showRules()}>
        <RulesPanel rules={rules()} onChange={setRules}>
          <label>
            <input type="checkbox" checked={backup()} onChange={(e) => setBackup(e.currentTarget.checked)} /> Create backup on save
          </label>
        </RulesPanel>
      </Show>
      <Show when={isBinary()}>
        <div class="banner">
          One of the files looks binary.{" "}
          <button class="link" onClick={() => openTab({ kind: "hex", paths: [...tab().paths] })}>Open in Hex Compare</button>
        </div>
      </Show>
      <div class="paths two">
        <PathBar value={tab().paths[0] ?? ""} title={tab().titles?.[0]} onCommit={(p) => changePath(0, p)} readOnly={readOnly(0)} dirty={dirty()[0]} info={sideInfo(0)} onSave={() => saveSide(0)} saveTitle="Save left file" />
        <PathBar value={tab().paths[1] ?? ""} title={tab().titles?.[1]} onCommit={(p) => changePath(1, p)} readOnly={readOnly(1)} dirty={dirty()[1]} info={sideInfo(1)} onSave={() => saveSide(1)} saveTitle="Save right file" />
      </div>
      <div class="tcompare">
        <div class="overview" title="Difference map">
          <For each={result()?.hunks ?? []}>
            {(h, i) => {
              const total = () => Math.max(1, result()!.rows.length);
              return (
                <Show when={hunkActive(i())}>
                  <div
                    class="ov-mark"
                    classList={{ imp: h.important, cur: cur() === i() }}
                    style={{ top: `${(h.start / total()) * 100}%`, height: `max(2px, ${((h.end - h.start) / total()) * 100}%)` }}
                    onClick={() => goHunk(i())}
                  />
                </Show>
              );
            }}
          </For>
        </div>
        <Pane side={0} />
        <div class="divider" />
        <Pane side={1} />
      </div>
      <div class="details">
        <Show when={selRowData()} fallback={<div class="muted">Select a line to see details. Double-click a line to edit it.</div>}>
          {(row) => (
            <>
              <div class="dline">
                <span class="dl-tag">L</span>
                <span class="tx">
                  {row().l !== undefined && <Highlighted text={L()[row().l!] ?? ""} spans={row().ls} cls="hl" />}
                </span>
              </div>
              <div class="dline">
                <span class="dl-tag">R</span>
                <span class="tx">
                  {row().r !== undefined && <Highlighted text={R()[row().r!] ?? ""} spans={row().rs} cls="hl" />}
                </span>
              </div>
            </>
          )}
        </Show>
      </div>
      <div class="statusbar">
        <span classList={{ "st-same": !!result()?.identical, "st-diff": (result()?.important ?? 0) > 0 }}>{status()}</span>
        <span class="muted">{message()}</span>
        <span class="spacer" />
        <button class="link" onClick={() => setEditAll(0)} disabled={readOnly(0)}>Edit left as text</button>
        <button class="link" onClick={() => setEditAll(1)} disabled={readOnly(1)}>Edit right as text</button>
      </div>
      <Show when={replacing()}>
        {(r) => (
          <ReplacementDialog
            initial={r()}
            onClose={() => setReplacing(null)}
            onOk={(rep) => {
              setReplacing(null);
              setRules({ ...rules(), replacements: [...(rules().replacements ?? []), rep] });
              setMessage(`Added replacement “${rep.from}” → “${rep.to}”.`);
            }}
          />
        )}
      </Show>
      <Show when={editAll() !== null}>
        <EditAllModal
          text={lines(editAll()!).join("\n")}
          onClose={() => setEditAll(null)}
          onApply={(t) => {
            const s = editAll()!;
            snapshot();
            editLines(s, t.length ? t.split(/\r\n|\n|\r/) : []);
            setEditAll(null);
            recompute(true);
          }}
        />
      </Show>
    </div>
  );
}

function EditAllModal(props: { text: string; onClose: () => void; onApply: (t: string) => void }) {
  let ta!: HTMLTextAreaElement;
  return (
    <Modal title="Edit text" onClose={props.onClose} wide>
      <textarea class="edit-all" ref={ta} value={props.text} spellcheck={false} />
      <div class="modal-actions">
        <button onClick={props.onClose}>Cancel</button>
        <button class="primary" onClick={() => props.onApply(ta.value)}>Apply</button>
      </div>
    </Modal>
  );
}
