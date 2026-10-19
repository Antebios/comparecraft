import { createRoot, createEffect } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { api, type FolderOptions, type ViewKind } from "./api";

/** One "Open With" application: `%1`/`%2` (or `%F`) stand for the selected file(s). */
export interface OpenWithApp {
  name: string;
  command: string;
}
export interface FilterPreset {
  name: string;
  mask: string;
}
export interface WorkspaceTab {
  kind: ViewKind;
  paths: string[];
  options: Record<string, unknown>;
  sessionName?: string;
}

export type BackupKind = "nameTildeExt" | "nameExtTilde" | "nameExtBak" | "tildeNameExt" | "nameBak" | "nameBakExt" | "folder";

/** Program-wide options (Tools › Options), persisted to settings.json in the config folder. */
export interface Settings {
  // Startup
  /** "none", "last" (the tabs open at the last exit) or the name of a saved workspace. */
  workspaceLoad: string;
  workspaceSave: string;
  lastWorkspace: WorkspaceTab[];
  /** Named workspaces (Session › Save Workspace As). */
  workspaces: Record<string, WorkspaceTab[]>;
  quickCompareShow: boolean;
  quickCompareRules: boolean;
  quickCompareOpenIfDiff: boolean;
  // Tabs
  tabNewNext: boolean;
  tabSingleCloseWindow: boolean;
  tabsConfirmClose: boolean;
  tabSingleHide: boolean;
  // Appearance
  theme: "auto" | "light" | "dark";
  colors: Record<string, string>;
  folderStripes: boolean;
  folderColorFolders: boolean;
  uiFontSize: number;
  editorFont: string;
  editorFontSize: number;
  // Text editing
  contextLines: number;
  tabSize: number;
  findCurrentWord: boolean;
  // Next difference
  nextDiffLoadFirst: boolean;
  nextDiffAfterCopy: boolean;
  nextDiffWrap: boolean;
  nextDiffShowMessage: boolean;
  // Backups
  backupOnCopy: boolean;
  backupOnSave: boolean;
  backupKind: BackupKind;
  backupDir: string;
  // File operations
  confirmCopy: boolean;
  confirmMove: boolean;
  confirmOverwriteNewer: boolean;
  confirmDelete: boolean;
  confirmCompare: boolean;
  useTrash: boolean;
  // Commands: command id -> shortcut ("" removes the default shortcut)
  keymap: Record<string, string>;
  // Open With
  openWith: OpenWithApp[];
  // Tweaks
  escClosesFileViews: boolean;
  showHints: boolean;
  columnLine: number;
  extraLineSpacing: number;
  logMaxMessages: number;
  mruCapacity: number;
  filterPresets: FilterPreset[];
  // View state shared by all folder views
  showToolbar: boolean;
  folderColumns: { size: boolean; modified: boolean };
  /** Session defaults for new folder comparisons ("Also update session defaults"). */
  folderDefaults: Partial<FolderOptions> | null;
  filterHistory: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  workspaceLoad: "none",
  workspaceSave: "none",
  lastWorkspace: [],
  workspaces: {},
  quickCompareShow: false,
  quickCompareRules: true,
  quickCompareOpenIfDiff: true,
  tabNewNext: false,
  tabSingleCloseWindow: false,
  tabsConfirmClose: true,
  tabSingleHide: false,
  theme: "auto",
  colors: {},
  folderStripes: false,
  folderColorFolders: true,
  uiFontSize: 13,
  editorFont: "",
  editorFontSize: 12,
  contextLines: 3,
  tabSize: 4,
  findCurrentWord: true,
  nextDiffLoadFirst: false,
  nextDiffAfterCopy: false,
  nextDiffWrap: false,
  nextDiffShowMessage: true,
  backupOnCopy: false,
  backupOnSave: false,
  backupKind: "nameExtBak",
  backupDir: "",
  confirmCopy: true,
  confirmMove: true,
  confirmOverwriteNewer: true,
  confirmDelete: true,
  confirmCompare: true,
  useTrash: true,
  keymap: {},
  openWith: [],
  escClosesFileViews: false,
  showHints: true,
  columnLine: 0,
  extraLineSpacing: 0,
  logMaxMessages: 1000,
  mruCapacity: 20,
  filterPresets: [
    { name: "Source code", mask: "*.c;*.cpp;*.h;*.hpp;*.cs;*.java;*.js;*.ts;*.tsx;*.py;*.rs;*.go" },
    { name: "Web", mask: "*.html;*.htm;*.css;*.js;*.ts;*.json" },
    { name: "Exclude VCS folders", mask: "*.*;-.git\\;-.svn\\;-.hg\\" },
    { name: "Exclude build output", mask: "*.*;-node_modules\\;-target\\;-dist\\;-build\\;-bin\\;-obj\\" },
  ],
  showToolbar: true,
  folderColumns: { size: true, modified: true },
  folderDefaults: null,
  filterHistory: [],
};

