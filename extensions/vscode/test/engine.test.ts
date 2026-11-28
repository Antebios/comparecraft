import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ComparisonEngine, type HelperAccess, type HelperClient } from "../src/engine";
import { BackendError, ErrorCode, UnavailableError } from "../src/errors";
import type { EntryType, FileAccess, FileInfo } from "../src/fileAccess";
import { isUriString } from "../src/paths";
import { WasmEngine } from "../src/wasmEngine";

const WASM_FILE = path.resolve(__dirname, "..", "..", "media", "engine", "comparecraft-engine.wasm");
const noWasm = !existsSync(WASM_FILE) && `build it with npm run build:engine (${WASM_FILE})`;
const loadWasm = () => WasmEngine.load(readFileSync(WASM_FILE));

/** In-memory files: local paths (no scheme) and URI strings, as a provider would serve them. */
class MemoryFiles implements FileAccess {
  readonly reads: string[] = [];
  constructor(readonly entries: Record<string, string | Uint8Array | null>) {}
  isLocal(file: string) { return !isUriString(file); }
  async stat(file: string): Promise<FileInfo | undefined> {
    if (!(file in this.entries)) return undefined;
    const value = this.entries[file];
    return value === null ? { type: "folder", size: 0, mtime: 1, readOnly: false }
      : { type: "file", size: typeof value === "string" ? Buffer.byteLength(value) : value!.length, mtime: 1000, readOnly: file.includes("readonly") };
  }
  async readFile(file: string): Promise<Uint8Array> {
    this.reads.push(file);
    const value = this.entries[file];
    if (value === undefined || value === null) throw new Error(`no file ${file}`);
    return typeof value === "string" ? new TextEncoder().encode(value) : value;
  }
  async read(file: string, offset: number, length: number) { return (await this.readFile(file)).subarray(offset, offset + length); }
  async list(): Promise<[string, EntryType][]> { return []; }
  async create(): Promise<void> { throw new Error("read-only"); }
  async realpath(file: string) { return file; }
}

class FakeHelper implements HelperAccess, HelperClient {
  readonly executable = "/helper";
  readonly info = { protocolVersion: 1, server: { name: "fake", version: "1" }, capabilities: { methods: ["text.diff", "path.info"] } };
  readonly calls: string[] = [];
  installed = true;
  failure: Error | undefined;
  async client() {
    if (this.failure) throw this.failure;
    return this.installed ? this : undefined;
  }
  supports(...methods: readonly string[]) { return methods.every(method => this.info.capabilities.methods.includes(method)); }
  async request<T>(method: string): Promise<T> {
    this.calls.push(method);
    return { helper: method } as T;
  }
}

function engine(files: FileAccess, helper?: HelperAccess) {
  const lines: string[] = [];
  return { lines, engine: new ComparisonEngine({ files, helper, wasm: loadWasm, log: line => lines.push(line) }) };
}

test("the helper compares local files; the WebAssembly engine compares everything else", { skip: noWasm }, async () => {
  const files = new MemoryFiles({ "/a.txt": "one\n", "vscode-vfs://github/o/r/a.txt": "one\ntwo\n", "vscode-vfs://github/o/r/b.txt": "one\nthree\n" });
  const helper = new FakeHelper();
  const { engine: e, lines } = engine(files, helper);
  assert.deepEqual(await e.request("text.diff", { left: ["a"], right: ["b"] }), { helper: "text.diff" });
  assert.deepEqual(await e.request("path.info", { path: "/a.txt" }), { helper: "path.info" });
  // Virtual resources never reach the helper.
  const info = await e.request<{ exists: boolean; kind: string; size: number }>("path.info", { path: "vscode-vfs://github/o/r/a.txt" });
  assert.deepEqual([info.exists, info.kind, info.size], [true, "text", 8]);
  const loaded = await e.request<{ lines: string[]; modified: number; readOnly: boolean }>("text.load", { path: "vscode-vfs://github/o/r/b.txt" });
  assert.deepEqual([loaded.lines, loaded.modified, loaded.readOnly], [["one", "three"], 1000, false]);
  // A method the helper lacks (an older desktop install) also falls back.
  const table = await e.request<{ rows: unknown[] }>("table.compare", { left: "/a.txt", right: "/a.txt" });
  assert.equal(table.rows.length, 1);
  assert.deepEqual(helper.calls, ["text.diff", "path.info"]);
  assert.deepEqual(lines, []);
  // Without an installed helper every request runs in WebAssembly, announced once.
  helper.installed = false;
  const diff = await e.request<{ identical: boolean }>("text.diff", { left: ["a"], right: ["b"] });
  assert.equal(diff.identical, false);
  await e.request("text.diff", { left: ["a"], right: ["a"] });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /WebAssembly/);
});

