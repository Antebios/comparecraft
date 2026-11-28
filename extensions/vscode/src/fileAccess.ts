/** File access for comparison sides, independent of where files live. Pure interface module. */

export interface FileInfo {
  readonly type: "file" | "folder" | "other";
  readonly size: number;
  /** Modification time in milliseconds, when known. */
  readonly mtime: number | null;
  /** The file can't be written (permissions, or a read-only file system provider). */
  readonly readOnly: boolean;
}

export type EntryType = "file" | "folder" | "other";

/**
 * Reads files by path string (see `paths.ts`): absolute file-system paths through the extension host's
 * disk where it has one, URI strings through VS Code's file system providers.
 */
export interface FileAccess {
  /** True when the helper (a native process on the extension host) can open `path` directly. */
  isLocal(path: string): boolean;
  /** Undefined when nothing exists at `path`. */
  stat(path: string): Promise<FileInfo | undefined>;
  readFile(path: string): Promise<Uint8Array>;
  /** Up to `length` bytes at `offset`; fewer at the end of the file. */
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
  /** Folder entries as `[name, type]`. */
  list(path: string): Promise<[string, EntryType][]>;
  /** Creates a new file; fails when something already exists at `path`. */
  create(path: string, data: Uint8Array): Promise<void>;
  /** Resolves symbolic links where the file system has them; other paths are returned unchanged. */
  realpath(path: string): Promise<string>;
}

/** Bytes as base64 without Node's Buffer (also in the browser). */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Random bytes as lower-case hex, from the Web Crypto API (Node 20+ and browsers). */
export function randomHex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return [...values].map(value => value.toString(16).padStart(2, "0")).join("");
}

export const randomBase64 = (bytes: number): string => toBase64(crypto.getRandomValues(new Uint8Array(bytes)));