/** Colors that can be changed on the Appearance page: CSS variable -> label. */
export const COLOR_VARS: [string, string][] = [
  ["--diff-fg", "Different / newer text"],
  ["--older-fg", "Older text"],
  ["--orphan-fg", "Orphan text"],
  ["--orphan-bg", "Orphan background"],
  ["--same-fg", "Same text"],
  ["--unimp-fg", "Unimportant difference text"],
  ["--diff-bg", "Difference background"],
  ["--unimp-bg", "Unimportant background"],
  ["--sel", "Selection background"],
];

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

const [settings, setSettingsStore] = createStore<Settings>(clone(DEFAULT_SETTINGS));
export { settings };

let loaded = false;

/** Merges stored values over the defaults; settings saved by older versions keep working. */
function normalize(raw: unknown): Settings {
  const s = { ...clone(DEFAULT_SETTINGS), ...((raw && typeof raw === "object" ? raw : {}) as Partial<Settings>) };
  s.folderColumns = { ...DEFAULT_SETTINGS.folderColumns, ...(s.folderColumns ?? {}) };
  return s;
}

/** Values kept in localStorage before settings.json existed. */
function migrateLocal(s: Settings): Settings {
  const ls = (k: string) => localStorage.getItem(`comparecraft.${k}`);
  if (ls("theme")) s.theme = ls("theme") as Settings["theme"];
  if (ls("confirmCopy") === "false") s.confirmCopy = false;
  if (ls("useTrash") === "false") s.useTrash = false;
  return s;
}

export async function loadSettings() {
  try {
    const raw = await api.loadSettings();
    const empty = !raw || Object.keys(raw).length === 0;
    setSettingsStore(reconcile(empty ? migrateLocal(normalize({})) : normalize(raw)));
  } catch {
    setSettingsStore(reconcile(migrateLocal(normalize({}))));
  }
  loaded = true;
}

let saveTimer: number | undefined;
function scheduleSave() {
  if (!loaded) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void api.saveSettings(clone(unwrap(settings))).catch((e) => console.error("save settings failed", e)), 150);
}

/** Replaces all settings (Options dialog OK/Apply, import, restore defaults). */
export function replaceSettings(s: Settings) {
  setSettingsStore(reconcile(normalize(clone(s))));
  scheduleSave();
}

/** Changes one setting and saves. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  // Objects are replaced, not merged, so removed keys stay removed.
  setSettingsStore(key as never, (typeof value === "object" && value !== null ? reconcile(clone(value)) : value) as never);
  scheduleSave();
}

export const snapshotSettings = (): Settings => clone(unwrap(settings));

/** Remembers a filter string in the most-recently-used list of the Filters box. */
export function rememberFilter(mask: string) {
  const m = mask.trim();
  if (!m) return;
  setSetting("filterHistory", [m, ...settings.filterHistory.filter((x) => x !== m)].slice(0, Math.max(1, settings.mruCapacity)));
}

/** Backup naming passed to the backend, or undefined when backups are off. */
export const backupSpec = (enabled: boolean) => (enabled ? { kind: settings.backupKind, dir: settings.backupDir || null } : undefined);

// Applies appearance settings to the document.
createRoot(() => {
  createEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    for (const [v] of COLOR_VARS) {
      const c = settings.colors[v];
      if (c) root.style.setProperty(v, c);
      else root.style.removeProperty(v);
    }
    root.style.setProperty("--ui-font-size", `${settings.uiFontSize}px`);
    root.style.setProperty("--editor-font-size", `${settings.editorFontSize}px`);
    root.style.setProperty("--tab-size", String(settings.tabSize));
    if (settings.editorFont.trim()) root.style.setProperty("--mono", `${settings.editorFont}, monospace`);
    else root.style.removeProperty("--mono");
    root.classList.toggle("folder-stripes", settings.folderStripes);
    root.classList.toggle("no-hints", !settings.showHints);
  });
});

/** Writes pending changes now (used before the window closes). */
export async function flushSettings() {
  if (!loaded) return;
  clearTimeout(saveTimer);
  await api.saveSettings(clone(unwrap(settings))).catch((e) => console.error("save settings failed", e));
}

/** Asks the application shell to show Tools › Options, optionally on a page. */
export const showOptions = (page?: string) => window.dispatchEvent(new CustomEvent("comparecraft:options", { detail: page }));
