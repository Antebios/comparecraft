import { createEffect, Show } from "solid-js";
import { render } from "solid-js/web";
import { dispatchKey } from "../commands";
import { ContextMenuHost } from "../components/ContextMenu";
import MenuBar from "../components/MenuBar";
import { PromptHost } from "../components/Prompt";
import { setHost } from "../host";
import { loadSettings, settings } from "../settings";
import { closeTab, openTab, state, type Tab } from "../store";
import TextCompare from "../views/TextCompare";
import { ReplaceHost } from "../views/folderOps";
import { ModalHost } from "../views/sessionMenu";
import { request, vscode, vscodeHost } from "./host";
import "../styles.css";
import "./vscode.css";

setHost(vscodeHost);

export interface EmbeddedSpec {
  paths: string[];
  titles?: (string | null)[];
  readOnly?: boolean[];
  options?: Record<string, unknown>;
  restore?: [string[] | null, string[] | null];
}

let scope = "";
const handleKey = (e: KeyboardEvent) => {
  if (scope && dispatchKey(e, scope)) e.stopImmediatePropagation();
};
// VS Code's webview wrapper adds its keydown listener to this window before the page loads and
// calls preventDefault on undo/redo/save/find/print chords (keyCodes Z, Y, S, F, P) so the
// workbench can handle them. Claim those chords in the capture phase, before that listener runs.
const WRAPPER_PREVENTED = new Set([90, 89, 83, 70, 80]);
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && WRAPPER_PREVENTED.has(e.keyCode)) handleKey(e);
}, true);
// Other handled chords (Ctrl+R, F5, ...) also must not run workbench keybindings.
window.addEventListener("keydown", handleKey);

function Embedded(props: { id: string }) {
  const tab = () => state.tabs.find((t) => t.id === props.id);
  // Other views (hex, table, merge, another text compare) open as separate VS Code panels.
  createEffect(() => {
    for (const t of state.tabs.filter((t) => t.id !== props.id)) {
      const spec = JSON.parse(JSON.stringify({ kind: t.kind, paths: t.paths, titles: t.titles, readOnly: t.readOnly, options: t.options })) as Pick<Tab, "kind" | "paths" | "titles" | "readOnly" | "options">;
      closeTab(t.id);
      void request("openTab", spec).catch(() => undefined);
    }
  });
  return (
    <div class="app embedded" classList={{ "no-toolbar": !settings.showToolbar }}>
      <MenuBar scope={props.id} />
      <div class="content">
        <Show when={tab()}>
          {(t) => (
            <div class="tab-view" style={{ display: "flex" }}>
              <TextCompare tab={t()} active />
            </div>
          )}
        </Show>
      </div>
      <ModalHost />
      <PromptHost />
      <ReplaceHost />
      <ContextMenuHost />
    </div>
  );
}

async function start() {
  const root = document.getElementById("root")!;
  try {
    const spec = await request<EmbeddedSpec>("init");
    // Persist immediately so a reload before the first edit can still restore the panel.
    vscode.setState(spec);
    await loadSettings();
    const options = { ...(spec.options ?? {}) };
    if (spec.restore) options.restore = spec.restore;
    const id = openTab({ kind: "text", paths: spec.paths, titles: spec.titles ?? [], readOnly: spec.readOnly ?? [], options });
    scope = id;
    render(() => <Embedded id={id} />, root);
  } catch (e) {
    root.textContent = `CompareCraft could not start: ${e instanceof Error ? e.message : String(e)}`;
  }
}

void start();
