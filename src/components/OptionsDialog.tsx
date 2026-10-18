import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { createMemo, createResource, createSignal, For, type JSX, Match, onMount, Show, Switch } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { api, errText, type ShellItem } from "../api";
import { allCommands, chordOf, displayKeys, labelOf } from "../commands";
import { COLOR_VARS, DEFAULT_SETTINGS, replaceSettings, snapshotSettings, type BackupKind, type Settings } from "../settings";
import { trapFocus } from "./common";

export type OptionsPage =
  | "startup" | "tabs" | "colors" | "text" | "nextdiff" | "backups" | "fileops" | "archives" | "shortcuts" | "openwith" | "tweaks";

const PAGES: { id: OptionsPage; label: string; keywords: string }[] = [
  { id: "startup", label: "Startup", keywords: "workspace quick compare file manager integration nautilus dolphin explorer context menu" },
  { id: "tabs", label: "Tabs", keywords: "tab window close warn hide single" },
  { id: "colors", label: "Colors, Fonts", keywords: "theme dark light color font stripes background text size" },
  { id: "text", label: "Text Editing", keywords: "context lines tab size find word indent" },
  { id: "nextdiff", label: "Next Difference", keywords: "next difference first load copy wrap message" },
  { id: "backups", label: "Backups", keywords: "backup bak tilde save copy folder" },
  { id: "fileops", label: "File Operations", keywords: "confirm copy move delete overwrite newer recycle trash" },
  { id: "archives", label: "Archive Types", keywords: "zip tar archive plugin" },
  { id: "shortcuts", label: "Toolbars, Shortcuts", keywords: "keyboard shortcut toolbar command key binding" },
  { id: "openwith", label: "Open With", keywords: "open with application program editor command" },
  { id: "tweaks", label: "Tweaks", keywords: "hints escape esc column line spacing log messages most recently used mru name filter presets" },
];

const BACKUP_KINDS: [BackupKind, string][] = [
  ["nameTildeExt", "name~.ext"],
  ["nameExtTilde", "name.ext~"],
  ["nameExtBak", "name.ext.bak"],
  ["tildeNameExt", "~name.ext"],
  ["nameBak", "name.bak"],
  ["nameBakExt", "name.bak.ext"],
];

const SHELL_LABELS: Record<ShellItem["id"], string> = {
  compare: "Compare (two selected items)",
  sync: "Sync folders",
  merge: "Merge (three selected files)",
  edit: "Edit text file",
};

