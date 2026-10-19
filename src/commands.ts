import { createSignal, onCleanup } from "solid-js";
import { settings } from "./settings";

/**
 * Menu names and order follow the reference application's action categories.
 * Folder views use "Actions" where file views use "File"; empty menus are not shown.
 */
export const MENUS = ["Session", "File", "Actions", "Edit", "Search", "View", "Tools", "Help"] as const;
export type MenuName = (typeof MENUS)[number];

export interface Command {
  id: string;
  menu: MenuName;
  label: string;
  /** e.g. "Ctrl+N", "Shift+Ctrl+R", "Alt+Down", "F5", "Ctrl+Plus". Ctrl means ⌘ on macOS. */
  keys?: string;
  /** Additional key bindings that are not displayed. */
  altKeys?: string[];
  run: () => unknown;
  enabled?: () => boolean;
  checked?: () => boolean;
  /** Commands with different groups inside one menu are separated by a divider. */
  group?: string;
  /** Bind the shortcut without listing the command in the menus. */
  hidden?: boolean;
  /** Allow the shortcut while a text input has focus. */
  inInputs?: boolean;
  /** Caption that depends on state (e.g. "Open" vs "Open in New View"); defaults to `label`. */
  caption?: () => string;
  /** When false the command is left out of menus and its shortcut does nothing. */
  visible?: () => boolean;
  /**
   * Makes the command a cascading submenu. Entries are command ids of the same
   * scope, ad-hoc commands or "-". Unless `enabled` says otherwise, a submenu is
   * enabled when any of its entries is (as in the reference application).
   */
  submenu?: () => MenuRef[];
  /** Shown in bold as the default (double-click) action. */
  isDefault?: () => boolean;
}

/**
 * Order of command groups in menus that mix tab and global commands, following the
 * reference application's Session menu. "" stands for any group not listed.
 */
export const GROUP_ORDER: Partial<Record<MenuName, string[]>> = {
  Session: ["start", "tabs", "workspace", "session", "files", "nav", "report", "using", "", "exit"],
};

/** A registered command id, an ad-hoc command, or "-" for a separator. */
export type MenuRef = string | Command;
export type MenuEntry = Command | "-";

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const [scopes, setScopes] = createSignal<Record<string, Command[]>>({});

/** Registers commands for a scope ("global" or a tab id) for the lifetime of the calling component. */
export function registerCommands(scope: string, cmds: Command[]) {
  setScopes((s) => ({ ...s, [scope]: cmds }));
  onCleanup(() =>
    setScopes((s) => {
      const n = { ...s };
      delete n[scope];
      return n;
    }),
  );
}

/** Commands visible for the active scope: tab commands first so they take precedence over global ones. */
export function commandsFor(scope: string): Command[] {
  const s = scopes();
  const all = [...(s[scope] ?? []), ...(s.global ?? [])];
  const km = settings.keymap;
  if (!Object.keys(km).length) return all;
  return all.map((c) => (c.id in km ? { ...c, keys: km[c.id] || undefined, altKeys: km[c.id] ? c.altKeys : [] } : c));
}

/** Every registered command (all scopes), first registration of each id wins; for the Options dialog. */
export function allCommands(): { scope: string; cmd: Command }[] {
  const seen = new Set<string>();
  const out: { scope: string; cmd: Command }[] = [];
  for (const [scope, cmds] of Object.entries(scopes()))
    for (const c of cmds) if (!c.hidden && !seen.has(c.id) && seen.add(c.id)) out.push({ scope, cmd: c });
  return out;
}

export const labelOf = (c: Command) => c.caption?.() ?? c.label;
export const isVisible = (c: Command) => !c.visible || c.visible();

/** Resolves menu references against a scope, dropping hidden items, empty submenus and redundant separators. */
export function resolveMenu(scope: string, refs: MenuRef[]): MenuEntry[] {
  const cmds = commandsFor(scope);
  const out: MenuEntry[] = [];
  for (const r of refs) {
    const c = typeof r === "string" ? (r === "-" ? "-" : cmds.find((x) => x.id === r)) : r;
    if (!c) continue;
    if (c === "-") {
      if (out.length && out[out.length - 1] !== "-") out.push(c);
      continue;
    }
    if (!isVisible(c) || (c.submenu && !resolveMenu(scope, c.submenu()).length)) continue;
    out.push(c);
  }
  while (out[out.length - 1] === "-") out.pop();
  return out;
}

