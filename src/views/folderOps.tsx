/**
 * Folder Compare operation dialogs. Layouts and captions follow the reference
 * application's operation dialogs (a shared shell with a "Selection:" summary,
 * side choices, an "Action:" description and Start/Cancel buttons); see
 * docs/REVERSE_ENGINEERING.md §9.
 */
import { open as openDialog } from "../host";
import { setSetting, settings } from "../settings";
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { errText, fmtSize, fmtTime } from "../api";
import { Modal } from "../components/common";

export type SideName = "left" | "right";
export interface SideCount {
  files: number;
  folders: number;
  bytes: number;
}
export type Counts = Record<SideName, SideCount>;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export const countText = (c: SideCount) =>
  !c.files && !c.folders ? "nothing selected" : [c.files ? plural(c.files, "file") : "", c.folders ? plural(c.folders, "folder") : "", c.files ? fmtSize(c.bytes) : ""].filter(Boolean).join(", ");
const hasAny = (c: SideCount) => c.files + c.folders > 0;

/** Description of what an operation acts on, e.g. "files, folders". */
function kinds(c: Counts, sides: SideName[]) {
  const f = sides.some((s) => c[s].files), d = sides.some((s) => c[s].folders);
  return [f ? "files" : "", d ? "folders" : ""].filter(Boolean).join(", ") || "items";
}

