import { invoke } from "@tauri-apps/api/core";

export type ViewKind = "home" | "text" | "folder" | "sync" | "fmerge" | "merge" | "hex" | "table" | "picture" | "edit" | "patch";

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
  message: string | null;
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
  /** Orphan (one-sided) lines are unimportant when their content is unimportant. */
  ignoreBlankLines: boolean;
  /** Line alignment: standard, unaligned, Myers O(ND) or Patience Diff. */
  algorithm: "standard" | "none" | "myers" | "patience";
  /** Lines the standard alignment searches ahead for matching runs (default 2000). */
  skewTolerance?: number;
  /** Pair remaining differing lines by character similarity. */
  useCloseness?: boolean;
  /** Show differing lines as orphans instead of pairing them. */
  neverAlignDiffs?: boolean;
  /** Text treated as equivalent when aligning ("Replacement…"); such differences are unimportant. */
  replacements?: Replacement[];
}

export interface Replacement {
  from: string;
  to: string;
  regex?: boolean;
}

export const defaultRules = (): Rules => ({
  ignoreCase: true,
  ignoreLeadingWs: true,
  ignoreTrailingWs: true,
  ignoreEmbeddedWs: true,
  ignoreBlankLines: true,
  algorithm: "standard",
  skewTolerance: 2000,
  useCloseness: true,
  neverAlignDiffs: false,
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
  /** Marked "Ignored" by the user (frontend only); treated as unimportant. */
  ignored?: boolean;
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
  /** Folder-name masks; empty or "*" includes all folders. */
  includeFolders?: string;
  otherFilters?: OtherFilter[];
  /** Exclude protected operating system files (hidden + system attributes on Windows). */
  excludeHidden?: boolean;
  /** Ignore folder structure: compare all files as if they were in one folder. */
  flatten?: boolean;
  /** Timestamps exactly one hour apart are equal. */
  ignoreDst?: boolean;
  /** Timestamps a whole number of hours apart are equal. */
  ignoreTz?: boolean;
}
/** Excludes files by date, size or content ("Other Filters"). */
export interface OtherFilter {
  kind: "date" | "size" | "content";
  enabled?: boolean;
  /** date: exclude files newer (true) or older (false) than `days` ago or `date`. */
  newer?: boolean;
  days?: number | null;
  date?: number | null;
  /** size: exclude files larger (true) or smaller (false) than `size` bytes. */
  larger?: boolean;
  size?: number;
  /** content: exclude files containing `text` (or not containing it). */
  notContaining?: boolean;
  text?: string;
  caseSensitive?: boolean;
  wholeWords?: boolean;
  regex?: boolean;
}
export interface Alignment {
  /** Relative path of the parent folder ("" for the base folder), using left-side names. */
  parent: string;
  left: string;
  right: string;
}
export type Status = "same" | "similar" | "diff" | "left" | "right" | "error";
/** Verdict of a content comparison of a file pair. */
export type ContentVerdict = "sameBinary" | "same" | "similar" | "different" | "differentBinary";
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
  /** Set when the criteria compared the files' contents. */
  content?: ContentVerdict;
  children?: FNode[];
  /** Ignore folder structure: each side's relative path. */
  leftPath?: string;
  rightPath?: string;
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
export type MergeStatus = "same" | "left" | "right" | "both" | "conflict";
export interface MergeItem {
  rel: string;
  name: string;
  left?: Side;
  right?: Side;
  base?: Side;
  output?: Side;
  status: MergeStatus;
  error?: string;
}
export interface FolderMergeResult {
  items: MergeItem[];
  summary: Record<MergeStatus, number>;
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

export type HexAlign = "none" | "fast" | "complete";

/** Aligned byte map. Kinds: 0 same, 1 left only, 2 right only, 3 different. */
export interface HexAlignment {
  leftSize: number;
  rightSize: number;
  align: HexAlign;
  map: [number, number][];
  counts: [number, number, number, number];
}

export type PixMode = "tolerance" | "range" | "blend";

export interface PixOptions {
  mode: PixMode;
  /** Largest per-channel difference that is still unimportant (0-255). */
  tolerance: number;
  /** Shade difference colours by the pictures' luminance. */
  ghost: boolean;
  ignoreUnimportant: boolean;
  /** Right picture weight in blend mode (0-100). */
  blendPct: number;
  offsetX: number;
  offsetY: number;
  /** RGBA of canvas areas covered by neither picture. */
  background: [number, number, number, number];
  /** Per side: clockwise quarter turns, applied after the horizontal flip. */
  rotate: [number, number];
  flip: [boolean, boolean];
  autoScale: boolean;
}

export interface PicInfo {
  width: number;
  height: number;
  format: string;
  hasAlpha: boolean;
}

export interface PixResult {
  left: PicInfo;
  right: PicInfo;
  width: number;
  height: number;
  counts: { same: number; unimportant: number; important: number; leftOrphan: number; rightOrphan: number };
  /** PNG data URL of the rendered difference picture. */
  image: string;
  /** Transformed pictures (rotated/flipped/scaled), null when shown as loaded. */
  sides: [string | null, string | null];
}

export interface TableOptions {
  delimiter: string;
  header: boolean;
  keys: number[];
  /** Differences only in character case are unimportant. */
  ignoreCase: boolean;
  /** Differences only in whitespace are unimportant. */
  trim: boolean;
  /** Zero-based columns whose differences are unimportant. */
  unimportant: number[];
  /** Numbers differing by at most this much are unimportant (0 = exact). */
  numTolerance: number;
  /** `numTolerance` is a percentage of the larger value. */
  numRelative: boolean;
}
export interface TableRow {
  l?: number;
  r?: number;
  k: "same" | "changed" | "unimportant" | "left" | "right";
  /** Columns that differ. */
  cells?: number[];
  /** Subset of `cells` whose differences are unimportant. */
  minor?: number[];
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
  /** Locked sessions are not overwritten by Save Session. */
  locked?: boolean;
}

export const api = {
  takeLaunchSpec: () => invoke<LaunchSpec | null>("take_launch_spec"),
  pathInfo: (path: string) => invoke<PathInfo>("path_info", { path }),
  loadText: (path: string) => invoke<TextFile>("load_text", { path }),
  saveText: (f: { path: string; lines: string[]; encoding: string; bom: boolean; eol: string; finalNewline: boolean; backup: boolean; backupKind?: string; backupDir?: string | null }) =>
    invoke<PathInfo>("save_text", f),
  diffTexts: (left: string[], right: string[], rules: Rules) => invoke<DiffResult>("diff_texts", { left, right, rules }),
  mergeTexts: (base: string[], left: string[], right: string[], rules: Rules) =>
    invoke<MergeResult>("merge_texts", { base, left, right, rules }),
  compareFolders: (left: string, right: string, options: FolderOptions) =>
    invoke<FolderResult>("compare_folders", { left, right, options }),
  planSync: (left: string, right: string, options: FolderOptions, mode: string) =>
    invoke<Action[]>("plan_sync", { left, right, options, mode }),
  compareFolderMerge: (left: string, right: string, base: string | null, output: string | null, options: FolderOptions) =>
    invoke<FolderMergeResult>("compare_folder_merge", { left, right, base, output, options }),
  executeActions: (actions: Action[], useTrash: boolean, backup?: BackupSpec) =>
    invoke<ActionResult[]>("execute_actions", { actions, useTrash, backup: backup ?? null }),
  compareItems: (left: string, right: string, rels: string[], options: FolderOptions) =>
    invoke<(FNode | null)[]>("compare_items", { left, right, rels, options }),
  itemInfo: (paths: string[]) => invoke<ItemInfo[]>("item_info", { paths }),
  makeReport: (request: ReportRequest, spec: ReportSpec, target: "content" | "browser" | `file:${string}`) =>
    invoke<string>("make_report", { request, spec, target }),
  newWindow: () => invoke<void>("new_window"),
  readBytes: async (path: string, offset: number, len: number) => {
    const b64 = await invoke<string>("read_bytes", { path, offset, len });
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
  hexAlign: (left: string, right: string, align: HexAlign) => invoke<HexAlignment>("hex_align", { left, right, align }),
  pixCompare: (left: string, right: string, options: PixOptions, leftData?: string, rightData?: string) =>
    invoke<PixResult>("pix_compare", { left, right, options, leftData: leftData ?? null, rightData: rightData ?? null }),
  pixImage: (path: string) => invoke<string>("pix_image", { path }),
  compareTables: (left: string, right: string, options: TableOptions) =>
    invoke<TableResult>("compare_tables", { left, right, options }),
  readDataUrl: (path: string) => invoke<{ url: string; size: number }>("read_data_url", { path }),
  quickCompare: (left: string, right: string, mode: string) => invoke<number>("quick_compare", { left, right, mode }),
  listSessions: () => invoke<Session[]>("list_sessions"),
  saveSession: (session: Session) => invoke<void>("save_session", { session }),
  deleteSession: (id: string) => invoke<void>("delete_session", { id }),
  findSession: (name: string) => invoke<Session | null>("find_session", { name }),
  loadSettings: () => invoke<Record<string, unknown>>("load_settings"),
  saveSettings: (settings: unknown) => invoke<void>("save_settings", { settings }),
  resetSettings: () => invoke<void>("reset_settings"),
  exportSettings: (path: string, settings: unknown | null, sessionIds: string[] | null) =>
    invoke<void>("export_settings", { path, settings, sessionIds }),
  readSettingsFile: (path: string) => invoke<ImportData>("read_settings_file", { path }),
  importSessions: (sessions: Session[], replace: boolean) => invoke<void>("import_sessions", { sessions, replace }),
  saveSnapshot: (dir: string, path: string, crc: boolean, emptyDirs: boolean, options: FolderOptions | null) =>
    invoke<number>("save_snapshot", { dir, out: path, crc, emptyDirs, options }),
  spawnCommand: (program: string, args: string[]) => invoke<void>("spawn_command", { program, args }),
  shellIntegrationStatus: () => invoke<ShellStatus>("shell_integration_status"),
  setShellIntegration: (items: ShellItem[]) => invoke<void>("set_shell_integration", { items }),
};

/** What a report covers: an open file viewer, selected files of a folder comparison, or the folder comparison. */
export type ReportRequest =
  | { type: "pair"; kind: "text" | "hex" | "table" | "picture"; left: string; right: string; view?: { left?: string[]; right?: string[]; rules?: Rules; table?: TableOptions } }
  | { type: "files"; files: [string, string | null, string | null][]; leftBase: string; rightBase: string; forced: string | null }
  | { type: "folder"; root: FNode; leftBase: string; rightBase: string; options: FolderOptions; expanded: string[] };

/** Report layout and options, using the script command's option names. */
export interface ReportSpec {
  layout: string;
  options: string[];
  title: string | null;
  outputOptions: string[];
  css: string | null;
}

export interface BackupSpec {
  kind: string;
  dir: string | null;
}
export interface ImportData {
  settings: Record<string, unknown> | null;
  sessions: Session[];
}
export interface ShellItem {
  id: "compare" | "selectLeft" | "compareStaged" | "sync" | "merge";
  enabled: boolean;
}
export interface ShellStatus {
  supported: boolean;
  items: ShellItem[];
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** The folder containing a path ("" when it has none). */
export function dirname(p: string): string {
  const t = p.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  if (i < 0) return "";
  if (i === 0) return t[0];
  return /^[A-Za-z]:$/.test(t.slice(0, i)) ? t.slice(0, i + 1) : t.slice(0, i);
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
