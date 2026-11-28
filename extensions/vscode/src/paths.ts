/**
 * Resource paths as the controller, embedded specs and the webview carry them: an absolute file-system
 * path for a file the extension host can open directly, or the resource's full URI string for anything
 * else (virtual workspaces, and every resource in browser VS Code). Pure string helpers: no Node or
 * VS Code imports, so the browser bundle and plain Node unit tests can both use them.
 */

const WINDOWS = typeof process !== "undefined" && process.platform === "win32";
const URI = /^([a-zA-Z][a-zA-Z0-9+.-]+):(\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/;

/** True for `scheme:...` strings. Windows drive paths (`C:\`) have a one-letter "scheme" and don't match. */
export const isUriString = (value: string): boolean => /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(value);

/** Absolute file-system path (for this platform) or URI string. */
export function isAbsolutePath(value: string): boolean {
  if (!value) return false;
  if (isUriString(value)) return true;
  return WINDOWS ? /^([a-zA-Z]:)?[\\/]/.test(value) : value.startsWith("/");
}

interface ParsedUri { scheme: string; hasAuthority: boolean; authority: string; path: string; rest: string }

function parseUri(value: string): ParsedUri | undefined {
  const match = URI.exec(value);
  if (!match) return undefined;
  return {
    scheme: match[1]!, hasAuthority: match[2] !== undefined, authority: match[3] ?? "", path: match[4] ?? "",
    rest: (match[5] ?? "") + (match[6] ?? "")
  };
}

const uriPrefix = (uri: ParsedUri) => `${uri.scheme}:${uri.hasAuthority ? `//${uri.authority}` : ""}`;

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Last path segment; URI segments are decoded for display. */
export function basename(value: string): string {
  if (isUriString(value)) {
    const uri = parseUri(value);
    const segments = (uri?.path ?? "").split("/").filter(Boolean);
    return decode(segments[segments.length - 1] ?? "");
  }
  const parts = value.split(WINDOWS ? /[\\/]/ : /\//).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** Extension including the dot, like Node's `path.extname` (".txt"; "" for ".bashrc" or "name"). */
export function extname(value: string): string {
  const name = basename(value);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/** The containing folder; a root is its own parent. */
export function dirname(value: string): string {
  if (isUriString(value)) {
    const uri = parseUri(value);
    if (!uri) return value;
    const path = uri.path.replace(/\/+$/, "");
    const index = path.lastIndexOf("/");
    return uriPrefix(uri) + (index <= 0 ? "/" : path.slice(0, index)) + uri.rest;
  }
  const normalized = normalizeFsPath(value);
  const separator = WINDOWS ? "\\" : "/";
  const index = normalized.lastIndexOf(separator);
  const root = rootOf(normalized);
  if (index < root.length) return root;
  return normalized.slice(0, index);
}

/** Appends a slash-separated relative path. */
export function joinPath(base: string, rel: string): string {
  if (!rel) return base;
  if (isUriString(base)) {
    const uri = parseUri(base);
    if (!uri) return base;
    const encoded = rel.split("/").map(segment => encodeURIComponent(segment)).join("/");
    return `${uriPrefix(uri)}${uri.path.replace(/\/+$/, "")}/${encoded}${uri.rest}`;
  }
  const separator = WINDOWS ? "\\" : "/";
  return base.replace(/[\\/]+$/, "") + separator + rel.split("/").join(separator);
}

function rootOf(normalized: string): string {
  if (!WINDOWS) return "/";
  const unc = /^\\\\[^\\]+\\[^\\]+\\?/.exec(normalized);
  if (unc) return unc[0].endsWith("\\") ? unc[0] : `${unc[0]}\\`;
  const drive = /^[a-zA-Z]:\\/.exec(normalized);
  return drive ? drive[0] : "\\";
}

/** Resolves "." and ".." segments and duplicate or trailing separators of an absolute path. */
function normalizeFsPath(value: string): string {
  const separator = WINDOWS ? "\\" : "/";
  let rest = WINDOWS ? value.replace(/\//g, "\\") : value;
  let prefix = "";
  if (WINDOWS) {
    const unc = /^\\\\[^\\]+\\[^\\]+/.exec(rest);
    const drive = /^[a-zA-Z]:/.exec(rest);
    if (unc) prefix = unc[0];
    else if (drive) prefix = drive[0];
    rest = rest.slice(prefix.length);
  }
  const parts: string[] = [];
  for (const part of rest.split(separator)) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${prefix}${separator}${parts.join(separator)}`;
}

/**
 * Identity used to compare resources: normalized and case-insensitive for Windows file paths; for URIs a
 * lower-case scheme and authority and a decoded path, so differently encoded strings of one URI match.
 */
export function pathKey(value: string): string {
  if (isUriString(value)) {
    const uri = parseUri(value);
    if (!uri) return value;
    const path = uri.path.split("/").map(decode).join("/");
    return `${uri.scheme.toLowerCase()}://${uri.authority.toLowerCase()}${path.length > 1 ? path.replace(/\/+$/, "") : path}${uri.rest}`;
  }
  const normalized = normalizeFsPath(value);
  return WINDOWS ? normalized.toLowerCase() : normalized;
}

export const samePath = (a: string, b: string): boolean => pathKey(a) === pathKey(b);

/** True when `file` is strictly inside the folder `base` (same scheme and authority for URIs). */
export function withinFolder(base: string, file: string): boolean {
  if (!base || !file || isUriString(base) !== isUriString(file)) return false;
  const baseKey = pathKey(base), fileKey = pathKey(file);
  if (isUriString(base)) {
    const prefix = baseKey.endsWith("/") ? baseKey : `${baseKey}/`;
    return fileKey.startsWith(prefix) && fileKey.length > prefix.length;
  }
  const separator = WINDOWS ? "\\" : "/";
  const prefix = baseKey.endsWith(separator) ? baseKey : `${baseKey}${separator}`;
  return fileKey.startsWith(prefix) && fileKey.length > prefix.length;
}

/** The URI scheme of a path string ("file" for file-system paths). */
export const schemeOf = (value: string): string => isUriString(value) ? value.slice(0, value.indexOf(":")).toLowerCase() : "file";

/** Converts a `file:` URL to a path for this platform, like Node's `url.fileURLToPath`. */
export function fileUrlToPath(href: string): string {
  const url = new URL(href);
  if (url.protocol !== "file:") throw new Error(`Not a file URL: ${href}`);
  if (/%2f/i.test(url.pathname) || (WINDOWS && /%5c/i.test(url.pathname))) throw new Error(`File URL path must not include encoded separators: ${href}`);
  const pathname = decodeURIComponent(url.pathname);
  if (WINDOWS) {
    if (url.hostname && url.hostname !== "localhost") return `\\\\${url.hostname}${pathname.replace(/\//g, "\\")}`;
    const local = pathname.replace(/^\/([a-zA-Z]:)/, "$1").replace(/\//g, "\\");
    if (!/^[a-zA-Z]:\\/.test(local)) throw new Error(`File URL path must be absolute: ${href}`);
    return local;
  }
  if (url.hostname && url.hostname !== "localhost") throw new Error(`File URL host must be "localhost" or empty on this platform: ${href}`);
  return pathname;
}
