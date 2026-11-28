/**
 * Routes comparison requests to the native helper or the WebAssembly engine. Pure module (interfaces
 * only), shared by the desktop/remote Node extension host and browser VS Code.
 *
 * - The helper handles files the extension host can open directly, when a helper is installed (bundled
 *   with the extension, configured in `comparecraft.backendPath`, or next to the desktop app).
 * - Everything else is read through `FileAccess` and compared by the WebAssembly engine, which runs the
 *   same Rust engine code. Folder comparison always needs the helper.
 * - An invalid explicit helper setting, or a helper that fails to start, is reported; only a helper that
 *   isn't installed at all falls back to WebAssembly.
 */
import { BackendError, ErrorCode, UnavailableError } from "./errors";
import type { FileAccess } from "./fileAccess";
import { basename } from "./paths";
import type { WasmEngine } from "./wasmEngine";

export interface HelperInfo {
  protocolVersion: number;
  server: { name: string; version: string };
  capabilities: { methods: string[]; folderOptions?: string[] };
}

/** The running helper process (see `backend.ts`). */
export interface HelperClient {
  readonly executable: string;
  readonly info: HelperInfo;
  supports(...methods: readonly string[]): boolean;
  request<T>(method: string, params?: unknown): Promise<T>;
}

export interface HelperAccess {
  /** The running helper; undefined when none is installed. Invalid settings and start failures throw. */
  client(): Promise<HelperClient | undefined>;
}

export interface EngineOptions {
  readonly files: FileAccess;
  readonly wasm: () => Promise<WasmEngine>;
  readonly helper?: HelperAccess;
  readonly log: (line: string) => void;
}

/** Path parameters of the path-based protocol methods. */
const PATH_PARAMS: Record<string, readonly string[]> = {
  "path.info": ["path"],
  "text.load": ["path"],
  "hex.align": ["left", "right"],
  "table.compare": ["left", "right"],
  "pix.compare": ["left", "right"],
  "pix.image": ["path"],
  "file.quickCompare": ["left", "right"],
  "folder.compare": ["left", "right"],
  "folder.compareItems": ["left", "right"],
};

const PURE = new Set(["text.diff", "text.merge"]);
const FOLDER = new Set(["folder.compare", "folder.compareItems"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "jpe", "jfif", "gif", "bmp", "dib", "webp", "ico", "svg", "avif", "tif", "tiff", "tga", "pnm", "pbm", "pgm", "ppm", "pam", "qoi"]);
const TABLE_EXTENSIONS = new Set(["csv", "tsv", "tab"]);
const KIND_SNIFF_BYTES = 8192;
/** `quick_compare`'s verdict when a side can't be compared (see `src-tauri/src/quick.rs`). */
const QUICK_UNKNOWN_ERROR = 100;

type Params = Record<string, unknown>;

export class ComparisonEngine {
  private wasmEngine: Promise<WasmEngine> | undefined;
  private announced = false;

  constructor(private readonly options: EngineOptions) {}

  /** The installed helper, or undefined (browser VS Code, or no helper installed). */
  async helper(): Promise<HelperClient | undefined> {
    return this.options.helper ? this.options.helper.client() : undefined;
  }

  wasm(): Promise<WasmEngine> {
    if (!this.wasmEngine) {
      const loading = this.options.wasm();
      this.wasmEngine = loading;
      loading.catch(() => { if (this.wasmEngine === loading) this.wasmEngine = undefined; });
    }
    return this.wasmEngine;
  }

  /** Runs one protocol request (see docs/vscode-extension/backend-protocol.md) on the best engine. */
  async request<T>(method: string, params: Params): Promise<T> {
    const paths = (PATH_PARAMS[method] ?? []).map(key => params[key]);
    const local = paths.every(item => typeof item === "string" && this.options.files.isLocal(item));
    if (PURE.has(method) || local) {
      const helper = await this.helper();
      if (helper?.supports(method)) return helper.request<T>(method, params);
      if (FOLDER.has(method)) {
        throw new UnavailableError(helper
          ? "Update CompareCraft: the installed backend lacks embedded folder comparison support."
          : "Folder comparison in VS Code needs the CompareCraft helper (comparecraft-backend), which isn't installed here. Install the CompareCraft desktop app, or set comparecraft.backendPath.");
      }
      if (!helper && !this.announced) {
        this.announced = true;
        this.options.log("No CompareCraft helper is installed here; comparing with the WebAssembly engine.");
      }
    } else if (FOLDER.has(method)) {
      throw new UnavailableError("Folder comparison needs folders on disk.");
    }
    return this.fallback<T>(method, params) as Promise<T>;
  }

