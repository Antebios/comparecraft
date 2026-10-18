import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { createResource, createSignal, For, Show } from "solid-js";
import { api, errText, type FolderOptions, type Session } from "../api";
import { DEFAULT_SETTINGS, replaceSettings, settings, snapshotSettings, type Settings } from "../settings";
import { setSessionsVersion } from "../store";
import { Modal } from "./common";

/** Groups of settings that can be exported/imported separately. */
const SETTING_GROUPS: { id: string; label: string; keys: (keyof Settings)[] }[] = [
  { id: "options", label: "Program options", keys: Object.keys(DEFAULT_SETTINGS).filter((k) => !["keymap", "colors", "theme", "filterPresets", "openWith", "lastWorkspace"].includes(k)) as (keyof Settings)[] },
  { id: "colors", label: "Colors and theme", keys: ["theme", "colors", "uiFontSize", "editorFont", "editorFontSize"] },
  { id: "keymap", label: "Keyboard shortcuts", keys: ["keymap"] },
  { id: "presets", label: "Name filter presets", keys: ["filterPresets"] },
  { id: "openwith", label: "Open With applications", keys: ["openWith"] },
];

function pick(s: Settings, groups: string[]): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const g of SETTING_GROUPS) if (groups.includes(g.id)) for (const k of g.keys) (out as Record<string, unknown>)[k] = s[k];
  return out;
}

function GroupChecks(props: { value: string[]; onChange: (v: string[]) => void; available?: (id: string) => boolean }) {
  return (
    <For each={SETTING_GROUPS}>
      {(g) => (
        <label class="opt-check">
          <input
            type="checkbox"
            disabled={props.available ? !props.available(g.id) : false}
            checked={props.value.includes(g.id)}
            onChange={(e) => props.onChange(e.currentTarget.checked ? [...props.value, g.id] : props.value.filter((x) => x !== g.id))}
          />{" "}
          {g.label}
        </label>
      )}
    </For>
  );
}

