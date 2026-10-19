import { createSignal, For, Show } from "solid-js";
import type { Chunk, DiffResult, FNode, HexAlignment, PixResult, TableResult } from "../api";
import { Modal } from "./common";

/** A category of a folder comparison with the relative paths of its files. */
export interface InfoGroup {
  label: string;
  /** Status class of the files' icon. */
  cls: string;
  items: string[];
}

const add = (out: string[], n: number, what: string) => {
  if (n > 0) out.push(`${n} ${what}`);
};

/** Text Compare Info: line counts per category, then the number of difference sections. */
export function textInfo(d: DiffResult): string[] {
  const out: string[] = [];
  const n = (f: (r: DiffResult["rows"][number]) => boolean) => d.rows.filter(f).length;
  add(out, n((r) => r.k === "same"), "same line(s)");
  add(out, n((r) => r.k === "unimportant" && r.l != null && r.r == null), "unimportant left orphan line(s)");
  add(out, n((r) => r.k === "unimportant" && r.l == null && r.r != null), "unimportant right orphan line(s)");
  add(out, n((r) => r.k === "unimportant" && r.l != null && r.r != null), "unimportant difference line(s)");
  add(out, n((r) => r.k === "left"), "important left orphan line(s)");
  add(out, n((r) => r.k === "right"), "important right orphan line(s)");
  add(out, n((r) => r.k === "changed"), "important difference line(s)");
  if (d.hunks.length) out.push("", `${d.hunks.length} difference section(s)`);
  return out;
}

/** Text Merge Info: output line counts per change kind, difference and conflict sections. */
export function mergeInfo(chunks: Chunk[]): string[] {
  const out: string[] = [];
  const lines = (k: Chunk["kind"]) => chunks.filter((c) => c.kind === k).reduce((n, c) => n + Math.max(c.base.length, c.left.length, c.right.length), 0);
  add(out, lines("stable"), "same line(s)");
  add(out, lines("both"), "same changed line(s)");
  add(out, lines("left"), "left changed line(s)");
  add(out, lines("right"), "right changed line(s)");
  add(out, lines("conflict"), "conflict line(s)");
  const sections = chunks.filter((c) => c.kind !== "stable").length;
  const conflicts = chunks.filter((c) => c.kind === "conflict").length;
  if (sections) {
    out.push("", `${sections} difference section(s)`);
    if (conflicts) out.push(`${conflicts} conflict section(s)`);
  }
  return out;
}

/** Hex Compare Info: byte counts per alignment status. */
export function hexInfo(h: HexAlignment): string[] {
  const [same, lOnly, rOnly, diff] = h.counts;
  const out: string[] = [];
  add(out, same, "same byte(s)");
  add(out, diff, "difference byte(s)");
  add(out, lOnly, "left orphan byte(s)");
  add(out, rOnly, "right orphan byte(s)");
  return out;
}

/** Table Compare Info: row counts per category. */
export function tableInfo(t: TableResult): string[] {
  const out: string[] = [];
  const n = (k: string) => t.rows.filter((r) => r.k === k).length;
  add(out, n("same"), "same row(s)");
  add(out, n("unimportant"), "unimportant difference row(s)");
  add(out, n("left"), "important left orphan row(s)");
  add(out, n("right"), "important right orphan row(s)");
  add(out, n("changed"), "important difference row(s)");
  return out;
}

/** Picture Compare Info: pixel counts per category. */
export function pictureInfo(p: PixResult, ignoreUnimportant: boolean): string[] {
  const c = p.counts;
  const out: string[] = [];
  add(out, ignoreUnimportant ? 0 : c.unimportant, "unimportant difference pixel(s)");
  add(out, ignoreUnimportant ? c.unimportant : 0, "ignored unimportant difference pixel(s)");
  add(out, c.same, "same pixel(s)");
  add(out, c.important, "important difference pixel(s)");
  add(out, c.leftOrphan, "left orphan pixel(s)");
  add(out, c.rightOrphan, "right orphan pixel(s)");
  return out;
}

/** Folder Compare Info: every file of the comparison under its category, in a fixed order. */
export function folderInfo(root: FNode, timesize: boolean): InfoGroup[] {
  const groups: InfoGroup[] = [
    { label: "same file(s)", cls: "same", items: [] },
    { label: "left orphan file(s)", cls: "left", items: [] },
    { label: "right orphan file(s)", cls: "right", items: [] },
    { label: "left newer file(s)", cls: "newer", items: [] },
    { label: "right newer file(s)", cls: "newer", items: [] },
    { label: "difference file(s)", cls: "diff", items: [] },
    { label: "uncompared file(s)", cls: "error", items: [] },
  ];
  const walk = (n: FNode) => {
    for (const c of n.children ?? []) {
      if (c.dir) {
        walk(c);
        continue;
      }
      const g =
        c.status === "same" || c.status === "similar" ? 0
        : c.status === "left" ? 1
        : c.status === "right" ? 2
        : c.status === "diff" && timesize && c.newer === "left" ? 3
        : c.status === "diff" && timesize && c.newer === "right" ? 4
        : c.status === "diff" ? 5
        : 6;
      groups[g].items.push(c.rel);
    }
  };
  walk(root);
  return groups.filter((g) => g.items.length > 0).map((g) => ({ ...g, label: `${g.items.length} ${g.label}` }));
}

export function InfoDialog(props: { title: string; lines?: string[]; groups?: InfoGroup[]; onClose: () => void }) {
  const [open, setOpen] = createSignal(new Set<number>());
  const toggle = (i: number) => {
    const s = new Set(open());
    if (s.has(i)) s.delete(i);
    else s.add(i);
    setOpen(s);
  };
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <div class="info-dlg">
        <Show when={props.groups} fallback={<For each={props.lines ?? []} fallback={<div class="muted">No lines.</div>}>{(l) => <div class="info-line">{l || "\u00a0"}</div>}</For>}>
          {(groups) => (
            <For each={groups()} fallback={<div class="muted">No files.</div>}>
              {(g, i) => (
                <div class="info-group">
                  <div class="info-node" onClick={() => toggle(i())}>
                    <span class="info-twisty">{open().has(i()) ? "▾" : "▸"}</span>
                    <span class={`info-icon st-${g.cls}`} />
                    {g.label}
                  </div>
                  <Show when={open().has(i())}>
                    <For each={g.items}>
                      {(p) => (
                        <div class="info-leaf">
                          <span class={`info-icon st-${g.cls}`} />
                          {p}
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              )}
            </For>
          )}
        </Show>
      </div>
      <div class="modal-actions">
        <span class="spacer" />
        <button class="tb-btn primary" ref={(el) => setTimeout(() => el.focus())} onClick={props.onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