  private async fallback<T>(method: string, p: Params): Promise<unknown> {
    const wasm = await this.wasm();
    const files = this.options.files;
    switch (method) {
      case "text.diff":
      case "text.merge":
        return wasm.call<T>(method, p);
      case "path.info": {
        const file = p.path as string;
        const info = await files.stat(file);
        if (!info) return { path: file, exists: false, isDir: false, size: 0, modified: null, kind: "missing" };
        const isDir = info.type === "folder";
        const kind = isDir ? "folder" : byExtension(file) ?? wasm.call<string>("kind.detect", { name: file }, await files.read(file, 0, KIND_SNIFF_BYTES));
        return { path: file, exists: true, isDir, size: info.size, modified: info.mtime, kind };
      }
      case "text.load": {
        const file = p.path as string;
        const info = await this.existingFile(file);
        const decoded = wasm.call<Params>("text.decode", { name: file }, await this.contents(file, info.size, wasm));
        return { ...decoded, size: info.size, modified: info.mtime, readOnly: info.readOnly };
      }
      case "hex.align": {
        const [a, b] = await this.pair(p, wasm);
        return wasm.call<T>("hex.alignData", { align: p.align ?? "complete" }, a, b);
      }
      case "table.compare": {
        const [a, b] = await this.pair(p, wasm);
        return wasm.call<T>("table.compareData", { leftName: basename(p.left as string), rightName: basename(p.right as string), options: p.options ?? {} }, a, b);
      }
      case "pix.compare": {
        const sides = await Promise.all((["left", "right"] as const).map(async side => {
          const data = p[`${side}Data`];
          return typeof data === "string" ? new Uint8Array(0) : this.contents(p[side] as string, (await this.existingFile(p[side] as string)).size, wasm);
        }));
        return wasm.call<T>("pix.compareData", {
          leftName: basename(p.left as string), rightName: basename(p.right as string), options: p.options ?? {},
          leftData: p.leftData ?? null, rightData: p.rightData ?? null
        }, sides[0], sides[1]);
      }
      case "pix.image": {
        const file = p.path as string;
        const info = await this.existingFile(file);
        return wasm.call<T>("pix.imageData", { name: basename(file) }, await this.contents(file, info.size, wasm));
      }
      case "file.quickCompare": {
        // Like the helper: a missing side or a folder is the "unknown error" verdict, not a failure.
        const infos = await Promise.all([files.stat(p.left as string), files.stat(p.right as string)]);
        if (infos.some(info => info?.type !== "file")) return QUICK_UNKNOWN_ERROR;
        const [a, b] = await this.pair(p, wasm);
        return wasm.call<T>("quick.compareData", { mode: p.mode }, a, b);
      }
      default:
        throw new BackendError(`The ${method} comparison isn't available for these files.`, ErrorCode.methodNotFound);
    }
  }

  private async existingFile(file: string) {
    const info = await this.options.files.stat(file);
    if (!info) throw new BackendError(`${file}: not found`, ErrorCode.io, { path: file, kind: "NotFound" });
    if (info.type !== "file") throw new BackendError(`${file} is not a file`, ErrorCode.io, { path: file });
    return info;
  }

  /** Whole file contents, refusing files above the engine's in-memory limit before reading them. */
  private async contents(file: string, size: number, wasm: WasmEngine): Promise<Uint8Array> {
    const limit = wasm.info.limits.maxDataBytes;
    if (size > limit) {
      throw new BackendError(`${basename(file)} is ${size} bytes; files above ${limit} bytes can't be compared here.`, ErrorCode.tooLarge, { limit, actual: size });
    }
    return this.options.files.readFile(file);
  }

  private async pair(p: Params, wasm: WasmEngine): Promise<[Uint8Array, Uint8Array]> {
    const left = p.left as string, right = p.right as string;
    const [l, r] = await Promise.all([this.existingFile(left), this.existingFile(right)]);
    return Promise.all([this.contents(left, l.size, wasm), this.contents(right, r.size, wasm)]);
  }
}

function byExtension(file: string): string | undefined {
  const name = basename(file);
  const dot = name.lastIndexOf(".");
  // Like Rust's `Path::extension`: a leading dot (".png") starts a name, not an extension.
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return IMAGE_EXTENSIONS.has(extension) ? "picture" : TABLE_EXTENSIONS.has(extension) ? "table" : undefined;
}