export function ExportDialog(props: { onClose: () => void; onDone: (msg: string) => void }) {
  const [groups, setGroups] = createSignal(SETTING_GROUPS.map((g) => g.id));
  const [withSessions, setWithSessions] = createSignal(true);
  const [sessions] = createResource(() => api.listSessions().then((l) => l.filter((s) => s.saved)));
  const [chosen, setChosen] = createSignal<Set<string> | null>(null);
  const sel = () => chosen() ?? new Set((sessions() ?? []).map((s) => s.id));
  const [err, setErr] = createSignal("");
  async function run() {
    const path = await saveDialog({ defaultPath: "comparecraft-settings.json", filters: [{ name: "CompareCraft settings", extensions: ["json"] }] });
    if (!path) return;
    try {
      await api.exportSettings(path, groups().length ? pick(snapshotSettings(), groups()) : null, withSessions() ? [...sel()] : []);
      props.onDone(`Settings exported to ${path}`);
      props.onClose();
    } catch (e) {
      setErr(errText(e));
    }
  }
  return (
    <Modal title="Export Settings" onClose={props.onClose}>
      <p>What settings do you want to export?</p>
      <GroupChecks value={groups()} onChange={setGroups} />
      <label class="opt-check"><input type="checkbox" checked={withSessions()} onChange={(e) => setWithSessions(e.currentTarget.checked)} /> Saved sessions</label>
      <Show when={withSessions()}>
        <div class="opt-list">
          <For each={sessions() ?? []} fallback={<span class="muted">(no saved sessions)</span>}>
            {(s) => (
              <label class="opt-check indent">
                <input
                  type="checkbox"
                  checked={sel().has(s.id)}
                  onChange={(e) => {
                    const n = new Set(sel());
                    if (e.currentTarget.checked) n.add(s.id);
                    else n.delete(s.id);
                    setChosen(n);
                  }}
                />{" "}
                {s.name}
              </label>
            )}
          </For>
        </div>
      </Show>
      <p class="err">{err()}</p>
      <div class="modal-foot">
        <span class="spacer" />
        <button class="primary" disabled={!groups().length && !withSessions()} onClick={() => void run()}>Export…</button>
        <button onClick={props.onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

export function ImportDialog(props: { onClose: () => void; onDone: (msg: string) => void }) {
  const [file, setFile] = createSignal("");
  const [data, setData] = createSignal<{ settings: Record<string, unknown> | null; sessions: Session[] } | null>(null);
  const [groups, setGroups] = createSignal<string[]>([]);
  const [importSessions, setImportSessions] = createSignal(true);
  const [replace, setReplace] = createSignal(false);
  const [err, setErr] = createSignal("");
  const has = (id: string) => {
    const s = data()?.settings;
    return !!s && SETTING_GROUPS.find((g) => g.id === id)!.keys.some((k) => k in s);
  };
  async function choose() {
    const p = await openDialog({ filters: [{ name: "CompareCraft settings", extensions: ["json"] }] });
    if (typeof p !== "string") return;
    setErr("");
    try {
      const d = await api.readSettingsFile(p);
      setFile(p);
      setData(d);
      setGroups(SETTING_GROUPS.map((g) => g.id).filter(has));
    } catch (e) {
      setErr(errText(e));
    }
  }
  async function run() {
    const d = data();
    if (!d) return;
    try {
      if (d.settings && groups().length) {
        const cur = snapshotSettings();
        const inc = d.settings as Partial<Settings>;
        for (const g of SETTING_GROUPS)
          if (groups().includes(g.id)) for (const k of g.keys) if (k in inc) (cur as unknown as Record<string, unknown>)[k] = inc[k];
        replaceSettings(cur);
      }
      if (importSessions() && d.sessions.length) {
        await api.importSessions(d.sessions, replace());
        setSessionsVersion((v) => v + 1);
      }
      props.onDone(`Imported settings from ${file()}`);
      props.onClose();
    } catch (e) {
      setErr(errText(e));
    }
  }
  return (
    <Modal title="Import Settings" onClose={props.onClose}>
      <div class="opt-row">
        <input type="text" readOnly value={file()} placeholder="Settings file to import" style={{ flex: 1 }} />
        <button onClick={() => void choose()}>Browse…</button>
      </div>
      <Show when={data()}>
        <p>Which settings do you want to import?</p>
        <GroupChecks value={groups()} onChange={setGroups} available={has} />
        <label class="opt-check">
          <input type="checkbox" checked={importSessions()} disabled={!data()!.sessions.length} onChange={(e) => setImportSessions(e.currentTarget.checked)} /> Saved sessions ({data()!.sessions.length})
        </label>
        <label class="opt-check indent">
          <input type="checkbox" checked={replace()} disabled={!importSessions() || !data()!.sessions.length} onChange={(e) => setReplace(e.currentTarget.checked)} /> Delete all existing sessions
        </label>
      </Show>
      <p class="err">{err()}</p>
      <div class="modal-foot">
        <span class="spacer" />
        <button class="primary" disabled={!data() || (!groups().length && !importSessions())} onClick={() => void run()}>Import</button>
        <button onClick={props.onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

export async function restoreFactoryDefaults(): Promise<boolean> {
  if (!(await ask("Restore all options, colors, shortcuts and presets to their factory defaults? Saved sessions are kept.", { title: "Restore Factory Defaults", kind: "warning" })))
    return false;
  await api.resetSettings().catch(() => undefined);
  replaceSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  return true;
}

/** Saves a folder's listing (names, sizes, times and optional CRCs) as a snapshot file that can be compared later. */
export function SnapshotDialog(props: { left?: string; right?: string; options?: FolderOptions; onClose: () => void; onDone: (msg: string) => void }) {
  const [which, setWhich] = createSignal<"left" | "right" | "other">(props.left ? "left" : props.right ? "right" : "other");
  const [other, setOther] = createSignal("");
  const [out, setOut] = createSignal("");
  const [crc, setCrc] = createSignal(false);
  const [empty, setEmpty] = createSignal(true);
  const [filtered, setFiltered] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal("");
  const dir = () => (which() === "left" ? props.left : which() === "right" ? props.right : other()) ?? "";
  async function run() {
    let path = out();
    if (!path) {
      const p = await saveDialog({ defaultPath: "snapshot.ccsnap", filters: [{ name: "CompareCraft snapshot", extensions: ["ccsnap"] }] });
      if (!p) return;
      path = p;
    }
    setBusy(true);
    setErr("");
    try {
      const n = await api.saveSnapshot(dir(), path, crc(), empty(), filtered() ? null : props.options ?? null);
      props.onDone(`Snapshot of ${dir()} saved to ${path} (${n} items)`);
      props.onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Save Snapshot" onClose={props.onClose}>
      <fieldset class="opt-group">
        <legend>Folder</legend>
        <label class="opt-check"><input type="radio" name="snap" disabled={!props.left} checked={which() === "left"} onChange={() => setWhich("left")} /> Left base folder <span class="muted">{props.left}</span></label>
        <label class="opt-check"><input type="radio" name="snap" disabled={!props.right} checked={which() === "right"} onChange={() => setWhich("right")} /> Right base folder <span class="muted">{props.right}</span></label>
        <label class="opt-check"><input type="radio" name="snap" checked={which() === "other"} onChange={() => setWhich("other")} /> Other:</label>
        <div class="opt-row indent">
          <input type="text" value={other()} disabled={which() !== "other"} onInput={(e) => setOther(e.currentTarget.value)} style={{ flex: 1 }} />
          <button disabled={which() !== "other"} onClick={async () => { const d = await openDialog({ directory: true }); if (typeof d === "string") setOther(d); }}>Browse…</button>
        </div>
      </fieldset>
      <fieldset class="opt-group">
        <legend>Snapshot file</legend>
        <div class="opt-row">
          <input type="text" value={out()} placeholder="(choose when saving)" onInput={(e) => setOut(e.currentTarget.value)} style={{ flex: 1 }} />
          <button onClick={async () => { const p = await saveDialog({ defaultPath: "snapshot.ccsnap", filters: [{ name: "CompareCraft snapshot", extensions: ["ccsnap"] }] }); if (p) setOut(p); }}>Browse…</button>
        </div>
      </fieldset>
      <fieldset class="opt-group">
        <legend>Include</legend>
        <label class="opt-check"><input type="checkbox" checked={crc()} onChange={(e) => setCrc(e.currentTarget.checked)} /> CRCs (allows content comparison against the snapshot)</label>
        <label class="opt-check"><input type="checkbox" checked={empty()} onChange={(e) => setEmpty(e.currentTarget.checked)} /> Empty folders</label>
        <label class="opt-check"><input type="checkbox" checked={filtered()} disabled={!props.options} onChange={(e) => setFiltered(e.currentTarget.checked)} /> Items excluded by file filters</label>
      </fieldset>
      <p class="muted small">Open a snapshot by entering its path as one side of a folder comparison.</p>
      <p class="err">{err()}</p>
      <div class="modal-foot">
        <span class="spacer" />
        <button class="primary" disabled={!dir() || busy()} onClick={() => void run()}>{busy() ? "Saving…" : "Save"}</button>
        <button onClick={props.onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

const FORMATS: [string, string, string][] = [
  ["Picture", "*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp;*.ico;*.svg;*.avif;*.tif;*.tiff;*.tga;*.pnm;*.pbm;*.pgm;*.ppm;*.qoi", "Picture Compare"],
  ["Table", "*.csv;*.tsv;*.tab", "Table Compare"],
  ["Binary", "(content contains NUL or control bytes)", "Hex Compare"],
  ["Text", "* (everything else)", "Text Compare"],
];

export function FileFormatsDialog(props: { onClose: () => void }) {
  return (
    <Modal title="File Formats" onClose={props.onClose} wide>
      <p class="muted">File formats decide which view opens a file and are checked in this order.</p>
      <table class="opt-table">
        <thead><tr><th>Format</th><th>Masks</th><th>View</th></tr></thead>
        <tbody>
          <For each={FORMATS}>{([n, m, v]) => <tr><td>{n}</td><td><code>{m}</code></td><td>{v}</td></tr>}</For>
        </tbody>
      </table>
      <p class="muted small">Text comparison rules (whitespace, case, regular-expression grammar) are set per view with Session › Session Settings or the Rules button.</p>
      <div class="modal-foot"><span class="spacer" /><button onClick={props.onClose}>Close</button></div>
    </Modal>
  );
}

/** Named snapshots of all options that can be switched between. */
export function ProfilesDialog(props: { onClose: () => void; onDone: (msg: string) => void }) {
  const KEY = "comparecraft.profiles";
  const load = (): Record<string, Settings> => {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? "{}");
    } catch {
      return {};
    }
  };
  const [profiles, setProfiles] = createSignal(load());
  const [sel, setSel] = createSignal("");
  const [name, setName] = createSignal("");
  const store = (p: Record<string, Settings>) => {
    localStorage.setItem(KEY, JSON.stringify(p));
    setProfiles(p);
  };
  return (
    <Modal title="Profiles" onClose={props.onClose}>
      <p class="muted">A profile stores every program option, color and shortcut. Switching profiles replaces the current options.</p>
      <div class="opt-list">
        <For each={Object.keys(profiles())} fallback={<span class="muted">(no profiles)</span>}>
          {(n) => (
            <label class="opt-check">
              <input type="radio" name="prof" checked={sel() === n} onChange={() => setSel(n)} /> {n}
            </label>
          )}
        </For>
      </div>
      <div class="opt-row">
        <input type="text" placeholder="New profile name" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        <button disabled={!name().trim()} onClick={() => (store({ ...profiles(), [name().trim()]: { ...snapshotSettings(), lastWorkspace: [] } }), setSel(name().trim()), setName(""))}>
          Save Current As
        </button>
      </div>
      <div class="modal-foot">
        <button disabled={!sel()} onClick={() => { const p = { ...profiles() }; delete p[sel()]; store(p); setSel(""); }}>Delete</button>
        <span class="spacer" />
        <button
          class="primary"
          disabled={!sel()}
          onClick={() => {
            replaceSettings({ ...profiles()[sel()], lastWorkspace: settings.lastWorkspace });
            props.onDone(`Profile “${sel()}” loaded`);
            props.onClose();
          }}
        >
          Use Profile
        </button>
        <button onClick={props.onClose}>Close</button>
      </div>
    </Modal>
  );
}
