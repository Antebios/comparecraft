import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openPath } from "@tauri-apps/plugin-opener";
import { createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { api, type ReportRequest, type ReportSpec } from "../api";
import { Modal } from "./common";

/** Which report dialog: a file viewer's, a folder comparison's, or the generic one for mixed selected files. */
export type ReportKind = "text" | "hex" | "table" | "picture" | "folder" | "files";

const CAPTION: Record<ReportKind, string> = {
  text: "Text Compare Report",
  hex: "Hex Compare Report",
  table: "Table Compare Report",
  picture: "Picture Compare Report",
  folder: "Folder Compare Report",
  files: "File Compare Report",
};

const LAYOUTS: Record<ReportKind, [string, string][]> = {
  text: [["side-by-side", "Side-by-side"], ["summary", "Summary"], ["interleaved", "Interleaved"], ["patch", "Patch"], ["statistics", "Statistics"], ["xml", "XML Dump"]],
  hex: [["side-by-side", "Side-by-side"], ["summary", "Summary"], ["interleaved", "Interleaved"]],
  table: [["side-by-side", "Side-by-side"], ["summary", "Summary"], ["interleaved", "Interleaved"]],
  picture: [["side-by-side", "Side-by-side"], ["summary", "Summary"]],
  folder: [["side-by-side", "Side-by-side"], ["summary", "Summary"], ["xml", "XML Dump"]],
  files: [["side-by-side", "Side-by-side"], ["summary", "Summary"], ["interleaved", "Interleaved"]],
};

const FILE_DISPLAY: [string, string][] = [["all", "All"], ["mismatches", "Differences"], ["matches", "Same"], ["none", "None"]];

/** Folder display filters in the order of the reference dialog, with their script option names. */
export const FOLDER_DISPLAY: [string, string][] = [
  ["all", "All"],
  ["mismatches", "Differences"],
  ["matches", "Same"],
  ["no-orphans", "No Orphans"],
  ["mismatches-no-orphans", "Differences but No Orphans"],
  ["orphans", "Orphans"],
  ["left-newer", "Left Newer"],
  ["right-newer", "Right Newer"],
  ["left-newer-orphans", "Left Newer and Left Orphans"],
  ["right-newer-orphans", "Right Newer and Right Orphans"],
  ["left-orphans", "Left Orphans"],
  ["right-orphans", "Right Orphans"],
  ["none", "None"],
];

const COLUMNS: [string, string][] = [["size", "Size"], ["timestamp", "Modified"], ["crc", "CRC"], ["attributes", "Attributes"]];

type Output = "printer" | "html" | "plain";

interface State {
  layout: string;
  display: string;
  context: boolean;
  ignoreUnimportant: boolean;
  numbers: boolean;
  strikeLeft: boolean;
  strikeRight: boolean;
  patch: "normal" | "context" | "unified";
  columns: string[];
  fileLinks: boolean;
  output: Output;
  printMono: boolean;
  printWrap: "none" | "word" | "char";
  htmlStyle: "color" | "mono" | "custom";
  css: string;
  htmlWordWrap: boolean;
}

const DEFAULTS: State = {
  layout: "side-by-side",
  display: "all",
  context: false,
  ignoreUnimportant: false,
  numbers: false,
  strikeLeft: false,
  strikeRight: false,
  patch: "normal",
  columns: ["size", "timestamp"],
  fileLinks: false,
  output: "html",
  printMono: false,
  printWrap: "char",
  htmlStyle: "color",
  css: "",
  htmlWordWrap: false,
};

const stateKey = (k: ReportKind) => `comparecraft.report.${k}`;

/** Last used settings of a report dialog, kept like the reference application's per-view report state. */
function loadState(k: ReportKind, columns?: string[]): State {
  let saved: Partial<State> = {};
  try {
    saved = JSON.parse(localStorage.getItem(stateKey(k)) ?? "{}");
  } catch {
    /* ignore */
  }
  const s = { ...DEFAULTS, ...saved };
  if (!LAYOUTS[k].some(([v]) => v === s.layout)) s.layout = LAYOUTS[k][0][0];
  // Folder reports start from the view's visible columns.
  if (columns) s.columns = columns;
  return s;
}

/** Translates the dialog settings into report command options. */
export function toSpec(k: ReportKind, s: State, title: string): ReportSpec {
  const o: string[] = [];
  const patchLike = k === "text" && (s.layout === "patch" || s.layout === "statistics");
  if (k !== "picture" && !patchLike) {
    const ctx = s.display === "mismatches" && s.context && k !== "folder";
    o.push(`display-${ctx ? "context" : s.display}`);
  }
  if (k !== "folder" && s.ignoreUnimportant) o.push("ignore-unimportant");
  if (k !== "folder" && s.numbers && s.layout !== "summary") o.push("line-numbers");
  if (s.layout === "interleaved") {
    if (s.strikeLeft) o.push("strikeout-left-diffs");
    if (s.strikeRight) o.push("strikeout-right-diffs");
  }
  if (k === "text" && s.layout === "patch" && s.patch !== "normal") o.push(`patch-${s.patch}`);
  if (k === "folder") {
    for (const c of s.columns) o.push(`column-${c}`);
    if (s.columns.length === 0) o.push("column-none");
    if (s.fileLinks && s.output === "html") o.push("include-file-links");
  }
  const oo: string[] = [];
  let css: string | null = null;
  if (s.output === "printer") {
    oo.push(s.printMono ? "html-mono" : "html-color", `wrap-${s.printWrap === "char" ? "character" : s.printWrap}`);
  } else if (s.output === "html") {
    oo.push(`html-${s.htmlStyle}`);
    if (s.htmlStyle === "custom") css = s.css.trim() || null;
    if (s.htmlWordWrap) oo.push("wrap-word");
  }
  return { layout: s.layout, options: o, title: title.trim() || null, outputOptions: oo, css };
}

export function ReportDialog(props: {
  kind: ReportKind;
  /** Default report title (the view name). */
  title: string;
  request: () => ReportRequest;
  /** Folder reports: columns shown in the view. */
  columns?: string[];
  onClose: () => void;
}) {
  const k = props.kind;
  const [s, set] = createStore<State>(loadState(k, props.columns));
  const [title, setTitle] = createSignal(props.title);
  const [msg, setMsg] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [preview, setPreview] = createSignal<string | null>(null);

  const isPatch = () => k === "text" && s.layout === "patch";
  const plainOnly = () => k === "text" && ["patch", "statistics", "xml"].includes(s.layout);
  const output = (): Output => (plainOnly() || (k === "folder" && s.layout === "xml") ? "plain" : s.output);
  const spec = () => toSpec(k, { ...s, output: output() }, title());
  const ext = () => (output() === "plain" ? (s.layout === "xml" ? "xml" : isPatch() ? "diff" : "txt") : "html");

  async function run<T>(what: string, f: () => Promise<T>) {
    setBusy(true);
    setMsg(`${what}…`);
    try {
      localStorage.setItem(stateKey(k), JSON.stringify({ ...s, columns: k === "folder" ? s.columns : DEFAULTS.columns }));
      await f();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }
  const content = () => api.makeReport(props.request(), spec(), "content");
  const copy = () =>
    run("Copying", async () => {
      await writeText(await content());
      setMsg("Report copied to the clipboard.");
    });
  const saveAs = () =>
    run("Saving", async () => {
      const filters = [{ name: ext() === "html" ? "HTML report" : "Report", extensions: [ext()] }, { name: "All files", extensions: ["*"] }];
      const p = await saveDialog({ title: "Save Report As", defaultPath: `report.${ext()}`, filters });
      if (!p) return setMsg("");
      await api.makeReport(props.request(), spec(), `file:${p}`);
      setMsg(`Saved ${p}`);
    });
  const browser = () =>
    run("Generating", async () => {
      const p = await api.makeReport(props.request(), spec(), "browser");
      await openPath(p);
      setMsg("Report opened in the browser.");
    });
  const printPreview = () =>
    run("Generating", async () => {
      setPreview(await content());
      setMsg("");
    });
  const print = () =>
    run("Printing", async () => {
      const html = await content();
      const frame = document.createElement("iframe");
      frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
      document.body.appendChild(frame);
      await new Promise<void>((resolve) => {
        frame.onload = () => resolve();
        frame.srcdoc = html;
      });
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      setTimeout(() => frame.remove(), 60_000);
      setMsg("Sent to the print dialog.");
    });
  const help = () => window.dispatchEvent(new CustomEvent("comparecraft:help", { detail: "reports.md" }));

  const radio = <K extends keyof State>(name: K, value: State[K], label: string, disabled?: () => boolean) => (
    <label class="op-opt">
      <input type="radio" name={`rpt-${String(name)}`} checked={s[name] === value} disabled={disabled?.()} onChange={() => set(name, value as never)} /> {label}
    </label>
  );
  const check = (name: keyof State, label: string, disabled?: () => boolean) => (
    <label class="op-opt">
      <input type="checkbox" checked={!!s[name]} disabled={disabled?.()} onChange={(e) => set(name, e.currentTarget.checked as never)} /> {label}
    </label>
  );

  return (
    <Modal title={preview() == null ? CAPTION[k] : "Print Preview"} onClose={() => (preview() == null ? props.onClose() : setPreview(null))} wide>
      <Show when={preview() == null} fallback={
        <>
          <iframe class="report-preview" srcdoc={preview() ?? ""} title="Print Preview" />
          <div class="modal-actions">
            <span class="muted">{msg()}</span>
            <span class="spacer" />
            <button class="tb-btn primary" disabled={busy()} onClick={print}>Print…</button>
            <button class="tb-btn" onClick={() => setPreview(null)}>Close</button>
          </div>
        </>
      }>
      <div class="report-dlg op-form">
        <div class="report-top">
          <fieldset class="report-layouts">
            <legend>Report layout:</legend>
            <select size={6} value={s.layout} onChange={(e) => set("layout", e.currentTarget.value)}>
              <For each={LAYOUTS[k]}>{([v, l]) => <option value={v}>{l}</option>}</For>
            </select>
          </fieldset>
          <fieldset class="report-options">
            <legend>Report options:</legend>
            <Show when={k !== "folder"}>{check("ignoreUnimportant", "Ignore unimportant")}</Show>
            <Show when={k !== "picture" && !isPatch() && !(k === "text" && s.layout === "statistics")}>
              <div class="op-row">
                <select value={s.display} onChange={(e) => set("display", e.currentTarget.value)}>
                  <For each={k === "folder" ? FOLDER_DISPLAY : FILE_DISPLAY}>{([v, l]) => <option value={v}>{l}</option>}</For>
                </select>
                <Show when={k !== "folder"}>{check("context", "Show context", () => s.display !== "mismatches")}</Show>
              </div>
            </Show>
            <Show when={["text", "files"].includes(k) && s.layout === "side-by-side"}>{check("numbers", "Include line numbers")}</Show>
            <Show when={k === "hex" && s.layout !== "summary"}>{check("numbers", "Include byte addresses")}</Show>
            <Show when={k === "table" && s.layout !== "summary"}>
              {check("numbers", "Include row numbers")}
            </Show>
            <Show when={s.layout === "interleaved"}>
              {check("strikeLeft", "Strikeout left differences")}
              {check("strikeRight", "Strikeout right differences")}
            </Show>
            <Show when={isPatch()}>
              <div class="report-sub">
                <span>Patch style:</span>
                {radio("patch", "normal", "Normal diff")}
                {radio("patch", "context", "Context diff")}
                {radio("patch", "unified", "Unified diff")}
              </div>
            </Show>
            <Show when={k === "folder"}>
              <div class="report-sub">
                <span>Columns:</span>
                <For each={COLUMNS}>
                  {([v, l]) => (
                    <label class="op-opt">
                      <input
                        type="checkbox"
                        checked={s.columns.includes(v)}
                        onChange={(e) => set("columns", e.currentTarget.checked ? COLUMNS.map((c) => c[0]).filter((c) => c === v || s.columns.includes(c)) : s.columns.filter((c) => c !== v))}
                      />{" "}
                      {l}
                    </label>
                  )}
                </For>
              </div>
            </Show>
          </fieldset>
        </div>
        <fieldset class="report-output">
          <legend>Output options:</legend>
          <div class="report-out">
            <div class="report-out-kinds">
              {radio("output", "printer", "Printer", plainOnly)}
              {radio("output", "html", "HTML report", plainOnly)}
              {radio("output", "plain", "Plain text", plainOnly)}
            </div>
            <div class="report-out-opts">
              <Show when={output() === "printer"}>
                <div class="op-row">
                  <span>Difference highlighting:</span>
                  {radio("printMono", false, "Use color")}
                  {radio("printMono", true, "Monochrome")}
                </div>
                <div class="op-row">
                  <span>Wrap lines:</span>
                  {radio("printWrap", "none", "No wrap")}
                  {radio("printWrap", "word", "Wrap words")}
                  {radio("printWrap", "char", "Wrap characters")}
                </div>
              </Show>
              <Show when={output() === "html"}>
                {radio("htmlStyle", "color", "Use color stylesheet")}
                {radio("htmlStyle", "mono", "Use monochrome stylesheet")}
                <div class="op-row">
                  {radio("htmlStyle", "custom", "Use custom stylesheet URL:")}
                  <input class="report-css" value={s.css} disabled={s.htmlStyle !== "custom"} onInput={(e) => set("css", e.currentTarget.value)} />
                </div>
                {check("htmlWordWrap", "Allow word wrapping")}
                <Show when={k === "folder"}>{check("fileLinks", "Include links to file reports")}</Show>
              </Show>
              <Show when={output() === "plain"}>
                <span class="muted">{plainOnly() ? "This layout is produced as plain text." : "Produces a plain text report."}</span>
              </Show>
            </div>
            <div class="report-out-btns">
              <Show when={output() === "printer"}>
                <button class="tb-btn" disabled={busy()} onClick={printPreview}>Print Preview</button>
                <button class="tb-btn primary" disabled={busy()} onClick={print}>Print…</button>
              </Show>
              <Show when={output() === "html"}>
                <button class="tb-btn primary" disabled={busy()} onClick={browser}>View in Browser</button>
              </Show>
              <Show when={output() !== "printer"}>
                <button class="tb-btn" disabled={busy()} onClick={copy}>Copy to Clipboard</button>
                <button class="tb-btn" disabled={busy()} onClick={saveAs}>Save As…</button>
              </Show>
            </div>
          </div>
          <label class="report-title">
            Report title: <input value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
          </label>
        </fieldset>
        <div class="modal-actions">
          <span class="muted report-msg">{msg() || `Produces ${CAPTION[k].replace(/ Report$/, "")} report.`}</span>
          <span class="spacer" />
          <button class="tb-btn" onClick={help}>Help</button>
          <button class="tb-btn" onClick={props.onClose}>Close</button>
        </div>
      </div>
      </Show>
    </Modal>
  );
}
