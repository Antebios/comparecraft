import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { batch, createEffect, createMemo, createSignal, For, Index, on, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { api, errText, type TableOptions, type TableResult, type TableRow } from "../api";
import { Btn, PathBar, ROW_H, useViewport } from "../components/common";
import { displayKeys, registerCommands, type Command, type MenuRef } from "../commands";
import { showContextMenu } from "../components/ContextMenu";
import { externalCommands } from "../components/external";
import { dropDown, SessionButtons } from "../components/SessionTools";
import { openTab, persistSession, updateTab, type Tab } from "../store";
import { tableInfo } from "../components/InfoDialog";
import { sessionCommands } from "./sessionMenu";

const COL_W = 140;
type Filter = "all" | "diffs" | "same";
type Kind = TableRow["k"];

const DELIMS: [string, string][] = [
  ["", "Auto-detect"],
  [",", "Comma"],
  ["\t", "Tab"],
  [";", "Semicolon"],
  ["|", "Pipe"],
];

/** Quotes a cell for delimited output when it contains the delimiter, quotes or line breaks. */
const quote = (c: string, d: string) => (c.includes(d) || /["\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);

/** Parses "1, 3 5" (1-based) into sorted zero-based column indices. */
const parseCols = (v: string) =>
  [...new Set(v.split(/[,\s]+/).map((x) => parseInt(x, 10) - 1).filter((x) => x >= 0))].sort((a, b) => a - b);

export default function TableCompare(props: { tab: Tab; active: boolean }) {
  const tab = () => props.tab;
  const left = () => tab().paths[0] ?? "";
  const right = () => tab().paths[1] ?? "";
  const [opts, setOpts] = createStore<TableOptions>({
    delimiter: "",
    header: true,
    keys: [],
    ignoreCase: false,
    trim: true,
    unimportant: [],
    numTolerance: 0,
    numRelative: false,
    ...((tab().options.table as Partial<TableOptions> | undefined) ?? {}),
  });
  const [result, setResult] = createSignal<TableResult | null>(null);
  const [error, setError] = createSignal("");
  const [message, setMessage] = createSignal("");
  const [filter, setFilter] = createSignal<Filter>((tab().options.tableFilter as Filter) ?? "all");
  const [minor, setMinor] = createSignal((tab().options.ignoreUnimportant as boolean) ?? false);
  const [showRules, setShowRules] = createSignal(false);
  const [showDetails, setShowDetails] = createSignal((tab().options.tableDetails as boolean) ?? true);
  const [showRowNums, setShowRowNums] = createSignal((tab().options.tableRowNums as boolean) ?? true);
  const [sel, setSel] = createSignal(-1);
  const [anchor, setAnchor] = createSignal(-1);
  const [selSide, setSelSide] = createSignal<0 | 1>(0);

  createEffect(
    on([filter, minor, showDetails, showRowNums], ([f, m, d, n]) =>
      updateTab(tab().id, { options: { ...tab().options, tableFilter: f, ignoreUnimportant: m, tableDetails: d, tableRowNums: n } }),
      { defer: true },
    ),
  );

  let scroller!: HTMLDivElement;
  const vp = useViewport(() => scroller);

  async function refresh() {
    if (!left() || !right()) return;
    setError("");
    try {
      setResult(await api.compareTables(left(), right(), { ...opts, keys: [...opts.keys], unimportant: [...opts.unimportant] }));
    } catch (e) {
      setError(errText(e));
      setResult(null);
    }
  }

  onMount(async () => {
    await refresh();
    if (left() && right()) void persistSession(tab());
  });

  function setPath(i: 0 | 1, p: string) {
    const paths = [...tab().paths];
    paths[i] = p;
    updateTab(tab().id, { paths });
    void refresh().then(() => persistSession(tab()));
  }

  function apply() {
    updateTab(tab().id, { options: { ...tab().options, table: { ...opts, keys: [...opts.keys], unimportant: [...opts.unimportant] } } });
    void refresh();
  }

  function swap() {
    batch(() => {
      updateTab(tab().id, { paths: [right(), left()], titles: [tab().titles?.[1] ?? null, tab().titles?.[0] ?? null] });
      setSelSide(selSide() === 0 ? 1 : 0);
    });
    void refresh();
  }


  /** Row kind after "Ignore Unimportant Differences" is applied. */
  const kindOf = (r: TableRow): Kind => (r.k === "unimportant" && minor() ? "same" : r.k);

  const rows = createMemo(() => {
    const r = result();
    if (!r) return [];
    const idx = r.rows.map((_, i) => i);
    const f = filter();
    if (f === "all") return idx;
    return idx.filter((i) => (kindOf(r.rows[i]) === "same") === (f === "same"));
  });

  const diffRowIdx = createMemo(() => rows().filter((i) => kindOf(result()!.rows[i]) !== "same"));

  function reveal(ri: number) {
    const vis = rows().indexOf(ri);
    if (vis < 0) return;
    const top = vis * ROW_H;
    if (top < scroller.scrollTop || top + ROW_H > scroller.scrollTop + vp.height() - ROW_H) scroller.scrollTop = Math.max(0, top - vp.height() / 3);
  }

  function select(ri: number, extend = false) {
    batch(() => {
      if (!extend || anchor() < 0) setAnchor(ri);
      setSel(ri);
    });
    reveal(ri);
  }

  function nav(dir: 1 | -1) {
    const list = diffRowIdx();
    const cur = sel();
    const next = dir > 0 ? list.find((i) => i > cur) : [...list].reverse().find((i) => i < cur);
    if (next === undefined) return setMessage(dir > 0 ? "No more differences below." : "No more differences above.");
    setMessage("");
    select(next);
  }

  function move(dir: 1 | -1, extend = false) {
    const list = rows();
    if (!list.length) return;
    const at = list.indexOf(sel());
    const next = list[Math.min(list.length - 1, Math.max(0, at < 0 ? 0 : at + dir))];
    select(next, extend);
  }

  /** Visible rows between the anchor and the selection, in display order. */
  const selected = createMemo(() => {
    const list = rows();
    const a = list.indexOf(anchor()),
      b = list.indexOf(sel());
    if (b < 0) return [];
    if (a < 0) return [sel()];
    return list.slice(Math.min(a, b), Math.max(a, b) + 1);
  });

  async function copy() {
    const r = result();
    if (!r || !selected().length) return;
    const s = selSide();
    const d = r.delimiter;
    const lines = selected()
      .map((ri) => {
        const row = r.rows[ri];
        const n = s === 0 ? row.l : row.r;
        return n === undefined ? null : (s === 0 ? r.left : r.right)[n].map((c) => quote(c, d)).join(d);
      })
      .filter((x): x is string => x !== null);
    if (!lines.length) return;
    try {
      await writeText(lines.join("\n"));
    } catch {
      await navigator.clipboard.writeText(lines.join("\n")).catch((e) => setMessage(`Clipboard unavailable: ${errText(e)}`));
    }
  }

  const toggleCol = (field: "keys" | "unimportant", c: number) => {
    setOpts(field, opts[field].includes(c) ? opts[field].filter((k) => k !== c) : [...opts[field], c].sort((a, b) => a - b));
    apply();
  };

  const formatItems = (): MenuRef[] => [
    ...DELIMS.map(([d, label]): Command => ({
      id: `fmt-${label}`, menu: "Session", label, checked: () => opts.delimiter === d, run: () => (setOpts("delimiter", d), apply()),
    })),
    "-",
    { id: "fmt-header", menu: "Session", label: "First Line Contains Column Names", checked: () => opts.header, run: () => (setOpts("header", !opts.header), apply()) },
  ];

  const filterCmd = (f: Filter, label: string): Command => ({
    id: `show-${f}`, menu: "View", group: "filter", label, checked: () => filter() === f, run: () => setFilter(f),
  });
  registerCommands(tab().id, [
    ...sessionCommands({
      tab,
      title: "Table Compare",
      notify: setMessage,
      report: {
        kind: "table",
        enabled: () => !!result(),
        request: () => ({
          type: "pair", kind: "table", left: left(), right: right(),
          view: { table: { ...opts, keys: [...opts.keys], unimportant: [...opts.unimportant] } },
        }),
      },
      info: { enabled: () => !!result(), lines: () => tableInfo(result()!) },
    }),
    { id: "settings", menu: "Session", group: "session", label: "Session Settings (Rules)…", checked: showRules, run: () => setShowRules(!showRules()) },
    { id: "swap", menu: "Session", group: "files", label: "Swap Sides", run: swap },
    { id: "reload", menu: "Session", group: "files", label: "Reload", keys: "F5", run: refresh },
    { id: "compare-using", menu: "Session", group: "using", label: "Compare Files Using", submenu: () => ["as-text", "as-hex"], run: () => {} },
    { id: "as-text", menu: "Session", hidden: true, label: "Text Compare", enabled: () => !!left() && !!right(), run: () => openTab({ kind: "text", paths: [left(), right()] }) },
    { id: "as-hex", menu: "Session", hidden: true, label: "Hex Compare", enabled: () => !!left() && !!right(), run: () => openTab({ kind: "hex", paths: [left(), right()] }) },
    { id: "copy", menu: "Edit", group: "clip", label: "Copy", keys: "Ctrl+C", altKeys: ["Ctrl+Insert"], enabled: () => selected().length > 0, run: copy },
    { id: "next-diff", menu: "Search", group: "diff", label: "Next Difference", keys: "Ctrl+N", altKeys: ["Alt+Down"], run: () => nav(1) },
    { id: "prev-diff", menu: "Search", group: "diff", label: "Previous Difference", keys: "Ctrl+P", altKeys: ["Alt+Up"], run: () => nav(-1) },
    { id: "row-up", menu: "Search", hidden: true, label: "Row Up", keys: "Up", run: () => move(-1) },
    { id: "row-down", menu: "Search", hidden: true, label: "Row Down", keys: "Down", run: () => move(1) },
    { id: "sel-up", menu: "Search", hidden: true, label: "Extend Selection Up", keys: "Shift+Up", run: () => move(-1, true) },
    { id: "sel-down", menu: "Search", hidden: true, label: "Extend Selection Down", keys: "Shift+Down", run: () => move(1, true) },
    filterCmd("all", "Show All"),
    filterCmd("diffs", "Show Differences"),
    filterCmd("same", "Show Same"),
    { id: "ignore-unimp", menu: "View", group: "rules", label: "Ignore Unimportant Differences", checked: minor, run: () => setMinor(!minor()) },
    { id: "row-nums", menu: "View", group: "show", label: "Row Numbers", checked: showRowNums, run: () => setShowRowNums(!showRowNums()) },
    { id: "details", menu: "View", group: "show", label: "Details", checked: showDetails, run: () => setShowDetails(!showDetails()) },
    ...externalCommands(() => tab().paths[selSide()] || undefined),
  ]);
  const onContext = (e: MouseEvent) => {
    showContextMenu(e, tab().id, [
      "copy", "-", "next-diff", "prev-diff", "-", "show-all", "show-diffs", "show-same", "ignore-unimp", "-", "reload", "swap", "-", "open-default", "reveal",
    ]);
  };
  const onHeaderContext = (e: MouseEvent, c: number) => {
    e.stopPropagation();
    showContextMenu(e, tab().id, [
      { id: "col-key", menu: "Edit", label: "Key Column", checked: () => opts.keys.includes(c), run: () => toggleCol("keys", c) },
      { id: "col-unimp", menu: "Edit", label: "Unimportant Column", checked: () => opts.unimportant.includes(c), enabled: () => !opts.keys.includes(c), run: () => toggleCol("unimportant", c) },
    ]);
  };

  const win = createMemo(() => {
    const list = rows();
    const { start, end } = vp.range(list.length);
    const out: { i: number; ri: number }[] = [];
    for (let i = start; i < end; i++) out.push({ i, ri: list[i] });
    return out;
  });

  const cols = () => Array.from({ length: result()?.columns ?? 0 }, (_, i) => i);
  const colName = (c: number) => result()?.header[c] || `Col ${c + 1}`;
  const lnW = () => (showRowNums() ? 50 : 0);
  const gridWidth = () => cols().length * COL_W + lnW();
  const selSet = createMemo(() => new Set(selected()));

  const cellClass = (r: TableRow | undefined, c: number, filler: boolean) => {
    const changed = !!r?.cells?.includes(c);
    const unimp = changed && !!r?.minor?.includes(c);
    return { tchanged: changed && !unimp, tminor: unimp, tkey: opts.keys.includes(c), tunimpcol: opts.unimportant.includes(c), filler };
  };

  const side = (s: 0 | 1, ri: number) => {
    const r = () => result()!.rows[ri];
    const n = () => (s === 0 ? r().l : r().r);
    const cells = () => (n() !== undefined ? (s === 0 ? result()!.left : result()!.right)[n()!] : undefined);
    return (
      <div
        class="tside"
        classList={{ selside: selSide() === s && selSet().has(ri), "kb-target": selSide() === s && sel() === ri }}
        style={{ width: `${gridWidth()}px` }}
        onMouseDown={(e) => {
          if (e.button !== 0 && selSet().has(ri) && selSide() === s) return;
          setSelSide(s);
          select(ri, e.shiftKey);
        }}
      >
        <Show when={showRowNums()}>
          <span class="tln">{n() !== undefined ? n()! + 1 : ""}</span>
        </Show>
        <For each={cols()}>
          {(c) => (
            <span class="tcell" classList={cellClass(r(), c, !cells())} style={{ width: `${COL_W}px` }} title={cells()?.[c] ?? ""}>
              {cells()?.[c] ?? ""}
            </span>
          )}
        </For>
      </div>
    );
  };

  const counts = () => {
    const r = result();
    const c: Record<Kind, number> = { same: 0, changed: 0, unimportant: 0, left: 0, right: 0 };
    r?.rows.forEach((x) => c[x.k]++);
    return c;
  };

  const headerSide = () => (
    <div class="tside" style={{ width: `${gridWidth()}px` }}>
      <Show when={showRowNums()}>
        <span class="tln">#</span>
      </Show>
      <For each={cols()}>
        {(c) => (
          <span
            class="tcell th"
            classList={{ tkey: opts.keys.includes(c), tunimpcol: opts.unimportant.includes(c) }}
            style={{ width: `${COL_W}px` }}
            title="Click to toggle as key column; right-click for column options"
            onClick={() => toggleCol("keys", c)}
            onContextMenu={(e) => onHeaderContext(e, c)}
          >
            {opts.keys.includes(c) ? "🔑 " : ""}
            {colName(c)}
          </span>
        )}
      </For>
    </div>
  );

  /** The selected row, one line per side, with every column (BC's Details pane). */
  const details = () => {
    const r = result();
    const row = r?.rows[sel()];
    const line = (s: 0 | 1) => {
      const n = row ? (s === 0 ? row.l : row.r) : undefined;
      const cells = n !== undefined ? (s === 0 ? r!.left : r!.right)[n] : undefined;
      return (
        <div class="tdrow" classList={{ [`k-${row ? kindOf(row) : "same"}`]: true }}>
          <span class="tdlab">{s === 0 ? "Left" : "Right"}{n !== undefined ? ` ${n + 1}` : ""}</span>
          <For each={cols()}>
            {(c) => (
              <span class="tcell" classList={cellClass(row, c, !cells)} style={{ width: `${COL_W}px` }} title={cells?.[c] ?? ""}>
                {cells?.[c] ?? ""}
              </span>
            )}
          </For>
        </div>
      );
    };
    return (
      <div class="tdetails">
        <div class="tdrow th">
          <span class="tdlab" />
          <For each={cols()}>
            {(c) => (
              <span class="tcell th" classList={{ tkey: opts.keys.includes(c) }} style={{ width: `${COL_W}px` }}>
                {colName(c)}
              </span>
            )}
          </For>
        </div>
        {line(0)}
        {line(1)}
      </div>
    );
  };

  const numInput = (v: number, set: (n: number) => void) => (
    <input type="number" class="num" min={0} step="any" value={v} onChange={(e) => set(Math.max(0, parseFloat(e.currentTarget.value) || 0))} />
  );

  return (
    <div class="view">
      <div class="toolbar">
        <SessionButtons tab={tab()} />
        <div class="seg">
          <Btn title="All: show all rows" active={filter() === "all"} onClick={() => setFilter("all")}>All</Btn>
          <Btn title="Diffs: show differences only" active={filter() === "diffs"} onClick={() => setFilter("diffs")}>≠ Diffs</Btn>
          <Btn title="Same: show matching rows only" active={filter() === "same"} onClick={() => setFilter("same")}>= Same</Btn>
        </div>
        <Btn title="Minor: ignore unimportant differences (treat them as same)" active={minor()} onClick={() => setMinor(!minor())}>≈ Minor</Btn>
        <Btn title="Rules: edit comparison rules" active={showRules()} onClick={() => setShowRules(!showRules())}>⚙ Rules</Btn>
        <button class="tb-btn" title="Format: delimiter and header row" onClick={(e) => dropDown(e.currentTarget, tab().id, formatItems())}>
          ▦ Format ▾
        </button>
        <span class="sep" />
        <Btn title="Copy: copy selected rows to the clipboard" kbd={displayKeys("Ctrl+C")} disabled={!selected().length} onClick={copy}>⧉ Copy</Btn>
        <span class="sep" />
        <Btn title="Next difference" kbd={displayKeys("Ctrl+N")} onClick={() => nav(1)}>▼ Next Diff</Btn>
        <Btn title="Previous difference" kbd={displayKeys("Ctrl+P")} onClick={() => nav(-1)}>▲ Prev Diff</Btn>
        <span class="sep" />
        <Btn title="Swap sides" onClick={swap}>⇄ Swap</Btn>
        <Btn title="Reload files" kbd="F5" onClick={refresh}>⟳ Reload</Btn>
      </div>
      <Show when={showRules()}>
        <div class="panel rules">
          <label title="Columns used to match rows between files (comma separated, 1-based). Empty = align by content.">
            Key columns:{" "}
            <input style={{ width: "6em" }} value={opts.keys.map((k) => k + 1).join(",")} onChange={(e) => (setOpts("keys", parseCols(e.currentTarget.value)), apply())} />
          </label>
          <label title="Differences in these columns are unimportant (comma separated, 1-based). Key columns are always important.">
            Unimportant columns:{" "}
            <input style={{ width: "6em" }} value={opts.unimportant.map((k) => k + 1).join(",")} onChange={(e) => (setOpts("unimportant", parseCols(e.currentTarget.value)), apply())} />
          </label>
          <strong>Unimportant text differences:</strong>
          <label>
            <input type="checkbox" checked={opts.ignoreCase} onChange={(e) => (setOpts("ignoreCase", e.currentTarget.checked), apply())} /> Character case
          </label>
          <label>
            <input type="checkbox" checked={opts.trim} onChange={(e) => (setOpts("trim", e.currentTarget.checked), apply())} /> Whitespace
          </label>
          <label title="Numbers that differ by no more than this are unimportant differences (0 = exact)">
            Numeric tolerance: {numInput(opts.numTolerance, (n) => (setOpts("numTolerance", n), apply()))}{" "}
            <select value={opts.numRelative ? "rel" : "abs"} onChange={(e) => (setOpts("numRelative", e.currentTarget.value === "rel"), apply())}>
              <option value="abs">absolute</option>
              <option value="rel">relative (%)</option>
            </select>
          </label>
        </div>
      </Show>
      <div class="paths two">
        <PathBar value={left()} title={tab().titles?.[0]} onCommit={(p) => setPath(0, p)} />
        <PathBar value={right()} title={tab().titles?.[1]} onCommit={(p) => setPath(1, p)} />
      </div>
      <Show when={error()}>
        <div class="banner err">{error()}</div>
      </Show>
      <div class="tscroll" ref={scroller} onContextMenu={onContext} onScroll={(e) => vp.setScrollTop(e.currentTarget.scrollTop)}>
        <div class="theader" style={{ width: `${gridWidth() * 2 + 12}px` }}>
          {headerSide()}
          <span class="tgap" />
          {headerSide()}
        </div>
        <div style={{ height: `${rows().length * ROW_H}px`, position: "relative", width: `${gridWidth() * 2 + 12}px` }}>
          <Index each={win()}>
            {(it) => {
              const r = () => result()!.rows[it().ri];
              return (
                <div class="trow2" classList={{ [`k-${r().k}`]: true, sel: selSet().has(it().ri) }} style={{ top: `${it().i * ROW_H}px` }}>
                  {side(0, it().ri)}
                  <span class="tgap" />
                  {side(1, it().ri)}
                </div>
              );
            }}
          </Index>
        </div>
      </div>
      <Show when={showDetails() && result()}>{details()}</Show>
      <div class="statusbar">
        <Show when={message()}>
          <span>{message()}</span>
        </Show>
        <Show when={result()}>
          <span>
            {result()!.rows.length} rows · <span class="st-same">{counts().same} same</span> · <span class="st-diff">{counts().changed} changed</span> ·{" "}
            <span class="st-unimp">{counts().unimportant} unimportant</span> · <span class="st-orphan">{counts().left} left-only · {counts().right} right-only</span> ·
            delimiter “{result()!.delimiter === "\t" ? "Tab" : result()!.delimiter}”
          </span>
        </Show>
      </div>
    </div>
  );
}
