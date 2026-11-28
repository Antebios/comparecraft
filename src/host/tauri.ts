import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Host } from ".";

/**
 * Tauri labels drag-and-drop positions physical, but wry passes on each platform's own coordinates:
 * physical pixels on Windows (WebView2), logical pixels on Linux (GTK) and macOS (AppKit).
 */
const dropScale = () => (navigator.userAgent.includes("Windows") ? window.devicePixelRatio || 1 : 1);

/**
 * Where the pointer is during a file drag, in CSS pixels. On Linux the web view also gets its own
 * `dragover` events, whose coordinates are exact whatever the display scaling; elsewhere the native
 * handler takes the drag and only Tauri's position is available.
 */
function dragPointer() {
  let seen: { x: number; y: number; at: number } | null = null;
  const track = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes("Files")) seen = { x: e.clientX, y: e.clientY, at: performance.now() };
  };
  document.addEventListener("dragenter", track, true);
  document.addEventListener("dragover", track, true);
  return {
    reset: () => void (seen = null),
    at(native: { x: number; y: number }) {
      if (seen && performance.now() - seen.at < 1000) return { x: seen.x, y: seen.y };
      const scale = dropScale();
      return { x: native.x / scale, y: native.y / scale };
    },
    stop() {
      document.removeEventListener("dragenter", track, true);
      document.removeEventListener("dragover", track, true);
    },
  };
}

export const tauriHost: Host = {
  name: "tauri",
  listFontFamilies: () => invoke<string[]>("list_font_families"),
  invoke,
  listen,
  ask,
  message,
  open,
  save,
  readText,
  writeText,
  openUrl,
  openPath,
  revealItemInDir,
  window: () => getCurrentWindow(),
  onFileDrop: async (handler) => {
    // Only "enter" and "drop" carry the paths; "over" reuses the ones from "enter".
    let paths: string[] = [];
    const pointer = dragPointer();
    const unlisten = await getCurrentWebview().onDragDropEvent(({ payload: p }) => {
      if (p.type === "leave") {
        paths = [];
        pointer.reset();
        return handler({ type: "leave", x: 0, y: 0 });
      }
      if (p.type !== "over") paths = p.paths;
      handler({ type: p.type, paths, ...pointer.at(p.position) });
      if (p.type === "drop") pointer.reset();
    });
    return () => {
      unlisten();
      pointer.stop();
    };
  },
};
