import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, errText, fmtSize, type PixMode, type PixOptions, type PixResult } from "../api";
import { Btn, PathBar } from "../components/common";
import { displayKeys, registerCommands } from "../commands";
import { showContextMenu } from "../components/ContextMenu";
import { externalCommands } from "../components/external";
import { persistSession, updateTab, type Tab } from "../store";

const DEFAULTS: PixOptions = {
  mode: "tolerance",
  tolerance: 25,
  ghost: true,
  ignoreUnimportant: false,
  blendPct: 50,
  offsetX: 0,
  offsetY: 0,
  background: [0, 0, 0, 0],
  rotate: [0, 0],
  flip: [false, false],
  autoScale: false,
};

/** Extensions decoded by the native engine; other formats are rasterised by the webview. */
const NATIVE = new Set("png jpg jpeg jpe jfif gif bmp dib tif tiff webp ico tga pnm pbm pgm ppm pam qoi".split(" "));
const ext = (p: string) => p.slice(p.lastIndexOf(".") + 1).toLowerCase();

const ZOOM_MIN = 0.01;
const ZOOM_MAX = 20;

interface Source {
  /** URL the webview can display. */
  url: string;
  size: number;
  /** Rasterised PNG for formats the native engine can't decode. */
  raster?: string;
}

function decodeImg(url: string): Promise<HTMLImageElement> {
  const el = new Image();
  el.src = url;
  return el.decode().then(() => el);
}

function toPng(el: HTMLImageElement): string {
  const c = document.createElement("canvas");
  c.width = el.naturalWidth;
  c.height = el.naturalHeight;
  c.getContext("2d")!.drawImage(el, 0, 0);
  return c.toDataURL("image/png");
}

async function loadSource(path: string): Promise<Source> {
  const { url, size } = await api.readDataUrl(path);
  try {
    const el = await decodeImg(url);
    return { url, size, raster: NATIVE.has(ext(path)) ? undefined : toPng(el) };
  } catch {
    return { url: await api.pixImage(path), size };
  }
}

