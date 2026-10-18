import { api } from "../api";
import { displayKeys, type Command, type MenuRef } from "../commands";
import { activate, openSession, type Tab } from "../store";
import { Btn } from "./common";
import { showContextMenu } from "./ContextMenu";

/** Opens a menu of `items` below a toolbar button. */
export function dropDown(button: Element, scope: string, items: MenuRef[]) {
  const r = button.getBoundingClientRect();
  showContextMenu(new MouseEvent("contextmenu", { clientX: r.left, clientY: r.bottom }), scope, items);
}

/** Lists the saved sessions of this view's kind; picking one opens it. */
export async function sessionsMenu(button: Element, tab: Tab) {
  const list = (await api.listSessions().catch(() => [])).filter((s) => s.saved && s.kind === tab.kind).sort((a, b) => a.name.localeCompare(b.name));
  const items: Command[] = list.length
    ? list.map((s) => ({ id: `sess-${s.id}`, menu: "Session", label: s.name, run: () => openSession(s) }))
    : [{ id: "sess-none", menu: "Session", label: "(No saved sessions)", enabled: () => false, run: () => {} }];
  dropDown(button, tab.id, items);
}

/** The leading Home / Sessions toolbar buttons shared by the file views. */
export function SessionButtons(props: { tab: Tab }) {
  return (
    <>
      <Btn title="Home: show the Home view" kbd={displayKeys("Alt+Home")} onClick={() => activate("home")}>⌂ Home</Btn>
      <button class="tb-btn" title="Sessions: open a saved session of this type" onClick={(e) => void sessionsMenu(e.currentTarget, props.tab)}>
        ☰ Sessions ▾
      </button>
      <span class="sep" />
    </>
  );
}