test("helper setting errors are reported, not hidden by the WebAssembly engine", { skip: noWasm }, async () => {
  const helper = new FakeHelper();
  helper.failure = new Error("comparecraft.backendPath is invalid");
  const { engine: e } = engine(new MemoryFiles({}), helper);
  await assert.rejects(e.request("text.diff", { left: [], right: [] }), /backendPath is invalid/);
});

test("folder comparison needs the helper and folders on disk", { skip: noWasm }, async () => {
  const helper = new FakeHelper();
  const { engine: e } = engine(new MemoryFiles({}), helper);
  await assert.rejects(e.request("folder.compare", { left: "/l", right: "/r" }), (error: Error) => error instanceof UnavailableError && /lacks embedded folder/.test(error.message));
  helper.installed = false;
  await assert.rejects(e.request("folder.compare", { left: "/l", right: "/r" }), /isn't installed here/);
  await assert.rejects(e.request("folder.compareItems", { left: "vscode-vfs://x/l", right: "/r", rels: [] }), /folders on disk/);
  const { engine: browser } = engine(new MemoryFiles({}));
  await assert.rejects(browser.request("folder.compare", { left: "/l", right: "/r" }), UnavailableError);
});

test("in-memory views: pictures, hex, quick compare, kind detection and size limits", { skip: noWasm }, async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const files = new MemoryFiles({
    "mem:/a.png": png, "mem:/b.png": png, "mem:/x.bin": new Uint8Array([1, 0, 2]), "mem:/y.bin": new Uint8Array([1, 0, 3, 4]),
    "mem:/folder": null
  });
  const { engine: e } = engine(files);
  const pix = await e.request<{ counts: { important: number }; image: string }>("pix.compare", { left: "mem:/a.png", right: "mem:/b.png", options: {} });
  assert.equal(pix.counts.important, 0);
  assert.match(await e.request<string>("pix.image", { path: "mem:/a.png" }), /^data:image\/png;base64,/);
  // An already rasterised side is not read again.
  files.reads.length = 0;
  await e.request("pix.compare", { left: "mem:/a.png", right: "mem:/b.png", options: {}, leftData: `data:image/png;base64,${png.toString("base64")}` });
  assert.deepEqual(files.reads, ["mem:/b.png"]);
  const hex = await e.request<{ leftSize: number; counts: number[] }>("hex.align", { left: "mem:/x.bin", right: "mem:/y.bin", align: "none" });
  assert.equal(hex.leftSize, 3);
  assert.equal(await e.request("file.quickCompare", { left: "mem:/x.bin", right: "mem:/x.bin", mode: "binary" }), 1);
  assert.equal(await e.request("file.quickCompare", { left: "mem:/x.bin", right: "mem:/missing", mode: "rules" }), 100);
  assert.equal((await e.request<{ kind: string }>("path.info", { path: "mem:/x.bin" })).kind, "hex");
  assert.equal((await e.request<{ kind: string }>("path.info", { path: "mem:/a.png" })).kind, "picture");
  assert.equal((await e.request<{ kind: string; isDir: boolean }>("path.info", { path: "mem:/folder" })).kind, "folder");
  assert.equal((await e.request<{ exists: boolean }>("path.info", { path: "mem:/none" })).exists, false);
  await assert.rejects(e.request("text.load", { path: "mem:/folder" }), /not a file/);

  const wasm = await loadWasm();
  const big = new MemoryFiles({ "mem:/big.bin": new Uint8Array(0), "mem:/small.bin": new Uint8Array(1) });
  big.stat = async file => ({ type: "file", size: file.includes("big") ? wasm.info.limits.maxDataBytes + 1 : 1, mtime: 1, readOnly: false });
  const { engine: limited } = engine(big);
  await assert.rejects(limited.request("hex.align", { left: "mem:/big.bin", right: "mem:/small.bin" }),
    (error: BackendError) => error.code === ErrorCode.tooLarge && /can't be compared here/.test(error.message));
  assert.ok(!big.reads.includes("mem:/big.bin"), "files above the limit are never read");
});

test("the WebAssembly engine reports protocol errors and recovers after them", { skip: noWasm }, async () => {
  const wasm = await loadWasm();
  assert.ok(wasm.supports("text.diff", "pix.compareData", "quick.compareData"));
  assert.throws(() => wasm.call("text.diff", { left: [] }), (error: BackendError) => error.code === ErrorCode.invalidParams);
  assert.throws(() => wasm.call("folder.compare", {}), (error: BackendError) => error.code === ErrorCode.methodNotFound);
  assert.equal(wasm.call<{ identical: boolean }>("text.diff", { left: ["x"], right: ["x"] }).identical, true);
});
