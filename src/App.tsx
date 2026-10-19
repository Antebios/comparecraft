import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createEffect, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { api, type LaunchSpec } from "./api";
import { dispatchKey, IS_MAC, registerCommands } from "./commands";
import OptionsDialog, { type OptionsPage } from "./components/OptionsDialog";
import { ExportDialog, FileFormatsDialog, ImportDialog, ProfilesDialog, restoreFactoryDefaults, SnapshotDialog } from "./components/ToolsDialogs";
import { flushSettings, loadSettings, setSetting, settings } from "./settings";
import { Modal } from "./components/common";
import { HelpViewer } from "./components/HelpViewer";
import { ONLINE_MANUAL, pageForView } from "./help/manual";
import MenuBar, { ShortcutList } from "./components/MenuBar";
import { PromptHost } from "./components/Prompt";
import { ReplaceHost } from "./views/folderOps";
import { ContextMenuHost } from "./components/ContextMenu";
import { activate, closeTab, KIND_LABEL, openSpec, openTab, restoreWorkspace, saveWorkspace, state, tabTitle, type Tab } from "./store";
import FolderCompare from "./views/FolderCompare";
import HexCompare from "./views/HexCompare";
import Home from "./views/Home";
import PictureCompare from "./views/PictureCompare";
import TableCompare from "./views/TableCompare";
import TextCompare from "./views/TextCompare";
import TextMerge from "./views/TextMerge";
import TextEdit from "./views/TextEdit";
import PatchView from "./views/PatchView";

function TabView(props: { tab: Tab }) {
  const active = () => state.active === props.tab.id;
  return (
    <div class="tab-view" style={{ display: active() ? "flex" : "none" }}>
      <Switch>
        <Match when={props.tab.kind === "text"}>
          <TextCompare tab={props.tab} active={active()} />
        </Match>
        <Match when={props.tab.kind === "folder" || props.tab.kind === "sync"}>
          <FolderCompare tab={props.tab} active={active()} />
        </Match>
        <Match when={props.tab.kind === "merge"}>
          <TextMerge tab={props.tab} active={active()} />
        </Match>
        <Match when={props.tab.kind === "hex"}>
          <HexCompare tab={props.tab} active={active()} />
        </Match>
        <Match when={props.tab.kind === "table"}>
          <TableCompare tab={props.tab} active={active()} />
        </Match>
        <Match when={props.tab.kind === "picture"}>
          <PictureCompare tab={props.tab} active={active()} />
        </Match>
        <Match when={props.tab.kind === "edit"}>
          <TextEdit tab={props.tab} active={active()} />
        </Match>
        <Match when={props.tab.kind === "patch"}>
          <PatchView tab={props.tab} active={active()} />
        </Match>
      </Switch>
    </div>
  );
}

