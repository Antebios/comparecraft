import { ask, message } from "@tauri-apps/plugin-dialog";
import { createSignal, Show, type JSX } from "solid-js";
import { dirname, type ReportRequest } from "../api";
import type { Command } from "../commands";
import { InfoDialog, type InfoGroup } from "../components/InfoDialog";
import { promptText } from "../components/Prompt";
import { ReportDialog, type ReportKind } from "../components/ReportDialog";
import { openTab, persistSession, replaceTab, setSessionLocked, tabTitle, type Tab } from "../store";

const [modal, setModal] = createSignal<(() => JSX.Element) | null>(null);
/** Shows a dialog above the whole window (used by the shared Session commands). */
export const showModal = (f: () => JSX.Element) => setModal(() => f);
export const closeModal = () => setModal(null);
export function ModalHost() {
  return <Show when={modal()}>{(f) => f()()}</Show>;
}

export interface SessionMenuOptions {
  tab: () => Tab;
  /** Caption prefix: "Text Compare", "Folder Compare", "Text Merge", … */
  title: string;
  /** Unsaved edits that Clear Session would discard. */
  dirty?: () => boolean;
  notify?: (msg: string) => void;
  report?: { kind: ReportKind; request: () => ReportRequest; columns?: () => string[]; enabled?: () => boolean };
  info?: { lines?: () => string[]; groups?: () => InfoGroup[]; enabled?: () => boolean };
  /** "Compare Parent Folders" / "Merge Parent Folders" (false to omit). */
  parents?: { label?: string; kind?: Tab["kind"]; paths?: () => string[] } | false;
}

async function errorBox(e: unknown) {
  await message(String((e as Error)?.message ?? e), { title: "Session", kind: "error" }).catch(() => {});
}

/** Save Session As: prompts for a name and saves the session under it. */
export async function saveSessionAs(tab: Tab, notify?: (m: string) => void): Promise<boolean> {
  const n = (await promptText("Save Session As", "Session name:", tab.sessionName ?? ""))?.trim();
  if (!n) return false;
  try {
    await persistSession(tab, n);
    notify?.(`Saved session “${n}”`);
    return true;
  } catch (e) {
    await errorBox(e);
    return false;
  }
}

/** Save Session: replaces the named session, or asks for a name when it has none or is locked. */
export async function saveSession(tab: Tab, notify?: (m: string) => void): Promise<boolean> {
  if (!tab.sessionName || tab.locked) return saveSessionAs(tab, notify);
  try {
    await persistSession(tab, tab.sessionName);
    notify?.(`Saved session “${tab.sessionName}”`);
    return true;
  } catch (e) {
    await errorBox(e);
    return false;
  }
}

/**
 * The Session menu commands every comparison shares: Save Session [As], Locked, Clear Session,
 * "<View> Report…", "<View> Info" and Compare Parent Folders.
 */
export function sessionCommands(o: SessionMenuOptions): Command[] {
  const t = o.tab;
  const cmds: Command[] = [
    { id: "save-session", menu: "Session", group: "session", label: "Save Session", keys: "Shift+Ctrl+S", run: () => saveSession(t(), o.notify) },
    { id: "save-session-as", menu: "Session", group: "session", label: "Save Session As…", run: () => saveSessionAs(t(), o.notify) },
    {
      id: "session-locked", menu: "Session", group: "session", label: "Locked", checked: () => !!t().locked,
      enabled: () => t().paths.some(Boolean),
      run: async () => {
        if (!t().sessionName && !(await saveSessionAs(t(), o.notify))) return;
        try {
          await setSessionLocked(t(), !t().locked);
          o.notify?.(t().locked ? `Locked session “${t().sessionName}”` : `Unlocked session “${t().sessionName}”`);
        } catch (e) {
          await errorBox(e);
        }
      },
    },
    {
      id: "clear-session", menu: "Session", group: "session", label: "Clear Session", keys: "Shift+Ctrl+C",
      run: async () => {
        if (o.dirty?.() && !(await ask("Discard the unsaved changes in this session?", { title: "Clear Session", kind: "warning" }))) return;
        replaceTab(t().id, { kind: t().kind });
      },
    },
  ];
  const r = o.report;
  if (r)
    cmds.push({
      id: "session-report", menu: "Session", group: "report", label: `${o.title} Report…`,
      enabled: () => (r.enabled ? r.enabled() : t().paths.some(Boolean)),
      run: () => showModal(() => <ReportDialog kind={r.kind} title={tabTitle(t())} request={r.request} columns={r.columns?.()} onClose={closeModal} />),
    });
  const i = o.info;
  if (i)
    cmds.push({
      id: "session-info", menu: "Session", group: "report", label: `${o.title} Info`, keys: "Ctrl+I",
      enabled: () => (i.enabled ? i.enabled() : true),
      run: () => showModal(() => <InfoDialog title={`${o.title} Info`} lines={i.lines?.()} groups={i.groups?.()} onClose={closeModal} />),
    });
  if (o.parents !== false) {
    const p = o.parents ?? {};
    const sources = () => (p.paths ? p.paths() : t().paths.slice(0, 2));
    cmds.push({
      id: "compare-parents", menu: "Session", group: "using", label: p.label ?? "Compare Parent Folders",
      enabled: () => sources().slice(0, 2).every((x) => !!x && !!dirname(x)),
      run: () => openTab({ kind: p.kind ?? "folder", paths: sources().map((x) => (x ? dirname(x) : "")) }),
    });
  }
  return cmds;
}
