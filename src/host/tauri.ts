import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Host } from ".";

export const tauriHost: Host = {
  name: "tauri",
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
  window: () => getCurrentWindow()
};
