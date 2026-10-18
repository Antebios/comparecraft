import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { createEffect, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { api, type LaunchSpec } from "./api";
import { dispatchKey, registerCommands } from "./commands";
import { Modal } from "./components/common";
import MenuBar, { ShortcutList } from "./components/MenuBar";
import { PromptHost } from "./components/Prompt";
import { ReplaceHost } from "./views/folderOps";
import { ContextMenuHost } from "./components/ContextMenu";
import { activate, closeTab, KIND_LABEL, openSpec, openTab, state, tabTitle, type Tab } from "./store";
import FolderCompare from "./views/FolderCompare";
import HexCompare from "./views/HexCompare";
import Home from "./views/Home";
import PictureCompare from "./views/PictureCompare";
import TableCompare from "./views/TableCompare";
import TextCompare from "./views/TextCompare";
import TextMerge from "./views/TextMerge";

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
      </Switch>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = createSignal<"auto" | "light" | "dark">((localStorage.getItem("comparecraft.theme") as "auto") ?? "auto");
  const applyTheme = (t: "auto" | "light" | "dark") => {
    setTheme(t);
    localStorage.setItem("comparecraft.theme", t);
    document.documentElement.dataset.theme = t;
  };
  applyTheme(theme());

  createEffect(() => {
    state.active;
    queueMicrotask(() => document.querySelector(".tabbar .active")?.scrollIntoView({ inline: "nearest", block: "nearest" }));
  });

  async function requestClose(t: Tab) {
    if (t.dirty && !(await ask(`“${tabTitle(t)}” has unsaved changes. Close anyway?`, { kind: "warning" }))) return;
    closeTab(t.id);
  }

  const [dialog, setDialog] = createSignal<"shortcuts" | "about" | null>(null);
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
    { id: "theme-auto", menu: "View", group: "theme", label: "Theme: Follow System", checked: () => theme() === "auto", run: () => applyTheme("auto") },
    { id: "theme-light", menu: "View", group: "theme", label: "Theme: Light", checked: () => theme() === "light", run: () => applyTheme("light") },
    { id: "theme-dark", menu: "View", group: "theme", label: "Theme: Dark", checked: () => theme() === "dark", run: () => applyTheme("dark") },
    { id: "shortcuts", menu: "Help", label: "Keyboard Shortcuts", keys: "F1", run: () => setDialog("shortcuts") },
    { id: "about", menu: "Help", label: "About CompareCraft", run: () => setDialog("about") },
  ]);

  const onKey = (e: KeyboardEvent) => void dispatchKey(e, state.active);

  onMount(async () => {
    window.addEventListener("keydown", onKey);
    const unlisten = await listen<LaunchSpec>("launch", (e) => void openSpec(e.payload));
    onCleanup(unlisten);
    const win = getCurrentWindow();
    const unClose = await win.onCloseRequested(async (e) => {
      const dirty = state.tabs.filter((t) => t.dirty);
      if (dirty.length && !(await ask(`${dirty.length} tab(s) have unsaved changes. Quit anyway?`, { kind: "warning" }))) e.preventDefault();
    });
    onCleanup(unClose);
    const spec = await api.takeLaunchSpec();
    if (spec) await openSpec(spec);
  });
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div class="app">
      <MenuBar scope={state.active} />
      <div class="tabbar">
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
        <select class="theme-select" value={theme()} onChange={(e) => applyTheme(e.currentTarget.value as "auto")} title="Theme">
          <option value="auto">Auto theme</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <div class="content">
        <div class="tab-view" style={{ display: state.active === "home" ? "flex" : "none" }}>
          <Home />
        </div>
        <For each={state.tabs}>{(t) => <TabView tab={t} />}</For>
      </div>
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
      <PromptHost />
      <ReplaceHost />
      <ContextMenuHost />
    </div>
  );
}