/** The common operation-dialog shell. */
function OpShell(props: {
  title: string;
  counts?: Counts;
  action: string;
  startLabel?: string;
  canStart?: boolean;
  busy?: boolean;
  wide?: boolean;
  onStart: () => void;
  onClose: () => void;
  children?: JSX.Element;
  footer?: JSX.Element;
}) {
  return (
    <Modal title={props.title} onClose={props.onClose} wide={props.wide}>
      <form
        class="op-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (props.canStart !== false && !props.busy) props.onStart();
        }}
      >
        <Show when={props.counts}>
          {(c) => (
            <fieldset class="op-sel">
              <legend>Selection:</legend>
              <div>Left side: {countText(c().left)}</div>
              <div>Right side: {countText(c().right)}</div>
            </fieldset>
          )}
        </Show>
        {props.children}
        <fieldset class="op-action">
          <legend>Action:</legend>
          {props.action}
        </fieldset>
        <div class="modal-actions">
          {props.footer}
          <span class="spacer" />
          <button type="button" class="tb-btn" onClick={props.onClose}>Cancel</button>
          <button type="submit" class="tb-btn primary" disabled={props.canStart === false || props.busy} ref={(el) => setTimeout(() => el.isConnected && !el.closest(".modal")?.querySelector("input:focus") && el.focus())}>
            {props.startLabel ?? "Start"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------- Copy / Move to Side ---------- */

export function SideDialog(props: {
  move: boolean;
  counts: Counts;
  /** Direction requested by the command; undefined lets the dialog choose (both sides possible). */
  to?: SideName;
  onStart: (to: SideName, dontShow: boolean) => void;
  onClose: () => void;
}) {
  // Reference behaviour: without an explicit direction the side with selected items is the source.
  const initial: SideName = props.to ?? (hasAny(props.counts.left) ? "right" : "left");
  const [to, setTo] = createSignal<SideName>(initial);
  const [dontShow, setDontShow] = createSignal(false);
  const src = () => (to() === "right" ? "left" : "right");
  const verb = props.move ? "Move" : "Copy";
  return (
    <OpShell
      title={`${verb} to Side`}
      counts={props.counts}
      action={`${verb} selected ${kinds(props.counts, [src()])}.${props.move ? " Folders with hidden items will not be moved." : ""}`}
      canStart={hasAny(props.counts[src()])}
      onStart={() => props.onStart(to(), dontShow())}
      onClose={props.onClose}
      footer={
        <Show when={!props.move}>
          <label><input type="checkbox" checked={dontShow()} onChange={(e) => setDontShow(e.currentTarget.checked)} /> Don't show again</label>
        </Show>
      }
    >
      <div class="op-row">
        <label><input type="radio" name="dir" checked={to() === "right"} disabled={!hasAny(props.counts.left)} onChange={() => setTo("right")} /> Left to right →</label>
        <label><input type="radio" name="dir" checked={to() === "left"} disabled={!hasAny(props.counts.right)} onChange={() => setTo("left")} /> ← Right to left</label>
      </div>
    </OpShell>
  );
}

/* ---------- Delete ---------- */

export function DeleteDialog(props: { counts: Counts; permanent: boolean; onStart: (sides: SideName[], useTrash: boolean) => void; onClose: () => void }) {
  const [l, setL] = createSignal(hasAny(props.counts.left));
  const [r, setR] = createSignal(hasAny(props.counts.right));
  const [trash, setTrash] = createSignal(!props.permanent && settings.useTrash);
  const sides = () => [...(l() ? ["left" as const] : []), ...(r() ? ["right" as const] : [])];
  return (
    <OpShell
      title={props.permanent ? "Delete Permanently" : "Delete"}
      counts={props.counts}
      action={`Delete selected ${kinds(props.counts, sides())}.`}
      startLabel="Delete"
      canStart={sides().length > 0}
      onStart={() => {
        if (!props.permanent) setSetting("useTrash", trash());
        props.onStart(sides(), trash());
      }}
      onClose={props.onClose}
    >
      <div class="op-row">
        <label><input type="checkbox" checked={l()} disabled={!hasAny(props.counts.left)} onChange={(e) => setL(e.currentTarget.checked)} /> Left side</label>
        <label><input type="checkbox" checked={r()} disabled={!hasAny(props.counts.right)} onChange={(e) => setR(e.currentTarget.checked)} /> Right side</label>
      </div>
      <label class="op-opt"><input type="checkbox" checked={trash()} disabled={props.permanent} onChange={(e) => setTrash(e.currentTarget.checked)} /> Use recycle bin if possible</label>
    </OpShell>
  );
}

/* ---------- Rename ---------- */

/** DOS-style mask that matches every name: differing positions become "?", differing lengths "*". */
export function dosMask(names: string[]): string {
  if (!names.length) return "*";
  if (names.length === 1) return names[0];
  if (names.every((n) => n.length === names[0].length))
    return [...names[0]].map((ch, i) => (names.every((n) => n[i] === ch) ? ch : "?")).join("");
  let pre = names[0], suf = names[0];
  for (const n of names) {
    while (!n.startsWith(pre)) pre = pre.slice(0, -1);
    while (!n.endsWith(suf)) suf = suf.slice(1);
  }
  const min = Math.min(...names.map((n) => n.length));
  if (pre.length + suf.length > min) suf = suf.slice(pre.length + suf.length - min);
  return `${pre}*${suf}`;
}

const escRe = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/**
 * Applies a DOS-style rename: the wildcards of the old mask capture parts of the
 * name, and each wildcard of the new mask inserts the corresponding capture.
 */
export function dosRename(oldMask: string, newMask: string, name: string): string | null {
  const re = new RegExp("^" + [...oldMask].map((c) => (c === "*" ? "(.*)" : c === "?" ? "(.)" : escRe(c))).join("") + "$", "i");
  const m = re.exec(name);
  if (!m) return null;
  let k = 1;
  return [...newMask].map((c) => (c === "*" || c === "?" ? m[k++] ?? "" : c)).join("");
}

export function RenameDialog(props: { names: string[]; onStart: (rename: (name: string) => string | null) => void; onClose: () => void }) {
  const unique = [...new Set(props.names)];
  const [regex, setRegex] = createSignal(false);
  const [oldMask, setOld] = createSignal(dosMask(unique));
  const [newMask, setNew] = createSignal(dosMask(unique));
  const fn = createMemo<((n: string) => string | null) | string>(() => {
    const o = oldMask(), n = newMask();
    if (!regex()) return (name: string) => dosRename(o, n, name);
    try {
      const re = new RegExp(o);
      return (name: string) => (re.test(name) ? name.replace(re, n) : null);
    } catch (e) {
      return errText(e);
    }
  });
  const preview = () => {
    const f = fn();
    return typeof f === "string" ? [] : unique.map((n) => ({ from: n, to: f(n) }));
  };
  const changes = () => preview().filter((p) => p.to && p.to !== p.from && !/[\\/]/.test(p.to));
  return (
    <OpShell
      title="Rename"
      action={`Rename ${plural(changes().length, "item")}.`}
      canStart={changes().length > 0}
      wide
      onStart={() => {
        const f = fn();
        if (typeof f !== "string") props.onStart(f);
      }}
      onClose={props.onClose}
    >
      <div class="op-row">
        <label><input type="radio" name="rmode" checked={!regex()} onChange={() => setRegex(false)} /> DOS compatible</label>
        <label><input type="radio" name="rmode" checked={regex()} onChange={() => setRegex(true)} /> Regular expressions</label>
      </div>
      <label class="op-field">Old {regex() ? "pattern" : "mask"}:<input value={oldMask()} onInput={(e) => setOld(e.currentTarget.value)} spellcheck={false} /></label>
      <label class="op-field">New {regex() ? "pattern" : "mask"}:<input value={newMask()} ref={(el) => setTimeout(() => (el.focus(), el.select()))} onInput={(e) => setNew(e.currentTarget.value)} spellcheck={false} /></label>
      <Show when={typeof fn() === "string"}>
        <div class="banner err">{fn() as string}</div>
      </Show>
      <div class="op-list">
        <For each={preview()}>
          {(p) => (
            <div classList={{ muted: !p.to || p.to === p.from }}>
              {p.from} → {p.to ?? "(no match)"}
            </div>
          )}
        </For>
      </div>
    </OpShell>
  );
}

/* ---------- Attributes ---------- */

/** Checkbox with a third, indeterminate ("leave unchanged") state. */
function TriBox(props: { value: boolean | null; onToggle: () => void }) {
  let el!: HTMLInputElement;
  createEffect(() => {
    el.checked = !!props.value;
    el.indeterminate = props.value === null;
  });
  return <input type="checkbox" ref={el} onChange={props.onToggle} />;
}

const RWX = [
  ["Owner", 0o400, 0o200, 0o100],
  ["Group", 0o040, 0o020, 0o010],
  ["Other", 0o004, 0o002, 0o001],
] as const;

export function AttributesDialog(props: { counts: Counts; modes: number[]; windows: boolean; onStart: (mode: number, mask: number) => void; onClose: () => void }) {
  // Tri-state per bit: true/false when all items agree, null when mixed (left unchanged).
  const initial = (bit: number): boolean | null => {
    const set = props.modes.filter((m) => m & bit).length;
    return set === props.modes.length ? true : set === 0 ? false : null;
  };
  const [bits, setBits] = createSignal(new Map<number, boolean | null>([...RWX.flatMap((r) => [r[1], r[2], r[3]])].map((b) => [b, initial(b)])));
  const cycle = (b: number) => {
    const m = new Map(bits());
    m.set(b, !m.get(b));
    setBits(m);
  };
  const mode = () => [...bits()].reduce((a, [b, v]) => (v ? a | b : a), 0);
  const mask = () => [...bits()].reduce((a, [b, v]) => (v === null ? a : a | b), 0);
  const octal = () => [...bits().values()].every((v) => v !== null) ? mode().toString(8).padStart(3, "0") : "";
  const setOctal = (s: string) => {
    if (!/^[0-7]{3}$/.test(s)) return;
    const v = parseInt(s, 8);
    setBits(new Map([...bits().keys()].map((b) => [b, !!(v & b)])));
  };
  const box = (b: number) => <TriBox value={bits().get(b) ?? null} onToggle={() => cycle(b)} />;
  return (
    <OpShell title="Attributes" counts={props.counts} action="Check a box to set attribute. Uncheck to clear. Greyed boxes are left unchanged." onStart={() => props.onStart(mode(), mask())} onClose={props.onClose}>
      <Show
        when={!props.windows}
        fallback={<label class="op-opt">{(() => {
          // On Windows only the read-only attribute maps onto the owner write bit (inverted).
          const ro = () => (bits().get(0o200) === null ? null : !bits().get(0o200));
          return <><TriBox value={ro()} onToggle={() => cycle(0o200)} /> Read-only</>;
        })()}</label>}
      >
        <table class="op-perm">
          <thead><tr><th /><th>Read</th><th>Write</th><th>Execute</th></tr></thead>
          <tbody>
            <For each={RWX}>{(r) => <tr><td>{r[0]}</td><td>{box(r[1])}</td><td>{box(r[2])}</td><td>{box(r[3])}</td></tr>}</For>
          </tbody>
        </table>
        <label class="op-field">Permissions (octal):<input value={octal()} placeholder="mixed" maxLength={3} style={{ width: "5em" }} onChange={(e) => setOctal(e.currentTarget.value)} /></label>
      </Show>
    </OpShell>
  );
}

/* ---------- Touch ---------- */

const toLocalInput = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 19);
};

