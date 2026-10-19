import { ask } from "@tauri-apps/plugin-dialog";
import { createResource, createSignal, For, Show } from "solid-js";
import { api, fmtTime, type Session, type ViewKind } from "../api";
import { PathBar } from "../components/common";
import { settings } from "../settings";
import { KIND_LABEL, openAuto, openSession, openTab, sessionsVersion, setSessionsVersion } from "../store";

const NEW_KINDS: { kind: ViewKind; icon: string; help: string }[] = [
  { kind: "folder", icon: "📁", help: "Compare two folder trees and copy, delete or sync items." },
  { kind: "sync", icon: "⇆", help: "Update or mirror one folder into another." },
  { kind: "fmerge", icon: "⑃", help: "Three-way merge of two changed folders against their common base." },
  { kind: "text", icon: "📝", help: "Line-by-line text diff with intraline highlights and editing." },
  { kind: "merge", icon: "🔀", help: "Three-way merge of left/right changes against a common base." },
  { kind: "table", icon: "▦", help: "Cell-by-cell comparison of CSV/TSV data with key columns." },
  { kind: "hex", icon: "⬡", help: "Byte-level comparison of binary files." },
  { kind: "picture", icon: "🖼", help: "Pixel comparison of images with blend and difference modes." },
];

export default function Home() {
  const [a, setA] = createSignal("");
  const [b, setB] = createSignal("");
  const [qcResult, setQcResult] = createSignal("");

  /** Optional "quick compare" verdict for two files before opening a view (Options › Startup). */
  async function compare() {
    setQcResult("");
    if (settings.quickCompareShow) {
      const [ia, ib] = await Promise.all([api.pathInfo(a()), api.pathInfo(b())]);
      if (ia.exists && ib.exists && !ia.isDir && !ib.isDir) {
        const code = await api.quickCompare(a(), b(), settings.quickCompareRules ? "rules" : "binary");
        const text: Record<number, string> = {
          1: "Files are binary same", 2: "Files are the same according to comparison rules", 11: "Files are binary different",
          12: "Files are similar (only unimportant differences)", 13: "Files are different",
        };
        setQcResult(text[code] ?? "Files could not be compared");
        const different = code >= 11 && code < 100;
        if (!(different && settings.quickCompareOpenIfDiff)) return;
      }
    }
    await openAuto([a(), b()]);
  }
  const [sessions, { refetch }] = createResource(sessionsVersion, () => api.listSessions());
  const saved = () => (sessions() ?? []).filter((s) => s.saved);
  const recent = () => (sessions() ?? []).filter((s) => !s.saved).sort((x, y) => y.modified - x.modified);

  async function remove(s: Session) {
    if (!(await ask(`Delete session "${s.name}"?`, { kind: "warning" }))) return;
    await api.deleteSession(s.id);
    setSessionsVersion((v) => v + 1);
    void refetch();
  }

  const list = (items: Session[], empty: string) => (
    <Show when={items.length} fallback={<div class="muted small">{empty}</div>}>
      <ul class="session-list">
        <For each={items}>
          {(s) => (
            <li onDblClick={() => openSession(s)} title={s.paths.filter(Boolean).join("\n")}>
              <span class="s-kind">{KIND_LABEL[s.kind] ?? s.kind}</span>
              <span class="s-name" onClick={() => openSession(s)}>{s.name}</span>
              <span class="s-time muted small">{fmtTime(s.modified)}</span>
              <button class="icon-btn" title="Delete session" onClick={() => remove(s)}>✕</button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );

  return (
    <div class="home">
      <div class="home-col">
        <h2>New session</h2>
        <div class="new-grid">
          <For each={NEW_KINDS}>
            {(k) => (
              <button class="new-card" title={k.help} onClick={() => openTab({ kind: k.kind })}>
                <span class="new-icon">{k.icon}</span>
                <span>{KIND_LABEL[k.kind]}</span>
                <span class="muted small">{k.help}</span>
              </button>
            )}
          </For>
        </div>
        <h2>Quick compare</h2>
        <div class="quick">
          <PathBar value={a()} onCommit={setA} placeholder="Left file or folder…" />
          <PathBar value={b()} onCommit={setB} placeholder="Right file or folder…" />
          <button class="primary" disabled={!a() || !b()} onClick={() => void compare()}>
            Compare
          </button>
          <Show when={qcResult()}>
            <div class="qc-result">
              {qcResult()} <button class="link-btn" onClick={() => void openAuto([a(), b()])}>Open view</button>
            </div>
          </Show>
          <div class="muted small">The viewer is chosen automatically from the file type (folder, text, table, image or binary). Type a path and press Enter, or use ‘…’ to browse.</div>
        </div>
      </div>
      <div class="home-col">
        <h2>Saved sessions</h2>
        {list(saved(), "No saved sessions yet. Use “★ Save Session” in any comparison.")}
        <h2>Recent</h2>
        {list(recent(), "Comparisons you open are listed here automatically.")}
      </div>
    </div>
  );
}
