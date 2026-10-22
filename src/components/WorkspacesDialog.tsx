import { ask } from "../host";
import { createSignal, For } from "solid-js";
import { setSetting, settings } from "../settings";
import { KIND_LABEL } from "../store";
import { Modal } from "./common";
import { promptText } from "./Prompt";

/** Session › Load Workspace › Manage Workspaces: rename, delete and load saved workspaces. */
export function WorkspacesDialog(props: { onLoad: (name: string) => void; onClose: () => void }) {
  const names = () => Object.keys(settings.workspaces).sort((a, b) => a.localeCompare(b));
  const [sel, setSel] = createSignal(names()[0] ?? "");

  async function rename() {
    const old = sel();
    const name = (await promptText("Rename Workspace", "New name:", old))?.trim();
    if (!name || name === old) return;
    if (settings.workspaces[name] && !(await ask(`Replace the workspace “${name}”?`, { kind: "warning" }))) return;
    const ws = { ...settings.workspaces, [name]: settings.workspaces[old] };
    delete ws[old];
    setSetting("workspaces", ws);
    if (settings.workspaceLoad === old) setSetting("workspaceLoad", name);
    if (settings.workspaceSave === old) setSetting("workspaceSave", name);
    setSel(name);
  }
  async function remove() {
    const old = sel();
    if (!(await ask(`Delete the workspace “${old}”?`, { kind: "warning" }))) return;
    const ws = { ...settings.workspaces };
    delete ws[old];
    setSetting("workspaces", ws);
    if (settings.workspaceLoad === old) setSetting("workspaceLoad", "none");
    if (settings.workspaceSave === old) setSetting("workspaceSave", "none");
    setSel(names()[0] ?? "");
  }
  const onKey = (e: KeyboardEvent) => {
    if (!sel()) return;
    if (e.key === "F2") (e.preventDefault(), void rename());
    else if (e.key === "Delete") (e.preventDefault(), void remove());
    else if (e.key === "Enter") (e.preventDefault(), props.onLoad(sel()));
  };

  return (
    <Modal title="Manage Workspaces" onClose={props.onClose}>
      <div class="op-form">
        <div class="op-list ws-list" tabIndex={0} onKeyDown={onKey}>
          <For each={names()} fallback={<div class="muted">No saved workspaces. Use Session › Save Workspace As to save the open tabs.</div>}>
            {(n) => (
              <div class="ws-item" classList={{ selected: sel() === n }} onClick={() => setSel(n)} onDblClick={() => props.onLoad(n)}>
                <b>{n}</b>
                <span class="muted"> · {settings.workspaces[n].map((t) => KIND_LABEL[t.kind]).join(", ") || "no tabs"}</span>
              </div>
            )}
          </For>
        </div>
        <div class="op-row">
          <label>
            On startup, load:{" "}
            <select value={settings.workspaceLoad} onChange={(e) => setSetting("workspaceLoad", e.currentTarget.value)}>
              <option value="none">(none)</option>
              <option value="last">Last used tabs</option>
              <For each={names()}>{(n) => <option value={n}>{n}</option>}</For>
            </select>
          </label>
          <label>
            On exit, save as:{" "}
            <select value={settings.workspaceSave} onChange={(e) => setSetting("workspaceSave", e.currentTarget.value)}>
              <option value="none">(none)</option>
              <option value="last">Last used tabs</option>
              <For each={names()}>{(n) => <option value={n}>{n}</option>}</For>
            </select>
          </label>
        </div>
      </div>
      <div class="modal-actions">
        <button class="tb-btn" disabled={!sel()} onClick={rename}>Rename (F2)</button>
        <button class="tb-btn" disabled={!sel()} onClick={remove}>Delete (Del)</button>
        <span class="spacer" />
        <button class="tb-btn" disabled={!sel()} onClick={() => props.onLoad(sel())}>Load</button>
        <button class="tb-btn primary" onClick={props.onClose}>Close</button>
      </div>
    </Modal>
  );
}
