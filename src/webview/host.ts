// VS Code webview implementation of the shared UI host. Every privileged operation is a
// request to the extension, which validates it; the webview has no file system access.
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import type { Host } from "../host";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();

type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void };
const pending = new Map<number, Pending>();
const listeners = new Map<string, Set<EventCallback<unknown>>>();
let nextId = 1;

window.addEventListener("message", (event: MessageEvent) => {
  const m = event.data as { type?: string; id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; payload?: unknown };
  if (m?.type === "response" && typeof m.id === "number") {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(m.error ?? "Request failed");
  } else if (m?.type === "event" && typeof m.event === "string") {
    for (const handler of listeners.get(m.event) ?? []) handler({ event: m.event as never, id: 0, payload: m.payload });
  }
});

export function request<T>(method: string, params?: unknown): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    vscode.postMessage({ type: "request", id, method, params });
  });
}

let stateTimer: number | undefined;
let lastState: unknown;
/** Debounced: view state is mirrored for reload restore and lossless close. */
function publishState(state: unknown) {
  lastState = JSON.parse(JSON.stringify(state));
  clearTimeout(stateTimer);
  stateTimer = window.setTimeout(() => {
    vscode.setState(lastState);
    vscode.postMessage({ type: "state", state: lastState });
  }, 250);
}

const dialogOptions = (options: unknown) => (typeof options === "string" ? { title: options } : options ?? {});

export const vscodeHost: Host = {
  name: "vscode",
  invoke: (cmd, args) => request("invoke", { cmd, args: args ?? {} }),
  listen: async <T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> => {
    const set = listeners.get(event) ?? new Set();
    listeners.set(event, set);
    const h = handler as EventCallback<unknown>;
    set.add(h);
    return () => void set.delete(h);
  },
  ask: (message, options) => request("ask", { message, ...dialogOptions(options) }),
  message: (message, options) => request("message", { message, ...dialogOptions(options) }),
  open: ((options) => request("open", options ?? {})) as Host["open"],
  save: (options) => request("save", options ?? {}),
  readText: () => request("clipboard.read"),
  writeText: (text) => request("clipboard.write", { text }),
  openUrl: (url) => request("openUrl", { url: String(url) }),
  openPath: (path) => request("openPath", { path }),
  revealItemInDir: (path) => request("reveal", { path: Array.isArray(path) ? path[0] : path }),
  window: () => ({
    close: () => request("close"),
    onCloseRequested: async () => () => {},
  }),
  emit(event, payload) {
    if (event === "text-state") publishState(payload);
  },
};
