import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { api, errText } from "../api";
import { registerCommands } from "../commands";
import { Btn, PathBar } from "../components/common";
import { persistSession, updateTab, type Tab } from "../store";

interface PatchFile {
  name: string;
  start: number;
  added: number;
  removed: number;
}
type LineKind = "meta" | "file" | "hunk" | "add" | "del" | "ctx";

function classify(l: string): LineKind {
  if (l.startsWith("+++ ") || l.startsWith("--- ")) return "file";
  if (l.startsWith("@@")) return "hunk";
  if (l.startsWith("+")) return "add";
  if (l.startsWith("-")) return "del";
  if (l.startsWith(" ") || l === "") return "ctx";
  return "meta";
}

/** Read-only viewer for unified diff / patch files ("Text Patch" view). */
export default function PatchView(props: { tab: Tab; active: boolean }) {
  const tab = () => props.tab;
  const [lines, setLines] = createSignal<string[]>([]);
  const [message, setMessage] = createSignal("");
  const [current, setCurrent] = createSignal(0);
  let body!: HTMLDivElement;

  const kinds = createMemo(() => lines().map(classify));
  const files = createMemo(() => {
    const out: PatchFile[] = [];
    const ls = lines();
    const ks = kinds();
    for (let i = 0; i < ls.length; i++) {
      if (ls[i].startsWith("--- ") && ls[i + 1]?.startsWith("+++ ")) {
        const name = ls[i + 1].slice(4).split("\t")[0].replace(/^b\//, "");
        const prev = out[out.length - 1];
        let start = i;
        while (start > 0 && ks[start - 1] === "meta" && (!prev || start - 1 > prev.start)) start--;
        out.push({ name: name === "/dev/null" ? ls[i].slice(4).split("\t")[0].replace(/^a\//, "") : name, start, added: 0, removed: 0 });
        i++;
      } else if (out.length && ks[i] === "add") out[out.length - 1].added++;
      else if (out.length && ks[i] === "del") out[out.length - 1].removed++;
    }
    return out;
  });

  async function load(path: string) {
    if (!path) return;
    try {
      const f = await api.loadText(path);
      setLines(f.lines);
      setMessage(`${files().length} file(s)`);
    } catch (e) {
      setLines([]);
      setMessage(errText(e));
    }
  }
  const go = (i: number) => {
    const f = files()[i];
    if (!f) return;
    setCurrent(i);
    body.querySelector(`[data-line="${f.start}"]`)?.scrollIntoView({ block: "start" });
  };

  onMount(() => void load(tab().paths[0] ?? ""));

  registerCommands(tab().id, [
    { id: "reload", menu: "File", label: "Reload", keys: "F5", run: () => load(tab().paths[0] ?? "") },
    { id: "next-file", menu: "Search", label: "Next File", keys: "Ctrl+N", run: () => go(Math.min(files().length - 1, current() + 1)) },
    { id: "prev-file", menu: "Search", label: "Previous File", keys: "Ctrl+P", run: () => go(Math.max(0, current() - 1)) },
  ]);

  return (
    <div class="view">
      <div class="toolbar">
        <Btn title="Previous file" kbd="Ctrl+P" onClick={() => go(Math.max(0, current() - 1))}>▲ Prev File</Btn>
        <Btn title="Next file" kbd="Ctrl+N" onClick={() => go(Math.min(files().length - 1, current() + 1))}>▼ Next File</Btn>
        <Btn title="Reload" kbd="F5" onClick={() => void load(tab().paths[0] ?? "")}>⟳ Reload</Btn>
      </div>
      <div class="paths">
        <PathBar
          value={tab().paths[0] ?? ""}
          placeholder="Patch file (.diff, .patch)…"
          onCommit={(p) => {
            updateTab(tab().id, { paths: [p] });
            void load(p).then(() => persistSession(tab()));
          }}
        />
      </div>
      <div class="patch-layout">
        <div class="patch-files">
          <For each={files()} fallback={<div class="muted small" style={{ padding: "6px" }}>No files</div>}>
            {(f, i) => (
              <div class="patch-file" classList={{ sel: current() === i() }} onClick={() => go(i())} title={f.name}>
                <span class="patch-name">{f.name}</span>
                <span class="patch-stat"><span class="add">+{f.added}</span> <span class="del">−{f.removed}</span></span>
              </div>
            )}
          </For>
        </div>
        <div class="patch-body" ref={body}>
          <For each={lines()}>
            {(l, i) => (
              <div class={`pl pl-${kinds()[i()]}`} data-line={i()}>
                {l || " "}
              </div>
            )}
          </For>
        </div>
      </div>
      <div class="statusbar">
        <Show when={message()}>
          <span class="muted">{message()}</span>
        </Show>
      </div>
    </div>
  );
}
