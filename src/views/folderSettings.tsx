/**
 * Folder Compare "Session Settings" dialog: tabs Specs, Comparison, Handling,
 * Name Filters, Other Filters and Misc, with a "Use for this view only /
 * Also update session defaults / Also update saved session" choice.
 */
import { open as openDialog } from "../host";
import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { fmtSize, type FolderOptions, type OtherFilter } from "../api";
import { Modal } from "../components/common";
import { PresetEditor } from "../components/OptionsDialog";
import { setSetting, settings } from "../settings";

export type SettingsTab = "specs" | "comparison" | "handling" | "names" | "other" | "misc";
export type ApplyScope = "view" | "defaults" | "saved";

/** Per-view settings that are not comparison options. */
export interface FolderViewSettings {
  expandOnLoad: boolean;
  expandDiffsOnly: boolean;
  /** Automatic refresh interval in seconds; 0 = off. */
  autoRefreshSecs: number;
  description: string;
}
export const defaultViewSettings = (): FolderViewSettings => ({ expandOnLoad: false, expandDiffsOnly: false, autoRefreshSecs: 0, description: "" });

const TABS: [SettingsTab, string][] = [
  ["specs", "Specs"],
  ["comparison", "Comparison"],
  ["handling", "Handling"],
  ["names", "Name Filters"],
  ["other", "Other Filters"],
  ["misc", "Misc"],
];

const split = (s: string | undefined) => (s ?? "").split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
const lines = (a: string[]) => a.join("\n");

/** Splits the exclude list into file masks and folder masks (folder masks end with "/" or "\"). */
export function splitExcludes(exclude: string) {
  const all = split(exclude);
  const isDir = (m: string) => /[\\/]$/.test(m);
  return { files: all.filter((m) => !isDir(m)), folders: all.filter(isDir).map((m) => m.replace(/[\\/]+$/, "")) };
}

/** Text of the toolbar Filters box: include masks followed by "-"-prefixed excludes. */
export function filterText(o: FolderOptions): string {
  const inc = split(o.include).filter((m) => m !== "*" && m !== "*.*");
  const exc = split(o.exclude).map((m) => `-${m}`);
  return [...inc, ...exc].join(";") || "*.*";
}

/** Parses the Filters box: "-" marks an exclude; masks ending in "\" or "/" are folders. */
export function parseFilterText(text: string): { include: string; exclude: string } {
  const inc: string[] = [];
  const exc: string[] = [];
  for (const m of split(text)) {
    if (m.startsWith("-")) exc.push(m.slice(1).replace(/\\$/, "/"));
    else inc.push(m);
  }
  return { include: inc.join(";") || "*", exclude: exc.join(";") };
}

export function describeFilter(f: OtherFilter): string {
  const verb = f.enabled === false ? "(off) " : "";
  if (f.kind === "date") {
    const when = f.date ? new Date(f.date).toLocaleDateString() : `${f.days ?? 0} days ago`;
    return `${verb}Exclude files modified ${f.newer ? "after" : "before"} ${when}`;
  }
  if (f.kind === "size") return `${verb}Exclude files ${f.larger ? "larger" : "smaller"} than ${fmtSize(f.size ?? 0)}`;
  return `${verb}Exclude files ${f.notContaining ? "not containing" : "containing"} “${f.text ?? ""}”${f.caseSensitive ? ", match case" : ""}${f.wholeWords ? ", whole words" : ""}${f.regex ? ", regex" : ""}`;
}

