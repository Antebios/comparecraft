import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import { dispatchKey } from "../commands";
import { ContextMenuHost } from "../components/ContextMenu";
import MenuBar from "../components/MenuBar";
import { PromptHost } from "../components/Prompt";
import { listen, message, setHost } from "../host";
import { errText } from "../api";
import type { ComparisonListener, ComparisonReceipt } from "../comparisonStatus";
import { loadSettings, settings } from "../settings";
import { closeTab, openTab, state, type Tab } from "../store";
import HexCompare from "../views/HexCompare";
import PatchView from "../views/PatchView";
import PictureCompare from "../views/PictureCompare";
import TableCompare from "../views/TableCompare";
import TextCompare from "../views/TextCompare";
import TextMerge from "../views/TextMerge";
import FolderCompare from "../views/FolderCompare";
import { ReplaceHost } from "../views/folderOps";
import { ModalHost } from "../views/sessionMenu";
import { request, vscode, vscodeHost } from "./host";
import "../styles.css";
import "./vscode.css";

setHost(vscodeHost);

/** Read-only views; the text views report their own state because they track unsaved edits. */
const FILE_VIEWS = ["hex", "table", "picture", "patch"] as const;
type FileView = (typeof FILE_VIEWS)[number];
const isFileView = (kind: unknown): kind is FileView => FILE_VIEWS.includes(kind as FileView);

