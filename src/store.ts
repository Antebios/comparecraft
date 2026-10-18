import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { api, basename, type LaunchSpec, type Session, type ViewKind } from "./api";

export interface Tab {
  id: string;
  kind: ViewKind;
  paths: string[];
  titles: (string | null)[];
  readOnly: boolean[];
  options: Record<string, unknown>;
  sessionId: string;
  sessionName?: string;
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
  merge: "Text Merge",
  hex: "Hex Compare",
  table: "Table Compare",
  picture: "Picture Compare",
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
    s.tabs.push(tab);
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

/** Records the comparison as a recent (auto-saved) session, or as a named one. */
export async function persistSession(tab: Tab, name?: string) {
  if (!tab.paths.some(Boolean)) return;
  const saved = !!name;
  const session: Session = {
    id: saved ? uid() : tab.sessionId,
    name: name ?? tabTitle(tab),
    kind: tab.kind,
    paths: [...tab.paths],
    options: JSON.parse(JSON.stringify(tab.options ?? {})),
    modified: Date.now(),
    saved,
  };
  try {
    await api.saveSession(session);
    if (saved) updateTab(tab.id, { sessionName: name });
    setSessionsVersion((v) => v + 1);
  } catch (e) {
    console.error("save session failed", e);
  }
}

export function openSession(s: Session) {
  openTab({
    kind: s.kind,
    paths: [...s.paths],
    options: (s.options as Record<string, unknown>) ?? {},
    sessionId: s.saved ? uid() : s.id,
    sessionName: s.saved ? s.name : undefined,
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