export default function App() {
  createEffect(() => {
    state.active;
    queueMicrotask(() => document.querySelector(".tabbar .active")?.scrollIntoView({ inline: "nearest", block: "nearest" }));
  });

  async function requestClose(t: Tab) {
    if (t.dirty && settings.tabsConfirmClose && !(await ask(`“${tabTitle(t)}” has unsaved changes. Close anyway?`, { kind: "warning" }))) return;
    closeTab(t.id);
  }

  type DialogName = "help" | "shortcuts" | "about" | "options" | "export" | "import" | "snapshot" | "formats" | "profiles";
  const [dialog, setDialog] = createSignal<DialogName | null>(null);
  const [optionsPage, setOptionsPage] = createSignal<OptionsPage | undefined>();
  const [helpPage, setHelpPage] = createSignal<string>();
  const [toast, setToast] = createSignal("");
  let toastTimer: number | undefined;
  const notify = (m: string) => {
    setToast(m);
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setToast(""), 5000);
  };
  const openOptions = (page?: OptionsPage) => {
    setOptionsPage(page);
    setDialog("options");
  };
  // Views open the Options dialog on a given page through this event.
  const onOpenOptions = (e: Event) => openOptions((e as CustomEvent<OptionsPage | undefined>).detail);
  window.addEventListener("comparecraft:options", onOpenOptions);
  onCleanup(() => window.removeEventListener("comparecraft:options", onOpenOptions));
  const snapshotBases = () => {
    const t = activeTab();
    return t && (t.kind === "folder" || t.kind === "sync") ? { left: t.paths[0] || undefined, right: t.paths[1] || undefined } : {};
  };
  async function openSingle(kind: "edit" | "patch") {
    const p = await openDialog({
      multiple: false,
      filters: kind === "patch" ? [{ name: "Patch files", extensions: ["diff", "patch"] }, { name: "All files", extensions: ["*"] }] : undefined,
    });
    if (typeof p === "string") openTab({ kind, paths: [p] });
  }
  const cycleTab = (dir: 1 | -1) => {
    const ids = ["home", ...state.tabs.map((t) => t.id)];
    const i = ids.indexOf(state.active);
    activate(ids[(i + (dir === 1 ? 1 : ids.length - 1)) % ids.length]);
  };
  const activeTab = () => state.tabs.find((x) => x.id === state.active);
  const newSession = (kind: Tab["kind"]) => () => void openTab({ kind, paths: [] });

  registerCommands("global", [
    { id: "home", menu: "Session", group: "nav", label: "Home", keys: "Alt+Home", run: () => activate("home") },
    { id: "new-tab", menu: "Session", group: "nav", label: "New Tab", keys: "Ctrl+T", run: () => activate("home") },
    { id: "new-text", menu: "Session", group: "new", label: "New Text Compare", run: newSession("text") },
    { id: "new-folder", menu: "Session", group: "new", label: "New Folder Compare", run: newSession("folder") },
    { id: "new-sync", menu: "Session", group: "new", label: "New Folder Sync", run: newSession("sync") },
    { id: "new-merge", menu: "Session", group: "new", label: "New Text Merge", run: newSession("merge") },
    { id: "new-table", menu: "Session", group: "new", label: "New Table Compare", run: newSession("table") },
    { id: "new-hex", menu: "Session", group: "new", label: "New Hex Compare", run: newSession("hex") },
    { id: "new-pix", menu: "Session", group: "new", label: "New Picture Compare", run: newSession("picture") },
    { id: "next-tab", menu: "Session", group: "tabs", label: "Select Next Tab", keys: "Ctrl+Tab", run: () => cycleTab(1) },
    { id: "prev-tab", menu: "Session", group: "tabs", label: "Select Previous Tab", keys: "Shift+Ctrl+Tab", run: () => cycleTab(-1) },
    {
      id: "close-tab", menu: "Session", group: "tabs", label: "Close Tab", keys: "Ctrl+W",
      enabled: () => !!activeTab(), run: () => { const t = activeTab(); if (t) void requestClose(t); },
    },
    { id: "exit", menu: "Session", group: "exit", label: "Exit", keys: "Ctrl+Q", run: () => void getCurrentWindow().close() },
    { id: "toolbar", menu: "View", group: "zbars", label: "Toolbar", checked: () => settings.showToolbar, run: () => setSetting("showToolbar", !settings.showToolbar) },
    { id: "options", menu: "Tools", group: "opt", label: "Options…", keys: IS_MAC ? "Ctrl+," : undefined, run: () => openOptions() },
    { id: "file-formats", menu: "Tools", group: "opt", label: "File Formats…", run: () => setDialog("formats") },
    { id: "profiles", menu: "Tools", group: "opt", label: "Profiles…", run: () => setDialog("profiles") },
    { id: "export-settings", menu: "Tools", group: "io", label: "Export Settings…", run: () => setDialog("export") },
    { id: "import-settings", menu: "Tools", group: "io", label: "Import Settings…", run: () => setDialog("import") },
    {
      id: "factory-defaults", menu: "Tools", group: "io", label: "Restore Factory Defaults…",
      run: async () => (await restoreFactoryDefaults()) && notify("Factory defaults restored"),
    },
    { id: "save-snapshot", menu: "Tools", group: "snap", label: "Save Snapshot…", run: () => setDialog("snapshot") },
    { id: "edit-text", menu: "Tools", group: "edit", label: "Edit Text File…", run: () => openSingle("edit") },
    { id: "view-patch", menu: "Tools", group: "edit", label: "View Patch…", run: () => openSingle("patch") },
    {
      id: "help", menu: "Help", group: "help", label: "CompareCraft Help", keys: "F1",
      run: () => (setHelpPage(pageForView(activeTab()?.kind)), setDialog("help")),
    },
    { id: "shortcuts", menu: "Help", group: "help", label: "Keyboard Shortcuts", keys: "Shift+F1", run: () => setDialog("shortcuts") },
    { id: "online-manual", menu: "Help", group: "help", label: "Online Manual", enabled: () => !!ONLINE_MANUAL, run: () => void openUrl(ONLINE_MANUAL) },
    { id: "about", menu: "Help", group: "about", label: "About CompareCraft", run: () => setDialog("about") },
  ]);

  const onKey = (e: KeyboardEvent) => {
    if (dispatchKey(e, state.active)) return;
    // Options › Tweaks › "ESC closes file views".
    const t = activeTab();
    if (e.key === "Escape" && settings.escClosesFileViews && t && t.kind !== "folder" && t.kind !== "sync" && !e.defaultPrevented) {
      const el = e.target as HTMLElement | null;
      if (document.querySelector(".modal-backdrop, .ctx-menu") || el?.closest("input, textarea, select, .findbar")) return;
      void requestClose(t);
    }
  };

  onMount(async () => {
    window.addEventListener("keydown", onKey);
    await loadSettings();
    restoreWorkspace();
    const unlisten = await listen<LaunchSpec>("launch", (e) => void openSpec(e.payload));
    onCleanup(unlisten);
    const win = getCurrentWindow();
    const unClose = await win.onCloseRequested(async (e) => {
      const dirty = state.tabs.filter((t) => t.dirty);
      if (dirty.length && !(await ask(`${dirty.length} tab(s) have unsaved changes. Quit anyway?`, { kind: "warning" }))) {
        e.preventDefault();
        return;
      }
      saveWorkspace();
      await flushSettings();
    });
    onCleanup(unClose);
    const spec = await api.takeLaunchSpec();
    if (spec) await openSpec(spec);
  });
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div class="app" classList={{ "no-toolbar": !settings.showToolbar }}>
      <MenuBar scope={state.active} />
      <div class="tabbar" style={{ display: settings.tabSingleHide && state.tabs.length === 0 ? "none" : undefined }}>
        <button class="tab home-tab" classList={{ active: state.active === "home" }} onClick={() => activate("home")} title="Home">
          ⌂ CompareCraft
        </button>
        <For each={state.tabs}>
          {(t) => (
            <div
              class="tab"
              classList={{ active: state.active === t.id }}
              onMouseDown={(e) => (e.button === 1 ? (e.preventDefault(), void requestClose(t)) : activate(t.id))}
              title={`${KIND_LABEL[t.kind]}\n${t.paths.filter(Boolean).join("\n")}`}
            >
              <span class="tab-kind">{KIND_LABEL[t.kind]}</span>
              <span class="tab-title">{tabTitle(t)}</span>
              <Show when={t.dirty}>
                <span class="tab-dirty">●</span>
              </Show>
              <button
                class="tab-close"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => (e.stopPropagation(), void requestClose(t))}
                title="Close (Ctrl+W)"
              >
                ✕
              </button>
            </div>
          )}
        </For>
        <span class="spacer" />
      </div>
      <div class="content">
        <div class="tab-view" style={{ display: state.active === "home" ? "flex" : "none" }}>
          <Home />
        </div>
        <For each={state.tabs}>{(t) => <TabView tab={t} />}</For>
      </div>
      <Show when={dialog() === "help"}>
        <HelpViewer file={helpPage()} onClose={() => setDialog(null)} />
      </Show>
      <Show when={dialog() === "shortcuts"}>
        <Modal title="Keyboard Shortcuts" onClose={() => setDialog(null)}>
          <ShortcutList scope={state.active} />
        </Modal>
      </Show>
      <Show when={dialog() === "about"}>
        <Modal title="About CompareCraft" onClose={() => setDialog(null)}>
          <p><b>CompareCraft 0.1.0</b>: compare, merge and synchronize files and folders.</p>
          <p class="muted">Tauri + SolidJS · MIT License</p>
        </Modal>
      </Show>
      <Show when={dialog() === "options"}>
        <OptionsDialog page={optionsPage()} onClose={() => setDialog(null)} />
      </Show>
      <Show when={dialog() === "export"}>
        <ExportDialog onClose={() => setDialog(null)} onDone={notify} />
      </Show>
      <Show when={dialog() === "import"}>
        <ImportDialog onClose={() => setDialog(null)} onDone={notify} />
      </Show>
      <Show when={dialog() === "snapshot"}>
        <SnapshotDialog {...snapshotBases()} onClose={() => setDialog(null)} onDone={notify} />
      </Show>
      <Show when={dialog() === "formats"}>
        <FileFormatsDialog onClose={() => setDialog(null)} />
      </Show>
      <Show when={dialog() === "profiles"}>
        <ProfilesDialog onClose={() => setDialog(null)} onDone={notify} />
      </Show>
      <Show when={toast()}>
        <div class="toast" onClick={() => setToast("")}>{toast()}</div>
      </Show>
      <PromptHost />
      <ReplaceHost />
      <ContextMenuHost />
    </div>
  );
}