export function TouchDialog(props: {
  counts: Counts;
  canCopy: boolean;
  onStart: (o: { sides: SideName[]; recursive: boolean; time: number | null }) => void;
  onClose: () => void;
}) {
  const [l, setL] = createSignal(hasAny(props.counts.left));
  const [r, setR] = createSignal(hasAny(props.counts.right));
  const [recursive, setRecursive] = createSignal(false);
  const [copy, setCopy] = createSignal(false);
  const last = Number(localStorage.getItem("comparecraft.lastTouch")) || Date.now();
  const [when, setWhen] = createSignal(toLocalInput(Date.now()));
  const sides = () => [...(l() ? ["left" as const] : []), ...(r() ? ["right" as const] : [])];
  const time = () => new Date(when()).getTime();
  return (
    <OpShell
      title="Touch"
      counts={props.counts}
      action={copy() ? "Copy timestamps from the other side." : `Set timestamps to ${new Date(time()).toLocaleString()}.`}
      canStart={sides().length > 0 && (copy() || !isNaN(time()))}
      onStart={() => {
        if (!copy()) localStorage.setItem("comparecraft.lastTouch", String(time()));
        props.onStart({ sides: sides(), recursive: recursive(), time: copy() ? null : time() });
      }}
      onClose={props.onClose}
    >
      <div class="op-row">
        <label><input type="checkbox" checked={l()} disabled={!hasAny(props.counts.left)} onChange={(e) => setL(e.currentTarget.checked)} /> Left side</label>
        <label><input type="checkbox" checked={r()} disabled={!hasAny(props.counts.right)} onChange={(e) => setR(e.currentTarget.checked)} /> Right side</label>
      </div>
      <label class="op-opt"><input type="checkbox" checked={recursive()} onChange={(e) => setRecursive(e.currentTarget.checked)} /> Including folder contents</label>
      <label class="op-opt"><input type="radio" name="tmode" checked={copy()} disabled={!props.canCopy} onChange={() => setCopy(true)} /> Copy timestamps from other side</label>
      <div class="op-opt">
        <label><input type="radio" name="tmode" checked={!copy()} onChange={() => setCopy(false)} /> Set timestamps to →</label>{" "}
        <input type="datetime-local" step="1" value={when()} disabled={copy()} onInput={(e) => setWhen(e.currentTarget.value)} />
      </div>
      <div class="op-row">
        Default:
        <button type="button" class="tb-btn" disabled={copy()} onClick={() => setWhen(toLocalInput(Date.now()))}>Current system time</button>
        <button type="button" class="tb-btn" disabled={copy()} onClick={() => setWhen(toLocalInput(last))}>Last touch</button>
      </div>
    </OpShell>
  );
}

