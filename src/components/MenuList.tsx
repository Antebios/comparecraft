import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { displayKeys, isEnabled, labelOf, resolveMenu, type Command, type MenuEntry } from "../commands";

export interface MenuListProps {
  scope: string;
  items: MenuEntry[];
  /** Closes the whole menu tree. */
  onClose: () => void;
  /** Closes only this submenu (Left / Escape inside a submenu). */
  onBack?: () => void;
  /** Left/Right at the top level, used by the menu bar to switch menus. */
  onEdge?: (dir: 1 | -1) => void;
  /** Fixed screen position; `altX` is where to align the right edge when there is no room on the right. */
  pos?: { x: number; y: number; altX?: number };
  /** Highlight the first enabled item (menus opened from the keyboard). */
  highlightFirst?: boolean;
  class?: string;
  ref?: (el: HTMLDivElement) => void;
}

/**
 * A drop-down list of commands with cascading submenus, shared by the menu bar
 * and context menus. The innermost open list owns the keyboard: Up/Down move,
 * Right/Enter open a submenu, Left/Escape close it.
 */
export function MenuList(props: MenuListProps) {
  const [hi, setHi] = createSignal(-1);
  const [sub, setSub] = createSignal<{ i: number; x: number; y: number; altX: number; kb: boolean } | null>(null);
  let el!: HTMLDivElement;
  const itemEls: HTMLElement[] = [];

  const enabled = (c: MenuEntry): c is Command => c !== "-" && isEnabled(c, props.scope);
  const firstEnabled = (from: number, step: 1 | -1) => {
    const n = props.items.length;
    let i = from;
    for (let k = 0; k < n; k++) {
      i = (i + step + n) % n;
      if (enabled(props.items[i])) return i;
    }
    return -1;
  };

  const openSub = (i: number, kb: boolean) => {
    const r = itemEls[i]?.getBoundingClientRect();
    if (!r) return;
    setSub({ i, x: r.right - 2, y: r.top - 5, altX: r.left + 2, kb });
  };

  const activate = (i: number, kb: boolean) => {
    const c = props.items[i];
    if (!enabled(c)) return;
    if (c.submenu) return openSub(i, kb);
    props.onClose();
    void c.run();
  };

  const onKey = (e: KeyboardEvent) => {
    if (sub()) return; // the open submenu handles keys
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    e.stopPropagation();
    e.preventDefault();
    const c = props.items[hi()];
    switch (e.key) {
      case "Escape":
        return (props.onBack ?? props.onClose)();
      case "Tab":
        return props.onClose();
      case "ArrowDown":
        return setHi(firstEnabled(hi(), 1));
      case "ArrowUp":
        return setHi(firstEnabled(hi() < 0 ? 0 : hi(), -1));
      case "Home":
        return setHi(firstEnabled(-1, 1));
      case "End":
        return setHi(firstEnabled(0, -1));
      case "ArrowRight":
        if (c && enabled(c) && c.submenu) return openSub(hi(), true);
        return props.onEdge?.(1);
      case "ArrowLeft":
        if (props.onBack) return props.onBack();
        return props.onEdge?.(-1);
      case "Enter":
      case " ":
        return hi() >= 0 && activate(hi(), true);
    }
  };

  createEffect(() => itemEls[hi()]?.scrollIntoView({ block: "nearest" }));

  onMount(() => {
    window.addEventListener("keydown", onKey, true);
    if (props.highlightFirst) setHi(firstEnabled(-1, 1));
    const p = props.pos;
    if (!p) return;
    // Keep the list on screen: flip to the left of the parent item, shift up if needed.
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      let x = p.x;
      if (x + r.width > window.innerWidth - 4) x = Math.max(4, (p.altX ?? x) - r.width);
      let y = p.y;
      if (y + r.height > window.innerHeight - 4) y = Math.max(4, window.innerHeight - r.height - 4);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.visibility = "visible";
    });
  });
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  const style = (): JSX.CSSProperties | undefined => (props.pos ? { left: `${props.pos.x}px`, top: `${props.pos.y}px` } : undefined);

  return (
    <div
      class={`menu-drop ${props.class ?? ""}`}
      role="menu"
      style={style()}
      ref={(d) => {
        el = d;
        props.ref?.(d);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <For each={props.items}>
        {(c, i) =>
          c === "-" ? (
            <div class="menu-sep" />
          ) : (
            <button
              ref={(b) => (itemEls[i()] = b)}
              class="menu-item"
              classList={{ hi: hi() === i(), bold: !!c.isDefault?.(), open: sub()?.i === i() }}
              role="menuitem"
              aria-haspopup={c.submenu ? "menu" : undefined}
              disabled={!isEnabled(c, props.scope)}
              onMouseEnter={() => {
                setHi(i());
                if (sub()?.i === i()) return;
                setSub(null);
                if (c.submenu && enabled(c)) openSub(i(), false);
              }}
              onClick={() => activate(i(), false)}
            >
              <span class="mi-check">{c.checked?.() ? "✓" : ""}</span>
              <span class="mi-label">{labelOf(c)}</span>
              <span class="mi-keys">{c.submenu ? "▸" : displayKeys(c.keys)}</span>
            </button>
          )
        }
      </For>
      <Show when={sub()} keyed>
        {(s) => (
          <MenuList
            scope={props.scope}
            items={resolveMenu(props.scope, (props.items[s.i] as Command).submenu!())}
            pos={{ x: s.x, y: s.y, altX: s.altX }}
            highlightFirst={s.kb}
            class="ctx-menu"
            onClose={props.onClose}
            onBack={() => setSub(null)}
          />
        )}
      </Show>
    </div>
  );
}
