import { ask, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { settings } from "../settings";
import { batch, createEffect, createMemo, createSignal, Index, onMount, Show } from "solid-js";
import { api, errText, strictRules, type Chunk, type MergeResult, type Rules, type TextFile } from "../api";
import { Btn, Modal, PathBar, ROW_H, useViewport } from "../components/common";
import { displayKeys, registerCommands } from "../commands";
import { showContextMenu } from "../components/ContextMenu";
import { persistSession, updateTab, type Tab } from "../store";
import { mergeInfo } from "../components/InfoDialog";
import { sessionCommands } from "./sessionMenu";

type Choice = "base" | "left" | "right" | "lr" | "rl" | { custom: string[] } | null;

const LABELS = ["Left", "Right", "Center (base)", "Output"];

function defaultChoice(c: Chunk): Choice {
  switch (c.kind) {
    case "stable":
      return "base";
    case "left":
    case "both":
      return "left";
    case "right":
      return "right";
    default:
      return null;
  }
}

function chunkOutput(c: Chunk, ch: Choice | undefined): string[] | null {
  if (ch === undefined) ch = defaultChoice(c);
  if (ch === null) return null;
  if (typeof ch === "object") return ch.custom;
  return { base: c.base, left: c.left, right: c.right, lr: [...c.left, ...c.right], rl: [...c.right, ...c.left] }[ch];
}

/** Section context menu, following the reference merge "Edit" popup. */
const MERGE_MENU = ["take-left", "take-base", "take-right", "take-lr", "take-rl", "-", "edit", "unresolve", "-", "next-conflict", "prev-conflict", "-", "save"];

export default function TextMerge(props: { tab: Tab; active: boolean }) {
  const tab = () => props.tab;
  // paths: [left, right, center, output]
  const [files, setFiles] = createSignal<(TextFile | null)[]>([null, null, null]);
  const [errors, setErrors] = createSignal<string[]>(["", "", ""]);
  const [merge, setMerge] = createSignal<MergeResult | null>(null);
  const [choices, setChoices] = createSignal<Choice[]>([]);
  const [sel, setSel] = createSignal(-1);
  const [rules, setRules] = createSignal<Rules>(strictRules());
  const [message, setMessage] = createSignal("");
  const [dirty, setDirty] = createSignal(false);
  const [editChunk, setEditChunk] = createSignal<number | null>(null);

  createEffect(() => updateTab(tab().id, { dirty: dirty() }));

  let top!: HTMLDivElement;
  let bottom!: HTMLDivElement;
  const vpTop = useViewport(() => top);
  const vpBot = useViewport(() => bottom);

  const path = (i: number) => tab().paths[i] ?? "";
  const outputPath = () => tab().output ?? path(3);

  async function loadAll() {
    const fs: (TextFile | null)[] = [];
    const errs: string[] = [];
    for (let i = 0; i < 3; i++) {
      if (!path(i)) {
        fs.push(null);
        errs.push("");
        continue;
      }
      try {
        fs.push(await api.loadText(path(i)));
        errs.push("");
      } catch (e) {
        fs.push(null);
        errs.push(errText(e));
      }
    }
    setFiles(fs);
    setErrors(errs);
    await recompute();
  }

  async function recompute() {
    const [l, r, c] = files();
    try {
      const m = await api.mergeTexts(c?.lines ?? [], l?.lines ?? [], r?.lines ?? [], rules());
      batch(() => {
        setChoices(m.chunks.map(defaultChoice));
        setMerge(m);
        setSel(-1);
        setDirty(false);
      });
    } catch (e) {
      setMessage(errText(e));
    }
  }

  onMount(async () => {
    await loadAll();
    if (path(0) || path(1)) void persistSession(tab());
  });

  const topRows = createMemo(() => {
    const m = merge();
    const out: { ci: number; j: number }[] = [];
    m?.chunks.forEach((c, ci) => {
      const n = Math.max(c.left.length, c.base.length, c.right.length, c.kind === "stable" ? 0 : 1);
      for (let j = 0; j < n; j++) out.push({ ci, j });
    });
    return out;
  });
  const chunkTopStart = createMemo(() => {
    const starts: number[] = [];
    topRows().forEach((r, i) => {
      if (starts[r.ci] === undefined) starts[r.ci] = i;
    });
    return starts;
  });

  const outRows = createMemo(() => {
    const m = merge();
    const out: { ci: number; text: string; marker?: boolean; conflict?: boolean }[] = [];
    m?.chunks.forEach((c, ci) => {
      const res = chunkOutput(c, choices()[ci]);
      if (res === null) {
        out.push({ ci, text: "<<<<<<< left", marker: true, conflict: true });
        c.left.forEach((t) => out.push({ ci, text: t, conflict: true }));
        out.push({ ci, text: "=======", marker: true, conflict: true });
        c.right.forEach((t) => out.push({ ci, text: t, conflict: true }));
        out.push({ ci, text: ">>>>>>> right", marker: true, conflict: true });
      } else res.forEach((t) => out.push({ ci, text: t }));
    });
    return out;
  });
  const chunkOutStart = createMemo(() => {
    const starts: number[] = [];
    outRows().forEach((r, i) => {
      if (starts[r.ci] === undefined) starts[r.ci] = i;
    });
    return starts;
  });

  const unresolved = () => choices().filter((c, i) => c === null && merge()?.chunks[i].kind === "conflict").length;

  function selectChunk(ci: number, scroll = true) {
    setSel(ci);
    if (!scroll) return;
    const t = chunkTopStart()[ci];
    if (t !== undefined) top.scrollTop = Math.max(0, t * ROW_H - vpTop.height() / 3);
    const o = chunkOutStart()[ci];
    if (o !== undefined) bottom.scrollTop = Math.max(0, o * ROW_H - vpBot.height() / 3);
  }

  function nav(dir: 1 | -1, conflictsOnly: boolean) {
    const m = merge();
    if (!m) return;
    for (let i = sel() + dir; i >= 0 && i < m.chunks.length; i += dir) {
      const k = m.chunks[i].kind;
      if (conflictsOnly ? k === "conflict" : k !== "stable") return selectChunk(i);
    }
    setMessage("No more " + (conflictsOnly ? "conflicts." : "changes."));
  }

  function choose(ch: Choice) {
    const ci = sel();
    if (ci < 0 || !merge() || merge()!.chunks[ci].kind === "stable") return setMessage("Select a change or conflict first.");
    const c = [...choices()];
    undoStack.push(choices());
    redoStack.length = 0;
    c[ci] = ch;
    setChoices(c);
    setDirty(true);
  }

  const undoStack: Choice[][] = [];
  const redoStack: Choice[][] = [];
  function undoChoice(from: Choice[][], to: Choice[][]) {
    const prev = from.pop();
    if (!prev) return;
    to.push(choices());
    setChoices(prev);
    setDirty(true);
  }

  async function saveOutput() {
    let p = outputPath();
    if (!p) {
      const picked = await saveDialog({ defaultPath: path(0) || undefined });
      if (!picked) return;
      p = picked;
      const paths = [...tab().paths];
      paths[3] = p;
      updateTab(tab().id, { paths, output: p });
    }
    if (unresolved() && !(await ask(`${unresolved()} conflict(s) are unresolved and will be written with conflict markers. Save anyway?`, { kind: "warning" })))
      return;
    const base = files()[2] ?? files()[0];
    try {
      await api.saveText({
        path: p,
        lines: outRows().map((r) => r.text),
        encoding: base?.encoding ?? "UTF-8",
        bom: base?.bom ?? false,
        eol: base?.eol === "Mixed" ? "LF" : base?.eol ?? "LF",
        finalNewline: base?.finalNewline ?? true,
        backup: settings.backupOnSave && !props.tab.noBackups,
        backupKind: settings.backupKind,
        backupDir: settings.backupDir || null,
      });
      setDirty(false);
      setMessage(`Saved ${p}`);
    } catch (e) {
      setMessage(`Save failed: ${errText(e)}`);
    }
  }

  const isChange = () => sel() >= 0 && !!merge() && merge()!.chunks[sel()].kind !== "stable";
  registerCommands(tab().id, [
    ...sessionCommands({
      tab,
      title: "Text Merge",
      dirty,
      notify: setMessage,
      info: { enabled: () => !!merge(), lines: () => mergeInfo(merge()!.chunks) },
      parents: { label: "Merge Parent Folders", kind: "fmerge", paths: () => [path(0), path(1), path(2), outputPath()] },
    }),
    { id: "reload", menu: "Session", group: "files", label: "Reload", keys: "F5", run: loadAll },
    { id: "save", menu: "File", label: "Save Output", keys: "Ctrl+S", run: saveOutput },
    { id: "undo", menu: "Edit", group: "undo", label: "Undo", keys: "Ctrl+Z", run: () => undoChoice(undoStack, redoStack) },
    { id: "redo", menu: "Edit", group: "undo", label: "Redo", keys: "Ctrl+Y", altKeys: ["Shift+Ctrl+Z"], run: () => undoChoice(redoStack, undoStack) },
    { id: "take-left", menu: "Edit", group: "take", label: "Take Left", keys: "Ctrl+L", enabled: isChange, run: () => choose("left") },
    { id: "take-right", menu: "Edit", group: "take", label: "Take Right", keys: "Ctrl+R", enabled: isChange, run: () => choose("right") },
    { id: "take-base", menu: "Edit", group: "take", label: "Take Center", enabled: isChange, run: () => choose("base") },
    { id: "take-lr", menu: "Edit", group: "take", label: "Take Left Then Right", keys: "Ctrl+B", enabled: isChange, run: () => choose("lr") },
    { id: "take-rl", menu: "Edit", group: "take", label: "Take Right Then Left", keys: "Shift+Ctrl+B", enabled: isChange, run: () => choose("rl") },
    { id: "edit", menu: "Edit", group: "edit", label: "Edit Output Section…", keys: "F2", enabled: isChange, run: () => setEditChunk(sel()) },
    { id: "unresolve", menu: "Edit", group: "edit", label: "Mark Unresolved", enabled: isChange, run: () => choose(null) },
    { id: "next-diff", menu: "Search", group: "diff", label: "Next Difference Section", keys: "Ctrl+N", run: () => nav(1, false) },
    { id: "prev-diff", menu: "Search", group: "diff", label: "Previous Difference Section", keys: "Ctrl+P", run: () => nav(-1, false) },
    { id: "next-conflict", menu: "Search", group: "conflict", label: "Next Conflict Section", keys: "Alt+N", run: () => nav(1, true) },
    { id: "prev-conflict", menu: "Search", group: "conflict", label: "Previous Conflict Section", keys: "Alt+P", run: () => nav(-1, true) },
  ]);

  function setPath(i: number, p: string) {
    const paths = [...tab().paths];
    while (paths.length < 4) paths.push("");
    paths[i] = p;
    updateTab(tab().id, { paths, ...(i === 3 ? { output: p } : {}) });
    if (i < 3) void loadAll().then(() => persistSession(tab()));
  }

  const kindClass = (ci: number) => `ck-${merge()?.chunks[ci].kind}`;

  const cell = (c: Chunk, j: number, which: "left" | "base" | "right", start: number) => {
    const arr = c[which];
    const changed =
      (which === "left" && (c.kind === "left" || c.kind === "both" || c.kind === "conflict")) ||
      (which === "right" && (c.kind === "right" || c.kind === "both" || c.kind === "conflict")) ||
      (which === "base" && c.kind !== "stable");
    return (
      <div class="mcell" classList={{ filler: j >= arr.length, changed }}>
        <span class="ln">{j < arr.length ? start + j + 1 : ""}</span>
        <span class="tx">{arr[j] ?? ""}</span>
      </div>
    );
  };

  const winTop = createMemo(() => {
    const rows = topRows();
    const { start, end } = vpTop.range(rows.length);
    const items: { i: number; ci: number; j: number }[] = [];
    for (let i = start; i < end; i++) items.push({ i, ...rows[i] });
    return items;
  });
  const winBot = createMemo(() => {
    const rows = outRows();
    const { start, end } = vpBot.range(rows.length);
    const items: { i: number; r: (typeof rows)[number] }[] = [];
    for (let i = start; i < end; i++) items.push({ i, r: rows[i] });
    return items;
  });

  return (
    <div class="view">
      <div class="toolbar">
        <Btn title="Previous change" kbd={displayKeys("Ctrl+P")} onClick={() => nav(-1, false)}>▲ Change</Btn>
        <Btn title="Next change" kbd={displayKeys("Ctrl+N")} onClick={() => nav(1, false)}>▼ Change</Btn>
        <Btn title="Previous conflict" kbd={displayKeys("Alt+P")} onClick={() => nav(-1, true)}>▲ Conflict</Btn>
        <Btn title="Next conflict" kbd={displayKeys("Alt+N")} onClick={() => nav(1, true)}>▼ Conflict</Btn>
        <span class="sep" />
        <Btn title="Take left" kbd={displayKeys("Ctrl+L")} onClick={() => choose("left")}>Take Left</Btn>
        <Btn title="Take center/base" onClick={() => choose("base")}>Take Base</Btn>
        <Btn title="Take right" kbd={displayKeys("Ctrl+R")} onClick={() => choose("right")}>Take Right</Btn>
        <Btn title="Take left then right" kbd={displayKeys("Ctrl+B")} onClick={() => choose("lr")}>Left+Right</Btn>
        <Btn title="Take right then left" kbd={displayKeys("Shift+Ctrl+B")} onClick={() => choose("rl")}>Right+Left</Btn>
        <Btn title="Edit output for this section" onClick={() => sel() >= 0 && setEditChunk(sel())}>✎ Edit</Btn>
        <Btn title="Mark section unresolved" onClick={() => choose(null)}>✕ Unresolve</Btn>
        <span class="sep" />
        <Btn
          title="Ignore whitespace when detecting changes"
          active={rules().ignoreTrailingWs}
          onClick={async () => {
            const on = !rules().ignoreTrailingWs;
            setRules({ ...strictRules(), ignoreLeadingWs: on, ignoreTrailingWs: on, ignoreEmbeddedWs: on });
            await recompute();
          }}
        >
          ≈ Ignore whitespace
        </Btn>
        <Btn title="Reload inputs" kbd="F5" onClick={loadAll}>⟳ Refresh</Btn>
        <Btn title="Save output" kbd={displayKeys("Ctrl+S")} onClick={saveOutput}>💾 Save Output</Btn>
      </div>
      <div class="paths three">
        {[0, 2, 1].map((i) => (
          <div class="labeled">
            <span class="plabel">{LABELS[i]}</span>
            <PathBar value={path(i)} title={tab().titles?.[i]} onCommit={(p) => setPath(i, p)} info={errors()[i] ? <span class="err-text">{errors()[i]}</span> : undefined} />
          </div>
        ))}
      </div>
      <div class="mtop" ref={top} onScroll={(e) => vpTop.setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ height: `${topRows().length * ROW_H}px`, position: "relative" }}>
          <Index each={winTop()}>
            {(it) => {
              const c = () => merge()!.chunks[it().ci];
              return (
                <div
                  class="mrow"
                  classList={{ [kindClass(it().ci)]: true, sel: sel() === it().ci, cstart: it().j === 0 }}
                  style={{ top: `${it().i * ROW_H}px` }}
                  onMouseDown={() => selectChunk(it().ci, false)}
                  onDblClick={() => selectChunk(it().ci)}
                  onContextMenu={(e) => showContextMenu(e, tab().id, MERGE_MENU)}
                >
                  {cell(c(), it().j, "left", c().leftStart)}
                  {cell(c(), it().j, "base", c().baseStart)}
                  {cell(c(), it().j, "right", c().rightStart)}
                </div>
              );
            }}
          </Index>
        </div>
      </div>
      <div class="labeled outbar">
        <span class="plabel">{LABELS[3]}</span>
        <PathBar value={outputPath()} title={tab().titles?.[3]} saveDialog onCommit={(p) => setPath(3, p)} dirty={dirty()} />
      </div>
      <div class="mbottom" ref={bottom} onScroll={(e) => vpBot.setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ height: `${outRows().length * ROW_H}px`, position: "relative" }}>
          <Index each={winBot()}>
            {(it) => (
              <div
                class="orow"
                classList={{ [kindClass(it().r.ci)]: true, sel: sel() === it().r.ci, marker: !!it().r.marker, conflict: !!it().r.conflict }}
                style={{ top: `${it().i * ROW_H}px` }}
                onMouseDown={() => selectChunk(it().r.ci, false)}
                onDblClick={() => selectChunk(it().r.ci)}
                onContextMenu={(e) => showContextMenu(e, tab().id, MERGE_MENU)}
              >
                <span class="ln">{it().i + 1}</span>
                <span class="tx">{it().r.text}</span>
              </div>
            )}
          </Index>
        </div>
      </div>
      <div class="statusbar">
        <Show when={merge()}>
          {(m) => (
            <span>
              {m().changes} change(s) merged ·{" "}
              <span classList={{ "st-diff": unresolved() > 0, "st-same": unresolved() === 0 }}>
                {unresolved()} of {m().conflicts} conflict(s) unresolved
              </span>
            </span>
          )}
        </Show>
        <span class="muted">{message()}</span>
      </div>
      <Show when={editChunk() !== null}>
        {(() => {
          const ci = editChunk()!;
          const c = merge()!.chunks[ci];
          const current = chunkOutput(c, choices()[ci]) ?? [...c.left, ...c.right];
          let ta!: HTMLTextAreaElement;
          return (
            <Modal title="Edit merged section" onClose={() => setEditChunk(null)} wide>
              <textarea class="edit-all" ref={ta} value={current.join("\n")} spellcheck={false} />
              <div class="modal-actions">
                <button onClick={() => setEditChunk(null)}>Cancel</button>
                <button
                  class="primary"
                  onClick={() => {
                    setSel(ci);
                    choose({ custom: ta.value.length ? ta.value.split(/\r\n|\n|\r/) : [] });
                    setEditChunk(null);
                  }}
                >
                  Apply
                </button>
              </div>
            </Modal>
          );
        })()}
      </Show>
    </div>
  );
}
