import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js";
import { errText } from "../api";
import { editorFontCss, fontSettingForFamily, quoteFontFamily, singleFontFamily } from "../editorFonts";

export default function EditorFontPicker(props: {
  value: string;
  size: number;
  onChange: (value: string) => void;
  listFamilies: () => Promise<string[]>;
}) {
  const id = createUniqueId();
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  let combobox!: HTMLDivElement;
  const [families, setFamilies] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");
  const [open, setOpen] = createSignal(false);
  const [filtering, setFiltering] = createSignal(false);
  const [active, setActive] = createSignal(-1);
  const [probe, setProbe] = createSignal("");
  const [loadable, setLoadable] = createSignal(false);
  let disposed = false;
  let request = 0;
  onCleanup(() => { disposed = true; request++; });

  async function load() {
    const current = ++request;
    setLoading(true);
    setError("");
    try {
      const names = await props.listFamilies();
      if (disposed || current !== request) return;
      setFamilies(names);
    } catch (e) {
      if (disposed || current !== request) return;
      setError(`Could not read installed fonts: ${errText(e)}`);
    } finally {
      if (!disposed && current === request) setLoading(false);
    }
  }
  onMount(() => {
    void load();
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !combobox.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    onCleanup(() => document.removeEventListener("pointerdown", dismissOutside));
  });
  createEffect(() => {
    if (open()) queueMicrotask(() => {
      if (!disposed && open()) list?.scrollIntoView({ block: "nearest" });
    });
  });

  const choices = createMemo(() => {
    const text = singleFontFamily(props.value)?.name ?? props.value;
    const query = filtering() ? text.toLocaleLowerCase().trim() : "";
    return ["", ...families().filter((name) => name.toLocaleLowerCase().includes(query))];
  });
  const selected = (family: string) => {
    if (!family) return !props.value.trim();
    const parsed = singleFontFamily(props.value);
    return !!parsed && !parsed.generic && parsed.name.toLocaleLowerCase() === family.toLocaleLowerCase();
  };
  function choose(family: string) {
    props.onChange(fontSettingForFamily(family));
    setOpen(false);
    setFiltering(false);
    setActive(-1);
    input.focus();
  }
  function move(delta: number) {
    const next = open()
      ? Math.max(0, Math.min(choices().length - 1, active() + delta))
      : delta > 0 ? 0 : choices().length - 1;
    setOpen(true);
    setActive(next);
    list?.querySelector(`#${CSS.escape(`${id}-option-${next}`)}`)?.scrollIntoView({ block: "nearest" });
  }

  createEffect(() => {
    const font = singleFontFamily(props.value);
    setLoadable(false);
    setProbe("");
    if (!font || font.generic || !font.name) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (typeof FontFace === "undefined") {
        setProbe("This WebView cannot verify local font loading. The preview may use a fallback.");
        return;
      }
      try {
        // A failed local() lookup can also mean the face name differs from the family name.
        await new FontFace("CompareCraft font availability probe", `local(${quoteFontFamily(font.name)})`).load();
        if (!cancelled) setLoadable(true);
      } catch (e) {
        if (!cancelled) setProbe(`Could not verify local font loading: ${errText(e)}. The face name may differ, or the font may be unavailable or unsupported; the preview may use a fallback.`);
      }
    }, 200);
    onCleanup(() => { cancelled = true; clearTimeout(timer); });
  });

  const status = createMemo(() => {
    if (!props.value.trim()) return "Default monospace uses the first available font in CompareCraft's default font list.";
    const font = singleFontFamily(props.value);
    if (!font) return "Font family list: the first usable family is used, followed by monospace fallback.";
    if (font.generic) return "Generic font family: the actual font depends on your operating system.";
    const missing = !loading() && !error()
      && !families().some((name) => name.toLocaleLowerCase() === font.name.toLocaleLowerCase());
    if (missing) return `"${font.name}" is not listed among installed fonts. The preview may use a fallback font or system alias. ${probe()}`;
    if (probe()) return probe();
    return loadable()
      ? "The WebView accepted a local font lookup. Check the preview; system aliases and unsupported characters may still use fallback fonts."
      : "Checking local font availability...";
  });

  return (
    <div class="editor-font-picker">
      <label for={`${id}-input`}>Editor font:</label>
      <div
        ref={combobox}
        class="font-combobox"
        onKeyDown={(e) => { if (e.key === "Tab") setOpen(false); }}
      >
        <div class="font-combobox-input">
          <input
            ref={input}
            id={`${id}-input`}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open()}
            aria-controls={`${id}-list`}
            aria-activedescendant={open() && active() >= 0 ? `${id}-option-${active()}` : undefined}
            aria-describedby={`${id}-status ${id}-help`}
            autocomplete="off"
            spellcheck={false}
            placeholder="Default monospace"
            value={props.value}
            onClick={() => { setFiltering(false); setActive(-1); setOpen(true); }}
            onInput={(e) => {
              props.onChange(e.currentTarget.value);
              setFiltering(true);
              setActive(-1);
              setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                move(e.key === "ArrowDown" ? 1 : -1);
              } else if (e.key === "Enter" && open()) {
                e.preventDefault();
                if (active() >= 0) choose(choices()[active()]);
                else setOpen(false);
              } else if (e.key === "Escape" && open()) {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <button
            type="button"
            aria-label="Show installed fonts"
            aria-expanded={open()}
            aria-controls={`${id}-list`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { input.focus(); setFiltering(false); setActive(-1); setOpen(!open()); }}
          >&#9662;</button>
        </div>
        <Show when={open()}>
          <div ref={list} id={`${id}-list`} class="font-list" role="listbox" aria-label="Installed font families">
            <For each={choices()}>
              {(family, index) => (
                <div
                  id={`${id}-option-${index()}`}
                  role="option"
                  aria-selected={selected(family)}
                  classList={{ active: active() === index() }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(family)}
                >{family || "Default monospace"}</div>
              )}
            </For>
          </div>
        </Show>
      </div>
      <Show when={loading()}><p role="status">Loading installed fonts...</p></Show>
      <Show when={error()}>
        <p class="err" role="alert">{error()} <button type="button" onClick={() => void load()}>Retry fonts</button></p>
      </Show>
      <Show when={!loading() && !error() && families().length === 0}>
        <p role="status">No installed font families were returned. You can still enter a custom family.</p>
      </Show>
      <p id={`${id}-help`} class="muted">Choose an installed family or enter a custom name or CSS fallback list. Clear the field for Default monospace.</p>
      <p id={`${id}-status`} class="font-status" role="status">{status()}</p>
      <pre
        class="editor-font-preview"
        aria-label="Editor font preview"
        style={{ "font-family": editorFontCss(props.value), "font-size": `${props.size}px` }}
      >{"AaBb IiLl 0O 1l 0123456789\nleft    = [value]; // sample\nright   = {value}; <> != +-"}</pre>
      <p class="muted">Preview only; Apply or OK changes the editor. Installed fonts must also be supported by this WebView. Legacy bitmap fonts such as original Fixedsys may not render; try an installed scalable monospace font.</p>
    </div>
  );
}
