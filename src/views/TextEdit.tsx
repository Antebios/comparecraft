import { ask, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { createEffect, createSignal, onMount, Show } from "solid-js";
import { api, errText, type TextFile } from "../api";
import { registerCommands } from "../commands";
import { Btn, PathBar } from "../components/common";
import { settings } from "../settings";
import { persistSession, updateTab, type Tab } from "../store";

/** Single-file text editor ("Text Edit" view). */
export default function TextEdit(props: { tab: Tab; active: boolean }) {
  const tab = () => props.tab;
  const [meta, setMeta] = createSignal<TextFile | null>(null);
  const [text, setText] = createSignal("");
  const [dirty, setDirty] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [pos, setPos] = createSignal({ line: 1, col: 1 });
  let area!: HTMLTextAreaElement;

  async function load(path: string) {
    if (!path) return;
    try {
      const f = await api.loadText(path);
      setMeta(f);
      setText(f.lines.join("\n"));
      setDirty(false);
      setMessage(`${f.encoding}${f.bom ? " BOM" : ""} · ${f.eol} · ${f.lines.length} lines`);
    } catch (e) {
      setMeta(null);
      setText("");
      setMessage(errText(e));
    }
  }

  async function commitPath(p: string) {
    if (dirty() && !(await ask("Discard unsaved changes?", { kind: "warning" }))) return;
    updateTab(tab().id, { paths: [p] });
    await load(p);
    void persistSession(tab());
  }

  async function saveTo(path: string) {
    const m = meta();
    try {
      await api.saveText({
        path,
        lines: text().split("\n"),
        encoding: m?.encoding ?? "UTF-8",
        bom: m?.bom ?? false,
        eol: m?.eol === "Mixed" || !m ? "LF" : m.eol,
        finalNewline: m?.finalNewline ?? true,
        backup: settings.backupOnSave && !tab().noBackups,
        backupKind: settings.backupKind,
        backupDir: settings.backupDir || null,
      });
      setDirty(false);
      setMessage(`Saved ${path}`);
      if (path !== tab().paths[0]) updateTab(tab().id, { paths: [path] });
    } catch (e) {
      setMessage(`Save failed: ${errText(e)}`);
    }
  }
  const save = () => (tab().paths[0] ? saveTo(tab().paths[0]) : saveAs());
  async function saveAs() {
    const p = await saveDialog({ defaultPath: tab().paths[0] || undefined });
    if (p) await saveTo(p);
  }
  async function reload() {
    if (dirty() && !(await ask("Discard unsaved changes and reload?", { kind: "warning" }))) return;
    await load(tab().paths[0] ?? "");
  }
  const updatePos = () => {
    const before = area.value.slice(0, area.selectionStart);
    const line = before.split("\n").length;
    setPos({ line, col: before.length - before.lastIndexOf("\n") });
  };

  onMount(() => void load(tab().paths[0] ?? ""));
  createEffect(() => updateTab(tab().id, { dirty: dirty() }));

  registerCommands(tab().id, [
    { id: "save", menu: "File", group: "save", label: "Save", keys: "Ctrl+S", inInputs: true, run: save },
    { id: "save-as", menu: "File", group: "save", label: "Save As…", keys: "Shift+Ctrl+S", inInputs: true, run: saveAs },
    { id: "reload", menu: "File", group: "save", label: "Reload", keys: "F5", run: reload },
  ]);

  return (
    <div class="view">
      <div class="toolbar">
        <Btn title="Save" kbd="Ctrl+S" onClick={save} disabled={!dirty()}>💾 Save</Btn>
        <Btn title="Save As" onClick={saveAs}>Save As…</Btn>
        <Btn title="Reload from disk" kbd="F5" onClick={reload}>⟳ Reload</Btn>
      </div>
      <div class="paths">
        <PathBar value={tab().paths[0] ?? ""} onCommit={commitPath} dirty={dirty()} />
      </div>
      <textarea
        ref={area}
        class="text-edit"
        spellcheck={false}
        value={text()}
        style={{ "tab-size": settings.tabSize }}
        onInput={(e) => {
          setText(e.currentTarget.value);
          setDirty(true);
          updatePos();
        }}
        onKeyUp={updatePos}
        onClick={updatePos}
      />
      <div class="statusbar">
        <span>{`Ln ${pos().line}, Col ${pos().col}`}</span>
        <Show when={message()}>
          <span class="muted">{message()}</span>
        </Show>
      </div>
    </div>
  );
}
