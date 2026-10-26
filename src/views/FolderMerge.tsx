import { ask } from "../host";
import { batch, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { api, errText, fmtSize, fmtTime, joinPath, type Action, type FolderMergeResult, type FolderOptions, type MergeItem, type MergeStatus, type Side } from "../api";
import { Btn, PathBar } from "../components/common";
import { displayKeys, registerCommands, type Command } from "../commands";
import { showContextMenu } from "../components/ContextMenu";
import type { InfoGroup } from "../components/InfoDialog";
import { SessionButtons } from "../components/SessionTools";
import { backupSpec, settings } from "../settings";
import { openAuto, openTab, persistSession, updateTab, type Tab } from "../store";
import { defaultOptions } from "./FolderCompare";
import { sessionCommands } from "./sessionMenu";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Filter = "all" | "changes" | "conflicts" | "same";
type Version = "left" | "right";

const STATUS_LABEL: Record<MergeStatus, string> = {
  same: "Unchanged",
  left: "Left change",
  right: "Right change",
  both: "Same change",
  conflict: "Conflict",
};
const STATUS_CLASS: Record<MergeStatus, string> = {
  same: "st-same",
  left: "st-orphan",
  right: "st-orphan",
  both: "st-unimp",
  conflict: "st-diff",
};
const INFO_CLASS: Record<MergeStatus, string> = { same: "same", left: "left", right: "right", both: "unimp", conflict: "diff" };
const CRITERIA: [FolderOptions["criteria"], string][] = [
  ["timesize", "Timestamp & size"],
  ["size", "Size"],
  ["crc", "CRC"],
  ["binary", "Binary contents"],
  ["rules", "Rules-based contents"],
];

/** The version a merge takes for an item: the changed side, or the left when unchanged or the same. */
const autoVersion = (it: MergeItem): Version | null => (it.status === "conflict" ? null : it.status === "right" ? "right" : "left");

/** Folder Merge: merges the changes of two folders relative to their common base into an output folder. */
export default function FolderMerge(props: { tab: Tab; active: boolean }) {
  const tab = () => props.tab;
  const path = (i: number) => tab().paths[i] ?? "";
  const left = () => path(0);
  const right = () => path(1);
  const base = () => path(2);
  const output = () => tab().output ?? path(3);
  const [opts, setOpts] = createSignal<FolderOptions>({ ...defaultOptions(), criteria: "binary", ...((tab().options.folder as Partial<FolderOptions> | undefined) ?? {}), flatten: false });
  const [result, setResult] = createSignal<FolderMergeResult | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [filter, setFilter] = createSignal<Filter>((tab().options.mergeFilter as Filter) ?? "all");
  const [sel, setSel] = createSignal<Set<string>>(new Set());
  const [anchor, setAnchor] = createSignal<string | null>(null);

  const ready = () => !!left() && !!right();
  async function refresh() {
    if (!ready()) return setResult(null);
    setBusy(true);
    setError("");
    try {
      const r = await api.compareFolderMerge(left(), right(), base() || null, output() || null, opts());
      batch(() => {
        setResult(r);
        setSel((s) => new Set([...s].filter((rel) => r.items.some((i) => i.rel === rel))));
      });
    } catch (e) {
      setError(errText(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }
  onMount(async () => {
    await refresh();
    if (ready()) void persistSession(tab());
  });

  function setPath(i: number, p: string) {
    const paths = [0, 1, 2, 3].map((k) => (k === i ? p : path(k)));
    updateTab(tab().id, { paths, ...(i === 3 ? { output: undefined } : {}) });
    void refresh().then(() => persistSession(tab()));
  }
  function setOption(o: Partial<FolderOptions>) {
    setOpts({ ...opts(), ...o });
    updateTab(tab().id, { options: { ...tab().options, folder: JSON.parse(JSON.stringify(opts())) } });
    void refresh();
  }
  function setFilterSaved(f: Filter) {
    setFilter(f);
    updateTab(tab().id, { options: { ...tab().options, mergeFilter: f } });
  }
  function swap() {
    updateTab(tab().id, { paths: [right(), left(), base(), path(3)], titles: [tab().titles?.[1] ?? null, tab().titles?.[0] ?? null, tab().titles?.[2] ?? null] });
    void refresh();
  }

  const rows = createMemo(() => {
    const items = result()?.items ?? [];
    const f = filter();
    return items.filter((i) => f === "all" || (f === "same" ? i.status === "same" : f === "conflicts" ? i.status === "conflict" : i.status !== "same"));
  });
  const selected = () => rows().filter((i) => sel().has(i.rel));
  /** The selected items, or all shown changes when nothing is selected. */
  const targets = () => (selected().length ? selected() : rows().filter((i) => i.status !== "same"));

  function click(e: MouseEvent, it: MergeItem) {
    const s = new Set(e.ctrlKey || e.metaKey ? sel() : []);
    if (e.shiftKey && anchor()) {
      const ids = rows().map((r) => r.rel);
      const [a, b] = [ids.indexOf(anchor()!), ids.indexOf(it.rel)].sort((x, y) => x - y);
      ids.slice(a, b + 1).forEach((id) => s.add(id));
    } else {
      if (s.has(it.rel) && (e.ctrlKey || e.metaKey)) s.delete(it.rel);
      else s.add(it.rel);
      setAnchor(it.rel);
    }
    setSel(s);
  }
  function move(d: number, extend = false) {
    const ids = rows().map((r) => r.rel);
    if (!ids.length) return;
    const cur = anchor() ? ids.indexOf(anchor()!) : -1;
    const next = ids[Math.max(0, Math.min(ids.length - 1, cur + d))];
    setAnchor(next);
    setSel(extend ? new Set([...sel(), next]) : new Set([next]));
    document.getElementById(`fm-${tab().id}-${next}`)?.scrollIntoView({ block: "nearest" });
  }

  const root = (v: Version | "base" | "output") => (v === "left" ? left() : v === "right" ? right() : v === "base" ? base() : output());
  const filePath = (v: Version | "base" | "output", it: MergeItem) => joinPath(root(v), it.rel);

  /** Copies the chosen version of each item to the output folder (deleting it there when that version is absent). */
  async function mergeItems(items: MergeItem[], force?: Version) {
    if (!output()) return setMessage("Choose an output folder first.");
    const actions: Action[] = [];
    let skipped = 0;
    for (const it of items) {
      const v = force ?? autoVersion(it);
      if (!v) {
        skipped++;
        continue;
      }
      const src: Side | undefined = it[v];
      const dst = filePath("output", it);
      if (src) {
        const from = filePath(v, it);
        if (from === dst) continue;
        actions.push({ op: "copy", from, to: dst, rel: it.rel, dir: false, size: src.size });
      } else if (it.output) {
        actions.push({ op: "delete", to: dst, rel: it.rel, dir: false, size: it.output.size });
      }
    }
    if (!actions.length) {
      return setMessage(skipped ? `Nothing merged: ${skipped} conflict(s) need Take Left, Take Right or Merge Files.` : "The output already contains the merged versions.");
    }
    const deletes = actions.filter((a) => a.op === "delete").length;
    const msg = `Merge ${actions.length} file(s) into ${output()}?` + (deletes ? `\n${deletes} file(s) will be deleted from the output.` : "") + (skipped ? `\n${skipped} conflict(s) are skipped.` : "");
    if (settings.confirmCopy && !(await ask(msg, { title: "Folder Merge", kind: "info" }))) return;
    setBusy(true);
    try {
      const res = await api.executeActions(actions, settings.useTrash, backupSpec(settings.backupOnCopy));
      const failed = res.filter((r) => !r.ok);
      setMessage(failed.length ? `${failed.length} of ${res.length} operation(s) failed: ${failed[0].error ?? ""}` : `Merged ${res.length} file(s)` + (skipped ? `; ${skipped} conflict(s) skipped.` : "."));
    } catch (e) {
      setMessage(errText(e));
    } finally {
      setBusy(false);
    }
    await refresh();
  }

  /** Opens a Text Merge of one file (left, right, base → output). */
  function mergeFile(it: MergeItem) {
    openTab({ kind: "merge", paths: [it.left ? filePath("left", it) : "", it.right ? filePath("right", it) : "", it.base ? filePath("base", it) : "", output() ? filePath("output", it) : ""] });
  }
  function compareFile(it: MergeItem, a: Version | "base" | "output", b: Version | "base" | "output") {
    void openAuto([filePath(a, it), filePath(b, it)]);
  }
  const one = () => (selected().length === 1 ? selected()[0] : null);
  const has = (v: Version | "base" | "output") => !!one() && !!one()![v];

  const infoGroups = (): InfoGroup[] =>
    (["conflict", "left", "right", "both", "same"] as MergeStatus[])
      .map((st) => ({ st, items: (result()?.items ?? []).filter((i) => i.status === st) }))
      .filter((g) => g.items.length)
      .map((g) => ({ label: `${g.items.length} ${STATUS_LABEL[g.st].toLowerCase()} file(s)`, cls: INFO_CLASS[g.st], items: g.items.map((i) => i.rel) }));

  const cmds: Command[] = [
    ...sessionCommands({
      tab,
      title: "Folder Merge",
      notify: setMessage,
      info: { enabled: () => !!result(), groups: infoGroups },
    }),
    { id: "swap", menu: "Session", group: "files", label: "Swap Sides", run: swap },
    { id: "reload", menu: "Session", group: "files", label: "Refresh", keys: "F5", run: refresh },
    { id: "compare-bases", menu: "Session", group: "using", label: "Compare Base Folders", enabled: ready, run: () => openTab({ kind: "folder", paths: [left(), right()] }) },
    { id: "sync-bases", menu: "Session", group: "using", label: "Sync Base Folders", enabled: ready, run: () => openTab({ kind: "sync", paths: [left(), right()] }) },
    { id: "merge", menu: "Actions", group: "merge", label: "Merge", keys: "Ctrl+M", enabled: () => !busy() && targets().length > 0, run: () => mergeItems(targets()) },
    { id: "take-left", menu: "Actions", group: "merge", label: "Take Left", keys: "Ctrl+L", enabled: () => !busy() && selected().length > 0, run: () => mergeItems(selected(), "left") },
    { id: "take-right", menu: "Actions", group: "merge", label: "Take Right", keys: "Ctrl+R", enabled: () => !busy() && selected().length > 0, run: () => mergeItems(selected(), "right") },
    { id: "merge-files", menu: "Actions", group: "open", label: "Merge Files", keys: "Enter", enabled: () => !!one(), run: () => mergeFile(one()!) },
    { id: "compare-lr", menu: "Actions", group: "open", label: "Compare Left with Right", enabled: () => has("left") && has("right"), run: () => compareFile(one()!, "left", "right") },
    { id: "compare-lb", menu: "Actions", group: "open", label: "Compare Left with Base", enabled: () => has("left") && has("base"), run: () => compareFile(one()!, "left", "base") },
    { id: "compare-rb", menu: "Actions", group: "open", label: "Compare Right with Base", enabled: () => has("right") && has("base"), run: () => compareFile(one()!, "right", "base") },
    { id: "compare-out", menu: "Actions", group: "open", label: "Compare Left with Output", enabled: () => has("left") && has("output"), run: () => compareFile(one()!, "left", "output") },
    { id: "select-all", menu: "Edit", group: "sel", label: "Select All", keys: "Ctrl+A", run: () => setSel(new Set(rows().map((r) => r.rel))) },
    { id: "select-conflicts", menu: "Edit", group: "sel", label: "Select Conflicts", run: () => setSel(new Set(rows().filter((r) => r.status === "conflict").map((r) => r.rel))) },
    { id: "select-changes", menu: "Edit", group: "sel", label: "Select Changes", run: () => setSel(new Set(rows().filter((r) => r.status !== "same").map((r) => r.rel))) },
    { id: "next-conflict", menu: "Search", group: "conflict", label: "Next Conflict", keys: "Alt+N", run: () => gotoConflict(1) },
    { id: "prev-conflict", menu: "Search", group: "conflict", label: "Previous Conflict", keys: "Alt+P", run: () => gotoConflict(-1) },
    { id: "row-up", menu: "Search", hidden: true, label: "Row Up", keys: "Up", run: () => move(-1) },
    { id: "row-down", menu: "Search", hidden: true, label: "Row Down", keys: "Down", run: () => move(1) },
    { id: "sel-up", menu: "Search", hidden: true, label: "Extend Selection Up", keys: "Shift+Up", run: () => move(-1, true) },
    { id: "sel-down", menu: "Search", hidden: true, label: "Extend Selection Down", keys: "Shift+Down", run: () => move(1, true) },
    ...(
      [
        ["all", "Show All"],
        ["changes", "Show Changes"],
        ["conflicts", "Show Conflicts"],
        ["same", "Show Unchanged"],
      ] as [Filter, string][]
    ).map(([f, label]): Command => ({ id: `show-${f}`, menu: "View", group: "filter", label, checked: () => filter() === f, run: () => setFilterSaved(f) })),
  ];
  registerCommands(tab().id, cmds);

  function gotoConflict(d: number) {
    const ids = rows().filter((r) => r.status === "conflict").map((r) => r.rel);
    if (!ids.length) return setMessage("No conflicts.");
    const all = rows().map((r) => r.rel);
    const cur = anchor() ? all.indexOf(anchor()!) : -1;
    const next = d > 0 ? ids.find((id) => all.indexOf(id) > cur) : [...ids].reverse().find((id) => all.indexOf(id) < cur);
    if (!next) return setMessage(d > 0 ? "No more conflicts below." : "No more conflicts above.");
    setMessage("");
    setAnchor(next);
    setSel(new Set([next]));
    document.getElementById(`fm-${tab().id}-${next}`)?.scrollIntoView({ block: "nearest" });
  }

  const cell = (s?: Side) => (s ? <span title={`${s.size.toLocaleString()} bytes`}>{fmtSize(s.size)} · {fmtTime(s.modified)}</span> : <span class="muted">—</span>);
  const count = (st: MergeStatus) => result()?.summary[st] ?? 0;

  return (
    <div class="view">
      <div class="toolbar">
        <SessionButtons tab={tab()} />
        <div class="seg">
          <Btn title="All: show all files" active={filter() === "all"} onClick={() => setFilterSaved("all")}>All</Btn>
          <Btn title="Changes: show files changed on either side" active={filter() === "changes"} onClick={() => setFilterSaved("changes")}>≠ Changes</Btn>
          <Btn title="Conflicts: show files changed differently on both sides" active={filter() === "conflicts"} onClick={() => setFilterSaved("conflicts")}>⚠ Conflicts</Btn>
          <Btn title="Same: show unchanged files" active={filter() === "same"} onClick={() => setFilterSaved("same")}>= Same</Btn>
        </div>
        <span class="sep" />
        <Btn title="Merge: copy the changed version of the selected files (or all changes) to the output folder" kbd={displayKeys("Ctrl+M")} disabled={busy() || !targets().length} onClick={() => void mergeItems(targets())}>⇣ Merge</Btn>
        <Btn title="Take Left: copy the left version of the selected files to the output folder" kbd={displayKeys("Ctrl+L")} disabled={busy() || !selected().length} onClick={() => void mergeItems(selected(), "left")}>◧ Take Left</Btn>
        <Btn title="Take Right: copy the right version of the selected files to the output folder" kbd={displayKeys("Ctrl+R")} disabled={busy() || !selected().length} onClick={() => void mergeItems(selected(), "right")}>◨ Take Right</Btn>
        <Btn title="Merge Files: open a Text Merge of the selected file" disabled={!one()} onClick={() => mergeFile(one()!)}>🔀 Merge Files</Btn>
        <span class="sep" />
        <Btn title="Next conflict" kbd={displayKeys("Alt+N")} onClick={() => gotoConflict(1)}>▼ Next Conflict</Btn>
        <Btn title="Previous conflict" kbd={displayKeys("Alt+P")} onClick={() => gotoConflict(-1)}>▲ Prev Conflict</Btn>
        <span class="sep" />
        <label class="tb-label" title="How files are compared">
          Compare:{" "}
          <select value={opts().criteria} onChange={(e) => setOption({ criteria: e.currentTarget.value as FolderOptions["criteria"] })}>
            <For each={CRITERIA}>{([v, l]) => <option value={v}>{l}</option>}</For>
          </select>
        </label>
        <Btn title="Swap left and right" onClick={swap}>⇄ Swap</Btn>
        <Btn title="Refresh" kbd="F5" onClick={() => void refresh()}>⟳ Refresh</Btn>
      </div>
      <div class="paths three">
        <PathBar folder value={left()} title={tab().titles?.[0]} placeholder="Left folder…" onCommit={(p) => setPath(0, p)} />
        <PathBar folder value={base()} title={tab().titles?.[2]} placeholder="Base (common ancestor) folder…" onCommit={(p) => setPath(2, p)} />
        <PathBar folder value={right()} title={tab().titles?.[1]} placeholder="Right folder…" onCommit={(p) => setPath(1, p)} />
      </div>
      <div class="paths fm-output">
        <PathBar folder value={output()} placeholder="Output folder (often the left folder)…" onCommit={(p) => setPath(3, p)} />
      </div>
      <Show when={error()}>
        <div class="banner err">{error()}</div>
      </Show>
      <div class="fm-list" tabIndex={0}>
        <div class="fm-row fm-head">
          <span>Name</span>
          <span>Status</span>
          <span>Left</span>
          <span>Base</span>
          <span>Right</span>
          <span>Output</span>
        </div>
        <Show when={ready()} fallback={<div class="fm-empty muted">Choose the left and right folders, their common base folder and an output folder.</div>}>
          <Show when={rows().length || busy()} fallback={<div class="fm-empty muted">{result() ? "No files to show." : ""}</div>}>
            <For each={rows()}>
              {(it) => (
                <div
                  id={`fm-${tab().id}-${it.rel}`}
                  class="fm-row"
                  classList={{ sel: sel().has(it.rel), [`fm-${it.status}`]: true }}
                  onClick={(e) => click(e, it)}
                  onDblClick={() => (it.status === "conflict" ? mergeFile(it) : it.left && it.right ? compareFile(it, "left", "right") : mergeFile(it))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!sel().has(it.rel)) (setSel(new Set([it.rel])), setAnchor(it.rel));
                    showContextMenu(e, tab().id, ["merge", "take-left", "take-right", "-", "merge-files", "compare-lr", "compare-lb", "compare-rb", "compare-out"]);
                  }}
                  title={it.error ?? it.rel}
                >
                  <span class="fm-name">{it.rel}</span>
                  <span class={STATUS_CLASS[it.status]}>{STATUS_LABEL[it.status]}</span>
                  {cell(it.left)}
                  {cell(it.base)}
                  {cell(it.right)}
                  {cell(it.output)}
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
      <div class="statusbar">
        <Show when={busy()}>
          <span>Comparing…</span>
        </Show>
        <Show when={message()}>
          <span>{message()}</span>
        </Show>
        <Show when={result()}>
          <span>
            {plural(result()!.items.length, "file")} · <span class="st-diff">{plural(count("conflict"), "conflict")}</span> ·{" "}
            <span class="st-orphan">{plural(count("left"), "left change")} · {plural(count("right"), "right change")}</span> ·{" "}
            <span class="st-unimp">{plural(count("both"), "same change")}</span> · <span class="st-same">{count("same")} unchanged</span>
            {selected().length ? ` · ${selected().length} selected` : ""}
          </span>
        </Show>
      </div>
    </div>
  );
}
