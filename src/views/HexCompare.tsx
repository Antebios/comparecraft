import { createMemo, createResource, createSignal, Index, onMount, Show } from "solid-js";
import { api, errText, fmtSize, type HexAlign, type HexAlignment } from "../api";
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

/** Index of the last element whose key is <= v (keys ascending). */
function floorIndex(keys: number[], v: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (keys[m] <= v) {
      ans = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return ans;
}

/** Precomputed geometry of an aligned map. */
interface Layout {
  /** Per map entry: first slot, left offset, right offset. */
  slot: number[];
  lOff: number[];
  rOff: number[];
  kind: number[];
  /** Blocks: runs of entries that are all same or all different, each starting a new row. */
  blocks: { slot: number; end: number; diff: boolean }[];
  slots: number;
}

function layoutOf(h: HexAlignment): Layout {
  const L: Layout = { slot: [], lOff: [], rOff: [], kind: [], blocks: [], slots: 0 };
  let s = 0;
  let l = 0;
  let r = 0;
  for (const [k, n] of h.map) {
    L.slot.push(s);
    L.lOff.push(l);
    L.rOff.push(r);
    L.kind.push(k);
    const diff = k !== 0;
    const last = L.blocks[L.blocks.length - 1];
    if (last && last.diff === diff) last.end = s + n;
    else L.blocks.push({ slot: s, end: s + n, diff });
    s += n;
    if (k !== 2) l += n;
    if (k !== 1) r += n;
  }
  L.slots = s;
  return L;
}

const KIND_LABEL = ["Same", "Left orphan", "Right orphan", "Different"];

export default function HexCompare(props: { tab: Tab; active: boolean }) {
  const tab = () => props.tab;
  const left = () => tab().paths[0] ?? "";
  const right = () => tab().paths[1] ?? "";
  const [width, setWidth] = createSignal(16);
  const [diffsOnly, setDiffsOnly] = createSignal(false);
  const [cursor, setCursor] = createSignal(-1);
  const [ctxSide, setCtxSide] = createSignal<0 | 1>(0);
  const hexOpts = () => (tab().options.hex as { align?: HexAlign } | undefined) ?? {};
  const align = (): HexAlign => hexOpts().align ?? "complete";
  const setAlign = (a: HexAlign) => {
    const options = { ...tab().options, hex: { ...hexOpts(), align: a } };
    updateTab(tab().id, { options });
    void persistSession({ ...tab(), options });
  };
  const lc = pageCache(left);
  const rc = pageCache(right);
  const [diff, { refetch }] = createResource(
    () => [left(), right(), align()] as const,
    async ([l, r, a]): Promise<HexAlignment | { error: string } | null> => {
      if (!l || !r) return null;
      try {
        return await api.hexAlign(l, r, a);
      } catch (e) {
        return { error: errText(e) };
      }
    },
  );
  const hd = () => {
    const d = diff();
    return d && !("error" in d) ? d : null;
  };
  const layout = createMemo(() => (hd() ? layoutOf(hd()!) : null));

  let scroller!: HTMLDivElement;
  const vp = useViewport(() => scroller);

  onMount(() => {
    if (left() && right()) void persistSession(tab());
  });

  /** Visible blocks and the first row of each. */
  const rows = createMemo(() => {
    const L = layout();
    const w = width();
    const blocks: { slot: number; end: number; diff: boolean }[] = [];
    const first: number[] = [];
    let n = 0;
    for (const b of L?.blocks ?? []) {
      if (diffsOnly() && !b.diff) continue;
      blocks.push(b);
      first.push(n);
      n += Math.ceil((b.end - b.slot) / w);
    }
    return { blocks, first, count: n };
  });

  /** Slot range [start, end) shown on visible row i. */
  const rowSlots = (i: number): [number, number] => {
    const R = rows();
    const bi = floorIndex(R.first, i);
    if (bi < 0) return [0, 0];
    const b = R.blocks[bi];
    const s = b.slot + (i - R.first[bi]) * width();
    return [s, Math.min(s + width(), b.end)];
  };

  /** Map entry, left and right offsets for an aligned slot. */
  const slotInfo = (slot: number) => {
    const L = layout();
    if (!L) return null;
    const e = floorIndex(L.slot, slot);
    if (e < 0 || slot >= L.slots) return null;
    const d = slot - L.slot[e];
    const k = L.kind[e];
    return { k, l: k === 2 ? null : L.lOff[e] + d, r: k === 1 ? null : L.rOff[e] + d, lBase: L.lOff[e] + (k === 2 ? 0 : d), rBase: L.rOff[e] + (k === 1 ? 0 : d) };
  };

  const rowOfSlot = (slot: number) => {
    const R = rows();
    let lo = 0;
    let hi = R.blocks.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      const b = R.blocks[m];
      if (slot < b.slot) hi = m - 1;
      else if (slot >= b.end) lo = m + 1;
      else return R.first[m] + Math.floor((slot - b.slot) / width());
    }
    return -1;
  };

  const win = createMemo(() => {
    const { start, end } = vp.range(rows().count);
    const out: number[] = [];
    for (let i = start; i < end; i++) out.push(i);
    return out;
  });

  function reveal(slot: number) {
    setCursor(slot);
    const row = rowOfSlot(slot);
    if (row >= 0) scroller.scrollTop = Math.max(0, row * ROW_H - vp.height() / 3);
  }

  function gotoDiff(dir: 1 | -1) {
    const bl = layout()?.blocks.filter((b) => b.diff) ?? [];
    if (!bl.length) return;
    const cur = cursor();
    const b = dir > 0 ? bl.find((x) => x.slot > cur) : [...bl].reverse().find((x) => x.end <= cur || (x.slot < cur && cur < x.end));
    if (b) reveal(b.slot);
  }

  async function goToOffset() {
    const info = cursor() >= 0 ? slotInfo(cursor()) : null;
    const v = await promptText("Go To", "Left file offset (decimal, or hex with 0x prefix):", info?.l != null ? `0x${info.l.toString(16)}` : "");
    if (v == null || !v.trim()) return;
    const off = Number(v.trim());
    const L = layout();
    if (!Number.isFinite(off) || off < 0 || !L) return;
    const o = Math.min(Math.floor(off), Math.max(0, (hd()?.leftSize ?? 1) - 1));
    // Last entry that holds left bytes at or before o.
    let e = floorIndex(L.lOff, o);
    while (e > 0 && L.kind[e] === 2) e--;
    if (e < 0) return;
    setDiffsOnly(false);
    reveal(L.kind[e] === 2 ? L.slot[e] : L.slot[e] + Math.min(o - L.lOff[e], (L.slot[e + 1] ?? L.slots) - L.slot[e] - 1));
  }

  const reload = () => (lc.reset(), rc.reset(), refetch());
  const ALIGNS: [HexAlign, string][] = [
    ["none", "None"],
    ["fast", "Fast"],
    ["complete", "Complete"],
  ];
  registerCommands(tab().id, [
    { id: "reload", menu: "Session", group: "files", label: "Reload", keys: "F5", run: reload },
    { id: "next-diff", menu: "Search", group: "diff", label: "Next Difference", keys: "Ctrl+N", altKeys: ["Alt+Down"], run: () => gotoDiff(1) },
    { id: "prev-diff", menu: "Search", group: "diff", label: "Previous Difference", keys: "Ctrl+P", altKeys: ["Alt+Up"], run: () => gotoDiff(-1) },
    { id: "goto", menu: "Search", group: "go", label: "Go To Offset…", keys: "Ctrl+G", run: goToOffset },
    { id: "diffs-only", menu: "View", group: "filter", label: "Show Differences Only", checked: diffsOnly, run: () => setDiffsOnly(!diffsOnly()) },
    ...[8, 16, 32].map((w) => ({ id: `width-${w}`, menu: "View" as const, group: "width", label: `${w} Bytes per Line`, checked: () => width() === w, run: () => setWidth(w) })),
    ...ALIGNS.map(([a, label]) => ({ id: `align-${a}`, menu: "View" as const, group: "align", label: `Alignment: ${label}`, checked: () => align() === a, run: () => setAlign(a) })),
    ...externalCommands(() => tab().paths[ctxSide()] || undefined),
  ]);
  const onContext = (e: MouseEvent) => {
    setCtxSide(sideOf(e));
    showContextMenu(e, tab().id, ["next-diff", "prev-diff", "-", "goto", "-", "diffs-only", "width-8", "width-16", "width-32", "-", "align-none", "align-fast", "align-complete", "-", "reload", "-", "open-default", "reveal"]);
  };

  function setPath(i: 0 | 1, p: string) {
    const paths = [...tab().paths];
    paths[i] = p;
    updateTab(tab().id, { paths });
    (i === 0 ? lc : rc).reset();
    void persistSession({ ...tab(), paths });
  }

  const side = (which: 0 | 1, i: number) => {
    const w = width();
    const [s0, s1] = rowSlots(i);
    const get = which === 0 ? lc.get : rc.get;
    const first = slotInfo(s0);
    const base = first ? (which === 0 ? first.lBase : first.rBase) : 0;
    const cells = [];
    const chars = [];
    for (let k = 0; k < w; k++) {
      const slot = s0 + k;
      const info = slot < s1 ? slotInfo(slot) : null;
      const off = info ? (which === 0 ? info.l : info.r) : null;
      const b = off != null ? get(off) : undefined;
      const kind = info?.k ?? 0;
      const cls = `hb${off == null ? (info ? " hmiss" : " hpad") : kind === 3 ? " hdiff" : kind !== 0 ? " horph" : ""}${slot === cursor() ? " hcur" : ""}`;
      cells.push(<span class={cls} onMouseDown={() => info && setCursor(slot)}>{off != null ? hex2(b) : "  "}</span>);
      chars.push(<span class={cls}>{off != null ? printable(b) : " "}</span>);
    }
    return (
      <div class="hside">
        <span class="hoff">{base.toString(16).padStart(8, "0").toUpperCase()}</span>
        <span class="hbytes">{cells}</span>
        <span class="hchars">{chars}</span>
      </div>
    );
  };

  const cur = createMemo(() => (cursor() >= 0 ? slotInfo(cursor()) : null));
  const offStr = (o: number | null, get: (o: number) => number | undefined) =>
    o == null ? "—" : `0x${o.toString(16).toUpperCase()} (${hex2(get(o))})`;

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
        <label class="tb-label" title="None compares byte N with byte N. Fast anchors on matching 50-byte runs. Complete also aligns the bytes between anchors.">
          Alignment{" "}
          <select value={align()} onChange={(e) => setAlign(e.currentTarget.value as HexAlign)}>
            {ALIGNS.map(([a, label]) => (
              <option value={a}>{label}</option>
            ))}
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
      <Show when={hd() && hd()!.align !== align()}>
        <div class="banner">Files are too large to align in memory; showing a positional comparison.</div>
      </Show>
      <div class="hscroll" ref={scroller} onContextMenu={onContext} onScroll={(e) => vp.setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ height: `${rows().count * ROW_H}px`, position: "relative" }}>
          <Index each={win()}>
            {(i) => (
              <div class="hrow" classList={{ hblock: floorIndex(rows().first, i()) >= 0 && rows().first[floorIndex(rows().first, i())] === i() && i() > 0 }} style={{ top: `${i() * ROW_H}px` }}>
                {side(0, i())}
                {side(1, i())}
              </div>
            )}
          </Index>
        </div>
      </div>
      <div class="statusbar">
        <Show when={hd()} fallback={<span>{diff.loading ? "Comparing…" : ""}</span>}>
          {(d) => (
            <span>
              <Show
                when={d().counts[1] + d().counts[2] + d().counts[3] === 0}
                fallback={
                  <span class="st-diff">
                    {d().counts[3].toLocaleString()} different · {d().counts[1].toLocaleString()} left orphan · {d().counts[2].toLocaleString()} right orphan byte(s)
                  </span>
                }
              >
                <span class="st-same">Files are binary identical</span>
              </Show>
              {` · ${d().counts[0].toLocaleString()} same`}
            </span>
          )}
        </Show>
        <span class="spacer" />
        <Show when={cur()}>
          {(c) => (
            <span class="muted">
              {KIND_LABEL[c().k]} · L {offStr(c().l, lc.get)} · R {offStr(c().r, rc.get)}
            </span>
          )}
        </Show>
      </div>
    </div>
  );
}
