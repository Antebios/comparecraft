import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const PROTOCOL_VERSION = 1;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_HEADER_BYTES = 8 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4 * 1024;
const EXIT_GRACE_MS = 2_000;

export const ErrorCode = {
  parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603,
  notInitialized: -32002, cancelled: -32800, unsupportedProtocol: -32010, io: -32020, tooLarge: -32021, busy: -32022
} as const;

export interface BackendInfo {
  protocolVersion: number;
  server: { name: string; version: string };
  capabilities: { methods: string[] };
  limits: { maxMessageBytes: number; maxConcurrentRequests: number; maxQueuedRequests: number; maxLinesPerSide: number };
}

export class BackendError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
  }
}

export interface BackendOptions {
  /** Client identity sent in `initialize`. */
  client: { name: string; version: string };
  /** Methods the caller needs; the handshake fails if the helper lacks any of them. */
  requiredMethods?: readonly string[];
  handshakeTimeoutMs?: number;
  /** Receives helper stderr lines and lifecycle messages. Never receives file contents. */
  log?: (line: string) => void;
  /** Arguments placed before `--stdio`; used by tests to run a script through Node. */
  argsPrefix?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** One running `comparecraft-backend --stdio` process speaking protocol 1. */
export class BackendClient {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer: Buffer = Buffer.alloc(0);
  private stderrTail = "";
  private stderrLine = "";
  private failure: BackendError | undefined;
  private exited = false;
  private readonly exitWaiters: (() => void)[] = [];
  private readonly exitListeners: ((error: BackendError) => void)[] = [];
  private disposing: Promise<void> | undefined;
  private maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES;
  private backendInfo: BackendInfo | undefined;

  private constructor(readonly executable: string, private readonly child: ChildProcessWithoutNullStreams, private readonly log: (line: string) => void) {
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.stderr(chunk.toString("utf8")));
    // A closed pipe surfaces through the exit handler; avoid unhandled stream errors.
    child.stdin.on("error", error => this.log(`backend stdin: ${error.message}`));
    child.once("error", error => this.fail(new BackendError(`Could not start the CompareCraft backend (${executable}): ${error.message}`)));
    child.once("exit", (code, signal) => {
      this.exited = true;
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      const expected = this.disposing !== undefined && code === 0;
      if (!expected) this.fail(new BackendError(`The CompareCraft backend exited unexpectedly (${reason}).${this.stderrSummary()}`));
      else this.fail(new BackendError("The CompareCraft backend was shut down."));
      for (const waiter of this.exitWaiters.splice(0)) waiter();
    });
  }

