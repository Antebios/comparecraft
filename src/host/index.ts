// Platform boundary for the shared UI. Desktop registers the Tauri host (./tauri.ts); the VS Code
// webview registers a postMessage host. Only type imports from @tauri-apps are allowed here so a
// webview bundle never pulls in Tauri runtime code.
import type * as Core from "@tauri-apps/api/core";
import type * as Event from "@tauri-apps/api/event";
import type * as Clipboard from "@tauri-apps/plugin-clipboard-manager";
import type * as Dialog from "@tauri-apps/plugin-dialog";
import type * as Opener from "@tauri-apps/plugin-opener";

export interface CloseRequest {
  preventDefault(): void;
}

export interface HostWindow {
  close(): Promise<void>;
  onCloseRequested(handler: (event: CloseRequest) => void | Promise<void>): Promise<() => void>;
}

export interface Host {
  readonly name: "tauri" | "vscode";
  invoke: typeof Core.invoke;
  listen: typeof Event.listen;
  ask: typeof Dialog.ask;
  message: typeof Dialog.message;
  open: typeof Dialog.open;
  save: typeof Dialog.save;
  readText: typeof Clipboard.readText;
  writeText: typeof Clipboard.writeText;
  openUrl: typeof Opener.openUrl;
  openPath: typeof Opener.openPath;
  revealItemInDir: typeof Opener.revealItemInDir;
  window(): HostWindow;
  /** Publishes view state to an embedding host (VS Code). Desktop leaves this undefined. */
  emit?(event: string, payload: unknown): void;
}

let current: Host | undefined;

export function setHost(host: Host): void {
  current = host;
}

export function host(): Host {
  if (!current) throw new Error("CompareCraft host is not initialized.");
  return current;
}

export const isEmbedded = () => current?.name === "vscode";

export const invoke: typeof Core.invoke = (cmd, args, options) => host().invoke(cmd, args, options);
export const listen: typeof Event.listen = (event, handler, options) => host().listen(event, handler, options);
export const ask: typeof Dialog.ask = (text, options) => host().ask(text, options);
export const message: typeof Dialog.message = (text, options) => host().message(text, options);
export const open = ((options) => host().open(options)) as typeof Dialog.open;
export const save: typeof Dialog.save = (options) => host().save(options);
export const readText: typeof Clipboard.readText = () => host().readText();
export const writeText: typeof Clipboard.writeText = (text, options) => host().writeText(text, options);
export const openUrl: typeof Opener.openUrl = (url, openWith) => host().openUrl(url, openWith);
export const openPath: typeof Opener.openPath = (path, openWith) => host().openPath(path, openWith);
export const revealItemInDir: typeof Opener.revealItemInDir = (path) => host().revealItemInDir(path);
export const getCurrentWindow = (): HostWindow => host().window();
export const emit = (event: string, payload: unknown): void => current?.emit?.(event, payload);
