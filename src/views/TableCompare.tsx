import { createMemo, createSignal, For, Index, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { api, errText, type TableOptions, type TableResult } from "../api";
import { Btn, PathBar, ROW_H, useViewport } from "../components/common";
import { displayKeys, registerCommands } from "../commands";
import { showContextMenu } from "../components/ContextMenu";
import { externalCommands, sideOf } from "../components/external";
import { persistSession, updateTab, type Tab } from "../store";

const COL_W = 140;

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
    ...((tab().options.table as Partial<TableOptions> | undefined) ?? {}),
  });
  const [result, setResult] = createSignal<TableResult | null>(null);
  const [error, setError] = createSignal("");
  const [diffsOnly, setDiffsOnly] = createSignal(false);
  const [sel, setSel] = createSignal(-1);
  const [ctxSide, setCtxSide] = createSignal<0 | 1>(0);

  let scroller!: HTMLDivElement;
  const vp = useViewport(() => scroller);

  async function refresh() {
    if (!left() || !right()) return;
    setError("");
    try {
      setResult(await api.compareTables(left(), right(), { ...opts, keys: [...opts.keys] }));
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
    updateTab(tab().id, { options: { ...tab().options, table: { ...opts, keys: [...opts.keys] } } });
    void refresh();
  }

  const rows = createMemo(() => {
    const r = result();
    if (!r) return [];
    const idx = r.rows.map((_, i) => i);
    return diffsOnly() ? idx.filter((i) => r.rows[i].k !== "same") : idx;
  });

  const diffRowIdx = createMemo(() => rows().filter((i) => result()!.rows[i].k !== "same"));

  function nav(dir: 1 | -1) {
    const list = diffRowIdx();
    const cur = sel();
    const next = dir > 0 ? list.find((i) => i > cur) : [...list].reverse().find((i) => i < cur);
    if (next === undefined) return;
    setSel(next);
    const vis = rows().indexOf(next);
    scroller.scrollTop = Math.max(0, vis * ROW_H - vp.height() / 3);
  }

  registerCommands(tab().id, [
    { id: "refresh", menu: "Session", group: "files", label: "Refresh", keys: "F5", run: refresh },
    { id: "next-diff", menu: "Search", group: "diff", label: "Next Difference", keys: "Ctrl+N", altKeys: ["Alt+Down"], run: () => nav(1) },
    { id: "prev-diff", menu: "Search", group: "diff", label: "Previous Difference", keys: "Ctrl+P", altKeys: ["Alt+Up"], run: () => nav(-1) },
    { id: "diffs-only", menu: "View", group: "filter", label: "Show Differences Only", checked: diffsOnly, run: () => setDiffsOnly(!diffsOnly()) },
    ...externalCommands(() => tab().paths[ctxSide()] || undefined),
  ]);
  const onContext = (e: MouseEvent) => {
    setCtxSide(sideOf(e));
    showContextMenu(e, tab().id, ["next-diff", "prev-diff", "-", "diffs-only", "-", "refresh", "-", "open-default", "reveal"]);
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
  const gridWidth = () => cols().length * COL_W + 50;

  const side = (cells: string[] | undefined, ri: number, rowNo: number | undefined) => {
    const r = result()!.rows[ri];
    const changed = new Set(r.cells ?? []);
    return (
      <div class="tside" style={{ width: `${gridWidth()}px` }}>
        <span class="tln">{rowNo !== undefined ? rowNo + 1 : ""}</span>
        <For each={cols()}>
          {(c) => (
            <span class="tcell" classList={{ tchanged: changed.has(c), tkey: opts.keys.includes(c), filler: !cells }} style={{ width: `${COL_W}px` }} title={cells?.[c] ?? ""}>
              {cells?.[c] ?? ""}
            </span>
          )}
        </For>
      </div>
    );
  };

  const counts = () => {
    const r = result();
    const c = { same: 0, changed: 0, left: 0, right: 0 };
    r?.rows.forEach((x) => c[x.k]++);
    return c;
  };

  return (
    <div class="view">
      <div class="toolbar">
        <Btn title="Previous difference" kbd={displayKeys("Ctrl+P")} onClick={() => nav(-1)}>▲ Prev</Btn>
        <Btn title="Next difference" kbd={displayKeys("Ctrl+N")} onClick={() => nav(1)}>▼ Next</Btn>
        <Btn title="Show only differing rows" active={diffsOnly()} onClick={() => setDiffsOnly(!diffsOnly())}>≠ Diffs only</Btn>
        <span class="sep" />
        <label class="tb-label">
          Delimiter{" "}
          <select value={opts.delimiter} onChange={(e) => (setOpts("delimiter", e.currentTarget.value), apply())}>
            <option value="">Auto</option>
            <option value=",">Comma</option>
            <option value={"\t"}>Tab</option>
            <option value=";">Semicolon</option>
            <option value="|">Pipe</option>
          </select>
        </label>
        <label class="tb-label">
          <input type="checkbox" checked={opts.header} onChange={(e) => (setOpts("header", e.currentTarget.checked), apply())} /> Header row
        </label>
        <label class="tb-label">
          <input type="checkbox" checked={opts.ignoreCase} onChange={(e) => (setOpts("ignoreCase", e.currentTarget.checked), apply())} /> Ignore case
        </label>
        <label class="tb-label">
          <input type="checkbox" checked={opts.trim} onChange={(e) => (setOpts("trim", e.currentTarget.checked), apply())} /> Trim cells
        </label>
        <label class="tb-label" title="Columns used to match rows between files (comma separated, 1-based). Empty = align by content.">
          Key columns{" "}
          <input
            style={{ width: "6em" }}
            value={opts.keys.map((k) => k + 1).join(",")}
            onChange={(e) => {
              const keys = e.currentTarget.value
                .split(/[,\s]+/)
                .map((x) => parseInt(x, 10) - 1)
                .filter((x) => x >= 0);
              setOpts("keys", keys);
              apply();
            }}
          />
        </label>
        <Btn title="Refresh" kbd="F5" onClick={refresh}>⟳ Refresh</Btn>
      </div>
      <div class="paths two">
        <PathBar value={left()} title={tab().titles?.[0]} onCommit={(p) => setPath(0, p)} />
        <PathBar value={right()} title={tab().titles?.[1]} onCommit={(p) => setPath(1, p)} />
      </div>
      <Show when={error()}>
        <div class="banner err">{error()}</div>
      </Show>
      <div class="tscroll" ref={scroller} onContextMenu={onContext} onScroll={(e) => vp.setScrollTop(e.currentTarget.scrollTop)}>
        <div class="theader" style={{ width: `${gridWidth() * 2 + 12}px` }}>
          {[0, 1].map(() => (
            <div class="tside" style={{ width: `${gridWidth()}px` }}>
              <span class="tln">#</span>
              <For each={cols()}>
                {(c) => (
                  <span
                    class="tcell th"
                    classList={{ tkey: opts.keys.includes(c) }}
                    style={{ width: `${COL_W}px` }}
                    title="Click to toggle as key column"
                    onClick={() => {
                      setOpts("keys", opts.keys.includes(c) ? opts.keys.filter((k) => k !== c) : [...opts.keys, c].sort((a, b) => a - b));
                      apply();
                    }}
                  >
                    {opts.keys.includes(c) ? "🔑 " : ""}
                    {colName(c)}
                  </span>
                )}
              </For>
            </div>
          ))}
        </div>
        <div style={{ height: `${rows().length * ROW_H}px`, position: "relative", width: `${gridWidth() * 2 + 12}px` }}>
          <Index each={win()}>
            {(it) => {
              const r = () => result()!.rows[it().ri];
              return (
                <div
                  class="trow2"
                  classList={{ [`k-${r().k}`]: true, sel: sel() === it().ri }}
                  style={{ top: `${it().i * ROW_H}px` }}
                  onMouseDown={() => setSel(it().ri)}
                >
                  {side(r().l !== undefined ? result()!.left[r().l!] : undefined, it().ri, r().l)}
                  <span class="tgap" />
                  {side(r().r !== undefined ? result()!.right[r().r!] : undefined, it().ri, r().r)}
                </div>
              );
            }}
          </Index>
        </div>
      </div>
      <div class="statusbar">
        <Show when={result()}>
          <span>
            {result()!.rows.length} rows · <span class="st-same">{counts().same} same</span> · <span class="st-diff">{counts().changed} changed</span> ·{" "}
            <span class="st-orphan">{counts().left} left-only · {counts().right} right-only</span> · delimiter “{result()!.delimiter === "\t" ? "Tab" : result()!.delimiter}”
          </span>
        </Show>
      </div>
    </div>
  );
}
