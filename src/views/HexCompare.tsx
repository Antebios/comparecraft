import { createMemo, createResource, createSignal, Index, onMount, Show } from "solid-js";
import { api, errText, fmtSize, type HexDiff } from "../api";
import { Btn, PathBar, ROW_H, useViewport } from "../components/common";
import { promptText } from "../components/Prompt";
import { displayKeys, registerCommands } from "../commands";
import { showContextMenu } from "../components/ContextMenu";
import { externalCommands, sideOf } from "../components/external";
import { persistSession, updateTab, type Tab } from "../store";

const PAGE = 64 * 1024;

/** Lazily reads 64 KB pages of a file and caches them. */
function pageCache(path: () => string) {
  const pages = new Map<number, Uint8Array>();
  const pending = new Set<number>();
  const [version, setVersion] = createSignal(0);
  const get = (offset: number): number | undefined => {
    version();
    const p = Math.floor(offset / PAGE);
    const page = pages.get(p);
    if (page) return page[offset - p * PAGE];
    if (!pending.has(p) && path()) {
      pending.add(p);
      api
        .readBytes(path(), p * PAGE, PAGE)
        .then((b) => pages.set(p, b))
        .catch(() => pages.set(p, new Uint8Array()))
        .finally(() => {
          pending.delete(p);
          setVersion((v) => v + 1);
        });
    }
    return undefined;
  };
  const reset = () => {
    pages.clear();
    setVersion((v) => v + 1);
  };
  return { get, reset };
}

