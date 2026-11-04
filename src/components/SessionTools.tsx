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

/** Primary smart-save action with an adjacent menu for explicit Save As. */
export function SessionSaveButton(props: { tab: Tab; onSave: () => void }) {
  const enabled = () => props.tab.paths.some(Boolean);
  return (
    <div class="session-save-split" role="group" aria-label="Save session">
      <Btn
        title={props.tab.sessionName && !props.tab.locked ? `Save changes to ${props.tab.sessionName}` : "Save this comparison as a named session"}
        kbd={displayKeys("Shift+Ctrl+S")}
        disabled={!enabled()}
        onClick={props.onSave}
      >
        ★ Save Session
      </Btn>
      <button
        class="tb-btn session-save-menu"
        title="More session save options"
        aria-label="More session save options"
        aria-haspopup="menu"
        disabled={!enabled()}
        onClick={(event) => dropDown(event.currentTarget, props.tab.id, ["save-session", "-", "save-session-as"])}
      >
        ▾
      </button>
    </div>
  );
}