async function pixelData(url: string): Promise<ImageData> {
  const el = await decodeImg(url);
  const c = document.createElement("canvas");
  c.width = el.naturalWidth;
  c.height = el.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(el, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

/** Position of a picture on the shared canvas for a difference offset (left at 0 for positive offsets). */
const place = (side: 0 | 1, off: number) => (off >= 0 ? (side === 0 ? 0 : off) : side === 0 ? -off : 0);

const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();

export default function PictureCompare(props: { tab: Tab; active: boolean }) {
  const tab = () => props.tab;
  const paths = () => [tab().paths[0] ?? "", tab().paths[1] ?? ""] as const;
  const opts = (): PixOptions => ({ ...DEFAULTS, ...((tab().options.pix as Partial<PixOptions> | undefined) ?? {}) });
  const setOpts = (patch: Partial<PixOptions>) => {
    const options = { ...tab().options, pix: { ...opts(), ...patch } };
    updateTab(tab().id, { options });
    void persistSession({ ...tab(), options });
  };

  const [sources, setSources] = createSignal<(Source | null)[]>([null, null]);
  const [errors, setErrors] = createSignal<string[]>(["", ""]);
  const [result, setResult] = createSignal<PixResult | null>(null);
  const [cmpError, setCmpError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [zoom, setZoom] = createSignal(1);
  const [fit, setFit] = createSignal(false);
  const [side, setSide] = createSignal<0 | 1>(0);
  const [hover, setHover] = createSignal<{ x: number; y: number } | null>(null);
  const [pixels, setPixels] = createSignal<(ImageData | null)[]>([null, null]);

  async function load() {
    const out: (Source | null)[] = [];
    const errs: string[] = [];
    for (const p of paths()) {
      if (!p) {
        out.push(null);
        errs.push("");
        continue;
      }
      try {
        out.push(await loadSource(p));
        errs.push("");
      } catch (e) {
        out.push(null);
        errs.push(errText(e) || "Unsupported picture format");
      }
    }
    batch(() => {
      setSources(out);
      setErrors(errs);
    });
  }

  onMount(async () => {
    await load();
    if (paths()[0] && paths()[1]) void persistSession(tab());
  });

  // Re-render the comparison when the pictures or options change (debounced for sliders).
  let seq = 0;
  let timer: number | undefined;
  createEffect(
    on([sources, () => JSON.stringify(opts())], () => {
      const [a, b] = sources();
      const o = opts();
      clearTimeout(timer);
      if (!a || !b) return setResult(null);
      const n = ++seq;
      timer = window.setTimeout(async () => {
        setBusy(true);
        try {
          const r = await api.pixCompare(paths()[0], paths()[1], o, a.raster, b.raster);
          if (n !== seq) return;
          batch(() => {
            setResult(r);
            setCmpError("");
          });
        } catch (e) {
          if (n === seq) setCmpError(errText(e));
        } finally {
          if (n === seq) setBusy(false);
        }
      }, 60);
    }),
  );
  onCleanup(() => clearTimeout(timer));

  /** URLs of the pictures as compared (after rotate/flip/scale). */
  const shown = createMemo(() => [0, 1].map((i) => result()?.sides[i] ?? sources()[i]?.url ?? null));
  createEffect(
    on(shown, (urls) => {
      setPixels([null, null]);
      urls.forEach((u, i) => {
        if (u)
          void pixelData(u)
            .then((d) => setPixels((p) => p.map((x, j) => (j === i ? d : x))))
            .catch(() => undefined);
      });
    }),
  );

  const dims = (i: 0 | 1) => {
    const r = result();
    return r ? (i === 0 ? r.left : r.right) : null;
  };
  const pos = (i: 0 | 1) => ({ x: place(i, opts().offsetX), y: place(i, opts().offsetY) });
  const canvas = () => ({ w: result()?.width ?? 0, h: result()?.height ?? 0 });

  // Zoom and fit-to-window.
  let diffPane: HTMLDivElement | undefined;
  const fitZoom = () => {
    const { w, h } = canvas();
    if (!diffPane || !w || !h) return 1;
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (diffPane.clientWidth - 4) / w, (diffPane.clientHeight - 4) / h));
  };
  const [paneSize, setPaneSize] = createSignal(0);
  const z = () => (fit() ? (paneSize(), fitZoom()) : zoom());
  const setZ = (v: number) => {
    setFit(false);
    setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v)));
  };
  const zoomIn = () => setZ(z() * 1.25);
  const zoomOut = () => setZ(z() / 1.25);
  onMount(() => {
    if (!diffPane) return;
    const ro = new ResizeObserver(() => setPaneSize((n) => n + 1));
    ro.observe(diffPane);
    onCleanup(() => ro.disconnect());
  });

  // Rotate/flip compose as the dihedral group: transform = rotate^r ∘ flipH^f.
  const turn = (q: number) => {
    const i = side();
    const rotate = [...opts().rotate] as [number, number];
    rotate[i] = (rotate[i] + q) % 4;
    setOpts({ rotate });
  };
  const flip = (vertical: boolean) => {
    const i = side();
    const rotate = [...opts().rotate] as [number, number];
    const fl = [...opts().flip] as [boolean, boolean];
    rotate[i] = ((vertical ? 2 : 0) - rotate[i] + 4) % 4;
    fl[i] = !fl[i];
    setOpts({ rotate, flip: fl });
  };
  const blendToggle = () => setOpts({ mode: "blend", blendPct: opts().mode === "blend" && opts().blendPct < 50 ? 100 : 0 });
  const nudge = (dx: number, dy: number) => setOpts({ offsetX: opts().offsetX + dx, offsetY: opts().offsetY + dy });
  const sideName = () => (side() === 0 ? "Left" : "Right");

  const modeCmd = (m: PixMode, label: string, keys: string) => ({
    id: `mode-${m}`,
    menu: "View" as const,
    group: "mode",
    label,
    keys,
    checked: () => opts().mode === m,
    run: () => setOpts({ mode: m }),
  });
  registerCommands(tab().id, [
    { id: "reload", menu: "Session", group: "files", label: "Reload", keys: "F5", run: load },
    modeCmd("tolerance", "Tolerance Mode", "Ctrl+1"),
    modeCmd("range", "Mismatch Range Mode", "Ctrl+2"),
    modeCmd("blend", "Blend Mode", "Ctrl+3"),
    { id: "blend-toggle", menu: "View", group: "mode", label: "Blend Toggle", keys: "F8", run: blendToggle },
    { id: "ghost", menu: "View", group: "opts", label: "Shading (Ghost)", checked: () => opts().ghost, run: () => setOpts({ ghost: !opts().ghost }) },
    {
      id: "ignore-unimportant",
      menu: "View",
      group: "opts",
      label: "Ignore Unimportant Differences",
      checked: () => opts().ignoreUnimportant,
      run: () => setOpts({ ignoreUnimportant: !opts().ignoreUnimportant }),
    },
    { id: "auto-scale", menu: "View", group: "xform", label: "Auto Scale", checked: () => opts().autoScale, run: () => setOpts({ autoScale: !opts().autoScale }) },
    { id: "rotate-cw", menu: "View", group: "xform", label: "Rotate Clockwise", run: () => turn(1) },
    { id: "rotate-ccw", menu: "View", group: "xform", label: "Rotate Counterclockwise", run: () => turn(3) },
    { id: "flip-h", menu: "View", group: "xform", label: "Flip Horizontally", run: () => flip(false) },
    { id: "flip-v", menu: "View", group: "xform", label: "Flip Vertically", run: () => flip(true) },
    { id: "reset-offset", menu: "View", group: "xform", label: "Reset Difference Offset", enabled: () => !!(opts().offsetX || opts().offsetY), run: () => setOpts({ offsetX: 0, offsetY: 0 }) },
    { id: "zoom-in", menu: "View", group: "zoom", label: "Zoom In", keys: "Ctrl+Plus", altKeys: ["Shift+Ctrl+Plus", "Ctrl+="], run: zoomIn },
    { id: "zoom-out", menu: "View", group: "zoom", label: "Zoom Out", keys: "Ctrl+Minus", run: zoomOut },
    { id: "zoom-1", menu: "View", group: "zoom", label: "Actual Size", keys: "Ctrl+0", run: () => setZ(1) },
    { id: "zoom-fit", menu: "View", group: "zoom", label: "Fit to Window", checked: fit, run: () => setFit(!fit()) },
    ...externalCommands(() => tab().paths[side()] || undefined),
  ]);

  const onContext = (e: MouseEvent, s: 0 | 1 | null) => {
    if (s !== null) setSide(s);
    const xform = s === null ? [] : ["rotate-cw", "rotate-ccw", "flip-h", "flip-v", "-"];
    const external = s === null ? [] : ["-", "open-default", "reveal"];
    showContextMenu(e, tab().id, [
      "mode-tolerance",
      "mode-range",
      "mode-blend",
      "-",
      ...xform,
      "auto-scale",
      "reset-offset",
      "-",
      "zoom-in",
      "zoom-out",
      "zoom-1",
      "zoom-fit",
      "-",
      "reload",
      ...external,
    ]);
  };

  // All three panes share the canvas coordinate space and scroll together.
  const panes: HTMLDivElement[] = [];
  let syncing = false;
  const sync = (from: HTMLDivElement) => {
    if (syncing) return;
    syncing = true;
    for (const p of panes) {
      if (p !== from) {
        p.scrollTop = from.scrollTop;
        p.scrollLeft = from.scrollLeft;
      }
    }
    requestAnimationFrame(() => (syncing = false));
  };
  const track = (e: MouseEvent) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.floor((e.clientX - box.left) / z());
    const y = Math.floor((e.clientY - box.top) / z());
    const { w, h } = canvas();
    setHover(x >= 0 && y >= 0 && x < w && y < h ? { x, y } : null);
  };
  const pixelAt = (i: 0 | 1) => {
    const p = hover();
    const d = pixels()[i];
    if (!p || !d) return null;
    const x = p.x - pos(i).x;
    const y = p.y - pos(i).y;
    if (x < 0 || y < 0 || x >= d.width || y >= d.height) return null;
    const o = (y * d.width + x) * 4;
    return [d.data[o], d.data[o + 1], d.data[o + 2], d.data[o + 3]];
  };
  const swatch = (i: 0 | 1) => {
    const c = pixelAt(i);
    return (
      <div class="pix-detail">
        <span class="pix-swatch checker">
          <span style={{ background: c ? `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})` : "transparent" }} />
        </span>
        <span>{i === 0 ? "L" : "R"}</span>
        <code>{c ? `${hex(c[0])}${hex(c[1])}${hex(c[2])}${c[3] !== 255 ? ` α${c[3]}` : ""}` : "—"}</code>
      </div>
    );
  };

  const pixelated = () => (z() >= 2 ? "pixelated" : "auto") as "pixelated" | "auto";
  const stage = (body: () => unknown) => (
    <div class="pix-stage" style={{ width: `${canvas().w * z()}px`, height: `${canvas().h * z()}px` }} onMouseMove={track} onMouseLeave={() => setHover(null)}>
      {body() as never}
    </div>
  );
  const sidePane = (i: 0 | 1) => (
    <div
      class="pic-pane checker"
      classList={{ focused: side() === i }}
      ref={(el) => (panes[i] = el)}
      onScroll={(e) => sync(e.currentTarget)}
      onMouseDown={() => setSide(i)}
      onContextMenu={(e) => onContext(e, i)}
    >
      <Show when={errors()[i]}>
        <div class="pix-msg err-text">{errors()[i]}</div>
      </Show>
      <Show when={shown()[i] && dims(i)}>
        {stage(() => (
          <img
            src={shown()[i]!}
            draggable={false}
            style={{
              left: `${pos(i).x * z()}px`,
              top: `${pos(i).y * z()}px`,
              width: `${dims(i)!.width * z()}px`,
              height: `${dims(i)!.height * z()}px`,
              "image-rendering": pixelated(),
            }}
          />
        ))}
      </Show>
    </div>
  );

  const info = (i: 0 | 1) => {
    if (errors()[i]) return <span class="err-text">{errors()[i]}</span>;
    const s = sources()[i];
    const d = dims(i);
    return s && d ? (
      <span class="muted small">
        {d.width}×{d.height} · {s.raster ? ext(paths()[i]).toUpperCase() : d.format}
        {d.hasAlpha ? " · alpha" : ""} · {fmtSize(s.size)}
      </span>
    ) : undefined;
  };
  function setPath(i: 0 | 1, p: string) {
    const next = [...tab().paths];
    next[i] = p;
    updateTab(tab().id, { paths: next });
    void load().then(() => persistSession(tab()));
  }

  const counts = () => result()?.counts;
  const differs = () => {
    const c = counts();
    return !!c && c.important + (opts().ignoreUnimportant ? 0 : c.unimportant) + c.leftOrphan + c.rightOrphan > 0;
  };
  const plural = (n: number, s: string) => `${n.toLocaleString()} ${s}${n === 1 ? "" : "s"}`;

  return (
    <div class="view">
      <div class="toolbar">
        <div class="seg">
          <Btn title="Tolerance mode" kbd={displayKeys("Ctrl+1")} active={opts().mode === "tolerance"} onClick={() => setOpts({ mode: "tolerance" })}>
            Tolerance
          </Btn>
          <Btn title="Mismatch range mode" kbd={displayKeys("Ctrl+2")} active={opts().mode === "range"} onClick={() => setOpts({ mode: "range" })}>
            Range
          </Btn>
          <Btn title="Blend mode" kbd={displayKeys("Ctrl+3")} active={opts().mode === "blend"} onClick={() => setOpts({ mode: "blend" })}>
            Blend
          </Btn>
        </div>
        <span class="sep" />
        <Btn title={`Rotate ${sideName()} picture clockwise`} onClick={() => turn(1)}>⟳ CW</Btn>
        <Btn title={`Rotate ${sideName()} picture counterclockwise`} onClick={() => turn(3)}>⟲ CCW</Btn>
        <Btn title={`Flip ${sideName()} picture horizontally`} onClick={() => flip(false)}>⇋ Horz</Btn>
        <Btn title={`Flip ${sideName()} picture vertically`} onClick={() => flip(true)}>⇵ Vert</Btn>
        <Btn title="Scale the smaller picture to match the bigger one" active={opts().autoScale} onClick={() => setOpts({ autoScale: !opts().autoScale })}>
          ⤢ Bigger
        </Btn>
        <span class="sep" />
        <Btn title="Zoom out" kbd={displayKeys("Ctrl+Minus")} onClick={zoomOut}>−</Btn>
        <span class="tb-label">{Math.round(z() * 100)}%</span>
        <Btn title="Zoom in" kbd={displayKeys("Ctrl+Plus")} onClick={zoomIn}>+</Btn>
        <Btn title="Actual size" kbd={displayKeys("Ctrl+0")} onClick={() => setZ(1)}>1:1</Btn>
        <Btn title="Fit to window" active={fit()} onClick={() => setFit(!fit())}>Fit</Btn>
        <span class="sep" />
        <Btn title="Reload" kbd="F5" onClick={load}>⟳ Refresh</Btn>
      </div>
      <div class="paths two">
        <PathBar value={paths()[0]} title={tab().titles?.[0]} onCommit={(p) => setPath(0, p)} info={info(0)} />
        <PathBar value={paths()[1]} title={tab().titles?.[1]} onCommit={(p) => setPath(1, p)} info={info(1)} />
      </div>
      <div class="pix-body">
        <div class="pics">
          {sidePane(0)}
          {sidePane(1)}
        </div>
        <div class="pix-bottom">
          <div
            class="pic-pane checker"
            ref={(el) => {
              panes[2] = el;
              diffPane = el;
            }}
            onScroll={(e) => sync(e.currentTarget)}
            onContextMenu={(e) => onContext(e, null)}
          >
            <Show when={cmpError()}>
              <div class="pix-msg err-text">{cmpError()}</div>
            </Show>
            <Show when={result()?.image && canvas().w}>
              {stage(() => <img src={result()!.image} draggable={false} style={{ width: "100%", height: "100%", "image-rendering": pixelated() }} />)}
            </Show>
          </div>
          <div class="pix-controls">
            <fieldset>
              <legend>Difference</legend>
              <For each={[["tolerance", "Tolerance"], ["range", "Mismatch range"], ["blend", "Blend"]] as const}>
                {([m, label]) => (
                  <label>
                    <input type="radio" name={`pixmode-${tab().id}`} checked={opts().mode === m} onChange={() => setOpts({ mode: m })} /> {label}
                  </label>
                )}
              </For>
            </fieldset>
            <Show when={opts().mode === "tolerance"}>
              <label class="pix-slider" title="Largest per-channel difference that is unimportant (blue); larger differences are important (red)">
                <span>
                  Tolerance <b>{opts().tolerance}</b>
                </span>
                <input type="range" min="0" max="255" value={opts().tolerance} onInput={(e) => setOpts({ tolerance: +e.currentTarget.value })} />
              </label>
              <label>
                <input type="checkbox" checked={opts().ghost} onChange={() => setOpts({ ghost: !opts().ghost })} /> Shading
              </label>
              <label>
                <input type="checkbox" checked={opts().ignoreUnimportant} onChange={() => setOpts({ ignoreUnimportant: !opts().ignoreUnimportant })} /> Ignore unimportant
              </label>
            </Show>
            <Show when={opts().mode === "blend"}>
              <label class="pix-slider" title="Weight of the right picture">
                <span>
                  Blend <b>{opts().blendPct}%</b>
                </span>
                <input type="range" min="0" max="100" value={opts().blendPct} onInput={(e) => setOpts({ blendPct: +e.currentTarget.value })} />
              </label>
              <Btn title="Switch between the left and right picture" kbd="F8" onClick={blendToggle}>
                Blend toggle
              </Btn>
            </Show>
            <fieldset>
              <legend>Offset</legend>
              <div class="pix-offset">
                <label>
                  X <input type="number" class="num" value={opts().offsetX} onChange={(e) => setOpts({ offsetX: Math.trunc(+e.currentTarget.value || 0) })} />
                </label>
                <label>
                  Y <input type="number" class="num" value={opts().offsetY} onChange={(e) => setOpts({ offsetY: Math.trunc(+e.currentTarget.value || 0) })} />
                </label>
              </div>
              <div class="pix-nudge">
                <button title="Move right picture left" onClick={() => nudge(-1, 0)}>←</button>
                <button title="Move right picture up" onClick={() => nudge(0, -1)}>↑</button>
                <button title="Move right picture down" onClick={() => nudge(0, 1)}>↓</button>
                <button title="Move right picture right" onClick={() => nudge(1, 0)}>→</button>
                <button title="Reset difference offset" disabled={!opts().offsetX && !opts().offsetY} onClick={() => setOpts({ offsetX: 0, offsetY: 0 })}>
                  Reset
                </button>
              </div>
            </fieldset>
            <fieldset>
              <legend>Pixel details</legend>
              <div class="muted small">{hover() ? `x ${hover()!.x}, y ${hover()!.y}` : "Hover over a picture"}</div>
              {swatch(0)}
              {swatch(1)}
            </fieldset>
          </div>
        </div>
      </div>
      <div class="statusbar">
        <Show when={counts()} fallback={<span class="muted">{busy() ? "Comparing…" : "Load two pictures to compare."}</span>}>
          {(c) => (
            <>
              <span classList={{ "st-same": !differs(), "st-diff": differs() }}>{differs() ? "Pictures differ" : "Pictures are the same"}</span>
              <span class="muted">
                {" · "}
                {plural(c().same, "same pixel")}
                <Show when={c().unimportant}> · {plural(c().unimportant, `${opts().ignoreUnimportant ? "ignored " : ""}unimportant difference pixel`)}</Show>
                <Show when={c().important}> · {plural(c().important, "important difference pixel")}</Show>
                <Show when={c().leftOrphan}> · {plural(c().leftOrphan, "left orphan pixel")}</Show>
                <Show when={c().rightOrphan}> · {plural(c().rightOrphan, "right orphan pixel")}</Show>
                <Show when={busy()}> · comparing…</Show>
              </span>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
