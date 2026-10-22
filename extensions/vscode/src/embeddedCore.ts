import path from "node:path";
import type { SideInput } from "./contracts";

/** Initial state of an embedded text comparison; also the persisted webview state. */
export interface EmbeddedSpec {
  readonly paths: string[];
  readonly titles: (string | null)[];
  readonly readOnly: boolean[];
  readonly options: Record<string, unknown>;
  /** Unsaved side text to restore over the loaded file, per side. */
  readonly restore?: [string[] | null, string[] | null];
}

/** Desktop `TextFile` shape returned to the shared UI for `load_text`. */
export interface TextFileResult {
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

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isLines = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");

/** Validates a spec from a webview or persisted state; throws on anything unexpected. */
export function parseSpec(value: unknown): EmbeddedSpec {
  if (!isObject(value)) throw new Error("Invalid embedded comparison state.");
  const { paths, titles = [], readOnly = [], options = {}, restore } = value;
  if (!Array.isArray(paths) || paths.length > 2 || !paths.every(item => typeof item === "string" && (item === "" || path.isAbsolute(item)))) {
    throw new Error("Embedded comparisons need up to two absolute file paths.");
  }
  if (!Array.isArray(titles) || !titles.every(item => item === null || typeof item === "string")) throw new Error("Invalid comparison titles.");
  if (!Array.isArray(readOnly) || !readOnly.every(item => item === null || typeof item === "boolean")) throw new Error("Invalid read-only flags.");
  if (!isObject(options)) throw new Error("Invalid comparison options.");
  let restored: EmbeddedSpec["restore"];
  if (restore !== undefined && restore !== null) {
    if (!Array.isArray(restore) || restore.length !== 2 || !restore.every(side => side === null || isLines(side))) {
      throw new Error("Invalid restored comparison text.");
    }
    restored = [restore[0] as string[] | null, restore[1] as string[] | null];
  }
  return { paths: paths as string[], titles: titles as (string | null)[], readOnly: readOnly.map(item => item === true), options, ...(restored ? { restore: restored } : {}) };
}

/** Splits like the desktop loader: a trailing line break does not add an empty last line. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function joinLines(lines: readonly string[], eol: "\n" | "\r\n", finalNewline: boolean): string {
  const text = lines.join(eol);
  return finalNewline && lines.length > 0 ? text + eol : text;
}

export function textFileFromBuffer(file: string, text: string, eol: "\n" | "\r\n", info: { size: number; modified: number | null; readOnly: boolean }): TextFileResult {
  return {
    path: file,
    lines: splitLines(text),
    encoding: "UTF-8",
    bom: false,
    eol: eol === "\r\n" ? "CRLF" : "LF",
    finalNewline: /(\r\n|\n|\r)$/.test(text),
    size: info.size,
    modified: info.modified,
    binary: false,
    readOnly: info.readOnly,
  };
}

export const pathKey = (file: string) => {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

export class ConflictError extends Error {
  constructor(file: string) {
    super(`${path.basename(file)} changed in VS Code or on disk after it was loaded into this comparison. Reload (F5) to compare against the current text before saving.`);
    this.name = "ConflictError";
  }
}

/**
 * Remembers the exact source text each comparison side was loaded from. A save is allowed only
 * while the document still has that text, so edits made elsewhere are never overwritten.
 */
export class DocumentGuard {
  private readonly baselines = new Map<string, { path: string; text: string }>();

  remember(file: string, text: string): void {
    this.baselines.set(pathKey(file), { path: file, text });
  }

  forget(file: string): void {
    this.baselines.delete(pathKey(file));
  }

  has(file: string): boolean {
    return this.baselines.has(pathKey(file));
  }

  /** Paths (as the view knows them) whose current text differs from the loaded baseline. */
  changed(file: string, current: string): string[] {
    const entry = this.baselines.get(pathKey(file));
    return entry && entry.text !== current ? [entry.path] : [];
  }

  /** Throws ConflictError when the document changed since load; unknown paths pass. */
  assertUnchanged(file: string, current: string): void {
    const entry = this.baselines.get(pathKey(file));
    if (entry && entry.text !== current) throw new ConflictError(file);
  }

  paths(): string[] {
    return [...this.baselines.values()].map(entry => entry.path);
  }
}

/** Desktop commands the embedded comparison deliberately does not provide. */
export function unsupportedCommand(command: string): Error {
  return new Error(`"${command}" is not available in the embedded comparison. Use CompareCraft: Open Desktop App for this feature.`);
}

/** Converts Tauri dialog filters to VS Code's `{ name: extensions }` form. */
export function dialogFilters(value: unknown): Record<string, string[]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const filters: Record<string, string[]> = {};
  for (const filter of value) {
    if (isObject(filter) && typeof filter.name === "string" && isLines(filter.extensions)) filters[filter.name] = filter.extensions;
  }
  return Object.keys(filters).length ? filters : undefined;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${name}.`);
  return value;
}

export function requireAbsolute(value: unknown, name = "path"): string {
  const file = requireString(value, name);
  if (!path.isAbsolute(file)) throw new Error(`The ${name} must be absolute: ${file}`);
  return file;
}

export function requireLines(value: unknown, name: string): string[] {
  if (!isLines(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

export function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

/** Panel title: the side names, or one name when both sides show the same file. */
export function titleOf(spec: EmbeddedSpec): string {
  const names = [0, 1].map(side => spec.titles[side] || (spec.paths[side] ? path.basename(spec.paths[side]!) : "Untitled"));
  return names[0] === names[1] ? names[0]! : `${names[0]} ↔ ${names[1]}`;
}

type Input = SideInput;

/**
 * Converts controller inputs to an embedded spec. Editable files stay live documents; read-only
 * files (for example "saved on disk") and in-memory text become read-only content sides.
 */
export async function specFromInputs(inputs: readonly Input[], loadDisk: (file: string) => Promise<string[]>): Promise<EmbeddedSpec> {
  if (inputs.length !== 2) throw new Error("Embedded comparisons have exactly two sides.");
  const paths: string[] = [], titles: (string | null)[] = [], readOnly: boolean[] = [], content: (string[] | null)[] = [];
  for (const input of inputs) {
    if (input.kind === "path" && !input.readOnly) {
      if (!path.isAbsolute(input.path)) throw new Error(`The path must be absolute: ${input.path}`);
      paths.push(input.path);
      titles.push(input.title ?? null);
      readOnly.push(false);
      content.push(null);
    } else {
      paths.push("");
      titles.push(input.title ?? (input.kind === "path" ? `${path.basename(input.path)} (read-only)` : input.name));
      readOnly.push(true);
      content.push(input.kind === "path" ? await loadDisk(input.path)
        : splitLines(typeof input.content === "string" ? input.content : new TextDecoder().decode(input.content)));
    }
  }
  return { paths, titles, readOnly, options: content.some(Boolean) ? { content } : {} };
}
