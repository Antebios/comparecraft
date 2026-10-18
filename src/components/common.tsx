import { open, save } from "@tauri-apps/plugin-dialog";
import { createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";

export function PathBar(props: {
  value: string;
  onCommit: (path: string) => void;
  folder?: boolean;
  placeholder?: string;
  title?: string | null;
  readOnly?: boolean;
  dirty?: boolean;
  saveDialog?: boolean;
  info?: JSX.Element;
}) {
  const [text, setText] = createSignal(props.value);
  createEffect(() => setText(props.value));
  const browse = async () => {
    const picked = props.saveDialog
      ? await save({ defaultPath: props.value || undefined })
      : await open({ directory: !!props.folder, multiple: false, defaultPath: props.value || undefined });
    if (typeof picked === "string") {
      setText(picked);
      props.onCommit(picked);
    }
  };
  return (
    <div class="pathbar" classList={{ dirty: !!props.dirty }}>
      {props.title ? (
        <div class="path-title" title={props.value}>
          {props.title}
        </div>
      ) : (
        <input
          class="path-input"
          value={text()}
          placeholder={props.placeholder ?? (props.folder ? "Folder path…" : "File path…")}
          spellcheck={false}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") props.onCommit(text().trim());
          }}
          onBlur={() => {
            if (text().trim() !== props.value) props.onCommit(text().trim());
          }}
        />
      )}
      {props.readOnly && <span class="badge" title="Read-only">RO</span>}
      {props.dirty && <span class="badge warn" title="Unsaved changes">●</span>}
      <button class="icon-btn" title="Browse…" onClick={browse}>
        …
      </button>
      {props.info}
    </div>
  );
}

export function Btn(props: {
  onClick: () => void;
  title: string;
  children: JSX.Element;
  disabled?: boolean;
  active?: boolean;
  kbd?: string;
}) {
  return (
    <button
      class="tb-btn"
      classList={{ active: !!props.active }}
      disabled={props.disabled}
      title={props.kbd ? `${props.title} (${props.kbd})` : props.title}
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  );
}

export const ROW_H = 20;

/** Tracks size of a scroll container and computes a virtual window. */
export function useViewport(el: () => HTMLElement | undefined) {
  const [height, setHeight] = createSignal(600);
  const [scrollTop, setScrollTop] = createSignal(0);
  onMount(() => {
    const e = el();
    if (!e) return;
    const ro = new ResizeObserver(() => setHeight(e.clientHeight));
    ro.observe(e);
    setHeight(e.clientHeight);
    onCleanup(() => ro.disconnect());
  });
  const range = (count: number, rowH = ROW_H, overscan = 12) => {
    const start = Math.max(0, Math.floor(scrollTop() / rowH) - overscan);
    const end = Math.min(count, Math.ceil((scrollTop() + height()) / rowH) + overscan);
    return { start, end };
  };
  return { height, scrollTop, setScrollTop, range };
}

/** Renders a line with highlighted UTF-16 ranges. */
export function Highlighted(props: { text: string; spans?: [number, number][]; cls: string }) {
  const parts = () => {
    const t = props.text;
    const sp = props.spans;
    if (!sp || sp.length === 0) return [{ s: t, h: false }];
    const out: { s: string; h: boolean }[] = [];
    let pos = 0;
    for (const [a, b] of sp) {
      if (a > pos) out.push({ s: t.slice(pos, a), h: false });
      out.push({ s: t.slice(a, b), h: true });
      pos = b;
    }
    if (pos < t.length) out.push({ s: t.slice(pos), h: false });
    return out;
  };
  return <>{parts().map((p) => (p.h ? <span class={props.cls}>{p.s}</span> : p.s))}</>;
}

export function Modal(props: { title: string; onClose: () => void; children: JSX.Element; wide?: boolean }) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));
  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal" classList={{ wide: !!props.wide }}>
        <div class="modal-head">
          <span>{props.title}</span>
          <button class="icon-btn" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div class="modal-body">{props.children}</div>
      </div>
    </div>
  );
}
