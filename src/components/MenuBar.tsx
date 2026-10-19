import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { commandsFor, displayKeys, GROUP_ORDER, isVisible, MENUS, type MenuEntry, type MenuName } from "../commands";
import { MenuList } from "./MenuList";

/** Application menu bar built from the commands registered for the active scope. */
export default function MenuBar(props: { scope: string }) {
  const [open, setOpen] = createSignal<{ m: MenuName; kb: boolean } | null>(null);
  let root!: HTMLDivElement;

  /** Visible commands of a menu, with separators between groups. */
  const items = (m: MenuName): MenuEntry[] => {
    const out: MenuEntry[] = [];
    let group: string | undefined;
    const order = GROUP_ORDER[m];
    const rank = (g?: string) => {
      const i = order!.indexOf(g ?? "");
      return i >= 0 ? i : order!.indexOf("");
    };
    let cmds = commandsFor(props.scope).filter((c) => c.menu === m);
    if (order) cmds = cmds.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c.group) - rank(b.c.group) || a.i - b.i).map((x) => x.c);
    for (const c of cmds) {
      if (c.hidden || !isVisible(c)) continue;
      if (out.length && c.group !== group) out.push("-");
      group = c.group;
      out.push(c);
    }
    return out;
  };
  const menus = () => MENUS.filter((m) => items(m).length > 0);

  const close = () => setOpen(null);
  const onDown = (e: MouseEvent) => {
    if (open() && !root.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "F10" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !document.querySelector(".modal-backdrop")) {
      e.preventDefault();
      e.stopPropagation();
      const first = menus()[0];
      return open() || !first ? close() : setOpen({ m: first, kb: true });
    }
  };
  const step = (dir: 1 | -1) => {
    const ms = menus();
    const i = ms.indexOf(open()!.m);
    setOpen({ m: ms[(i + dir + ms.length) % ms.length], kb: true });
  };
  onMount(() => {
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
  });
  onCleanup(() => {
    window.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", close);
  });

  return (
    <div class="menubar" ref={root}>
      <For each={menus()}>
        {(m) => (
          <div class="menu" classList={{ open: open()?.m === m }}>
            <button
              class="menu-title"
              onMouseDown={(e) => (e.preventDefault(), setOpen(open()?.m === m ? null : { m, kb: false }))}
              onMouseEnter={() => open() && open()!.m !== m && setOpen({ m, kb: false })}
            >
              {m}
            </button>
            <Show when={open()?.m === m ? open() : null} keyed>
              {(o) => <MenuList scope={props.scope} items={items(m)} highlightFirst={o.kb} onClose={close} onEdge={step} />}
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

/** Lists every shortcut available in the current view. */
export function ShortcutList(props: { scope: string }) {
  const rows = () => {
    const seen = new Set<string>();
    return commandsFor(props.scope).filter((c) => c.keys && !seen.has(c.keys) && seen.add(c.keys));
  };
  return (
    <table class="shortcut-table">
      <tbody>
        <For each={MENUS.filter((m) => rows().some((c) => c.menu === m))}>
          {(m) => (
            <>
              <tr>
                <th colSpan={2}>{m}</th>
              </tr>
              <For each={rows().filter((c) => c.menu === m)}>
                {(c) => (
                  <tr>
                    <td>{c.label}</td>
                    <td>
                      <kbd>{displayKeys(c.keys)}</kbd>
                    </td>
                  </tr>
                )}
              </For>
            </>
          )}
        </For>
      </tbody>
    </table>
  );
}