export function isEnabled(c: Command, scope: string): boolean {
  if (!isVisible(c)) return false;
  if (!c.submenu) return !c.enabled || c.enabled();
  if (c.enabled?.()) return true;
  return resolveMenu(scope, c.submenu()).some((x) => x !== "-" && isEnabled(x, scope));
}

const KEY_NAMES: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Delete: "Del",
  Insert: "Ins",
  Backspace: "BkSp",
  Escape: "Esc",
  " ": "Space",
  "+": "Plus",
  "=": "Plus",
  "-": "Minus",
  _: "Minus",
};

/**
 * Normalized key name of a keyboard event. Letters and digits follow the
 * layout's label (so Ctrl+N works on Dvorak/AZERTY); the physical code is the
 * fallback for non-Latin layouts, shifted digits and macOS Option characters.
 */
export function keyName(e: KeyboardEvent): string {
  if (/^[a-z0-9]$/i.test(e.key)) return e.key.toUpperCase();
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (e.code === "NumpadAdd") return "Plus";
  if (e.code === "NumpadSubtract") return "Minus";
  if (/^Numpad[0-9]$/.test(e.code) && !e.getModifierState("NumLock")) return e.code.slice(6);
  return KEY_NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
}

/** Canonical chord string of an event, e.g. "Shift+Ctrl+N". */
export function chordOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.shiftKey) parts.push("Shift");
  if (IS_MAC ? e.metaKey : e.ctrlKey) parts.push("Ctrl");
  if (IS_MAC && e.ctrlKey) parts.push("MacCtrl");
  if (e.altKey) parts.push("Alt");
  parts.push(keyName(e));
  return parts.join("+");
}

export function canonical(keys: string): string {
  const parts = keys.split("+");
  const key = parts.pop()!;
  const order = ["Shift", "Ctrl", "MacCtrl", "Alt"];
  return [...order.filter((m) => parts.includes(m)), key].join("+");
}

/** Human-readable shortcut for menus and tooltips (macOS symbols on Mac). */
export function displayKeys(keys?: string): string {
  if (!keys) return "";
  if (!IS_MAC) return keys.replace("Plus", "+").replace("Minus", "-");
  const map: Record<string, string> = { Shift: "⇧", Ctrl: "⌘", Alt: "⌥", MacCtrl: "⌃", Plus: "+", Minus: "-", Up: "↑", Down: "↓", Left: "←", Right: "→", Enter: "↩", Del: "⌦", BkSp: "⌫" };
  return keys
    .split("+")
    .map((p) => map[p] ?? p)
    .join("");
}

const isTextInput = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
};

// Editing chords that belong to a focused text input rather than the view.
const INPUT_NATIVE = new Set(["Ctrl+A", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+Y", "Shift+Ctrl+Z", "Del", "BkSp", "Ctrl+Del", "Ctrl+BkSp", "Shift+Ctrl+Del", "Shift+Ctrl+BkSp"]);

/** Finds and runs the command bound to the event; returns true if handled. */
export function dispatchKey(e: KeyboardEvent, scope: string): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  if (document.querySelector(".modal-backdrop")) return false;
  const chord = chordOf(e);
  const inInput = isTextInput(e.target);
  const plain = !/(^|\+)(Ctrl|Alt|MacCtrl)\+/.test(chord) && !/^(Shift\+)?F\d+$/.test(chord);
  for (const c of commandsFor(scope)) {
    const bindings = [c.keys, ...(c.altKeys ?? [])].filter(Boolean) as string[];
    if (!bindings.some((k) => canonical(k) === chord)) continue;
    if (inInput && !c.inInputs && (plain || INPUT_NATIVE.has(chord))) return false;
    if (!isVisible(c)) continue;
    e.preventDefault();
    if (isEnabled(c, scope)) void c.run();
    return true;
  }
  // Never let the webview reload, print or open its own find bar.
  if (WEBVIEW_RESERVED.has(chord)) e.preventDefault();
  return false;
}

const WEBVIEW_RESERVED = new Set(["F5", "Ctrl+F5", "Shift+F5", "Ctrl+R", "Shift+Ctrl+R", "Ctrl+P", "Ctrl+F", "Ctrl+G", "Ctrl+N", "Ctrl+O", "Ctrl+S", "F3", "F7", "Ctrl+U", "Shift+Ctrl+I"]);
