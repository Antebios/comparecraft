import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { getCurrentWindow } from "./host";
import { api, basename, type LaunchSpec, type Session, type ViewKind } from "./api";
import { setSetting, settings, type WorkspaceTab } from "./settings";

export interface Tab {
  id: string;
  kind: ViewKind;
  paths: string[];
  titles: (string | null)[];
  readOnly: boolean[];
  options: Record<string, unknown>;
  sessionId: string;
  sessionName?: string;
  /** The named session is locked against Save Session. */
  locked?: boolean;
  dirty: boolean;
  output?: string | null;
  saveTarget?: string | null;
  noBackups?: boolean;
  expandAll?: boolean;
  filters?: string | null;
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const [state, setState] = createStore<{ tabs: Tab[]; active: string }>({ tabs: [], active: "home" });
export { state };

export const [sessionsVersion, setSessionsVersion] = createSignal(0);

export const KIND_LABEL: Record<ViewKind, string> = {
  home: "Home",
  text: "Text Compare",
  folder: "Folder Compare",
  sync: "Folder Sync",
  fmerge: "Folder Merge",
  merge: "Text Merge",
  hex: "Hex Compare",
  table: "Table Compare",
  picture: "Picture Compare",
  edit: "Text Edit",
  patch: "Text Patch",
};

export function tabTitle(t: Tab): string {
  if (t.sessionName) return t.sessionName;
  const names = t.paths.slice(0, t.kind === "merge" ? 2 : 2).filter(Boolean).map(basename);
  if (names.length === 0) return KIND_LABEL[t.kind];
  if (names.length === 2 && names[0] === names[1]) return names[0];
  return names.join(" ↔ ");
}

export function openTab(init: Partial<Tab> & { kind: ViewKind }): string {
  const tab: Tab = {
    id: uid(),
    paths: [],
    titles: [],
    readOnly: [],
    options: {},
    sessionId: uid(),
    dirty: false,
    ...init,
  };
  setState(produce((s) => {
    const at = settings.tabNewNext ? s.tabs.findIndex((t) => t.id === s.active) : -1;
    if (at >= 0) s.tabs.splice(at + 1, 0, tab);
    else s.tabs.push(tab);
    s.active = tab.id;
  }));
  return tab.id;
}

export function closeTab(id: string) {
  setState(produce((s) => {
    const i = s.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    s.tabs.splice(i, 1);
    if (s.active === id) s.active = s.tabs[Math.max(0, i - 1)]?.id ?? "home";
  }));
  if (state.tabs.length === 0 && settings.tabSingleCloseWindow) void getCurrentWindow().close();
}

/** Closes every tab without closing the window (loading a workspace). */
export function closeAllTabs() {
  setState(produce((s) => {
    s.tabs.splice(0);
    s.active = "home";
  }));
}

/** The open tabs, as stored in a workspace. */
export function currentWorkspace(): WorkspaceTab[] {
  return state.tabs
    .filter((t) => t.paths.some(Boolean))
    .map((t) => ({ kind: t.kind, paths: [...t.paths], options: JSON.parse(JSON.stringify(t.options ?? {})), sessionName: t.sessionName }));
}

/** Saves the open tabs under a name (Session › Save Workspace As). */
export function saveNamedWorkspace(name: string) {
  setSetting("workspaces", { ...settings.workspaces, [name]: currentWorkspace() });
}

/** Opens the tabs of a workspace. */
export function openWorkspace(ws: WorkspaceTab[]) {
  for (const w of ws) openTab({ kind: w.kind, paths: [...w.paths], options: { ...w.options }, sessionName: w.sessionName });
}

/** Saves the workspace chosen in Options › Startup on exit. */
export function saveWorkspace() {
  const target = settings.workspaceSave;
  if (target === "none") return;
  if (target === "last") setSetting("lastWorkspace", currentWorkspace());
  else saveNamedWorkspace(target);
}

/** Loads the workspace chosen in Options › Startup. */
export function restoreWorkspace() {
  const src = settings.workspaceLoad;
  if (src === "none") return;
  openWorkspace(src === "last" ? settings.lastWorkspace : (settings.workspaces?.[src] ?? []));
}

export function activate(id: string) {
  setState("active", id);
}

export function updateTab(id: string, patch: Partial<Tab>) {
  setState("tabs", (t) => t.id === id, patch);
}

export function findTab(id: string): Tab | undefined {
  return state.tabs.find((t) => t.id === id);
}

/**
 * Records the comparison as a recent (auto-saved) session, or as a named one; a named session
 * replaces the saved session of that name unless it is locked.
 */
export async function persistSession(tab: Tab, name?: string) {
  if (!tab.paths.some(Boolean)) return;
  const saved = !!name;
  const existing = name ? await api.findSession(name).catch(() => null) : null;
  if (existing?.locked) throw new Error(`The session “${existing.name}” is locked. Use Save Session As to save it under another name.`);
  const session: Session = {
    id: existing?.id ?? (saved ? uid() : tab.sessionId),
    name: name ?? tabTitle(tab),
    kind: tab.kind,
    paths: [...tab.paths],
    options: JSON.parse(JSON.stringify(tab.options ?? {})),
    modified: Date.now(),
    saved,
    locked: false,
  };
  try {
    await api.saveSession(session);
    if (saved) updateTab(tab.id, { sessionName: name, locked: false });
    setSessionsVersion((v) => v + 1);
  } catch (e) {
    console.error("save session failed", e);
  }
}

/** Locks or unlocks the named session of a tab. */
export async function setSessionLocked(tab: Tab, locked: boolean) {
  const s = tab.sessionName ? await api.findSession(tab.sessionName) : null;
  if (!s) throw new Error("Save the session first.");
  await api.saveSession({ ...s, locked });
  updateTab(tab.id, { locked });
  setSessionsVersion((v) => v + 1);
}

/** Replaces a tab with a new one in the same place (Session › Clear Session). */
export function replaceTab(id: string, init: Partial<Tab> & { kind: ViewKind }) {
  const tab: Tab = { id: uid(), paths: [], titles: [], readOnly: [], options: {}, sessionId: uid(), dirty: false, ...init };
  setState(produce((s) => {
    const i = s.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    s.tabs[i] = tab;
    if (s.active === id) s.active = tab.id;
  }));
}

export function openSession(s: Session) {
  openTab({
    kind: s.kind,
    paths: [...s.paths],
    options: (s.options as Record<string, unknown>) ?? {},
    sessionId: s.saved ? uid() : s.id,
    sessionName: s.saved ? s.name : undefined,
    locked: s.saved && !!s.locked,
  });
}

/** Opens a compare tab for two paths, choosing the viewer from the file type. */
export async function openAuto(paths: string[], forceKind?: ViewKind) {
  let kind: ViewKind | undefined = forceKind;
  if (!kind) {
    if (paths.length >= 3) kind = "merge";
    else {
      const infos = await Promise.all(paths.filter(Boolean).map((p) => api.pathInfo(p)));
      const first = infos.find((i) => i.exists) ?? infos[0];
      if (!first) kind = "text";
      else if (first.isDir) kind = "folder";
      else kind = (["text", "hex", "table", "picture"].includes(first.kind) ? first.kind : "text") as ViewKind;
    }
  }
  return openTab({ kind, paths });
}

export async function openSpec(spec: LaunchSpec) {
  if (spec.message) {
    alert(spec.message);
    if (spec.kind === "home" && !spec.paths.length) return;
  }
  if (spec.kind === "home") {
    activate("home");
    return;
  }
  if (spec.kind === "session") {
    const s = spec.session ? await api.findSession(spec.session) : null;
    if (s) openSession(s);
    else alert(`No saved session named "${spec.session}"`);
    return;
  }
  openTab({
    kind: spec.kind,
    paths: spec.paths,
    titles: spec.titles,
    readOnly: spec.readOnly,
    output: spec.output,
    saveTarget: spec.saveTarget,
    noBackups: spec.noBackups,
    expandAll: spec.expandAll,
    filters: spec.filters,
  });
}