  /** Spawns the helper and completes the `initialize` handshake. */
  static async start(executable: string, options: BackendOptions): Promise<BackendClient> {
    const child = spawn(executable, [...(options.argsPrefix ?? []), "--stdio"], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: options.env ?? process.env
    });
    const client = new BackendClient(executable, child, options.log ?? (() => undefined));
    const timeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      const info = await Promise.race([
        client.send<BackendInfo>("initialize", { protocolVersions: [PROTOCOL_VERSION], client: options.client }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new BackendError(`The CompareCraft backend did not answer the handshake within ${timeoutMs / 1000} s (${executable}).`)), timeoutMs);
        })
      ]);
      if (info?.protocolVersion !== PROTOCOL_VERSION) {
        throw new BackendError(`The CompareCraft backend uses protocol ${String(info?.protocolVersion)}, but this extension needs protocol ${PROTOCOL_VERSION}. Install matching versions of CompareCraft and the extension.`);
      }
      const methods = Array.isArray(info.capabilities?.methods) ? info.capabilities.methods : [];
      const missing = (options.requiredMethods ?? []).filter(method => !methods.includes(method));
      if (missing.length) {
        throw new BackendError(`The installed CompareCraft backend ${info.server?.version ?? ""} lacks required features (${missing.join(", ")}). Update CompareCraft.`);
      }
      if (Number.isSafeInteger(info.limits?.maxMessageBytes) && info.limits.maxMessageBytes > 0) client.maxMessageBytes = info.limits.maxMessageBytes;
      client.backendInfo = info;
      return client;
    } catch (error) {
      client.kill();
      if (error instanceof BackendError && error.code === ErrorCode.unsupportedProtocol) {
        throw new BackendError(`The CompareCraft backend does not support protocol ${PROTOCOL_VERSION}. Install matching versions of CompareCraft and the extension.`, error.code, error.data);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  get info(): BackendInfo {
    if (!this.backendInfo) throw new BackendError("The CompareCraft backend is not initialized.");
    return this.backendInfo;
  }

  get alive(): boolean {
    return !this.failure && !this.exited;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Called once when the helper stops for any reason other than dispose(). */
  onExit(listener: (error: BackendError) => void): void {
    this.exitListeners.push(listener);
  }

  /** True when the running helper advertises every listed method. */
  supports(...methods: readonly string[]): boolean {
    return methods.every(method => this.info.capabilities.methods.includes(method));
  }

  async request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.info.capabilities.methods.includes(method)) {
      throw new BackendError(`The installed CompareCraft backend does not support ${method}. Update CompareCraft.`, ErrorCode.methodNotFound);
    }
    return this.send<T>(method, params, signal);
  }

  private send<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(new BackendError(`${method} was cancelled.`, ErrorCode.cancelled));
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }), "utf8");
    if (body.length > this.maxMessageBytes) {
      return Promise.reject(new BackendError(`${method} input is too large for the backend (${body.length} bytes; limit ${this.maxMessageBytes}).`, ErrorCode.tooLarge));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        this.notify("$/cancelRequest", { id });
        reject(new BackendError(`${method} was cancelled.`, ErrorCode.cancelled));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        method,
        resolve: value => resolve(value as T),
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort)
      });
      this.write(body);
    });
  }

  private notify(method: string, params?: unknown): void {
    if (this.failure || this.exited) return;
    this.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }), "utf8"));
  }

  private write(body: Buffer): void {
    if (!this.child.stdin.writable) return;
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (!this.failure) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) this.violation("header block too large");
        return;
      }
      if (end > MAX_HEADER_BYTES) return this.violation("header block too large");
      let length: number | undefined;
      for (const line of this.buffer.subarray(0, end).toString("ascii").split("\r\n")) {
        const separator = line.indexOf(":");
        if (separator > 0 && line.slice(0, separator).trim().toLowerCase() === "content-length") {
          const value = line.slice(separator + 1).trim();
          length = /^\d+$/.test(value) ? Number(value) : NaN;
        }
      }
      if (length === undefined || !Number.isSafeInteger(length)) return this.violation("missing or invalid Content-Length");
      if (length > this.maxMessageBytes) return this.violation(`message of ${length} bytes exceeds the limit`);
      const start = end + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length);
      this.buffer = this.buffer.subarray(start + length);
      let message: { id?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        return this.violation("response is not valid JSON");
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: { id?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }): void {
    if (typeof message.id !== "number") {
      if (message.error) this.log(`backend error without request id: ${message.error.message ?? "unknown"}`);
      return;
    }
    const pending = this.pending.get(message.id);
    // Answers to cancelled requests arrive after the caller was already rejected.
    if (!pending) return;
    this.pending.delete(message.id);
    pending.cleanup();
    if (message.error) {
      pending.reject(new BackendError(`CompareCraft backend ${pending.method} failed: ${message.error.message ?? "unknown error"}`, message.error.code, message.error.data));
    } else {
      pending.resolve(message.result ?? null);
    }
  }

  private stderr(text: string): void {
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_BYTES);
    const lines = (this.stderrLine + text).split(/\r?\n/);
    this.stderrLine = lines.pop() ?? "";
    for (const line of lines) if (line) this.log(line);
  }

  private stderrSummary(): string {
    const tail = this.stderrTail.trim();
    return tail ? ` Recent output: ${tail.split(/\r?\n/).slice(-5).join(" | ")}` : "";
  }

  private violation(detail: string): void {
    this.fail(new BackendError(`The CompareCraft backend broke the protocol (${detail}).${this.stderrSummary()}`));
    this.kill();
  }

  private fail(error: BackendError): void {
    if (this.failure) return;
    this.failure = error;
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(error);
    }
    if (this.disposing === undefined) {
      this.log(error.message);
      for (const listener of this.exitListeners.splice(0)) listener(error);
    }
  }

  private kill(): void {
    if (!this.exited) this.child.kill();
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), ms);
      this.exitWaiters.push(() => { clearTimeout(timer); resolve(true); });
    });
  }

  /** shutdown → exit → close stdin, then kill if the helper is still running after two seconds. */
  dispose(): Promise<void> {
    this.disposing ??= (async () => {
      if (!this.failure && !this.exited) {
        const shutdown = this.send("shutdown", undefined).catch(() => undefined);
        await Promise.race([shutdown, new Promise(resolve => setTimeout(resolve, EXIT_GRACE_MS))]);
        this.notify("exit");
      }
      this.child.stdin.end();
      if (!(await this.waitForExit(EXIT_GRACE_MS))) {
        this.log("The CompareCraft backend did not exit in time and was stopped.");
        this.kill();
        await this.waitForExit(EXIT_GRACE_MS);
      }
      this.fail(new BackendError("The CompareCraft backend was shut down."));
    })();
    return this.disposing;
  }
}

/** Starts one helper on demand, restarts it after a crash, and stops it on dispose or reset. */
export class BackendManager {
  private current: Promise<BackendClient> | undefined;

  constructor(private readonly resolveExecutable: () => Promise<string>, private readonly options: BackendOptions) {}

  get(): Promise<BackendClient> {
    if (!this.current) {
      const starting = (async () => {
        const executable = await this.resolveExecutable();
        this.options.log?.(`Starting CompareCraft backend: ${executable}`);
        const client = await BackendClient.start(executable, this.options);
        client.onExit(() => { if (this.current === starting) this.current = undefined; });
        return client;
      })();
      this.current = starting;
      starting.catch(() => { if (this.current === starting) this.current = undefined; });
    }
    return this.current;
  }

  /** Stops the running helper; the next get() starts a fresh one (for example after a settings change). */
  async reset(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    if (!current) return;
    try { await (await current).dispose(); } catch { /* a helper that failed to start has nothing to stop */ }
  }

  dispose(): Promise<void> {
    return this.reset();
  }
}
