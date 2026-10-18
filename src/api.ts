import { invoke } from "@tauri-apps/api/core";

export type ViewKind = "home" | "text" | "folder" | "sync" | "merge" | "hex" | "table" | "picture";

export interface LaunchSpec {
  kind: ViewKind | "session";
  paths: string[];
  titles: (string | null)[];
  readOnly: boolean[];
  filters: string | null;
  expandAll: boolean;
  output: string | null;
  saveTarget: string | null;
  noBackups: boolean;
  session: string | null;
}

export interface PathInfo {
  path: string;
  exists: boolean;
  isDir: boolean;
  size: number;
  modified: number | null;
  kind: string;
}

export interface TextFile {
  path: string;
  lines: string[];
  encoding: string;
  bom: boolean;
  eol: string;
  finalNewline: boolean;
  size: number;
  modified: number | null;
  binary: boolean;
  readOnly: boolean;
}

export interface Rules {
  ignoreCase: boolean;
  ignoreLeadingWs: boolean;
  ignoreTrailingWs: boolean;
  ignoreEmbeddedWs: boolean;
  ignoreBlankLines: boolean;
  algorithm: "patience" | "myers" | "lcs";
}

export const defaultRules = (): Rules => ({
  ignoreCase: false,
  ignoreLeadingWs: true,
  ignoreTrailingWs: true,
  ignoreEmbeddedWs: true,
  ignoreBlankLines: true,
  algorithm: "patience",
});

export const strictRules = (): Rules => ({
  ignoreCase: false,
  ignoreLeadingWs: false,
  ignoreTrailingWs: false,
  ignoreEmbeddedWs: false,
  ignoreBlankLines: false,
  algorithm: "patience",
});

export type RowKind = "same" | "unimportant" | "changed" | "left" | "right";
export interface Row {
  l?: number;
  r?: number;
  k: RowKind;
  h?: number;
  ls?: [number, number][];
  rs?: [number, number][];
}
export interface Hunk {
  start: number;
  end: number;
  important: boolean;
}
export interface DiffResult {
  rows: Row[];
  hunks: Hunk[];
  important: number;
  unimportant: number;
  sameLines: number;
  identical: boolean;
}

export type ChunkKind = "stable" | "left" | "right" | "both" | "conflict";
export interface Chunk {
  kind: ChunkKind;
  base: string[];
  left: string[];
  right: string[];
  baseStart: number;
  leftStart: number;
  rightStart: number;
}
export interface MergeResult {
  chunks: Chunk[];
  conflicts: number;
  changes: number;
}

export interface FolderOptions {
  criteria: "timesize" | "size" | "binary" | "crc" | "rules";
  timeToleranceSecs: number;
  include: string;
  exclude: string;
  ignoreCaseNames: boolean;
  followSymlinks: boolean;
  /** Items compared with each other although their names differ ("Align With"). */
  align?: Alignment[];
}
export interface Alignment {
  /** Relative path of the parent folder ("" for the base folder), using left-side names. */
  parent: string;
  left: string;
  right: string;
}
export type Status = "same" | "similar" | "diff" | "left" | "right" | "error";
export interface Side {
  name: string;
  size: number;
  modified: number | null;
}
export interface FNode {
  name: string;
  rel: string;
  dir: boolean;
  left?: Side;
  right?: Side;
  status: Status;
  newer?: "left" | "right";
  error?: string;
  children?: FNode[];
}
export interface Summary {
  files: number;
  same: number;
  similar: number;
  diff: number;
  leftOnly: number;
  rightOnly: number;
  errors: number;
}
export interface FolderResult {
  root: FNode;
  summary: Summary;
}
export interface Action {
  op: "copy" | "move" | "delete" | "rename" | "mkdir" | "touch" | "chmod";
  /** Source path (copy, move, rename) or, for touch, the item whose timestamp is copied. */
  from?: string;
  to: string;
  rel: string;
  dir: boolean;
  size: number;
  /** touch: new modification time (ms since the epoch). */
  time?: number;
  /** chmod: permission bits to set, limited to `mask`. */
  mode?: number;
  mask?: number;
  /** touch: include folder contents. */
  recursive?: boolean;
}
export interface ItemInfo {
  exists: boolean;
  dir: boolean;
  size: number;
  modified: number | null;
  mode: number;
}
export interface ActionResult {
  rel: string;
  op: string;
  ok: boolean;
  error?: string;
}

