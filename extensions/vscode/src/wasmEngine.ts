/**
 * The comparison engine compiled to WebAssembly (`src-tauri/src/wasm.rs`): the same Rust code as the
 * desktop app and the `comparecraft-backend` helper, for hosts where no helper can run. Pure module:
 * only the standard WebAssembly API, so Node tests, the Node extension host and browsers share it.
 */
import { BackendError, ErrorCode } from "./errors";

interface Exports {
  readonly memory: WebAssembly.Memory;
  cc_alloc(length: number): number;
  cc_free(pointer: number, length: number): void;
  cc_call(request: number, requestLength: number, a: number, aLength: number, b: number, bLength: number): number;
}

export interface WasmInfo {
  version: string;
  methods: string[];
  limits: { maxLinesPerSide: number; maxDataBytes: number };
}

const EMPTY = new Uint8Array(0);

export class WasmEngine {
  private exports: Exports | undefined;
  private engineInfo: WasmInfo | undefined;

  private constructor(private readonly module: WebAssembly.Module, readonly size: number) {}

  /** Compiles the module; instances are created on demand (again after a trap). */
  static async load(bytes: Uint8Array): Promise<WasmEngine> {
    const module = await WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
    const engine = new WasmEngine(module, bytes.length);
    engine.engineInfo = engine.call<WasmInfo>("engine.info", null);
    return engine;
  }

  get info(): WasmInfo {
    return this.engineInfo!;
  }

  supports(...methods: readonly string[]): boolean {
    return methods.every(method => this.info.methods.includes(method));
  }

  private instance(): Exports {
    this.exports ??= new WebAssembly.Instance(this.module, {}).exports as unknown as Exports;
    return this.exports;
  }

  /**
   * Runs one request synchronously. `a` and `b` are file contents for the `*Data`, `text.decode` and
   * `kind.detect` methods. Errors carry the protocol's error codes, as from the helper.
   */
  call<T>(method: string, params: unknown, a: Uint8Array = EMPTY, b: Uint8Array = EMPTY): T {
    const e = this.instance();
    const request = new TextEncoder().encode(JSON.stringify({ method, params: params ?? null }));
    const buffers: [number, number][] = [];
    const put = (bytes: Uint8Array): number => {
      const pointer = e.cc_alloc(bytes.length);
      buffers.push([pointer, bytes.length]);
      new Uint8Array(e.memory.buffer, pointer, bytes.length).set(bytes);
      return pointer;
    };
    let text: string;
    try {
      const requestPointer = put(request), aPointer = put(a), bPointer = put(b);
      const response = e.cc_call(requestPointer, request.length, aPointer, a.length, bPointer, b.length);
      const length = new DataView(e.memory.buffer).getUint32(response, true);
      text = new TextDecoder().decode(new Uint8Array(e.memory.buffer, response + 4, length));
      e.cc_free(response, length + 4);
    } catch (error) {
      // A trap (for example running out of memory) leaves the instance unusable; start a new one next time.
      this.exports = undefined;
      throw new BackendError(`The CompareCraft WebAssembly engine failed while running ${method}: ${error instanceof Error ? error.message : String(error)}`, ErrorCode.internal);
    } finally {
      if (this.exports) for (const [pointer, length] of buffers) e.cc_free(pointer, length);
    }
    const message = JSON.parse(text) as { result?: T; error?: { code?: number; message?: string; data?: unknown } };
    if (message.error) {
      throw new BackendError(`CompareCraft engine ${method} failed: ${message.error.message ?? "unknown error"}`, message.error.code, message.error.data);
    }
    return message.result as T;
  }
}
