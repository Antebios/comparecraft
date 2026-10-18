import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { resolveMenu, type MenuEntry, type MenuRef } from "../commands";
import { MenuList } from "./MenuList";

/** A registered command id, an ad-hoc command, or "-" for a separator. */
export type ContextItem = MenuRef;

interface OpenMenu {
  x: number;
  y: number;
  scope: string;
  items: MenuEntry[];
  kb: boolean;
}

const [menu, setMenu] = createSignal<OpenMenu | null>(null);

/**
 * Opens a context menu at the pointer. Items are resolved against the commands
 * registered for `scope`, so labels, shortcuts and enabled/checked state match
 * the menu bar. Unknown or invisible items are skipped, separators collapsed
 * and submenus cascade.
 */
export function showContextMenu(e: MouseEvent, scope: string, items: ContextItem[]) {
  e.preventDefault();
  e.stopPropagation();
  const resolved = resolveMenu(scope, items);
  if (!resolved.length) return;
  // Keyboard-invoked menus (Menu key / Shift+F10) report no pointer position.
  let { clientX: x, clientY: y } = e;
  const kb = (!x && !y) || (e as MouseEvent & { kb?: boolean }).kb === true;
  if (!x && !y) {
    const r = (e.target as HTMLElement).getBoundingClientRect?.();
    if (r) [x, y] = [r.left + 24, r.top + Math.min(r.height, 24)];
  }
  setMenu(null);
  setMenu({ x, y, scope, items: resolved, kb });
}

/** Renders the open context menu; mount once at the application root. */
export function ContextMenuHost() {
  let el: HTMLDivElement | undefined;
  const close = () => setMenu(null);

  const onDown = (e: MouseEvent) => {
    if (menu() && !el?.contains(e.target as Node)) close();
  };
  // Opens the active view's menu for its selection (or its main pane). Views
  // mark the element to prefer with `kb-target`, e.g. the selected side's row.
  const openForKeyboard = () => {
    const visible = (el: Element) => (el as HTMLElement).offsetParent !== null;
    const pick = (sel: string) => [...document.querySelectorAll(sel)].find(visible) as HTMLElement | undefined;
    const el = pick(".view .kb-target") ?? pick(".view .sel") ?? pick(".view .fscroll, .view .tpane, .view .hscroll, .view .tscroll, .view .pics, .view .mtop");
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 4, 120);
    const y = r.top + Math.min(r.height / 2, 12);
    const ev = Object.assign(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }), { kb: true });
    el.dispatchEvent(ev);
  };
  const onKeyOpen = (e: KeyboardEvent) => {
    if (menu() || !(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey))) return;
    if ((e.target as HTMLElement).closest?.("input, textarea, [contenteditable=true]") || document.querySelector(".modal-backdrop")) return;
    e.preventDefault();
    e.stopPropagation();
    openForKeyboard();
  };
  // Suppress the webview's own menu (Reload, Inspect…) except in text fields,
  // where the native Cut/Copy/Paste menu is still useful.
  const onContext = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest?.("input, textarea, [contenteditable=true]")) return;
    e.preventDefault();
  };
  onMount(() => {
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKeyOpen, true);
    window.addEventListener("contextmenu", onContext);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, { passive: true });
  });
  onCleanup(() => {
    window.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("keydown", onKeyOpen, true);
    window.removeEventListener("contextmenu", onContext);
    window.removeEventListener("blur", close);
    window.removeEventListener("resize", close);
    window.removeEventListener("wheel", close);
  });

  return (
    <Show when={menu()} keyed>
      {(m) => (
        <MenuList
          scope={m.scope}
          items={m.items}
          pos={{ x: m.x, y: m.y }}
          highlightFirst={m.kb}
          class="ctx-menu"
          ref={(d) => (el = d)}
          onClose={close}
        />
      )}
    </Show>
  );
}
