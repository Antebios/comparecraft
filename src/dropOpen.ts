// Opening comparisons from files or folders dragged onto the window. The desktop app reports drops
// through the native Tauri handler, which is the only source of real paths; the browser and the
// embedded hosts fall back to DOM drag events, where a path has to be recovered from the payload.
import { api } from "./api";
import { host, type DropPosition, type FileDropEvent } from "./host";
import { openAuto } from "./store";

/** Dispatched on a path bar to fill that side from a drop (PathBar listens for it). */
export const PATH_DROP_EVENT = "comparecraft:path-drop";

/** Windows file URLs carry the drive letter after a leading slash: /C:/dir → C:/dir. */
function fileUriPath(uri: string): string | null {
  if (!/^file:\/\//i.test(uri)) return null;
  try {
    const path = decodeURIComponent(new URL(uri).pathname);
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

/** Absolute paths in a DOM drag payload, as far as the embedding host exposes them. */
function transferPaths(data: DataTransfer | null): string[] {
  if (!data) return [];
  const uris = data
    .getData("text/uri-list")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(fileUriPath)
    .filter((path): path is string => !!path);
  // Some hosts (Electron, some VS Code webviews) attach a real path to each dropped file.
  const files = Array.from(data.files)
    .map((file) => (file as File & { path?: string }).path)
    .filter((path): path is string => !!path);
  // A dragged editor tab or file-manager row can arrive as plain text holding an absolute path.
  const text = data
    .getData("text/plain")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(line));
  return uris.length ? uris : files.length ? files : text;
}

/** Whether a drag carries files rather than in-page content (a selection, a menu item). */
function holdsFiles(data: DataTransfer | null): boolean {
  return !!data && Array.from(data.types).some((type) => type === "Files" || type === "text/uri-list");
}

/**
 * DOM drag and drop for hosts without a native handler. The browser navigates to a dropped file
 * unless both dragover and drop are cancelled, so every event is prevented while files are dragged.
 */
function installDomFileDrop(handle: (event: FileDropEvent) => void): () => void {
  let depth = 0;
  const at = (e: DragEvent): DropPosition => ({ x: e.clientX, y: e.clientY });
  const enter = (e: DragEvent) => {
    if (!holdsFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth++;
    if (depth === 1) handle({ type: "enter", paths: [], position: at(e) });
  };
  const over = (e: DragEvent) => {
    if (!holdsFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    handle({ type: "over", paths: [], position: at(e) });
  };
  const leave = (e: DragEvent) => {
    if (!holdsFiles(e.dataTransfer)) return;
    // relatedTarget is null when the pointer leaves the window, which ends the drag outright.
    depth = e.relatedTarget ? Math.max(0, depth - 1) : 0;
    if (depth === 0) handle({ type: "leave" });
  };
  const drop = (e: DragEvent) => {
    if (!holdsFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth = 0;
    handle({ type: "drop", paths: transferPaths(e.dataTransfer), position: at(e) });
  };
  const listeners: [string, (e: Event) => void][] = [
    ["dragenter", enter as (e: Event) => void],
    ["dragover", over as (e: Event) => void],
    ["dragleave", leave as (e: Event) => void],
    ["drop", drop as (e: Event) => void],
  ];
  for (const [name, listener] of listeners) window.addEventListener(name, listener);
  return () => {
    for (const [name, listener] of listeners) window.removeEventListener(name, listener);
  };
}

/** Reports drops from the native handler when the host has one, and from DOM events otherwise. */
export function installFileDrop(handle: (event: FileDropEvent) => void): () => void {
  const disposers: (() => void)[] = [];
  let live = true;
  const current = host();
  if (current.onFileDrop) {
    void current
      .onFileDrop(handle)
      .then((unlisten) => {
        // The native listener can arrive after the component is gone.
        if (live) disposers.push(unlisten);
        else unlisten();
      })
      .catch((e) => console.error("Native drag and drop is unavailable", e));
  }
  disposers.push(installDomFileDrop(handle));
  return () => {
    live = false;
    for (const dispose of disposers.splice(0)) dispose();
  };
}

/** A drag point wry has not reported yet arrives as 0, 0, which is the window's top-left corner. */
function usable(position: DropPosition | undefined): position is DropPosition {
  return !!position && (position.x !== 0 || position.y !== 0);
}

/** The bar marked as the drop target, kept so a drop without a point still knows its side. */
let hovered: HTMLElement | null = null;

function markTarget(bar: HTMLElement | null) {
  if (bar === hovered) return;
  hovered?.classList.remove("drop-target");
  bar?.classList.add("drop-target");
  hovered = bar;
}

/**
 * Marks the side a drop would fill, so the target is visible before the button is released. Only the
 * class is touched here: the path bars are re-rendered by their views and keep no drop state.
 */
export function previewDropTarget(position: DropPosition | undefined): void {
  markTarget(usable(position) ? pathBarAt(position) : null);
}

/** Ends a drag: no side stays marked. */
export function clearDropTarget(): void {
  markTarget(null);
}

/**
 * The path bar a drop at this position belongs to: the one under the pointer, or, for a drop in the
 * panes below them, the nearest column. Views place their bars in a .paths grid, so the left half of
 * a two-sided comparison resolves to its left bar. Null when no comparison is under the pointer.
 */
function pathBarAt(position: DropPosition): HTMLElement | null {
  const view = document.elementFromPoint(position.x, position.y)?.closest(".tab-view");
  // Only a comparison has sides to fill; a single-sided view (an editor, a patch) keeps its file.
  const group = Array.from(view?.querySelectorAll<HTMLElement>(".paths") ?? []).find(
    (paths) => paths.querySelectorAll(":scope > .pathbar").length > 1,
  );
  const bars = Array.from(group?.querySelectorAll<HTMLElement>(":scope > .pathbar") ?? []);
  if (!bars.length) return null;
  const rects = bars.map((bar) => bar.getBoundingClientRect());
  const inside = rects.findIndex(
    (r) => position.x >= r.left && position.x <= r.right && position.y >= r.top && position.y <= r.bottom,
  );
  if (inside >= 0) return bars[inside];
  const distance = (r: DOMRect) =>
    Math.hypot(
      Math.max(r.left - position.x, 0, position.x - r.right),
      Math.max(r.top - position.y, 0, position.y - r.bottom),
    );
  return bars[rects.reduce((best, r, i) => (distance(r) < distance(rects[best]) ? i : best), 0)];
}

/**
 * Fills the side under the pointer with a single dropped path. Returns false when the drop is not
 * over a comparison, so the caller can open a new tab instead.
 */
export function dropOntoPathBar(position: DropPosition | undefined, path: string): boolean {
  // The marked side takes the drop: it is the side the drag was shown over, so the promise made
  // while dragging holds. A host that reports only a point still resolves it here, and wry's 0, 0
  // means "not reported yet" rather than the window's top-left corner.
  const marked = hovered?.isConnected ? hovered : null;
  const bar = marked ?? (usable(position) ? pathBarAt(position) : null);
  markTarget(null);
  if (!bar) return false;
  bar.dispatchEvent(new CustomEvent<string>(PATH_DROP_EVENT, { detail: path }));
  return true;
}

/**
 * Opens the dropped items: two items in the view their types call for, three or four as a text
 * merge (the fourth is the output), and a single item on its own with the other side left to pick.
 * Nothing is read, copied or moved beyond what the comparison itself loads.
 */
export async function openDroppedPaths(paths: string[], notify: (message: string) => void): Promise<void> {
  const dropped = [...new Set(paths.filter(Boolean))];
  if (!dropped.length) {
    notify("The dropped items have no file-system path here.");
    return;
  }
  const infos = await Promise.all(dropped.map((path) => api.pathInfo(path).catch(() => null)));
  const readable = dropped.map((path, i) => ({ path, info: infos[i] })).filter((item) => item.info?.exists);
  const skipped = dropped.length - readable.length;
  if (!readable.length) {
    notify("Nothing to compare: the dropped items could not be read.");
    return;
  }
  // A folder comparison takes two sides; a text merge takes up to four, the last being the output.
  const limit = readable.some((item) => item.info?.isDir) ? 2 : 4;
  const opened = readable.slice(0, limit).map((item) => item.path);
  if (skipped) notify(`${skipped} dropped item(s) were skipped.`);
  else if (readable.length > limit) notify(`Compared the first ${limit} of ${readable.length} dropped items.`);
  await openAuto(opened);
}
