import type { ContentVerdict, DiffResult, HexAlignment, PixResult, Status, TableResult } from "./api";

export interface ComparisonStatus {
  status: Exclude<Status, "left" | "right">;
  content?: ContentVerdict;
  error?: string;
}

export type ComparisonListener = (paths: readonly string[], result: ComparisonStatus) => void;

export function contentStatus(important: boolean, unimportant = false, binary = false): ComparisonStatus {
  return important
    ? { status: "diff", content: binary ? "differentBinary" : "different" }
    : unimportant
      ? { status: "similar", content: "similar" }
      : { status: "same", content: binary ? "sameBinary" : "same" };
}

export const textStatus = (r: DiffResult) => contentStatus(r.important > 0, r.unimportant > 0);
export const hexStatus = (r: HexAlignment) => contentStatus(r.counts.slice(1).some((n) => n > 0), false, true);
export const tableStatus = (r: TableResult) =>
  contentStatus(r.rows.some((row) => row.k === "changed" || row.k === "left" || row.k === "right"), r.rows.some((row) => row.k === "unimportant"));
export const pictureStatus = (r: PixResult) =>
  contentStatus(r.counts.important + r.counts.leftOrphan + r.counts.rightOrphan > 0, r.counts.unimportant > 0);
