import { createMemo, createSignal, For, Show } from "solid-js";
import { errText } from "../api";
import {
  BUILTIN_PRESETS, METHOD_LABELS, presetLibraryError, resolvePresetState,
  type ComparisonPreset, type ComparisonPresetState, type ComparisonScope, type ContentMode,
} from "../comparisonPresets";
import { Modal } from "./common";

export default function ComparisonPresetsDialog(props: {
  library: readonly ComparisonPreset[];
  state: ComparisonPresetState;
  onClose: () => void;
  onSave: (library: ComparisonPreset[], state: ComparisonPresetState, useDefaults: boolean) => Promise<void>;
}) {
  const [library, setLibrary] = createSignal(props.library.map((p) => ({ ...p })));
  const [pins, setPins] = createSignal([...props.state.pinnedPresetIds]);
  const [selected, setSelected] = createSignal(props.state.activePresetId);
  const [useDefaults, setUseDefaults] = createSignal(false);
  const [deleting, setDeleting] = createSignal<string>();
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const presets = createMemo(() => [...BUILTIN_PRESETS, ...library()]);
  const current = () => presets().find((p) => p.id === selected())!;
  const builtin = () => selected().startsWith("builtin:");
  const validation = () => presetLibraryError(library());
  const edit = (patch: Partial<Pick<ComparisonPreset, "name" | "method" | "scope">>) =>
    setLibrary((items) => items.map((p) => p.id === selected() ? { ...p, ...patch } : p));
  const add = (duplicate: boolean) => {
    const source = current();
    const base = duplicate ? `${source.name} copy` : "New preset";
    let name = base;
    let n = 2;
    while (presets().some((p) => p.name.toLowerCase() === name.toLowerCase())) name = `${base} ${n++}`;
    const p: ComparisonPreset = {
      id: crypto.randomUUID(), name, method: duplicate ? source.method : "rules", scope: duplicate ? source.scope : "all",
    };
    setLibrary((items) => [...items, p]);
    setSelected(p.id);
    setDeleting(undefined);
  };
  const save = async () => {
    if (saving() || validation()) return;
    setSaving(true);
    setError("");
    try {
      const state = resolvePresetState({ ...props.state, pinnedPresetIds: pins() }, presets()).state;
      await props.onSave(library().map((p) => ({ ...p, name: p.name.trim() })), state, useDefaults());
    } catch (e) {
      setError(errText(e));
      setSaving(false);
    }
  };
  return (
    <Modal title="Comparison Presets" onClose={() => !saving() && props.onClose()} wide>
      <p class="muted">Presets are shared across the application. The active choice and pins belong to this folder session.</p>
      <fieldset class="preset-editor" disabled={saving()}>
        <legend class="sr-only">Edit comparison presets</legend>
        <div class="preset-editor-list" role="group" aria-label="Comparison presets">
          <For each={presets()}>{(p) => (
            <button type="button" classList={{ active: selected() === p.id }} aria-pressed={selected() === p.id}
              onClick={() => { setSelected(p.id); setDeleting(undefined); }}>
              <span>{p.name}</span><small>{p.scope === "all" ? "All included" : "Selected"} / {METHOD_LABELS[p.method]}{p.id.startsWith("builtin:") ? " (built-in)" : ""}</small>
            </button>
          )}</For>
        </div>
        <div class="preset-editor-fields">
          <label>Name<input value={current().name} readOnly={builtin()} onInput={(e) => edit({ name: e.currentTarget.value })} /></label>
          <label>Method<select value={current().method} disabled={builtin()} onChange={(e) => edit({ method: e.currentTarget.value as ContentMode })}>
            <For each={Object.entries(METHOD_LABELS)}>{([value, label]) => <option value={value}>{label}</option>}</For>
          </select></label>
          <label>Scope<select value={current().scope} disabled={builtin()} onChange={(e) => edit({ scope: e.currentTarget.value as ComparisonScope })}>
            <option value="all">All included files</option><option value="selected">Selected items</option>
          </select></label>
          <label class="opt-check"><input type="checkbox" checked={pins().includes(selected())} onChange={(e) =>
            setPins((ids) => e.currentTarget.checked ? [...ids, selected()] : ids.filter((id) => id !== selected()))} />Pin in this folder session</label>
          <p class="muted">All included respects configured session filters, even during Peek or Suppress Filters. Rules-based uses the existing comparison engine; custom rules and filters are not saved in presets.</p>
          <div class="opt-row">
            <button onClick={() => add(false)}>New</button>
            <button onClick={() => add(true)}>Duplicate</button>
            <button disabled={builtin()} onClick={() => setDeleting(selected())}>Delete</button>
          </div>
          <Show when={deleting()}>
            <div class="preset-delete" role="alert">
              <p>Delete this shared preset? Other sessions using it will need a different choice.</p>
              <button onClick={() => {
                const id = deleting();
                setSelected(BUILTIN_PRESETS[2].id);
                setLibrary((items) => items.filter((p) => p.id !== id));
                setPins((ids) => ids.filter((p) => p !== id));
                setDeleting(undefined);
              }}>Delete preset</button>
              <button onClick={() => setDeleting(undefined)}>Keep preset</button>
            </div>
          </Show>
        </div>
      </fieldset>
      <label class="opt-check"><input type="checkbox" checked={useDefaults()} disabled={saving()} onChange={(e) => setUseDefaults(e.currentTarget.checked)} />
        Use the current comparison choice and these pins as defaults for new folder sessions
      </label>
      <Show when={validation() || error()}><p class="err-text" role="alert">{error() || validation()}</p></Show>
      <div class="modal-actions">
        <button disabled={saving()} onClick={props.onClose}>Cancel</button>
        <button class="primary" disabled={saving() || !!validation()} onClick={() => void save()}>{saving() ? "Saving..." : "Save"}</button>
      </div>
    </Modal>
  );
}
