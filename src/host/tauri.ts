import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { dropPoint, type DropPosition, type Host } from ".";

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
  // The OS handler (WindowConfig.dragDropEnabled) is what supplies real paths for dropped files;
  // the webview's own HTML5 drop events cannot see them.
  onFileDrop: (handler) => {
    // Windows reports physical pixels, macOS and Linux logical ones; path bars are laid out in CSS
    // pixels, so the platform is what decides whether a scale factor applies.
    const at = (position: { x: number; y: number }): DropPosition =>
      dropPoint(position, navigator.userAgent, window.devicePixelRatio);
    return getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "drop") {
        handler({ type: "drop", paths: payload.paths, position: at(payload.position) });
      } else if (payload.type === "leave") {
        handler({ type: "leave" });
      } else {
        // Only the entry event carries the paths; a move only carries the pointer.
        const paths = payload.type === "enter" ? payload.paths : [];
        handler({ type: payload.type, paths, position: at(payload.position) });
      }
    });
  }
};