export default function OptionsDialog(props: { page?: OptionsPage; onClose: () => void }) {
  const [draft, setDraft] = createStore<Settings>(snapshotSettings());
  const [page, setPage] = createSignal<OptionsPage>(props.page ?? "startup");
  const [search, setSearch] = createSignal("");
  const [error, setError] = createSignal("");

  const pages = createMemo(() => {
    const q = search().trim().toLowerCase();
    if (!q) return PAGES;
    return PAGES.filter((p) => `${p.label} ${p.keywords}`.toLowerCase().includes(q));
  });

  // File manager integration is applied immediately on Apply, separately from settings.json.
  const [shell, { mutate: setShell }] = createResource(() => api.shellIntegrationStatus().catch(() => ({ supported: false, items: [] as ShellItem[] })));
  let shellDirty = false;

  async function apply() {
    setError("");
    replaceSettings(JSON.parse(JSON.stringify(unwrap(draft))));
    if (shellDirty && shell()) {
      try {
        await api.setShellIntegration(shell()!.items);
        shellDirty = false;
      } catch (e) {
        setError(`File manager integration: ${errText(e)}`);
        return false;
      }
    }
    return true;
  }

  const set = <K extends keyof Settings>(k: K) => (v: Settings[K]) => setDraft(k as never, v as never);
  const check = (k: keyof Settings, label: string, extra?: { disabled?: boolean; title?: string }) => (
    <label class="opt-check" title={extra?.title}>
      <input type="checkbox" checked={!!draft[k]} disabled={extra?.disabled} onChange={(e) => setDraft(k as never, e.currentTarget.checked as never)} /> {label}
    </label>
  );
  const num = (k: keyof Settings, label: string, min: number, max: number, suffix = "") => (
    <label class="opt-num">
      {label}{" "}
      <input type="number" min={min} max={max} value={draft[k] as number} onChange={(e) => setDraft(k as never, Math.max(min, Math.min(max, Number(e.currentTarget.value) || 0)) as never)} /> {suffix}
    </label>
  );
  const group = (title: string, children: JSX.Element) => (
    <fieldset class="opt-group">
      <legend>{title}</legend>
      {children}
    </fieldset>
  );

  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()} onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
      <div class="modal options-dialog" role="dialog" aria-label="Options" tabIndex={-1} ref={(el) => onMount(() => trapFocus(el))}>
        <div class="modal-head">
          <span>Options</span>
          <button class="icon-btn" onClick={props.onClose}>✕</button>
        </div>
        <div class="options-body">
          <div class="options-nav">
            <input class="options-search" placeholder="Search options" value={search()} onInput={(e) => setSearch(e.currentTarget.value)} />
            <For each={pages()}>
              {(p) => (
                <button class="options-cat" classList={{ active: page() === p.id }} onClick={() => setPage(p.id)}>
                  {p.label}
                </button>
              )}
            </For>
          </div>
          <div class="options-page">
            <h3>{PAGES.find((p) => p.id === page())?.label}</h3>
            <Switch>
              <Match when={page() === "startup"}>
                {group("Workspace",
                  <>
                    <label class="opt-row">
                      When starting, load workspace:{" "}
                      <select value={draft.workspaceLoad} onChange={(e) => set("workspaceLoad")(e.currentTarget.value as "none")}>
                        <option value="none">(none)</option>
                        <option value="last">Last used tabs</option>
                      </select>
                    </label>
                    <label class="opt-row">
                      On exit, save workspace as:{" "}
                      <select value={draft.workspaceSave} onChange={(e) => set("workspaceSave")(e.currentTarget.value as "none")}>
                        <option value="none">(none)</option>
                        <option value="last">Last used tabs</option>
                      </select>
                    </label>
                  </>,
                )}
                {group("Quick compare (Home view)",
                  <>
                    {check("quickCompareShow", "Show quick compare results for two files before opening a view")}
                    <label class="opt-check indent"><input type="radio" name="qc" checked={!draft.quickCompareRules} disabled={!draft.quickCompareShow} onChange={() => set("quickCompareRules")(false)} /> Binary comparison</label>
                    <label class="opt-check indent"><input type="radio" name="qc" checked={draft.quickCompareRules} disabled={!draft.quickCompareShow} onChange={() => set("quickCompareRules")(true)} /> Rules-based comparison</label>
                    {check("quickCompareOpenIfDiff", "Open view automatically if files are different", { disabled: !draft.quickCompareShow })}
                  </>,
                )}
                {group("File manager integration",
                  <Show when={shell()?.supported} fallback={<p class="muted">Not available on this platform. Use “Open With → CompareCraft” from your file manager.</p>}>
                    <p class="muted">Adds CompareCraft commands to the Nautilus (Files) scripts menu and the Dolphin context menu.</p>
                    <For each={shell()!.items}>
                      {(it, i) => (
                        <label class="opt-check">
                          <input
                            type="checkbox"
                            checked={it.enabled}
                            onChange={(e) => {
                              shellDirty = true;
                              const items = shell()!.items.map((x, j) => (j === i() ? { ...x, enabled: e.currentTarget.checked } : x));
                              setShell({ supported: true, items });
                            }}
                          />{" "}
                          {SHELL_LABELS[it.id] ?? it.id}
                        </label>
                      )}
                    </For>
                  </Show>,
                )}
              </Match>

              <Match when={page() === "tabs"}>
                {group("Tabs",
                  <>
                    {check("tabNewNext", "Open new tab next to active tab")}
                    {check("tabSingleCloseWindow", "Closing last tab closes the window")}
                    {check("tabsConfirmClose", "Warn when closing a tab with unsaved changes")}
                    {check("tabSingleHide", "Hide tab bar when no comparison tabs are open")}
                  </>,
                )}
              </Match>

              <Match when={page() === "colors"}>
                {group("Theme",
                  <label class="opt-row">
                    Theme:{" "}
                    <select value={draft.theme} onChange={(e) => set("theme")(e.currentTarget.value as "auto")}>
                      <option value="auto">Follow system</option>
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </select>
                  </label>,
                )}
                {group("Colors",
                  <div class="opt-colors">
                    <For each={COLOR_VARS}>
                      {([v, label]) => (
                        <label class="opt-color">
                          <input
                            type="color"
                            value={draft.colors[v] || getComputedStyle(document.documentElement).getPropertyValue(v).trim() || "#000000"}
                            onInput={(e) => setDraft("colors", { ...draft.colors, [v]: e.currentTarget.value })}
                          />
                          <span classList={{ muted: !draft.colors[v] }}>{label}</span>
                          <Show when={draft.colors[v]}>
                            <button class="link-btn" onClick={() => { const c = { ...draft.colors }; delete c[v]; setDraft("colors", c); }}>Default</button>
                          </Show>
                        </label>
                      )}
                    </For>
                  </div>,
                )}
                {group("Folder views",
                  <>
                    {check("folderStripes", "Alternate row background (stripes)")}
                    {check("folderColorFolders", "Color folders to reflect content")}
                  </>,
                )}
                {group("Fonts",
                  <>
                    {num("uiFontSize", "Interface font size:", 9, 24, "px")}
                    <label class="opt-row">
                      Editor font:{" "}
                      <input type="text" placeholder="(default monospace)" value={draft.editorFont} onChange={(e) => set("editorFont")(e.currentTarget.value)} />
                    </label>
                    {num("editorFontSize", "Editor font size:", 8, 28, "px")}
                  </>,
                )}
              </Match>

              <Match when={page() === "text"}>
                {group("Text views",
                  <>
                    {num("contextLines", "Context lines (Show Context):", 0, 50)}
                    {num("tabSize", "Tab size:", 1, 16)}
                    {check("findCurrentWord", "Initialize Find to current word")}
                  </>,
                )}
              </Match>

              <Match when={page() === "nextdiff"}>
                {group("Next Difference",
                  <>
                    {check("nextDiffLoadFirst", "Go to first difference when loading")}
                    {check("nextDiffAfterCopy", "Go to next difference after copy")}
                  </>,
                )}
                {group("When there are no more differences",
                  <>
                    {check("nextDiffWrap", "Wrap around")}
                    {check("nextDiffShowMessage", "Show a message")}
                  </>,
                )}
              </Match>

              <Match when={page() === "backups"}>
                {group("Back up files",
                  <>
                    {check("backupOnCopy", "Before replacing files with copy or move")}
                    {check("backupOnSave", "Before saving in file views")}
                  </>,
                )}
                {group("Backup name",
                  <>
                    <For each={BACKUP_KINDS}>
                      {([k, label]) => (
                        <label class="opt-check">
                          <input type="radio" name="bk" checked={draft.backupKind === k} onChange={() => set("backupKind")(k)} /> <code>{label}</code> (same folder)
                        </label>
                      )}
                    </For>
                    <label class="opt-check">
                      <input type="radio" name="bk" checked={draft.backupKind === "folder"} onChange={() => set("backupKind")("folder")} /> In this folder:
                    </label>
                    <div class="opt-row indent">
                      <input type="text" value={draft.backupDir} disabled={draft.backupKind !== "folder"} onChange={(e) => set("backupDir")(e.currentTarget.value)} style={{ flex: 1 }} />
                      <button
                        disabled={draft.backupKind !== "folder"}
                        onClick={async () => {
                          const d = await openDialog({ directory: true });
                          if (typeof d === "string") set("backupDir")(d);
                        }}
                      >
                        Browse…
                      </button>
                    </div>
                  </>,
                )}
              </Match>

              <Match when={page() === "fileops"}>
                {group("Confirmations",
                  <>
                    {check("confirmCopy", "Confirm copy")}
                    {check("confirmMove", "Confirm move")}
                    {check("confirmDelete", "Confirm delete")}
                    {check("confirmOverwriteNewer", "Confirm overwriting newer files")}
                    {check("confirmCompare", "Confirm content compare")}
                  </>,
                )}
                {group("Delete", check("useTrash", "Use recycle bin (trash) by default"))}
              </Match>

              <Match when={page() === "archives"}>
                <p class="muted">Archives are compared as files. Browsing archive contents as folders is not supported yet.</p>
                <table class="opt-table">
                  <thead><tr><th>Type</th><th>Masks</th><th>Status</th></tr></thead>
                  <tbody>
                    <For each={[["Zip", "*.zip;*.jar;*.war"], ["Tar", "*.tar"], ["Gzip", "*.gz;*.tgz"], ["7-Zip", "*.7z"]]}>
                      {([t, m]) => <tr class="muted"><td>{t}</td><td>{m}</td><td>As files</td></tr>}
                    </For>
                  </tbody>
                </table>
              </Match>

              <Match when={page() === "shortcuts"}>
                {group("Toolbar", check("showToolbar", "Show toolbar in views"))}
                <ShortcutsEditor keymap={draft.keymap} onChange={(km) => setDraft("keymap", km)} />
              </Match>

              <Match when={page() === "openwith"}>
                <OpenWithEditor apps={draft.openWith} onChange={(a) => setDraft("openWith", a)} />
              </Match>

              <Match when={page() === "tweaks"}>
                {group("Interface",
                  <>
                    {check("showHints", "Show hints (tooltips)")}
                    {check("escClosesFileViews", "ESC closes file views")}
                  </>,
                )}
                {group("Editor display",
                  <>
                    {num("columnLine", "Show column line at (0 = off):", 0, 400)}
                    {num("extraLineSpacing", "Extra line spacing:", 0, 10, "px")}
                  </>,
                )}
                {group("Metrics",
                  <>
                    {num("logMaxMessages", "Log panel maximum messages:", 50, 100000)}
                    {num("mruCapacity", "Most recently used list size:", 1, 100)}
                  </>,
                )}
                {group("Name filter presets", <PresetEditor presets={draft.filterPresets} onChange={(p) => setDraft("filterPresets", p)} />)}
              </Match>
            </Switch>
          </div>
        </div>
        <div class="modal-foot">
          <span class="err">{error()}</span>
          <span class="spacer" />
          <button class="primary" onClick={async () => (await apply()) && props.onClose()}>OK</button>
          <button onClick={props.onClose}>Cancel</button>
          <button onClick={() => void apply()}>Apply</button>
        </div>
      </div>
    </div>
  );
}

