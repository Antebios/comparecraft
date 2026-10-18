import type { JSX } from "solid-js";
import type { Rules } from "../api";

export function RulesPanel(props: { rules: Rules; onChange: (r: Rules) => void; children?: JSX.Element }) {
  const set = <K extends keyof Rules>(k: K, v: Rules[K]) => props.onChange({ ...props.rules, [k]: v });
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
    </div>
  );
}