export interface EmbeddedSpec {
  kind?: "text" | "merge" | "folder" | FileView;
  paths: string[];
  titles?: (string | null)[];
  readOnly?: boolean[];
  options?: Record<string, unknown>;
  restore?: [string[] | null, string[] | null];
  sessionId?: string;
  sessionName?: string;
  locked?: boolean;
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
  const [primaryId, setPrimaryId] = createSignal(props.id);
  const tab = () => state.tabs.find((t) => t.id === primaryId());
  const [error, setError] = createSignal("");
  const transfers = new Set<string>();
  const callbacks = new Map<string, { callback: ComparisonListener; paths: string[]; localId: string }>();
  const earlyReceipts = new Map<string, ComparisonReceipt>();
  const retired = new Set<string>();
  const disposers: (() => void)[] = [];
  const surfaceError = (e: unknown) => {
    const text = `Open comparison failed: ${errText(e)}`;
    setError(text);
    void message(text, { title: "CompareCraft", kind: "error" }).catch(() => {});
  };
  let unlisten: (() => void) | undefined;
  let disposed = false;
  const complete = (token: string, receipt: ComparisonReceipt) => {
    if (retired.has(token)) return;
    const receiver = callbacks.get(token);
    if (!receiver) {
      // A child may finish loading before the openTab response microtask registers its callback.
      if (earlyReceipts.size >= 128) earlyReceipts.delete(earlyReceipts.keys().next().value!);
      earlyReceipts.set(token, receipt);
      return;
    }
    if (!receipt || receipt.paths.length !== receiver.paths.length ||
      receipt.paths.some((path, i) => path !== receiver.paths[i])) return;
    receiver.callback(receipt.paths, receipt.result);
    // Keep the callback for subsequent child saves, but the hidden local tab is no longer needed.
    closeTab(receiver.localId);
    transfers.delete(receiver.localId);
  };
  void listen<{ token: string; receipt: ComparisonReceipt }>("folder-comparison", ({ payload }) => {
    complete(payload.token, payload.receipt);
  }).then((dispose) => { if (disposed) dispose(); else unlisten = dispose; });
  void listen<{ token: string }>("folder-origin-disposed", ({ payload }) => {
    if (retired.size >= 128) retired.delete(retired.values().next().value!);
    retired.add(payload.token);
    const receiver = callbacks.get(payload.token);
    if (receiver) { closeTab(receiver.localId); transfers.delete(receiver.localId); }
    callbacks.delete(payload.token);
    earlyReceipts.delete(payload.token);
  }).then((dispose) => { if (disposed) dispose(); else disposers.push(dispose); });
  onCleanup(() => {
    disposed = true;
    unlisten?.();
    disposers.forEach((dispose) => dispose());
    callbacks.clear();
    earlyReceipts.clear();
    retired.clear();
  });
  // Other views (hex, table, merge, another text compare) open as separate VS Code panels.
  createEffect(() => {
    // Clear Session replaces the primary tab in place, rather than opening another panel.
    if (!tab()) {
      const replacement = state.tabs.find((t) => !transfers.has(t.id));
      if (replacement) { setPrimaryId(replacement.id); scope = replacement.id; }
    }
    for (const t of state.tabs.filter((t) => t.id !== primaryId())) {
      if (transfers.has(t.id)) continue;
      transfers.add(t.id);
      const origin = tab()?.kind === "folder" && !!t.onComparison;
      const callback = t.onComparison;
      const paths = [...t.paths];
      const spec = JSON.parse(JSON.stringify({
        kind: t.kind, paths, titles: t.titles, readOnly: t.readOnly, options: t.options,
        sessionId: t.sessionId, sessionName: t.sessionName, locked: t.locked,
        ...(origin ? { origin: true } : {}),
      }));
      void request<{ originToken: string } | null>("openTab", spec).then((response) => {
        if (disposed) return;
        setError("");
        if (origin && callback && response?.originToken && !retired.has(response.originToken)) {
          // Bound retained callbacks. Evicted associations can no longer affect the parent.
          if (callbacks.size >= 128) {
            const oldest = callbacks.keys().next().value;
            if (oldest !== undefined) {
              closeTab(callbacks.get(oldest)!.localId);
              transfers.delete(callbacks.get(oldest)!.localId);
              callbacks.delete(oldest);
            }
          }
          callbacks.set(response.originToken, { callback, paths, localId: t.id });
          const early = earlyReceipts.get(response.originToken);
          if (early) { earlyReceipts.delete(response.originToken); complete(response.originToken, early); }
        } else { closeTab(t.id); transfers.delete(t.id); }
      }).catch((e) => {
        surfaceError(e);
        closeTab(t.id);
        transfers.delete(t.id);
      });
    }
  });
  // Read-only views persist their files and view options so a window reload restores them.
  createEffect(() => {
    const t = tab();
    if (!t || (!isFileView(t.kind) && t.kind !== "folder")) return;
    vscodeHost.emit?.("text-state", {
      kind: t.kind,
      paths: [...t.paths],
      titles: [...t.titles],
      readOnly: t.paths.map(() => true),
      options: JSON.parse(JSON.stringify(t.options)),
      sessionId: t.sessionId,
      sessionName: t.sessionName,
      locked: t.locked,
      dirty: [false, false],
    });
  });
  const view = (t: Tab) => {
    switch (t.kind) {
      case "folder": return <FolderCompare tab={t} active />;
      case "merge": return <TextMerge tab={t} active />;
      case "hex": return <HexCompare tab={t} active />;
      case "table": return <TableCompare tab={t} active />;
      case "picture": return <PictureCompare tab={t} active />;
      case "patch": return <PatchView tab={t} active />;
      default: return <TextCompare tab={t} active />;
    }
  };
  return (
    <div class="app embedded" classList={{ "no-toolbar": !settings.showToolbar }}>
      <MenuBar scope={primaryId()} />
      <Show when={error()}><div class="error" role="alert">{error()}</div></Show>
      <div class="content">
        <Show when={tab()} keyed>
          {(t) => (
            <div class="tab-view" style={{ display: "flex" }}>
              {view(t)}
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
    // Settings broadcasts update shared libraries/defaults, not the panel's tab options.
    let reloading = false;
    let reloadAgain = false;
    await listen("settings-changed", () => {
      reloadAgain = true;
      if (reloading) return;
      reloading = true;
      void (async () => {
        try {
          while (reloadAgain) { reloadAgain = false; await loadSettings(true); }
        } catch (e) {
          await message(`Reload settings failed: ${errText(e)}`, { title: "CompareCraft", kind: "error" });
        } finally { reloading = false; }
      })().catch((e) => console.error("Settings reload failed", e));
    });
    const options = { ...(spec.options ?? {}) };
    if (spec.restore && spec.kind !== "folder") options.restore = spec.restore;
    const merge = spec.kind === "merge";
    const kind = merge ? "merge" : spec.kind === "folder" ? "folder" : isFileView(spec.kind) ? spec.kind : "text";
    const id = openTab({
      kind,
      paths: spec.paths,
      titles: spec.titles ?? [],
      readOnly: spec.readOnly ?? [],
      options,
      ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
      sessionName: spec.sessionName,
      locked: spec.locked,
      ...(merge ? { output: spec.paths[3] } : {}),
    });
    scope = id;
    render(() => <Embedded id={id} />, root);
  } catch (e) {
    root.textContent = `CompareCraft could not start: ${e instanceof Error ? e.message : String(e)}`;
  }
}

void start();
