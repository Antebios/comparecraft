import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { batch, createEffect, createMemo, createSignal, For, Index, on, onMount, Show } from "solid-js";
import { api, defaultRules, errText, fmtSize, fmtTime, type DiffResult, type Row, type Rules, type TextFile } from "../api";
import { Btn, Highlighted, Modal, PathBar, ROW_H, useViewport } from "../components/common";
import { showContextMenu } from "../components/ContextMenu";
import { externalCommands } from "../components/external";
import FindBar from "../components/FindBar";
import { promptText } from "../components/Prompt";
import { displayKeys, registerCommands, type Command } from "../commands";
import { openTab, persistSession, updateTab, type Tab } from "../store";
import { RulesPanel } from "../components/RulesPanel";

type Side = 0 | 1;
type Filter = "all" | "diffs" | "context" | "same";

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

/**
 * Pane context menu, in the order of the reference "Edit" popup. Like the
 * reference, it only offers copying away from the clicked pane.
 */
const textMenu = (side: Side) => [
  ...(side === 0 ? ["copy-right", "copy-line-right"] : ["copy-left", "copy-line-left"]), "-",
  "copy-text", "del-line", "ins-before", "ins-after", "edit-line", "-",
  "ignore-unimp", "-",
  "open", "open-default", "reveal", "save",
];

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
  const [editing, setEditing] = createSignal<{ ri: number; side: Side } | null>(null);
  const [showRules, setShowRules] = createSignal(false);
  const [editAll, setEditAll] = createSignal<Side | null>(null);
  const [backup, setBackup] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const history: { l: string[]; r: string[]; d: [boolean, boolean] }[] = [];
  const future: { l: string[]; r: string[]; d: [boolean, boolean] }[] = [];
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

  async function loadSide(s: Side, path: string) {
    let file: TextFile | null = null;
    let err = "";
    if (path) {
      try {
        file = await api.loadText(path);
      } catch (e) {
        err = errText(e);
      }
    }
    // Update from the latest state after the await; both sides may load concurrently.
    batch(() => {
      setLines(s, file?.lines ?? []);
      const m = [...meta()] as [TextFile | null, TextFile | null];
      m[s] = file;
      setMeta(m);
      const errs = [...errors()] as [string, string];
      errs[s] = err;
      setErrors(errs);
      const d = [...dirty()] as [boolean, boolean];
      d[s] = false;
      setDirty(d);
    });
  }

  let token = 0;
  let timer: number | undefined;
  function recompute(immediate = false) {
    clearTimeout(timer);
    const run = async () => {
      const t = ++token;
      setBusy(true);
      try {
        const res = await api.diffTexts(L(), R(), rules());
        if (t === token) setResult(res);
      } catch (e) {
        setMessage(errText(e));
      } finally {
        if (t === token) setBusy(false);
      }
    };
    if (immediate) void run();
    else timer = window.setTimeout(run, 120);
  }

  onMount(async () => {
    const [lp, rp] = [tab().paths[0] ?? "", tab().paths[1] ?? ""];
    await Promise.all([loadSide(0, lp), loadSide(1, rp)]);
    recompute(true);
    if (lp || rp) void persistSession(tab());
  });

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
      const C = 3;
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
    setMessage(dir === 1 ? "No more differences below." : "No more differences above.");
  }

  function snapshot() {
    history.push({ l: L(), r: R(), d: dirty() });
    if (history.length > 200) history.shift();
    future.length = 0;
  }
  function restore(from: typeof history, to: typeof history) {
    const s = from.pop();
    if (!s) return;
    to.push({ l: L(), r: R(), d: dirty() });
    batch(() => {
      setL(s.l);
      setR(s.r);
      setDirty(s.d);
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

  function copyHunk(to: Side) {
    const res = result();
    const h = cur() >= 0 ? cur() : res?.rows[selRow()]?.h ?? -1;
    if (!res || h < 0 || h === undefined) return setMessage("Select a difference first.");
    if (readOnly(to)) return setMessage("Target side is read-only.");
    const from: Side = to === 0 ? 1 : 0;
    const hk = res.hunks[h];
    const fk = from === 0 ? "l" : "r";
    const tk = to === 0 ? "l" : "r";
    const src: string[] = [];
    const dstIdx: number[] = [];
    for (let i = hk.start; i < hk.end; i++) {
      const row = res.rows[i];
      if (row[fk] !== undefined) src.push(lines(from)[row[fk]!]);
      if (row[tk] !== undefined) dstIdx.push(row[tk]!);
    }
    snapshot();
    const dst = [...lines(to)];
    if (dstIdx.length) dst.splice(dstIdx[0], dstIdx[dstIdx.length - 1] - dstIdx[0] + 1, ...src);
    else dst.splice(insertionPoint(to, hk.end), 0, ...src);
    setLines(to, dst);
    markDirty(to);
    recompute(true);
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
    setLines(ed.side, arr);
    markDirty(ed.side);
    recompute(true);
  }

  function deleteLine() {
    const row = result()?.rows[selRow()];
    const s = selSide();
    const key = s === 0 ? "l" : "r";
    if (!row || row[key] === undefined || readOnly(s)) return;
    snapshot();
    const arr = [...lines(s)];
    arr.splice(row[key]!, 1);
    setLines(s, arr);
    markDirty(s);
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
    setLines(s, arr);
    markDirty(s);
    recompute(true);
  }

  async function saveSide(s: Side): Promise<boolean> {
    let path = s === 1 && tab().saveTarget ? tab().saveTarget! : tab().paths[s];
    if (!path) {
      const p = await saveDialog({});
      if (!p) return false;
      path = p;
      const paths = [...tab().paths];
      paths[s] = p;
      updateTab(tab().id, { paths });
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
      });
      const d = [...dirty()] as [boolean, boolean];
      d[s] = false;
      setDirty(d);
      setMessage(`Saved ${path}`);
      return true;
    } catch (e) {
      setMessage(`Save failed: ${errText(e)}`);
      return false;
    }
  }

  async function saveAll() {
    if (dirty()[0]) await saveSide(0);
    if (dirty()[1]) await saveSide(1);
  }

  async function changePath(s: Side, p: string) {
    if (dirty()[s] && !(await ask("Discard unsaved changes on this side?", { kind: "warning" }))) return;
    const paths = [...tab().paths];
    paths[s] = p;
    updateTab(tab().id, { paths });
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
      setErrors([errors()[1], errors()[0]]);
      updateTab(tab().id, { paths: [tab().paths[1] ?? "", tab().paths[0] ?? ""], titles: [tab().titles[1] ?? null, tab().titles[0] ?? null] });
    });
    recompute(true);
  }

  /** Copies the selected line (only) to the other side. */
  function copyLine(to: Side) {
    const res = result();
    const ri = selRow();
    const row = res?.rows[ri];
    if (!row) return setMessage("Select a line first.");
    if (readOnly(to)) return setMessage("Target side is read-only.");
    const from: Side = to === 0 ? 1 : 0;
    const fk = from === 0 ? "l" : "r";
    const tk = to === 0 ? "l" : "r";
    snapshot();
    const dst = [...lines(to)];
    const src = row[fk] !== undefined ? lines(from)[row[fk]!] : undefined;
    if (row[tk] !== undefined) {
      if (src === undefined) dst.splice(row[tk]!, 1);
      else dst[row[tk]!] = src;
    } else if (src !== undefined) dst.splice(insertionPoint(to, ri), 0, src);
    else return void history.pop();
    setLines(to, dst);
    markDirty(to);
    recompute(true);
  }

  function selectRow(ri: number, side: Side = selSide()) {
    batch(() => {
      setSelRow(ri);
      setSelSide(side);
      setCur(result()?.rows[ri]?.h ?? -1);
    });
    if (!visible().includes(ri)) setFilter("all");
    const vi = lowerBound(visible(), ri);
    const top = vi * ROW_H;
    if (top < paneL.scrollTop || top > paneL.scrollTop + vp.height() - ROW_H * 2) scrollToRow(ri);
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

  async function saveSession() {
    const n = await promptText("Save Session", "Session name:", tab().sessionName ?? "");
    if (n) {
      await persistSession(tab(), n);
      setMessage(`Saved session “${n}”`);
    }
  }

  const anyDirty = () => dirty()[0] || dirty()[1];
  const hasSel = () => selRow() >= 0;
  /** Copies the text selected with the mouse, or else the selected line. */
  async function copyText() {
    let text = window.getSelection()?.toString() ?? "";
    if (!text && hasSel()) {
      const idx = result()?.rows[selRow()]?.[selSide() === 0 ? "l" : "r"];
      if (idx !== undefined) text = lines(selSide())[idx] ?? "";
    }
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      setMessage(`Clipboard unavailable: ${errText(err)}`);
    }
  }
  const filterCmd = (f: Filter, label: string): Command => ({
    id: `show-${f}`, menu: "View", group: "filter", label, checked: () => filter() === f, run: () => setFilter(f),
  });
  registerCommands(tab().id, [
    { id: "save-session", menu: "Session", group: "session", label: "Save Session…", keys: "Shift+Ctrl+S", run: saveSession },
    { id: "settings", menu: "Session", group: "session", label: "Session Settings (Rules)…", checked: showRules, run: () => setShowRules(!showRules()) },
    { id: "swap", menu: "Session", group: "files", label: "Swap Sides", run: swap },
    { id: "reload", menu: "Session", group: "files", label: "Reload Files", keys: "F5", run: reload },
    { id: "recompare", menu: "Session", group: "files", label: "Recompare Files", keys: "Ctrl+F5", run: () => recompute(true) },
    { id: "as-hex", menu: "Session", group: "using", label: "Compare Files Using Hex Compare", run: () => openTab({ kind: "hex", paths: [...tab().paths] }) },
    { id: "as-merge", menu: "Session", group: "using", label: "Merge Files", run: () => openTab({ kind: "merge", paths: [tab().paths[0] ?? "", tab().paths[1] ?? ""] }) },
    { id: "open", menu: "File", group: "open", label: "Open File into Picked Side…", keys: "Ctrl+O", run: openFile },
    { id: "save", menu: "File", group: "save", label: "Save", keys: "Ctrl+S", enabled: anyDirty, run: saveAll },
    { id: "save-left", menu: "File", group: "save", label: "Save Left", enabled: () => dirty()[0], run: () => saveSide(0) },
    { id: "save-right", menu: "File", group: "save", label: "Save Right", enabled: () => dirty()[1], run: () => saveSide(1) },
    ...externalCommands(() => tab().paths[selSide()] || undefined, setMessage),
    { id: "backup", menu: "File", group: "opt", label: "Create .bak Backup on Save", checked: backup, run: () => setBackup(!backup()) },
    { id: "undo", menu: "Edit", group: "undo", label: "Undo", keys: "Ctrl+Z", run: undo },
    { id: "redo", menu: "Edit", group: "undo", label: "Redo", keys: "Ctrl+Y", altKeys: ["Shift+Ctrl+Z"], run: redo },
    { id: "copy-text", menu: "Edit", group: "clip", label: "Copy", keys: "Ctrl+C", run: copyText },
    { id: "copy-left", menu: "Edit", group: "copy", label: "Copy to Left", keys: "Ctrl+L", enabled: () => !readOnly(0), run: () => copyHunk(0) },
    { id: "copy-right", menu: "Edit", group: "copy", label: "Copy to Right", keys: "Ctrl+R", enabled: () => !readOnly(1), run: () => copyHunk(1) },
    { id: "copy-line-left", menu: "Edit", group: "copy", label: "Copy Line to Left", keys: "Shift+Ctrl+L", enabled: () => hasSel() && !readOnly(0), run: () => copyLine(0) },
    { id: "copy-line-right", menu: "Edit", group: "copy", label: "Copy Line to Right", keys: "Shift+Ctrl+R", enabled: () => hasSel() && !readOnly(1), run: () => copyLine(1) },
    { id: "edit-line", menu: "Edit", group: "line", label: "Edit Line", keys: "F2", enabled: () => hasSel() && !readOnly(selSide()), run: () => setEditing({ ri: selRow(), side: selSide() }) },
    { id: "ins-after", menu: "Edit", group: "line", label: "Insert Line After", keys: "Ctrl+Enter", enabled: hasSel, run: () => insertLine(false) },
    { id: "ins-before", menu: "Edit", group: "line", label: "Insert Line Before", keys: "Shift+Ctrl+Enter", enabled: hasSel, run: () => insertLine(true) },
    { id: "del-line", menu: "Edit", group: "line", label: "Delete Line", keys: "Del", enabled: () => hasSel() && !editing(), run: deleteLine },
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
          style={{ height: `${visible().length * ROW_H}px`, width: `calc(${(s === 0 ? maxL() : maxR()) + 2}ch + 64px)` }}
        >
          <Index each={windowRows()}>
            {(item) => {
              const row = () => result()!.rows[item().ri];
              const idx = () => row()[key];
              const k = () => kindOf(row());
              const isEditing = () => editing()?.ri === item().ri && editing()?.side === s;
              return (
                <div
                  class="trow"
                  classList={{
                    [`k-${k()}`]: true,
                    filler: idx() === undefined,
                    cur: row().h !== undefined && row().h === cur(),
                    sel: item().ri === selRow(),
                    "kb-target": item().ri === selRow() && s === selSide(),
                  }}
                  style={{ top: `${item().vi * ROW_H}px` }}
                  onMouseDown={() => {
                    setSelRow(item().ri);
                    setSelSide(s);
                    setCur(row().h ?? -1);
                  }}
                  onDblClick={() => !readOnly(s) && setEditing({ ri: item().ri, side: s })}
                  onContextMenu={(e) => showContextMenu(e, tab().id, textMenu(s))}
                >
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
            <input type="checkbox" checked={backup()} onChange={(e) => setBackup(e.currentTarget.checked)} /> Create .bak backup on save
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
        <PathBar value={tab().paths[0] ?? ""} title={tab().titles?.[0]} onCommit={(p) => changePath(0, p)} readOnly={readOnly(0)} dirty={dirty()[0]} info={sideInfo(0)} />
        <PathBar value={tab().paths[1] ?? ""} title={tab().titles?.[1]} onCommit={(p) => changePath(1, p)} readOnly={readOnly(1)} dirty={dirty()[1]} info={sideInfo(1)} />
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
      <Show when={editAll() !== null}>
        <EditAllModal
          text={lines(editAll()!).join("\n")}
          onClose={() => setEditAll(null)}
          onApply={(t) => {
            const s = editAll()!;
            snapshot();
            setLines(s, t.length ? t.split(/\r\n|\n|\r/) : []);
            markDirty(s);
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