const hex2 = (b: number | undefined) => (b === undefined ? "  " : b.toString(16).padStart(2, "0").toUpperCase());
const printable = (b: number | undefined) => (b === undefined ? " " : b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·");

export default function HexCompare(props: { tab: Tab; active: boolean }) {
  const tab = () => props.tab;
  const left = () => tab().paths[0] ?? "";
  const right = () => tab().paths[1] ?? "";
  const [width, setWidth] = createSignal(16);
  const [diffsOnly, setDiffsOnly] = createSignal(false);
  const [cursor, setCursor] = createSignal(-1);
  const [ctxSide, setCtxSide] = createSignal<0 | 1>(0);
  const lc = pageCache(left);
  const rc = pageCache(right);
  const [diff, { refetch }] = createResource(
    () => [left(), right()] as const,
    async ([l, r]): Promise<HexDiff | { error: string } | null> => {
      if (!l || !r) return null;
      try {
        return await api.hexDiff(l, r);
      } catch (e) {
        return { error: errText(e) };
      }
    },
  );
  const hd = () => {
    const d = diff();
    return d && !("error" in d) ? d : null;
  };

  let scroller!: HTMLDivElement;
  const vp = useViewport(() => scroller);

  onMount(() => {
    if (left() && right()) void persistSession(tab());
  });

  const total = () => Math.max(hd()?.leftSize ?? 0, hd()?.rightSize ?? 0);

  /** Row indices (line numbers) shown; when diffsOnly, only lines containing differences. */
  const lines = createMemo<number[] | null>(() => {
    if (!diffsOnly() || !hd()) return null;
    const w = width();
    const out: number[] = [];
    for (const [a, b] of hd()!.ranges) {
      for (let l = Math.floor(a / w); l <= Math.floor((b - 1) / w); l++) if (out[out.length - 1] !== l) out.push(l);
    }
    return out;
  });
  const lineCount = () => lines()?.length ?? Math.ceil(total() / width());

  const isDiff = (off: number) => {
    const r = hd()?.ranges;
    if (!r?.length) return false;
    let lo = 0;
    let hi = r.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (off < r[m][0]) hi = m - 1;
      else if (off >= r[m][1]) lo = m + 1;
      else return true;
    }
    return false;
  };

  const win = createMemo(() => {
    const { start, end } = vp.range(lineCount());
    const out: { i: number; line: number }[] = [];
    for (let i = start; i < end; i++) out.push({ i, line: lines()?.[i] ?? i });
    return out;
  });

  function gotoDiff(dir: 1 | -1) {
    const r = hd()?.ranges ?? [];
    if (!r.length) return;
    const cur = cursor();
    let idx = dir > 0 ? r.findIndex(([a]) => a > cur) : r.map(([a]) => a < cur).lastIndexOf(true);
    if (idx < 0) return;
    const off = r[idx][0];
    setCursor(off);
    const line = Math.floor(off / width());
    const visIndex = lines() ? lines()!.indexOf(line) : line;
    scroller.scrollTop = Math.max(0, visIndex * ROW_H - vp.height() / 3);
  }

  async function goToOffset() {
    const v = await promptText("Go To", "Offset (decimal, or hex with 0x prefix):", cursor() >= 0 ? `0x${cursor().toString(16)}` : "");
    if (v == null || !v.trim()) return;
    const off = Number(v.trim());
    if (!Number.isFinite(off) || off < 0) return;
    const o = Math.min(Math.floor(off), Math.max(0, total() - 1));
    setDiffsOnly(false);
    setCursor(o);
    scroller.scrollTop = Math.max(0, Math.floor(o / width()) * ROW_H - vp.height() / 3);
  }

  const reload = () => (lc.reset(), rc.reset(), refetch());
  registerCommands(tab().id, [
    { id: "reload", menu: "Session", group: "files", label: "Reload", keys: "F5", run: reload },
    { id: "next-diff", menu: "Search", group: "diff", label: "Next Difference", keys: "Ctrl+N", altKeys: ["Alt+Down"], run: () => gotoDiff(1) },
    { id: "prev-diff", menu: "Search", group: "diff", label: "Previous Difference", keys: "Ctrl+P", altKeys: ["Alt+Up"], run: () => gotoDiff(-1) },
    { id: "goto", menu: "Search", group: "go", label: "Go To Offset…", keys: "Ctrl+G", run: goToOffset },
    { id: "diffs-only", menu: "View", group: "filter", label: "Show Differences Only", checked: diffsOnly, run: () => setDiffsOnly(!diffsOnly()) },
    ...[8, 16, 32].map((w) => ({ id: `width-${w}`, menu: "View" as const, group: "width", label: `${w} Bytes per Line`, checked: () => width() === w, run: () => setWidth(w) })),
    ...externalCommands(() => tab().paths[ctxSide()] || undefined),
  ]);
  const onContext = (e: MouseEvent) => {
    setCtxSide(sideOf(e));
    showContextMenu(e, tab().id, ["next-diff", "prev-diff", "-", "goto", "-", "diffs-only", "width-8", "width-16", "width-32", "-", "reload", "-", "open-default", "reveal"]);
  };

  function setPath(i: 0 | 1, p: string) {
    const paths = [...tab().paths];
    paths[i] = p;
    updateTab(tab().id, { paths });
    (i === 0 ? lc : rc).reset();
    void persistSession({ ...tab(), paths });
  }

  const side = (get: (o: number) => number | undefined, size: () => number, line: number) => {
    const w = width();
    const base = line * w;
    const cells = [];
    const chars = [];
    for (let k = 0; k < w; k++) {
      const off = base + k;
      const has = off < size();
      const b = has ? get(off) : undefined;
      const d = has && isDiff(off);
      const cls = `hb${d ? " hdiff" : ""}${!has ? " hmiss" : ""}${off === cursor() ? " hcur" : ""}`;
      cells.push(<span class={cls} onMouseDown={() => setCursor(off)}>{has ? hex2(b) : "  "}</span>);
      chars.push(<span class={cls}>{has ? printable(b) : " "}</span>);
    }
    return (
      <div class="hside">
        <span class="hoff">{base.toString(16).padStart(8, "0").toUpperCase()}</span>
        <span class="hbytes">{cells}</span>
        <span class="hchars">{chars}</span>
      </div>
    );
  };

  return (
    <div class="view">
      <div class="toolbar">
        <Btn title="Previous difference" kbd={displayKeys("Ctrl+P")} onClick={() => gotoDiff(-1)}>▲ Prev</Btn>
        <Btn title="Next difference" kbd={displayKeys("Ctrl+N")} onClick={() => gotoDiff(1)}>▼ Next</Btn>
        <span class="sep" />
        <Btn title="Show only lines with differences" active={diffsOnly()} onClick={() => setDiffsOnly(!diffsOnly())}>≠ Diffs only</Btn>
        <label class="tb-label">
          Bytes/row{" "}
          <select value={width()} onChange={(e) => setWidth(+e.currentTarget.value)}>
            <option value="8">8</option>
            <option value="16">16</option>
            <option value="32">32</option>
          </select>
        </label>
        <Btn title="Reload" kbd="F5" onClick={reload}>⟳ Refresh</Btn>
      </div>
      <div class="paths two">
        <PathBar value={left()} title={tab().titles?.[0]} onCommit={(p) => setPath(0, p)} info={<span class="muted small">{fmtSize(hd()?.leftSize)}</span>} />
        <PathBar value={right()} title={tab().titles?.[1]} onCommit={(p) => setPath(1, p)} info={<span class="muted small">{fmtSize(hd()?.rightSize)}</span>} />
      </div>
      <Show when={diff() && "error" in diff()!}>
        <div class="banner err">{(diff() as { error: string }).error}</div>
      </Show>
      <div class="hscroll" ref={scroller} onContextMenu={onContext} onScroll={(e) => vp.setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ height: `${lineCount() * ROW_H}px`, position: "relative" }}>
          <Index each={win()}>
            {(it) => (
              <div class="hrow" style={{ top: `${it().i * ROW_H}px` }}>
                {side(lc.get, () => hd()?.leftSize ?? 0, it().line)}
                {side(rc.get, () => hd()?.rightSize ?? 0, it().line)}
              </div>
            )}
          </Index>
        </div>
      </div>
      <div class="statusbar">
        <Show when={hd()} fallback={<span>{diff.loading ? "Comparing…" : ""}</span>}>
          {(d) => (
            <span>
              <Show when={d().diffBytes === 0 && d().leftSize === d().rightSize} fallback={<span class="st-diff">{d().diffBytes.toLocaleString()} byte(s) differ in {d().ranges.length.toLocaleString()}{d().truncated ? "+" : ""} range(s)</span>}>
                <span class="st-same">Files are binary identical</span>
              </Show>
              {d().leftSize !== d().rightSize ? ` · sizes differ (${d().leftSize.toLocaleString()} vs ${d().rightSize.toLocaleString()})` : ""}
            </span>
          )}
        </Show>
        <span class="spacer" />
        <Show when={cursor() >= 0}>
          <span class="muted">
            Offset 0x{cursor().toString(16).toUpperCase()} ({cursor()}) · L {hex2(lc.get(cursor()))} · R {hex2(rc.get(cursor()))}
          </span>
        </Show>
      </div>
    </div>
  );
}
