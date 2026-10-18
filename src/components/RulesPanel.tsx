import { createSignal, For, Show, type JSX } from "solid-js";
import type { Replacement, Rules } from "../api";
import { Modal } from "./common";

export function RulesPanel(props: { rules: Rules; onChange: (r: Rules) => void; children?: JSX.Element }) {
  const set = <K extends keyof Rules>(k: K, v: Rules[K]) => props.onChange({ ...props.rules, [k]: v });
  const [adding, setAdding] = createSignal(false);
  const reps = () => props.rules.replacements ?? [];
  const cb = (k: keyof Rules, label: string) => (
    <label>
      <input type="checkbox" checked={props.rules[k] as boolean} onChange={(e) => set(k, e.currentTarget.checked as never)} /> {label}
    </label>
  );
  return (
    <div class="panel rules">
      <strong>Unimportant differences:</strong>
      {cb("ignoreLeadingWs", "Leading whitespace")}
      {cb("ignoreTrailingWs", "Trailing whitespace")}
      {cb("ignoreEmbeddedWs", "Embedded whitespace")}
      {cb("ignoreBlankLines", "Blank lines")}
      {cb("ignoreCase", "Character case")}
      <label>
        Alignment:{" "}
        <select value={props.rules.algorithm} onChange={(e) => set("algorithm", e.currentTarget.value as Rules["algorithm"])}>
          <option value="patience">Patience</option>
          <option value="myers">Myers</option>
          <option value="lcs">LCS</option>
        </select>
      </label>
      {props.children}
      <div class="rep-list">
        <strong>Replacements:</strong>
        <For each={reps()} fallback={<span class="muted">none</span>}>
          {(r, i) => (
            <span class="rep-chip" title={r.regex ? "Regular expression" : "Literal text"}>
              <code>{r.from}</code> → <code>{r.to}</code>
              {r.regex ? <em> (regex)</em> : null}
              <button class="icon-btn" title="Remove replacement" onClick={() => set("replacements", reps().filter((_, j) => j !== i()))}>
                ✕
              </button>
            </span>
          )}
        </For>
        <button class="link" onClick={() => setAdding(true)}>Add…</button>
      </div>
      <Show when={adding()}>
        <ReplacementDialog
          onClose={() => setAdding(false)}
          onOk={(r) => {
            setAdding(false);
            set("replacements", [...reps(), r]);
          }}
        />
      </Show>
    </div>
  );
}

/**
 * "Replacement…": text on either side matching "Text" is compared as if it were
 * "Replace with", so the difference becomes unimportant.
 */
export function ReplacementDialog(props: { initial?: Replacement; onClose: () => void; onOk: (r: Replacement) => void }) {
  const [from, setFrom] = createSignal(props.initial?.from ?? "");
  const [to, setTo] = createSignal(props.initial?.to ?? "");
  const [regex, setRegex] = createSignal(!!props.initial?.regex);
  const invalid = () => {
    if (!from()) return "Enter the text to replace.";
    if (regex()) {
      try {
        new RegExp(from());
      } catch (e) {
        return `Invalid regular expression: ${(e as Error).message}`;
      }
    }
    return "";
  };
  const ok = () => !invalid() && props.onOk({ from: from(), to: to(), regex: regex() });
  return (
    <Modal title="Replacement" onClose={props.onClose}>
      <form
        class="rep-form"
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
      >
        <label class="opt-row">
          <span class="opt-label">Text:</span>
          <input value={from()} onInput={(e) => setFrom(e.currentTarget.value)} spellcheck={false} ref={(el) => setTimeout(() => el.select())} />
        </label>
        <label class="opt-row">
          <span class="opt-label">Replace with:</span>
          <input value={to()} onInput={(e) => setTo(e.currentTarget.value)} spellcheck={false} />
        </label>
        <label class="opt-check">
          <input type="checkbox" checked={regex()} onChange={(e) => setRegex(e.currentTarget.checked)} /> Regular expression
        </label>
        <p class="muted">Differences where the left and right text only differ by this replacement are treated as unimportant.</p>
        <Show when={from() && invalid()}>
          <div class="err-text">{invalid()}</div>
        </Show>
        <div class="modal-actions">
          <button type="button" onClick={props.onClose}>Cancel</button>
          <button type="submit" class="primary" disabled={!!invalid()}>OK</button>
        </div>
      </form>
    </Modal>
  );
}