/* ---------- New Folder ---------- */

export function NewFolderDialog(props: { where: string[]; onStart: (name: string) => void; onClose: () => void }) {
  const [name, setName] = createSignal("New Folder");
  const valid = () => name().trim() !== "" && !/[\\/]/.test(name());
  return (
    <OpShell title="Create New Folder" action={`Create in: ${props.where.join("  and  ")}`} startLabel="OK" canStart={valid()} onStart={() => props.onStart(name().trim())} onClose={props.onClose}>
      <label class="op-field">Name:<input value={name()} ref={(el) => setTimeout(() => (el.focus(), el.select()))} onInput={(e) => setName(e.currentTarget.value)} spellcheck={false} /></label>
    </OpShell>
  );
}

/* ---------- Exclude ---------- */

export function ExcludeDialog(props: { names: string[]; ext: string; onStart: (byType: boolean, onlyHere: boolean, dontShow: boolean) => void; onClose: () => void }) {
  const [byType, setByType] = createSignal(false);
  const [onlyHere, setOnlyHere] = createSignal(false);
  const [dontShow, setDontShow] = createSignal(false);
  const typeLabel = props.ext ? `All ${props.ext} file types` : "All files without an extension";
  return (
    <OpShell
      title="Exclude from Session"
      action={byType() ? `Exclude ${typeLabel.toLowerCase()}${onlyHere() ? " in this folder" : ""}.` : `Exclude ${props.names.length === 1 ? props.names[0] : plural(props.names.length, "file")}.`}
      startLabel="OK"
      onStart={() => props.onStart(byType(), onlyHere(), dontShow())}
      onClose={props.onClose}
      footer={<label><input type="checkbox" checked={dontShow()} onChange={(e) => setDontShow(e.currentTarget.checked)} /> Don't show again during this session</label>}
    >
      <label class="op-opt"><input type="radio" name="xmode" checked={!byType()} onChange={() => setByType(false)} /> Selected filename{props.names.length === 1 ? "" : "s"}</label>
      <label class="op-opt"><input type="radio" name="xmode" checked={byType()} onChange={() => setByType(true)} /> {typeLabel}</label>
      <label class="op-opt"><input type="checkbox" checked={onlyHere()} onChange={(e) => setOnlyHere(e.currentTarget.checked)} /> Only in this folder</label>
    </OpShell>
  );
}

/* ---------- Copy / Move to Folder ---------- */

export type Structure = "relative" | "base" | "flat";

export function FolderDialog(props: {
  move: boolean;
  counts: Counts;
  side: SideName;
  initial: string;
  onStart: (side: SideName, dest: string, structure: Structure) => void;
  onClose: () => void;
}) {
  const verb = props.move ? "Move" : "Copy";
  const [side, setSide] = createSignal<SideName>(props.side);
  const [dest, setDest] = createSignal(localStorage.getItem("comparecraft.copyToFolder") || props.initial);
  const [structure, setStructure] = createSignal<Structure>((localStorage.getItem("comparecraft.copyStructure") as Structure) || "relative");
  const both = hasAny(props.counts.left) && hasAny(props.counts.right);
  async function browse() {
    const p = await openDialog({ directory: true, defaultPath: dest() || undefined, title: `${verb} to Folder` });
    if (typeof p === "string") setDest(p);
  }
  return (
    <OpShell
      title={`${verb} to Folder`}
      counts={props.counts}
      action={`${verb} selected ${kinds(props.counts, [side()])} from the ${side()} side.`}
      canStart={!!dest().trim() && hasAny(props.counts[side()])}
      onStart={() => {
        localStorage.setItem("comparecraft.copyToFolder", dest());
        localStorage.setItem("comparecraft.copyStructure", structure());
        props.onStart(side(), dest().trim(), structure());
      }}
      onClose={props.onClose}
    >
      <Show when={both}>
        <div class="op-row">
          From:
          <label><input type="radio" name="fside" checked={side() === "left"} onChange={() => setSide("left")} /> Left side</label>
          <label><input type="radio" name="fside" checked={side() === "right"} onChange={() => setSide("right")} /> Right side</label>
        </div>
      </Show>
      <label class="op-field">
        {verb} selected files to this folder:
        <span class="op-browse">
          <input value={dest()} onInput={(e) => setDest(e.currentTarget.value)} spellcheck={false} ref={(el) => setTimeout(() => el.focus())} />
          <button type="button" class="tb-btn" onClick={browse}>Browse…</button>
        </span>
      </label>
      <label class="op-opt"><input type="radio" name="struct" checked={structure() === "relative"} onChange={() => setStructure("relative")} /> Keep relative folder structure</label>
      <label class="op-opt"><input type="radio" name="struct" checked={structure() === "base"} onChange={() => setStructure("base")} /> Keep base folder structure</label>
      <label class="op-opt"><input type="radio" name="struct" checked={structure() === "flat"} onChange={() => setStructure("flat")} /> Don't keep folder structure</label>
    </OpShell>
  );
}

/* ---------- Compare Contents ---------- */

export type ContentMode = "crc" | "binary" | "rules";

export function ContentsDialog(props: { counts: Counts; onStart: (mode: ContentMode, showResults: boolean) => void; onClose: () => void }) {
  const [mode, setMode] = createSignal<ContentMode>((localStorage.getItem("comparecraft.contentsMode") as ContentMode) || "rules");
  const [show, setShow] = createSignal(localStorage.getItem("comparecraft.contentsResults") !== "false");
  return (
    <OpShell
      title="Compare Contents"
      counts={props.counts}
      action="Compare the contents of the selected files with their counterparts."
      onStart={() => {
        localStorage.setItem("comparecraft.contentsMode", mode());
        localStorage.setItem("comparecraft.contentsResults", String(show()));
        props.onStart(mode(), show());
      }}
      onClose={props.onClose}
    >
      <label class="op-opt"><input type="radio" name="cmode" checked={mode() === "crc"} onChange={() => setMode("crc")} /> CRC comparison</label>
      <label class="op-opt"><input type="radio" name="cmode" checked={mode() === "binary"} onChange={() => setMode("binary")} /> Binary comparison</label>
      <label class="op-opt"><input type="radio" name="cmode" checked={mode() === "rules"} onChange={() => setMode("rules")} /> Rules-based comparison</label>
      <label class="op-opt"><input type="checkbox" checked={show()} onChange={(e) => setShow(e.currentTarget.checked)} /> Show results dialog</label>
    </OpShell>
  );
}

/** Text of a quick-compare result code (1 binary same, 2 rules same, 11 binary different, 12 similar, 13 rules different). */
export function qcText(code: number): string {
  return { 1: "Binary same", 2: "Same", 11: "Binary differences", 12: "Unimportant differences", 13: "Important differences" }[code] ?? "Error";
}

export function ContentsResults(props: { rows: { rel: string; code: number }[]; onOpen: (rel: string) => void; onClose: () => void }) {
  return (
    <Modal title="Compare Contents Results" onClose={props.onClose} wide>
      <div class="op-list results">
        <table>
          <thead><tr><th>File</th><th>Result</th></tr></thead>
          <tbody>
            <For each={props.rows}>
              {(r) => (
                <tr class={r.code === 1 || r.code === 2 ? "res-same" : r.code === 12 ? "res-sim" : "res-diff"} onDblClick={() => props.onOpen(r.rel)} title="Double-click to open">
                  <td>{r.rel}</td>
                  <td>{qcText(r.code)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <div class="modal-actions">
        <span class="muted">{plural(props.rows.length, "file")} compared</span>
        <span class="spacer" />
        <button class="tb-btn primary" ref={(el) => setTimeout(() => el.focus())} onClick={props.onClose}>Close</button>
      </div>
    </Modal>
  );
}

/* ---------- Align With ---------- */

export function AlignDialog(props: { name: string; candidates: string[]; onPick: (name: string) => void; onClose: () => void }) {
  const [pick, setPick] = createSignal(props.candidates[0] ?? "");
  return (
    <OpShell title="Align With" action={`Compare “${props.name}” with “${pick()}”.`} startLabel="OK" canStart={!!pick()} onStart={() => props.onPick(pick())} onClose={props.onClose}>
      <div class="op-list">
        <For each={props.candidates} fallback={<div class="muted">No unmatched items on the other side of this folder.</div>}>
          {(c) => (
            <label class="op-opt" onDblClick={() => props.onPick(c)}>
              <input type="radio" name="align" checked={pick() === c} onChange={() => setPick(c)} /> {c}
            </label>
          )}
        </For>
      </div>
    </OpShell>
  );
}

/* ---------- Confirm File Replace (async, app-wide host) ---------- */

export type ReplaceAnswer = "yes" | "yesall" | "no" | "noall" | "cancel";
export interface FileFacts {
  path: string;
  size: number;
  modified: number | null;
}
interface ReplaceReq {
  target: FileFacts;
  source: FileFacts;
  resolve: (a: ReplaceAnswer) => void;
}
const [replaceReq, setReplaceReq] = createSignal<ReplaceReq | null>(null);

export function confirmReplace(target: FileFacts, source: FileFacts): Promise<ReplaceAnswer> {
  replaceReq()?.resolve("cancel");
  return new Promise((resolve) => setReplaceReq({ target, source, resolve }));
}

export function ReplaceHost() {
  const done = (a: ReplaceAnswer) => {
    const r = replaceReq();
    setReplaceReq(null);
    r?.resolve(a);
  };
  const facts = (f: FileFacts) => (
    <div class="op-facts">
      <div>{f.path}</div>
      <div class="muted">{fmtSize(f.size)} · {fmtTime(f.modified)}</div>
    </div>
  );
  return (
    <Show when={replaceReq()}>
      {(r) => (
        <Modal title="Confirm File Replace" onClose={() => done("cancel")}>
          <div class="op-form">
            <div>Would you like to replace the existing file</div>
            {facts(r().target)}
            <div>with this one?</div>
            {facts(r().source)}
            <div class="modal-actions">
              <span class="spacer" />
              <button class="tb-btn primary" ref={(el) => setTimeout(() => el.focus())} onClick={() => done("yes")}>Yes</button>
              <button class="tb-btn" onClick={() => done("yesall")}>Yes to All</button>
              <button class="tb-btn" onClick={() => done("no")}>No</button>
              <button class="tb-btn" onClick={() => done("noall")}>No to All</button>
              <button class="tb-btn" onClick={() => done("cancel")}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </Show>
  );
}