function ShortcutsEditor(props: { keymap: Record<string, string>; onChange: (km: Record<string, string>) => void }) {
  const [q, setQ] = createSignal("");
  const [sel, setSel] = createSignal<string | null>(null);
  const [capturing, setCapturing] = createSignal(false);
  const rows = createMemo(() => {
    const s = q().trim().toLowerCase();
    return allCommands()
      .filter(({ cmd }) => !cmd.submenu)
      .filter(({ cmd }) => !s || `${cmd.menu} ${labelOf(cmd)} ${cmd.keys ?? ""}`.toLowerCase().includes(s))
      .sort((a, b) => a.cmd.menu.localeCompare(b.cmd.menu) || labelOf(a.cmd).localeCompare(labelOf(b.cmd)));
  });
  const effective = (id: string, def?: string) => (id in props.keymap ? props.keymap[id] : def ?? "");
  const selCmd = () => allCommands().find((x) => x.cmd.id === sel())?.cmd;
  const conflict = () => {
    const c = selCmd();
    if (!c) return "";
    const k = effective(c.id, c.keys);
    if (!k) return "";
    const other = allCommands().find(({ cmd }) => cmd.id !== c.id && effective(cmd.id, cmd.keys) === k);
    return other ? `Also assigned to ${other.cmd.menu} › ${labelOf(other.cmd)}` : "";
  };
  const onKey = (e: KeyboardEvent) => {
    if (!capturing()) return;
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    setCapturing(false);
    if (e.key === "Escape") return;
    const c = selCmd();
    if (c) props.onChange({ ...props.keymap, [c.id]: chordOf(e) });
  };
  return (
    <>
      <input class="options-search" placeholder="Search commands" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
      <div class="opt-cmd-table">
        <table class="opt-table">
          <thead><tr><th>Menu</th><th>Command</th><th>Shortcut</th></tr></thead>
          <tbody>
            <For each={rows()}>
              {({ cmd }) => (
                <tr classList={{ sel: sel() === cmd.id, changed: cmd.id in props.keymap }} onClick={() => setSel(cmd.id)}>
                  <td>{cmd.menu}</td>
                  <td>{labelOf(cmd)}</td>
                  <td><kbd>{displayKeys(effective(cmd.id, cmd.keys))}</kbd></td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <div class="opt-row">
        Shortcut:{" "}
        <input
          class="shortcut-input"
          readOnly
          disabled={!selCmd()}
          value={capturing() ? "Press keys…" : displayKeys(selCmd() ? effective(selCmd()!.id, selCmd()!.keys) : "")}
          onFocus={() => setCapturing(true)}
          onBlur={() => setCapturing(false)}
          onKeyDown={onKey}
        />
        <button disabled={!selCmd()} onClick={() => props.onChange({ ...props.keymap, [sel()!]: "" })}>Remove</button>
        <button
          disabled={!selCmd() || !(sel()! in props.keymap)}
          onClick={() => {
            const km = { ...props.keymap };
            delete km[sel()!];
            props.onChange(km);
          }}
        >
          Default
        </button>
      </div>
      <p class="muted small">{conflict() || "Commands of views that are open are listed. Click the shortcut box and press a key combination."}</p>
    </>
  );
}

function OpenWithEditor(props: { apps: Settings["openWith"]; onChange: (a: Settings["openWith"]) => void }) {
  const [sel, setSel] = createSignal(-1);
  const [edit, setEdit] = createSignal<{ i: number; name: string; command: string } | null>(null);
  const save = () => {
    const e = edit()!;
    if (!e.name.trim() || !e.command.trim()) return;
    const a = [...props.apps];
    if (e.i < 0) a.push({ name: e.name.trim(), command: e.command.trim() });
    else a[e.i] = { name: e.name.trim(), command: e.command.trim() };
    props.onChange(a);
    setEdit(null);
  };
  return (
    <>
      <p class="muted">Applications listed in the folder view's Open With menu. Use <code>%1</code> and <code>%2</code> for the left and right file, or <code>%F</code> for all selected files.</p>
      <table class="opt-table">
        <thead><tr><th>Name</th><th>Command</th></tr></thead>
        <tbody>
          <For each={props.apps} fallback={<tr><td colSpan={2} class="muted">(none)</td></tr>}>
            {(a, i) => (
              <tr classList={{ sel: sel() === i() }} onClick={() => setSel(i())} onDblClick={() => setEdit({ i: i(), ...a })}>
                <td>{a.name}</td>
                <td><code>{a.command}</code></td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <div class="opt-row">
        <button onClick={() => setEdit({ i: -1, name: "", command: "" })}>New…</button>
        <button disabled={sel() < 0} onClick={() => (props.onChange(props.apps.filter((_, j) => j !== sel())), setSel(-1))}>Delete</button>
        <button disabled={sel() < 0} onClick={() => setEdit({ i: sel(), ...props.apps[sel()] })}>Edit…</button>
        <button disabled={sel() < 0} onClick={() => setEdit({ i: -1, name: `${props.apps[sel()].name} (copy)`, command: props.apps[sel()].command })}>Clone…</button>
      </div>
      <Show when={edit()}>
        <fieldset class="opt-group">
          <legend>{edit()!.i < 0 ? "New application" : "Edit application"}</legend>
          <label class="opt-row">Name: <input type="text" value={edit()!.name} onInput={(e) => setEdit({ ...edit()!, name: e.currentTarget.value })} /></label>
          <label class="opt-row">
            Command: <input type="text" style={{ flex: 1 }} placeholder="code --diff %1 %2" value={edit()!.command} onInput={(e) => setEdit({ ...edit()!, command: e.currentTarget.value })} />
          </label>
          <div class="opt-row">
            <button class="primary" onClick={save}>Save</button>
            <button onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </fieldset>
      </Show>
    </>
  );
}

export function PresetEditor(props: { presets: Settings["filterPresets"]; onChange: (p: Settings["filterPresets"]) => void }) {
  const [sel, setSel] = createSignal(-1);
  const [name, setName] = createSignal("");
  const [mask, setMask] = createSignal("");
  const pick = (i: number) => {
    setSel(i);
    setName(props.presets[i]?.name ?? "");
    setMask(props.presets[i]?.mask ?? "");
  };
  return (
    <>
      <table class="opt-table">
        <thead><tr><th>Name</th><th>Mask</th></tr></thead>
        <tbody>
          <For each={props.presets}>
            {(p, i) => (
              <tr classList={{ sel: sel() === i() }} onClick={() => pick(i())}>
                <td>{p.name}</td>
                <td><code>{p.mask}</code></td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <div class="opt-row">
        <input type="text" placeholder="Name" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        <input type="text" placeholder="*.c;*.h;-tmp\" style={{ flex: 1 }} value={mask()} onInput={(e) => setMask(e.currentTarget.value)} />
      </div>
      <div class="opt-row">
        <button disabled={!name().trim() || !mask().trim()} onClick={() => (props.onChange([...props.presets, { name: name().trim(), mask: mask().trim() }]), pick(props.presets.length))}>Add</button>
        <button disabled={sel() < 0 || !name().trim()} onClick={() => props.onChange(props.presets.map((p, j) => (j === sel() ? { name: name().trim(), mask: mask().trim() } : p)))}>Update</button>
        <button disabled={sel() < 0} onClick={() => (props.onChange(props.presets.filter((_, j) => j !== sel())), pick(-1))}>Delete</button>
        <button onClick={() => (props.onChange(JSON.parse(JSON.stringify(DEFAULT_SETTINGS.filterPresets))), pick(-1))}>Defaults</button>
      </div>
    </>
  );
}