export default function FolderSettingsDialog(props: {
  tab?: SettingsTab;
  options: FolderOptions;
  view: FolderViewSettings;
  paths: [string, string];
  sessionName?: string;
  onApply: (r: { options: FolderOptions; view: FolderViewSettings; paths: [string, string]; scope: ApplyScope }) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = createSignal<SettingsTab>(props.tab ?? "names");
  const [o, setO] = createStore<FolderOptions>(JSON.parse(JSON.stringify(props.options)));
  const [v, setV] = createStore<FolderViewSettings>({ ...props.view });
  const [paths, setPaths] = createSignal<[string, string]>([...props.paths]);
  const [scope, setScope] = createSignal<ApplyScope>("view");

  // Comparison criteria as BC-style quick tests + contents comparison.
  const isContents = (c: FolderOptions["criteria"]) => c === "crc" || c === "binary" || c === "rules";
  const [timeOn, setTimeOn] = createSignal(props.options.criteria === "timesize");
  const [contentsOn, setContentsOn] = createSignal(isContents(props.options.criteria));
  const [contentsMode, setContentsMode] = createSignal<"crc" | "binary" | "rules">(isContents(props.options.criteria) ? (props.options.criteria as "crc") : "binary");

  // Name filters as four lists.
  const ex = splitExcludes(props.options.exclude);
  const [incFiles, setIncFiles] = createSignal(lines(split(props.options.include).filter((m) => m !== "*")));
  const [excFiles, setExcFiles] = createSignal(lines(ex.files));
  const [incFolders, setIncFolders] = createSignal(lines(split(props.options.includeFolders).filter((m) => m !== "*")));
  const [excFolders, setExcFolders] = createSignal(lines(ex.folders));
  const [presetName, setPresetName] = createSignal<string | null>(null);

  const [editFilter, setEditFilter] = createSignal<{ i: number; f: OtherFilter } | null>(null);
  const [selFilter, setSelFilter] = createSignal(-1);
  const [selAlign, setSelAlign] = createSignal(-1);

  function build(): FolderOptions {
    const out = JSON.parse(JSON.stringify(unwrap(o))) as FolderOptions;
    out.criteria = contentsOn() ? contentsMode() : timeOn() ? "timesize" : "size";
    out.include = split(incFiles()).join(";") || "*";
    out.includeFolders = split(incFolders()).join(";");
    out.exclude = [...split(excFiles()), ...split(excFolders()).map((m) => `${m.replace(/[\\/]+$/, "")}/`)].join(";");
    return out;
  }
  const apply = () => props.onApply({ options: build(), view: { ...unwrap(v) }, paths: paths(), scope: scope() });

  const nameMask = () => {
    const inc = split(incFiles());
    const parts = [...(inc.length ? inc : ["*.*"]), ...split(excFiles()).map((m) => `-${m}`), ...split(excFolders()).map((m) => `-${m}\\`)];
    return parts.join(";");
  };
  function loadPreset(mask: string) {
    const p = parseFilterText(mask);
    const e = splitExcludes(p.exclude);
    setIncFiles(lines(split(p.include).filter((m) => m !== "*")));
    setExcFiles(lines(e.files));
    setExcFolders(lines(e.folders));
  }

  const browse = async (i: 0 | 1) => {
    const d = await openDialog({ directory: true, defaultPath: paths()[i] || undefined });
    if (typeof d === "string") setPaths(i === 0 ? [d, paths()[1]] : [paths()[0], d]);
  };
  const na = (label: string, title = "Not supported yet") => (
    <label class="opt-check muted" title={title}>
      <input type="checkbox" disabled /> {label}
    </label>
  );
  const group = (title: string, children: JSX.Element) => (
    <fieldset class="opt-group">
      <legend>{title}</legend>
      {children}
    </fieldset>
  );

  return (
    <Modal title="Folder Compare - Session Settings" onClose={props.onClose} wide>
      <div class="settings-tabs">
        <For each={TABS}>
          {([id, label]) => (
            <button class="settings-tab" classList={{ active: tab() === id }} onClick={() => setTab(id)}>
              {label}
            </button>
          )}
        </For>
      </div>
      <div class="settings-page">
        <Switch>
          <Match when={tab() === "specs"}>
            {group("Folders",
              <>
                <div class="opt-row">
                  <span class="opt-label">Left folder:</span>
                  <input type="text" style={{ flex: 1 }} value={paths()[0]} onInput={(e) => setPaths([e.currentTarget.value, paths()[1]])} />
                  <button onClick={() => void browse(0)}>Browse…</button>
                </div>
                <div class="opt-row">
                  <span class="opt-label" />
                  <button title="Swap sides" onClick={() => setPaths([paths()[1], paths()[0]])}>⇅ Swap</button>
                  <button title="Copy left to right" onClick={() => setPaths([paths()[0], paths()[0]])}>↓ Copy</button>
                  <button title="Copy right to left" onClick={() => setPaths([paths()[1], paths()[1]])}>↑ Copy</button>
                </div>
                <div class="opt-row">
                  <span class="opt-label">Right folder:</span>
                  <input type="text" style={{ flex: 1 }} value={paths()[1]} onInput={(e) => setPaths([paths()[0], e.currentTarget.value])} />
                  <button onClick={() => void browse(1)}>Browse…</button>
                </div>
                <p class="muted small">A snapshot file (.ccsnap) can be used in place of a folder.</p>
              </>,
            )}
            {group("Description",
              <textarea class="opt-memo" rows={3} value={v.description} onInput={(e) => setV("description", e.currentTarget.value)} />,
            )}
          </Match>

          <Match when={tab() === "comparison"}>
            {group("Quick tests",
              <>
                <label class="opt-check"><input type="checkbox" checked disabled /> Compare file size</label>
                <div class="opt-row">
                  <label class="opt-check"><input type="checkbox" checked={timeOn()} onChange={(e) => setTimeOn(e.currentTarget.checked)} /> Compare timestamps</label>
                  <label class="opt-num">
                    tolerance{" "}
                    <input type="number" min={0} disabled={!timeOn()} value={o.timeToleranceSecs} onChange={(e) => setO("timeToleranceSecs", Math.max(0, +e.currentTarget.value || 0))} /> seconds
                  </label>
                </div>
                <label class="opt-check indent"><input type="checkbox" disabled={!timeOn()} checked={!!o.ignoreDst} onChange={(e) => setO("ignoreDst", e.currentTarget.checked)} /> Ignore daylight saving time differences</label>
                <label class="opt-check indent"><input type="checkbox" disabled={!timeOn()} checked={!!o.ignoreTz} onChange={(e) => setO("ignoreTz", e.currentTarget.checked)} /> Ignore timezone differences</label>
                <label class="opt-check"><input type="checkbox" checked={!o.ignoreCaseNames} onChange={(e) => setO("ignoreCaseNames", !e.currentTarget.checked)} /> Compare filename case</label>
                {na("Align filenames with different extensions")}
                {na("Compare attributes")}
              </>,
            )}
            {group("Requires opening files",
              <>
                <label class="opt-check"><input type="checkbox" checked={contentsOn()} onChange={(e) => setContentsOn(e.currentTarget.checked)} /> Compare contents</label>
                <label class="opt-check indent"><input type="radio" name="cm" disabled={!contentsOn()} checked={contentsMode() === "crc"} onChange={() => setContentsMode("crc")} /> CRC comparison</label>
                <label class="opt-check indent"><input type="radio" name="cm" disabled={!contentsOn()} checked={contentsMode() === "binary"} onChange={() => setContentsMode("binary")} /> Binary comparison</label>
                <label class="opt-check indent"><input type="radio" name="cm" disabled={!contentsOn()} checked={contentsMode() === "rules"} onChange={() => setContentsMode("rules")} /> Rules-based comparison</label>
                {na("Override quick test results")}
                {na("Compare versions")}
              </>,
            )}
          </Match>

          <Match when={tab() === "handling"}>
            {group("Folder handling",
              <>
                <label class="opt-check"><input type="checkbox" checked disabled /> Automatically scan subfolders</label>
                <label class="opt-check"><input type="checkbox" checked={v.expandOnLoad} onChange={(e) => setV("expandOnLoad", e.currentTarget.checked)} /> Expand subfolders when loading session</label>
                <label class="opt-check indent"><input type="checkbox" disabled={!v.expandOnLoad} checked={v.expandDiffsOnly} onChange={(e) => setV("expandDiffsOnly", e.currentTarget.checked)} /> Only expand subfolders with differences</label>
                <label class="opt-check"><input type="checkbox" checked={o.followSymlinks} onChange={(e) => setO("followSymlinks", e.currentTarget.checked)} /> Follow symbolic links</label>
              </>,
            )}
            {group("Archives",
              <label class="opt-row muted" title="Not supported yet">
                Handle archives:{" "}
                <select disabled>
                  <option>As files always</option>
                </select>
              </label>,
            )}
            {group("Refresh",
              <div class="opt-row">
                <label class="opt-check">
                  <input type="checkbox" checked={v.autoRefreshSecs > 0} onChange={(e) => setV("autoRefreshSecs", e.currentTarget.checked ? 60 : 0)} /> Automatic refresh every
                </label>
                <input type="number" min={5} style={{ width: "5em" }} disabled={!v.autoRefreshSecs} value={v.autoRefreshSecs || 60} onChange={(e) => setV("autoRefreshSecs", Math.max(5, +e.currentTarget.value || 60))} /> seconds
              </div>,
            )}
          </Match>

          <Match when={tab() === "names"}>
            <div class="names-grid">
              <label>
                Include files:
                <textarea class="opt-memo" rows={5} placeholder="*.*" value={incFiles()} onInput={(e) => setIncFiles(e.currentTarget.value)} />
              </label>
              <label>
                Exclude files:
                <textarea class="opt-memo" rows={5} value={excFiles()} onInput={(e) => setExcFiles(e.currentTarget.value)} />
              </label>
              <label>
                Include folders:
                <textarea class="opt-memo" rows={5} placeholder="*" value={incFolders()} onInput={(e) => setIncFolders(e.currentTarget.value)} />
              </label>
              <label>
                Exclude folders:
                <textarea class="opt-memo" rows={5} value={excFolders()} onInput={(e) => setExcFolders(e.currentTarget.value)} />
              </label>
            </div>
            <p class="muted small">One mask per line (or separated by “;”). Wildcards: * and ?. An exclude containing a path separator is anchored to the base folder, e.g. <code>/src/gen</code>.</p>
            <div class="opt-row">
              <button onClick={() => (setIncFiles(""), setExcFiles(""), setIncFolders(""), setExcFolders(""))}>Clear</button>
              <select
                value=""
                onChange={(e) => {
                  const p = settings.filterPresets.find((x) => x.name === e.currentTarget.value);
                  if (p) loadPreset(p.mask);
                  e.currentTarget.value = "";
                }}
              >
                <option value="">Load preset…</option>
                <For each={settings.filterPresets}>{(p) => <option value={p.name}>{p.name}</option>}</For>
              </select>
              <button onClick={() => setPresetName("")}>Add To Presets…</button>
            </div>
            <Show when={presetName() !== null}>
              {group("Add to presets",
                <div class="opt-row">
                  Name: <input type="text" value={presetName()!} onInput={(e) => setPresetName(e.currentTarget.value)} />
                  <code class="small">{nameMask()}</code>
                  <button
                    class="primary"
                    disabled={!presetName()!.trim()}
                    onClick={() => {
                      setSetting("filterPresets", [...settings.filterPresets.filter((p) => p.name !== presetName()!.trim()), { name: presetName()!.trim(), mask: nameMask() }]);
                      setPresetName(null);
                    }}
                  >
                    OK
                  </button>
                  <button onClick={() => setPresetName(null)}>Cancel</button>
                </div>,
              )}
            </Show>
          </Match>

          <Match when={tab() === "other"}>
            <div class="opt-list filters-list">
              <For each={o.otherFilters ?? []} fallback={<span class="muted">(no filters)</span>}>
                {(f, i) => (
                  <div class="opt-list-item" classList={{ sel: selFilter() === i() }} onClick={() => setSelFilter(i())} onDblClick={() => setEditFilter({ i: i(), f: { ...f } })}>
                    <input
                      type="checkbox"
                      checked={f.enabled !== false}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setO("otherFilters", i(), "enabled", e.currentTarget.checked)}
                    />{" "}
                    {describeFilter(f)}
                  </div>
                )}
              </For>
            </div>
            <div class="opt-row">
              <button onClick={() => setEditFilter({ i: -1, f: { kind: "date", enabled: true, newer: false, days: 30 } })}>New…</button>
              <button disabled={selFilter() < 0} onClick={() => (setO("otherFilters", (o.otherFilters ?? []).filter((_, j) => j !== selFilter())), setSelFilter(-1))}>Delete</button>
              <button disabled={selFilter() < 0} onClick={() => setEditFilter({ i: selFilter(), f: { ...(o.otherFilters ?? [])[selFilter()] } })}>Edit…</button>
              <button disabled={selFilter() < 0} onClick={() => setEditFilter({ i: -1, f: { ...(o.otherFilters ?? [])[selFilter()] } })}>Clone…</button>
            </div>
            <label class="opt-check">
              <input type="checkbox" checked={!!o.excludeHidden} onChange={(e) => setO("excludeHidden", e.currentTarget.checked)} /> Exclude protected operating system files (Recommended)
            </label>
            <Show when={editFilter()}>
              <OtherFilterEditor
                value={editFilter()!.f}
                onCancel={() => setEditFilter(null)}
                onSave={(f) => {
                  const list = [...(o.otherFilters ?? [])];
                  if (editFilter()!.i < 0) list.push(f);
                  else list[editFilter()!.i] = f;
                  setO("otherFilters", list);
                  setEditFilter(null);
                }}
              />
            </Show>
          </Match>

          <Match when={tab() === "misc"}>
            {group("Alignment overrides",
              <>
                <table class="opt-table">
                  <thead><tr><th>Folder</th><th>Left</th><th>Right</th></tr></thead>
                  <tbody>
                    <For each={o.align ?? []} fallback={<tr><td colSpan={3} class="muted">(none; use Align With… on two orphans)</td></tr>}>
                      {(a, i) => (
                        <tr classList={{ sel: selAlign() === i() }} onClick={() => setSelAlign(i())}>
                          <td>{a.parent || "(base)"}</td>
                          <td>{a.left}</td>
                          <td>{a.right}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
                <div class="opt-row">
                  <button disabled={selAlign() < 0} onClick={() => (setO("align", (o.align ?? []).filter((_, j) => j !== selAlign())), setSelAlign(-1))}>Delete</button>
                  <button disabled={!(o.align ?? []).length} onClick={() => setO("align", [])}>Delete All</button>
                </div>
              </>,
            )}
            {group("Name filter presets", <PresetEditor presets={settings.filterPresets} onChange={(p) => setSetting("filterPresets", p)} />)}
          </Match>
        </Switch>
      </div>
      <div class="modal-foot">
        <select value={scope()} onChange={(e) => setScope(e.currentTarget.value as ApplyScope)}>
          <option value="view">Use for this view only</option>
          <option value="defaults">Also update session defaults</option>
          <Show when={props.sessionName}>
            <option value="saved">Also update saved session</option>
          </Show>
        </select>
        <span class="spacer" />
        <button class="primary" onClick={() => (apply(), props.onClose())}>OK</button>
        <button onClick={props.onClose}>Cancel</button>
        <button onClick={apply}>Apply</button>
      </div>
    </Modal>
  );
}

const UNITS: [string, number][] = [["bytes", 1], ["KB", 1024], ["MB", 1024 ** 2], ["GB", 1024 ** 3]];

function OtherFilterEditor(props: { value: OtherFilter; onSave: (f: OtherFilter) => void; onCancel: () => void }) {
  const [f, setF] = createStore<OtherFilter>({ enabled: true, ...props.value });
  const initialUnit = () => {
    const s = props.value.size ?? 0;
    for (let i = UNITS.length - 1; i > 0; i--) if (s && s % UNITS[i][1] === 0) return i;
    return 1;
  };
  const [unit, setUnit] = createSignal(initialUnit());
  const [sizeVal, setSizeVal] = createSignal(props.value.size ? (props.value.size ?? 0) / UNITS[initialUnit()][1] : 100);
  const [useDate, setUseDate] = createSignal(!!props.value.date);
  const dateStr = () => (f.date ? new Date(f.date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));
  const save = () => {
    const out: OtherFilter = { kind: f.kind, enabled: f.enabled !== false };
    if (f.kind === "date") Object.assign(out, { newer: !!f.newer, ...(useDate() ? { date: f.date ?? Date.now(), days: null } : { days: f.days ?? 30, date: null }) });
    if (f.kind === "size") Object.assign(out, { larger: !!f.larger, size: Math.round(sizeVal() * UNITS[unit()][1]) });
    if (f.kind === "content") Object.assign(out, { notContaining: !!f.notContaining, text: f.text ?? "", caseSensitive: !!f.caseSensitive, wholeWords: !!f.wholeWords, regex: !!f.regex });
    props.onSave(out);
  };
  return (
    <fieldset class="opt-group">
      <legend>Other Filter</legend>
      <div class="opt-row">
        <label class="opt-check"><input type="radio" name="ofk" checked={f.kind === "date"} onChange={() => setF("kind", "date")} /> Date modified</label>
        <label class="opt-check"><input type="radio" name="ofk" checked={f.kind === "size"} onChange={() => setF("kind", "size")} /> Size</label>
        <label class="opt-check"><input type="radio" name="ofk" checked={f.kind === "content"} onChange={() => setF("kind", "content")} /> Content</label>
        <label class="opt-check muted" title="Not supported yet"><input type="radio" disabled /> Attributes</label>
      </div>
      <Switch>
        <Match when={f.kind === "date"}>
          <div class="opt-row">
            Exclude files{" "}
            <select value={f.newer ? "newer" : "older"} onChange={(e) => setF("newer", e.currentTarget.value === "newer")}>
              <option value="older">older than</option>
              <option value="newer">newer than</option>
            </select>
            <label class="opt-check"><input type="radio" name="ofd" checked={!useDate()} onChange={() => setUseDate(false)} /></label>
            <input type="number" min={0} style={{ width: "5em" }} disabled={useDate()} value={f.days ?? 30} onChange={(e) => setF("days", Math.max(0, +e.currentTarget.value || 0))} /> days ago
            <label class="opt-check"><input type="radio" name="ofd" checked={useDate()} onChange={() => setUseDate(true)} /></label>
            <input type="date" disabled={!useDate()} value={dateStr()} onChange={(e) => setF("date", e.currentTarget.valueAsNumber || Date.now())} />
          </div>
        </Match>
        <Match when={f.kind === "size"}>
          <div class="opt-row">
            Exclude files{" "}
            <select value={f.larger ? "larger" : "smaller"} onChange={(e) => setF("larger", e.currentTarget.value === "larger")}>
              <option value="smaller">smaller than</option>
              <option value="larger">larger than</option>
            </select>
            <input type="number" min={0} style={{ width: "7em" }} value={sizeVal()} onChange={(e) => setSizeVal(Math.max(0, +e.currentTarget.value || 0))} />
            <select value={unit()} onChange={(e) => setUnit(+e.currentTarget.value)}>
              <For each={UNITS}>{([u], i) => <option value={i()}>{u}</option>}</For>
            </select>
          </div>
        </Match>
        <Match when={f.kind === "content"}>
          <div class="opt-row">
            Exclude files{" "}
            <select value={f.notContaining ? "not" : "yes"} onChange={(e) => setF("notContaining", e.currentTarget.value === "not")}>
              <option value="yes">containing</option>
              <option value="not">not containing</option>
            </select>
            <input type="text" style={{ flex: 1 }} value={f.text ?? ""} onInput={(e) => setF("text", e.currentTarget.value)} />
          </div>
          <div class="opt-row">
            <label class="opt-check"><input type="checkbox" checked={!!f.caseSensitive} onChange={(e) => setF("caseSensitive", e.currentTarget.checked)} /> Match case</label>
            <label class="opt-check"><input type="checkbox" checked={!!f.wholeWords} onChange={(e) => setF("wholeWords", e.currentTarget.checked)} /> Whole words</label>
            <label class="opt-check"><input type="checkbox" checked={!!f.regex} onChange={(e) => setF("regex", e.currentTarget.checked)} /> Regular expression</label>
          </div>
        </Match>
      </Switch>
      <div class="opt-row">
        <button class="primary" disabled={f.kind === "content" && !(f.text ?? "").trim()} onClick={save}>OK</button>
        <button onClick={props.onCancel}>Cancel</button>
      </div>
    </fieldset>
  );
}