export interface HexDiff {
  leftSize: number;
  rightSize: number;
  ranges: [number, number][];
  diffBytes: number;
  truncated: boolean;
}

export interface TableOptions {
  delimiter: string;
  header: boolean;
  keys: number[];
  ignoreCase: boolean;
  trim: boolean;
}
export interface TableRow {
  l?: number;
  r?: number;
  k: "same" | "changed" | "left" | "right";
  cells?: number[];
}
export interface TableResult {
  header: string[];
  left: string[][];
  right: string[][];
  rows: TableRow[];
  delimiter: string;
  columns: number;
}

export interface Session {
  id: string;
  name: string;
  kind: ViewKind;
  paths: string[];
  options: unknown;
  modified: number;
  saved: boolean;
}

export const api = {
  takeLaunchSpec: () => invoke<LaunchSpec | null>("take_launch_spec"),
  pathInfo: (path: string) => invoke<PathInfo>("path_info", { path }),
  loadText: (path: string) => invoke<TextFile>("load_text", { path }),
  saveText: (f: { path: string; lines: string[]; encoding: string; bom: boolean; eol: string; finalNewline: boolean; backup: boolean }) =>
    invoke<PathInfo>("save_text", f),
  diffTexts: (left: string[], right: string[], rules: Rules) => invoke<DiffResult>("diff_texts", { left, right, rules }),
  mergeTexts: (base: string[], left: string[], right: string[], rules: Rules) =>
    invoke<MergeResult>("merge_texts", { base, left, right, rules }),
  compareFolders: (left: string, right: string, options: FolderOptions) =>
    invoke<FolderResult>("compare_folders", { left, right, options }),
  planSync: (left: string, right: string, options: FolderOptions, mode: string) =>
    invoke<Action[]>("plan_sync", { left, right, options, mode }),
  executeActions: (actions: Action[], useTrash: boolean) => invoke<ActionResult[]>("execute_actions", { actions, useTrash }),
  compareItems: (left: string, right: string, rels: string[], options: FolderOptions) =>
    invoke<(FNode | null)[]>("compare_items", { left, right, rels, options }),
  itemInfo: (paths: string[]) => invoke<ItemInfo[]>("item_info", { paths }),
  fileReport: (pairs: [string, string][], context = 3) => invoke<string>("file_report", { pairs, context }),
  readBytes: async (path: string, offset: number, len: number) => {
    const b64 = await invoke<string>("read_bytes", { path, offset, len });
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
  hexDiff: (left: string, right: string) => invoke<HexDiff>("hex_diff", { left, right }),
  compareTables: (left: string, right: string, options: TableOptions) =>
    invoke<TableResult>("compare_tables", { left, right, options }),
  readDataUrl: (path: string) => invoke<{ url: string; size: number }>("read_data_url", { path }),
  quickCompare: (left: string, right: string, mode: string) => invoke<number>("quick_compare", { left, right, mode }),
  listSessions: () => invoke<Session[]>("list_sessions"),
  saveSession: (session: Session) => invoke<void>("save_session", { session }),
  deleteSession: (id: string) => invoke<void>("delete_session", { id }),
  findSession: (name: string) => invoke<Session | null>("find_session", { name }),
};

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function joinPath(root: string, rel: string): string {
  if (!rel) return root;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + rel.split("/").join(sep);
}

export function fmtSize(n: number | undefined | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function fmtTime(ms: number | null | undefined): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
