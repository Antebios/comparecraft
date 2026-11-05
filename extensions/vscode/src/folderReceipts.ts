import path from "node:path";
import { requireObject, requireLines, type EmbeddedSpec } from "./embeddedCore";

type Request = <T>(method: string, params: unknown) => Promise<T>;
export type DiskVerdict = "sameBinary" | "same" | "similar" | "different" | "differentBinary";

export function withinFolder(base: string, file: string): boolean {
  if (!base || !file) return false;
  const rel = path.relative(base, file);
  return rel !== "" && !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/** Re-evaluates saved contents, never the editable buffer reported by a child. */
export async function diskVerdict(spec: EmbeddedSpec, request: Request): Promise<DiskVerdict> {
  const left = spec.paths[0], right = spec.paths[1];
  if (!left || !right) throw new Error("A disk verdict needs two file paths.");
  if (spec.kind === "hex") return binaryVerdict(await request<number>("file.quickCompare", { left, right, mode: "binary" }));
  if (spec.kind === "table") {
    const result = await request<{ rows: { k: string }[] }>("table.compare", { left, right, options: requireObject(spec.options.table ?? {}, "table options") });
    if (!Array.isArray(result.rows)) throw new Error("Invalid table comparison result.");
    if (result.rows.some(row => !row || !["same", "unimportant", "changed", "left", "right"].includes(row.k))) throw new Error("Invalid table row verdict.");
    return result.rows.some(row => !["same", "unimportant"].includes(row.k)) ? "different"
      : result.rows.some(row => row.k === "unimportant") ? "similar" : "same";
  }
  if (spec.kind === "picture") {
    const result = await request<{ counts: { important: number; unimportant: number; leftOrphan: number; rightOrphan: number } }>("pix.compare", { left, right, options: requireObject(spec.options.pix ?? {}, "picture options") });
    const counts = requireObject(result.counts, "picture counts");
    for (const key of ["important", "unimportant", "leftOrphan", "rightOrphan"]) {
      if (typeof counts[key] !== "number" || !Number.isSafeInteger(counts[key]) || counts[key] < 0) throw new Error("Invalid picture comparison result.");
    }
    return result.counts.important || result.counts.leftOrphan || result.counts.rightOrphan ? "different"
      : result.counts.unimportant ? "similar" : "same";
  }
  const files = await Promise.all([left, right].map(file => request<{ lines: string[]; binary: boolean }>("text.load", { path: file })));
  if (files.some(file => file.binary)) return binaryVerdict(await request<number>("file.quickCompare", { left, right, mode: "binary" }));
  const result = await request<{ identical: boolean; important: number }>("text.diff", {
    left: requireLines(files[0]!.lines, "left disk text"), right: requireLines(files[1]!.lines, "right disk text"),
    rules: requireObject(spec.options.rules ?? {}, "text rules")
  });
  if (typeof result.identical !== "boolean" || !Number.isSafeInteger(result.important) || result.important < 0) throw new Error("Invalid disk text verdict.");
  return result.identical ? "same" : result.important === 0 ? "similar" : "different";
}

function binaryVerdict(value: number): DiskVerdict {
  if (value === 1) return "sameBinary";
  if (value === 11) return "differentBinary";
  throw new Error(`Invalid binary disk comparison verdict: ${value}`);
}
