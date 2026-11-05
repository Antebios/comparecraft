import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { type Command, type MenuEntry } from "../commands";
import { BUILTIN_PRESETS, METHOD_LABELS, presetDescription, type ComparisonPreset } from "../comparisonPresets";
import { MenuList } from "./MenuList";

export default function ComparisonPresetToolbar(props: {
  scope: string;
  active: ComparisonPreset;
  library: readonly ComparisonPreset[];
  pins: ComparisonPreset[];
  disabledReason: (p: ComparisonPreset) => string | undefined;
  onChoose: (id: string) => void;
  onRun: (p: ComparisonPreset) => void;
  onManage: () => void;
  onDialog: () => void;
  dialogEnabled: boolean;
}) {
  let root!: HTMLDivElement;
  let main!: HTMLDivElement;
  let measure!: HTMLDivElement;
  const [pinCount, setPinCount] = createSignal(0);
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuEntry[]; origin: HTMLButtonElement }>();
  const menuId = `comparison-presets-${props.scope}`;
  const close = () => {
    const origin = menu()?.origin;
    setMenu(undefined);
    origin?.focus();
  };
  const command = (p: ComparisonPreset, execute = false): Command => ({
    id: `${execute ? "run" : "choose"}:${p.id}`, menu: "Actions",
    label: execute ? presetDescription(p) : `${p.name} (${METHOD_LABELS[p.method]}, ${p.scope === "all" ? "All included" : "Selected"})`,
    checked: execute ? undefined : () => props.active.id === p.id,
    enabled: execute ? () => !props.disabledReason(p) : undefined,
    run: () => execute ? props.onRun(p) : props.onChoose(p.id),
  });
  const choices = (): MenuEntry[] => [
    ...(["all", "selected"] as const).map((scope): Command => ({
      id: `preset-scope:${scope}`, menu: "Actions", label: scope === "all" ? "All included files" : "Selected items",
      submenu: () => BUILTIN_PRESETS.filter((p) => p.scope === scope).map(commandChoice),
      run: () => {},
    })),
    ...(props.library.length ? ["-" as const, {
      id: "named-presets", menu: "Actions" as const, label: "My presets",
      submenu: () => props.library.map(commandChoice), run: () => {},
    }] : []),
    "-",
    { id: "manage-presets", menu: "Actions", label: "Manage Comparison Presets...", run: props.onManage },
    { id: "contents-dialog", menu: "Actions", label: "Compare Contents...", enabled: () => props.dialogEnabled, run: props.onDialog },
  ];
  const commandChoice = (p: ComparisonPreset) => command(p);
  const overflow = createMemo(() => props.pins.slice(pinCount()));
  const open = (origin: HTMLButtonElement, items: MenuEntry[]) => {
    if (menu()?.origin === origin) return close();
    const r = origin.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom, items, origin });
  };
  const layout = () => {
    if (!root?.parentElement || !main || !measure) return;
    const toolbar = root.parentElement;
    const siblings = [...toolbar.children].filter((el) => el !== root);
    const occupied = siblings.reduce((sum, el) => sum + el.getBoundingClientRect().width + 4, 0);
    const available = Math.max(main.getBoundingClientRect().width + 64, toolbar.clientWidth - occupied - 20);
    root.style.maxWidth = `${Math.min(toolbar.clientWidth - 12, available)}px`;
    const widths = [...measure.children].map((el) => el.getBoundingClientRect().width + 4);
    let used = main.getBoundingClientRect().width + 64;
    let count = 0;
    for (const width of widths) {
      if (used + width > available) break;
      used += width;
      count++;
    }
    setPinCount(count);
  };
  createEffect(on(() => JSON.stringify([props.pins, props.active, props.library]), () => {
    requestAnimationFrame(layout);
    if (menu()) close();
  }));
  onMount(() => {
    const observer = new ResizeObserver(layout);
    observer.observe(root.parentElement!);
    const outside = (e: MouseEvent) => { if (!root.contains(e.target as Node)) setMenu(undefined); };
    const dismiss = () => setMenu(undefined);
    window.addEventListener("mousedown", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    });
  });
  return (
    <div class="comparison-preset-toolbar" ref={root} role="group" aria-label="Content comparison presets">
      <div class="preset-split" ref={main}>
        <span class="preset-run-wrap" title={props.disabledReason(props.active) ?? presetDescription(props.active)}>
          <button class="tb-btn preset-run" disabled={!!props.disabledReason(props.active)} aria-label={`Run ${presetDescription(props.active)}`}
            aria-description={props.disabledReason(props.active)}
            onClick={() => props.onRun(props.active)}>
            <span>{props.active.name}</span>
            <Show when={!props.active.id.startsWith("builtin:")}><small>{props.active.scope === "all" ? "All" : "Selected"}</small></Show>
          </button>
        </span>
        <button class="tb-btn preset-dropdown" aria-label="Choose comparison preset" aria-haspopup="menu" aria-controls={menuId}
          aria-expanded={menu()?.origin.classList.contains("preset-dropdown") ?? false}
          title="Choose a preset (does not start comparison)"
          onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); open(e.currentTarget, choices()); } }}
          onClick={(e) => open(e.currentTarget, choices())}>▾</button>
      </div>
      <For each={props.pins.slice(0, pinCount())}>{(p) => (
        <span class="preset-pin-wrap" title={props.disabledReason(p) ?? presetDescription(p)}>
          <button class="tb-btn preset-pin" aria-label={`Run pinned ${presetDescription(p)}`} aria-description={props.disabledReason(p)}
            disabled={!!props.disabledReason(p)} onClick={() => props.onRun(p)}>{p.name}</button>
        </span>
      )}</For>
      <Show when={overflow().length}>
        <button class="tb-btn preset-more" aria-label="More pinned comparison presets" aria-haspopup="menu" aria-controls={menuId}
          aria-expanded={menu()?.origin.classList.contains("preset-more") ?? false}
          onClick={(e) => open(e.currentTarget, overflow().map((p) => command(p, true)))}>More ▾</button>
      </Show>
      <div class="preset-measure" aria-hidden="true" ref={measure}>
        <For each={props.pins}>{(p) => <span class="tb-btn preset-pin">{p.name}</span>}</For>
      </div>
      <Show when={menu()} keyed>{(m) => (
        <div id={menuId}>
          <MenuList scope={props.scope} items={m.items} pos={{ x: m.x, y: m.y }} class="ctx-menu" highlightFirst onClose={close} />
        </div>
      )}</Show>
    </div>
  );
}
