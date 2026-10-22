import { openUrl } from "../host";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { hasPage, highlight, imageUrl, NAV, ONLINE_MANUAL, page, PAGE_ORDER, queryTerms, search, type NavItem } from "../help/manual";

interface Location {
  file: string;
  anchor?: string;
  /** Search terms to mark in the page. */
  marks?: string[];
}

/** The searchable user manual. */
export function HelpViewer(props: { file?: string; onClose: () => void }) {
  const [history, setHistory] = createSignal<Location[]>([{ file: props.file && hasPage(props.file) ? props.file : PAGE_ORDER[0] }]);
  const [pos, setPos] = createSignal(0);
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const loc = () => history()[pos()];
  const current = createMemo(() => page(loc().file));
  const hits = createMemo(() => search(query()));
  let content!: HTMLElement;
  let scroller!: HTMLDivElement;
  let input!: HTMLInputElement;

  const go = (l: Location) => {
    setHistory([...history().slice(0, pos() + 1), l]);
    setPos(pos() + 1);
  };
  const back = () => pos() > 0 && setPos(pos() - 1);
  const forward = () => pos() < history().length - 1 && setPos(pos() + 1);
  const step = (d: 1 | -1) => {
    const i = PAGE_ORDER.indexOf(loc().file) + d;
    if (i >= 0 && i < PAGE_ORDER.length) go({ file: PAGE_ORDER[i] });
  };

  // Render the page, then scroll to the anchor and mark search terms.
  createEffect(
    on(loc, (l) => {
      const p = current();
      content.innerHTML = p ? p.html : `<h1>Page not found</h1><p>${l.file}</p>`;
      for (const img of Array.from(content.querySelectorAll("img"))) {
        const url = imageUrl(img.getAttribute("src") ?? "");
        if (url) img.src = url;
      }
      if (l.marks?.length) markTerms(content, l.marks);
      const target = l.anchor ? content.querySelector(`[id="${CSS.escape(l.anchor)}"]`) : null;
      const mark = content.querySelector("mark.help-hit");
      if (target) target.scrollIntoView({ block: "start" });
      else if (mark) mark.scrollIntoView({ block: "center" });
      else scroller.scrollTop = 0;
    }),
  );

  const onLink = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    e.preventDefault();
    if (/^(https?:|mailto:)/i.test(href)) {
      void openUrl(href);
      return;
    }
    const m = /^([^#?]*\.md)?(?:#(.*))?$/.exec(href);
    if (!m) return;
    const file = m[1] ? m[1].replace(/^\.\//, "") : loc().file;
    if (!m[1] && m[2]) {
      content.querySelector(`[id="${CSS.escape(m[2])}"]`)?.scrollIntoView({ block: "start" });
      return;
    }
    go({ file, anchor: m[2] });
  };

  const openHit = (i: number) => {
    const h = hits()[i];
    if (h) go({ file: h.section.file, anchor: h.section.id || undefined, marks: queryTerms(query()) });
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (query()) setQuery("");
      else props.onClose();
    } else if (e.altKey && e.key === "ArrowLeft") back();
    else if (e.altKey && e.key === "ArrowRight") forward();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      input.focus();
      input.select();
    }
  };
  onMount(() => {
    window.addEventListener("keydown", onKey, true);
    input.focus();
  });
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  const onSearchKey = (e: KeyboardEvent) => {
    const n = hits().length;
    if (e.key === "ArrowDown" && n) setSelected((selected() + 1) % n);
    else if (e.key === "ArrowUp" && n) setSelected((selected() + n - 1) % n);
    else if (e.key === "Enter") openHit(selected());
    else return;
    e.preventDefault();
    document.querySelector(".help-results .selected")?.scrollIntoView({ block: "nearest" });
  };

  const NavTree = (p: { items: NavItem[] }) => (
    <ul>
      <For each={p.items}>
        {(i) => (
          <li>
            <Show when={i.file} fallback={<span class="help-nav-group">{i.title}</span>}>
              <a classList={{ active: loc().file === i.file }} onClick={() => go({ file: i.file! })}>
                {i.title}
              </a>
            </Show>
            <Show when={i.children.length}>
              <NavTree items={i.children} />
            </Show>
          </li>
        )}
      </For>
    </ul>
  );

  const toc = () => current()?.sections.filter((s) => s.level === 2) ?? [];

  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="help-window" role="dialog" aria-label="CompareCraft Help">
        <div class="help-head">
          <button class="icon-btn" title="Back (Alt+Left)" disabled={pos() === 0} onClick={back}>
            ◀
          </button>
          <button class="icon-btn" title="Forward (Alt+Right)" disabled={pos() >= history().length - 1} onClick={forward}>
            ▶
          </button>
          <button class="icon-btn" title="Contents" onClick={() => (setQuery(""), go({ file: PAGE_ORDER[0] }))}>
            ⌂
          </button>
          <span class="help-title">CompareCraft Help</span>
          <span class="spacer" />
          <Show when={ONLINE_MANUAL}>
            <button title={ONLINE_MANUAL} onClick={() => void openUrl(ONLINE_MANUAL)}>
              Online manual ↗
            </button>
          </Show>
          <button class="icon-btn" title="Close (Esc)" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div class="help-main">
          <aside class="help-side">
            <input
              ref={input}
              class="help-search"
              type="search"
              placeholder="Search help (Ctrl+F)"
              value={query()}
              onInput={(e) => (setQuery(e.currentTarget.value), setSelected(0))}
              onKeyDown={onSearchKey}
            />
            <Show when={query().trim()} fallback={<nav class="help-nav"><NavTree items={NAV} /></nav>}>
              <div class="help-results">
                <div class="muted small">{hits().length ? `${hits().length}${hits().length === 60 ? "+" : ""} results` : "No results"}</div>
                <For each={hits()}>
                  {(h, i) => (
                    <a class="help-hit-item" classList={{ selected: selected() === i() }} onClick={() => (setSelected(i()), openHit(i()))}>
                      <span class="help-hit-title" innerHTML={highlight(h.section.title, queryTerms(query()))} />
                      <Show when={h.section.id}>
                        <span class="help-hit-page">{h.section.pageTitle}</span>
                      </Show>
                      <span class="help-hit-snippet" innerHTML={h.snippet} />
                    </a>
                  )}
                </For>
              </div>
            </Show>
          </aside>
          <div class="help-body" ref={scroller}>
            <article class="help-content" ref={content} onClick={onLink} />
            <div class="help-pager">
              <Show when={PAGE_ORDER.indexOf(loc().file) > 0}>
                <a onClick={() => step(-1)}>◀ {page(PAGE_ORDER[PAGE_ORDER.indexOf(loc().file) - 1])?.title}</a>
              </Show>
              <span class="spacer" />
              <Show when={PAGE_ORDER.indexOf(loc().file) < PAGE_ORDER.length - 1}>
                <a onClick={() => step(1)}>{page(PAGE_ORDER[PAGE_ORDER.indexOf(loc().file) + 1])?.title} ▶</a>
              </Show>
            </div>
          </div>
          <Show when={toc().length > 1}>
            <nav class="help-toc">
              <div class="muted small">On this page</div>
              <For each={toc()}>{(s) => <a onClick={() => content.querySelector(`[id="${CSS.escape(s.id)}"]`)?.scrollIntoView({ block: "start" })}>{s.title}</a>}</For>
            </nav>
          </Show>
        </div>
      </div>
    </div>
  );
}

/** Wraps occurrences of the terms in the element's text (outside code blocks) in `<mark class="help-hit">`. */
function markTerms(root: HTMLElement, terms: string[]) {
  const ts = terms.filter((t) => t.length > 1).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!ts.length) return;
  const re = new RegExp(`(${ts.join("|")})`, "giu");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    if (n.parentElement?.closest("pre")) continue;
    re.lastIndex = 0;
    if (re.test(n.data)) nodes.push(n);
  }
  for (const n of nodes) {
    const frag = document.createDocumentFragment();
    n.data.split(re).forEach((part, i) => {
      if (!part) return;
      if (i % 2) {
        const m = document.createElement("mark");
        m.className = "help-hit";
        m.textContent = part;
        frag.appendChild(m);
      } else frag.appendChild(document.createTextNode(part));
    });
    n.replaceWith(frag);
  }
}
