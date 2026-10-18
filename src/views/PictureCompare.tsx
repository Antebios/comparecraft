import { createEffect, createSignal, onMount, Show } from "solid-js";
import { api, errText, fmtSize } from "../api";
import { Btn, PathBar } from "../components/common";
import { displayKeys, registerCommands } from "../commands";
import { showContextMenu } from "../components/ContextMenu";
import { externalCommands, sideOf } from "../components/external";
import { persistSession, updateTab, type Tab } from "../store";

type Mode = "side" | "blend" | "diff";

interface Img {
  el: HTMLImageElement;
  data: ImageData;
  size: number;
}

async function loadImage(path: string): Promise<Img> {
  const { url, size } = await api.readDataUrl(path);
  const el = new Image();
  el.src = url;
  await el.decode();
  const c = document.createElement("canvas");
  c.width = el.naturalWidth;
  c.height = el.naturalHeight;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(el, 0, 0);
  return { el, data: ctx.getImageData(0, 0, c.width, c.height), size };
}

export default function PictureCompare(props: { tab: Tab; active: boolean }) {
  const tab = () => props.tab;
  const left = () => tab().paths[0] ?? "";
  const right = () => tab().paths[1] ?? "";
  const [imgs, setImgs] = createSignal<(Img | null)[]>([null, null]);
  const [errors, setErrors] = createSignal<string[]>(["", ""]);
  const [mode, setMode] = createSignal<Mode>("side");
  const [tolerance, setTolerance] = createSignal(0);
  const [blend, setBlend] = createSignal(50);
  const [zoom, setZoom] = createSignal(1);
  const [ctxSide, setCtxSide] = createSignal<0 | 1>(0);
  const [stats, setStats] = createSignal<{ diff: number; total: number } | null>(null);
  let diffCanvas!: HTMLCanvasElement;

  async function load() {
    const out: (Img | null)[] = [];
    const errs: string[] = [];
    for (const p of [left(), right()]) {
      if (!p) {
        out.push(null);
        errs.push("");
        continue;
      }
      try {
        out.push(await loadImage(p));
        errs.push("");
      } catch (e) {
        out.push(null);
        errs.push(errText(e) || "Unsupported image format");
      }
    }
    setImgs(out);
    setErrors(errs);
  }

  onMount(async () => {
    await load();
    if (left() && right()) void persistSession(tab());
  });

  // Compute pixel differences whenever images or tolerance change.
  createEffect(() => {
    const [a, b] = imgs();
    const tol = tolerance();
    if (!a || !b) return setStats(null);
    const w = Math.max(a.data.width, b.data.width);
    const h = Math.max(a.data.height, b.data.height);
    const out = new ImageData(w, h);
    let diff = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const inA = x < a.data.width && y < a.data.height;
        const inB = x < b.data.width && y < b.data.height;
        let different = inA !== inB;
        let gray = 0;
        if (inA && inB) {
          const ia = (y * a.data.width + x) * 4;
          const ib = (y * b.data.width + x) * 4;
          let m = 0;
          for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(a.data.data[ia + c] - b.data.data[ib + c]));
          different = m > tol;
          gray = (a.data.data[ia] * 0.3 + a.data.data[ia + 1] * 0.59 + a.data.data[ia + 2] * 0.11) * 0.35 + 140;
        }
        if (different) {
          diff++;
          out.data.set([230, 40, 40, 255], o);
        } else out.data.set([gray, gray, gray, 255], o);
      }
    }
    setStats({ diff, total: w * h });
    if (diffCanvas) {
      diffCanvas.width = w;
      diffCanvas.height = h;
      diffCanvas.getContext("2d")!.putImageData(out, 0, 0);
    }
  });

  function setPath(i: 0 | 1, p: string) {
    const paths = [...tab().paths];
    paths[i] = p;
    updateTab(tab().id, { paths });
    void load().then(() => persistSession(tab()));
  }

  const zoomIn = () => setZoom(Math.min(16, zoom() * 1.25));
  const zoomOut = () => setZoom(Math.max(0.05, zoom() / 1.25));
  const modeCmd = (m: Mode, label: string) => ({ id: `mode-${m}`, menu: "View" as const, group: "mode", label, checked: () => mode() === m, run: () => setMode(m) });
  registerCommands(tab().id, [
    { id: "reload", menu: "Session", group: "files", label: "Reload", keys: "F5", run: load },
    modeCmd("side", "Side by Side"),
    modeCmd("blend", "Blend"),
    modeCmd("diff", "Differences"),
    { id: "toggle-blend", menu: "View", group: "mode", label: "Toggle Blend", keys: "F8", run: () => setMode(mode() === "blend" ? "side" : "blend") },
    { id: "zoom-in", menu: "View", group: "zoom", label: "Zoom In", keys: "Ctrl+Plus", altKeys: ["Shift+Ctrl+Plus"], run: zoomIn },
    { id: "zoom-out", menu: "View", group: "zoom", label: "Zoom Out", keys: "Ctrl+Minus", run: zoomOut },
    { id: "zoom-1", menu: "View", group: "zoom", label: "Actual Size", keys: "Ctrl+0", run: () => setZoom(1) },
    ...externalCommands(() => tab().paths[ctxSide()] || undefined),
  ]);
  const onContext = (e: MouseEvent) => {
    setCtxSide(mode() === "side" ? sideOf(e) : 0);
    showContextMenu(e, tab().id, ["mode-side", "mode-blend", "mode-diff", "-", "zoom-in", "zoom-out", "zoom-1", "-", "reload", "-", "open-default", "reveal"]);
  };

  const imgStyle = (im: Img) => ({
    width: `${im.data.width * zoom()}px`,
    height: `${im.data.height * zoom()}px`,
    "image-rendering": (zoom() >= 2 ? "pixelated" : "auto") as "pixelated" | "auto",
  });
  const diffDims = () => {
    const [a, b] = imgs();
    return a && b ? { w: Math.max(a.data.width, b.data.width), h: Math.max(a.data.height, b.data.height) } : { w: 0, h: 0 };
  };

  const info = (i: number) => {
    const im = imgs()[i];
    if (errors()[i]) return <span class="err-text">{errors()[i]}</span>;
    return im ? <span class="muted small">{im.data.width}×{im.data.height} · {fmtSize(im.size)}</span> : undefined;
  };

  // Keep both scroll panes in sync.
  let paneA: HTMLDivElement | undefined;
  let paneB: HTMLDivElement | undefined;
  const sync = (from: HTMLDivElement, to?: HTMLDivElement) => {
    if (!to) return;
    to.scrollTop = from.scrollTop;
    to.scrollLeft = from.scrollLeft;
  };

  return (
    <div class="view">
      <div class="toolbar">
        <div class="seg">
          <Btn title="Side by side" active={mode() === "side"} onClick={() => setMode("side")}>◫ Side by side</Btn>
          <Btn title="Blend (overlay with opacity)" active={mode() === "blend"} onClick={() => setMode("blend")}>◐ Blend</Btn>
          <Btn title="Difference mask" active={mode() === "diff"} onClick={() => setMode("diff")}>▣ Differences</Btn>
        </div>
        <span class="sep" />
        <label class="tb-label" title="Per-channel difference treated as equal">
          Tolerance <input type="range" min="0" max="128" value={tolerance()} onInput={(e) => setTolerance(+e.currentTarget.value)} /> {tolerance()}
        </label>
        <Show when={mode() === "blend"}>
          <label class="tb-label">
            Left ⟷ Right <input type="range" min="0" max="100" value={blend()} onInput={(e) => setBlend(+e.currentTarget.value)} />
          </label>
        </Show>
        <span class="sep" />
        <Btn title="Zoom out" kbd={displayKeys("Ctrl+Minus")} onClick={zoomOut}>−</Btn>
        <span class="tb-label">{Math.round(zoom() * 100)}%</span>
        <Btn title="Zoom in" kbd={displayKeys("Ctrl+Plus")} onClick={zoomIn}>+</Btn>
        <Btn title="Actual size" kbd={displayKeys("Ctrl+0")} onClick={() => setZoom(1)}>1:1</Btn>
        <Btn title="Reload" kbd="F5" onClick={load}>⟳ Refresh</Btn>
      </div>
      <div class="paths two">
        <PathBar value={left()} title={tab().titles?.[0]} onCommit={(p) => setPath(0, p)} info={info(0)} />
        <PathBar value={right()} title={tab().titles?.[1]} onCommit={(p) => setPath(1, p)} info={info(1)} />
      </div>
      <div class="pics" onContextMenu={onContext}>
        <Show when={mode() === "side"}>
          <div class="pic-pane checker" ref={paneA} onScroll={(e) => sync(e.currentTarget, paneB)}>
            <Show when={imgs()[0]}>{(im) => <img src={im().el.src} style={imgStyle(im())} draggable={false} />}</Show>
          </div>
          <div class="pic-pane checker" ref={paneB} onScroll={(e) => sync(e.currentTarget, paneA)}>
            <Show when={imgs()[1]}>{(im) => <img src={im().el.src} style={imgStyle(im())} draggable={false} />}</Show>
          </div>
        </Show>
        <Show when={mode() === "blend"}>
          <div class="pic-pane checker single">
            <div class="blend-stack">
              <Show when={imgs()[0]}>{(im) => <img src={im().el.src} style={imgStyle(im())} draggable={false} />}</Show>
              <Show when={imgs()[1]}>
                {(im) => <img class="over" src={im().el.src} style={{ ...imgStyle(im()), opacity: blend() / 100 }} draggable={false} />}
              </Show>
            </div>
          </div>
        </Show>
        <div class="pic-pane single" style={{ display: mode() === "diff" ? "block" : "none" }}>
          <canvas ref={diffCanvas} style={{ width: `${diffDims().w * zoom()}px`, height: `${diffDims().h * zoom()}px`, "image-rendering": "pixelated" }} />
        </div>
      </div>
      <div class="statusbar">
        <Show when={stats()} fallback={<span class="muted">Load two images to compare.</span>}>
          {(s) => (
            <Show when={s().diff > 0} fallback={<span class="st-same">Images are identical{tolerance() ? " (within tolerance)" : ""}</span>}>
              <span class="st-diff">
                {s().diff.toLocaleString()} of {s().total.toLocaleString()} pixels differ ({((s().diff / s().total) * 100).toFixed(2)}%)
              </span>
            </Show>
          )}
        </Show>
        <Show when={imgs()[0] && imgs()[1] && (imgs()[0]!.data.width !== imgs()[1]!.data.width || imgs()[0]!.data.height !== imgs()[1]!.data.height)}>
          <span class="muted"> · dimensions differ</span>
        </Show>
      </div>
    </div>
  );
}
