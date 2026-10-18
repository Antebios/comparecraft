import { Show } from "solid-js";

/** Inline find bar (Ctrl+F); Enter = find next, Shift+Enter = previous, Esc = close. */
export default function FindBar(props: {
  query: string;
  onQuery: (q: string) => void;
  matchCase: boolean;
  onMatchCase: (v: boolean) => void;
  onFind: (dir: 1 | -1) => void;
  onClose: () => void;
  status?: string;
  inputRef?: (el: HTMLInputElement) => void;
}) {
  return (
    <div class="findbar">
      <span class="muted">Find</span>
      <input
        class="find-input"
        value={props.query}
        spellcheck={false}
        ref={(el) => {
          props.inputRef?.(el);
          setTimeout(() => (el.focus(), el.select()));
        }}
        onInput={(e) => props.onQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") props.onFind(e.shiftKey ? -1 : 1);
          else if (e.key === "Escape") props.onClose();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      <button class="tb-btn" title="Find Previous (Shift+F3)" onClick={() => props.onFind(-1)}>▲</button>
      <button class="tb-btn" title="Find Next (F3)" onClick={() => props.onFind(1)}>▼</button>
      <label class="muted">
        <input type="checkbox" checked={props.matchCase} onChange={(e) => props.onMatchCase(e.currentTarget.checked)} /> Match case
      </label>
      <Show when={props.status}>
        <span class="muted">{props.status}</span>
      </Show>
      <span class="spacer" />
      <button class="icon-btn" title="Close (Esc)" onClick={props.onClose}>✕</button>
    </div>
  );
}
