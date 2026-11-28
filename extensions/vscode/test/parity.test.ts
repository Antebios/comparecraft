// Parity of the WebAssembly engine with the native helper: both run the same Rust engine code, so for
// the same inputs they must return identical results. Uses the repository's engine, merge, hex and
// picture fixtures, and needs the built engine (npm run build:engine) and helper (COMPARECRAFT_BACKEND or
// src-tauri/target/debug/comparecraft-backend).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { BackendClient } from "../src/backend";
import { WasmEngine } from "../src/wasmEngine";

const extension = path.resolve(__dirname, "..", "..");
const repository = path.resolve(extension, "..", "..");
const fixtures = path.join(repository, "src-tauri", "tests", "fixtures");
const WASM_FILE = path.join(extension, "media", "engine", "comparecraft-engine.wasm");
const HELPER = process.env.COMPARECRAFT_BACKEND
  ?? path.join(repository, "src-tauri", "target", "debug", process.platform === "win32" ? "comparecraft-backend.exe" : "comparecraft-backend");
const skip = !existsSync(WASM_FILE) ? `build the engine with npm run build:engine (${WASM_FILE})`
  : !existsSync(HELPER) ? `build the helper with cargo build --bin comparecraft-backend or set COMPARECRAFT_BACKEND (${HELPER})` : false;

/** The rule variants of src-tauri/tests/engine_golden.rs, plus replacement rules. */
const VARIANTS: Record<string, Record<string, unknown>> = {
  standard: {},
  none: { algorithm: "none" },
  patience: { algorithm: "patience" },
  myers: { algorithm: "myers" },
  "standard-neveralign": { neverAlignDiffs: true },
  "standard-noclose": { useCloseness: false },
  "patience-noclose": { algorithm: "patience", useCloseness: false },
  case: { ignoreCase: false },
  whitespace: { ignoreLeadingWs: false, ignoreEmbeddedWs: false, ignoreTrailingWs: false },
  leading: { ignoreLeadingWs: false },
  orphans: { ignoreBlankLines: false },
  strict: { ignoreCase: false, ignoreLeadingWs: false, ignoreEmbeddedWs: false, ignoreTrailingWs: false, ignoreBlankLines: false },
  "myers-neveralign": { algorithm: "myers", neverAlignDiffs: true },
  "patience-neveralign": { algorithm: "patience", neverAlignDiffs: true },
  "standard-skew5": { skewTolerance: 5 },
  replacements: { replacements: [{ from: "\\d+", to: "N", regex: true }, { from: "colour", to: "color", regex: false }] },
};

const cases = (folder: string) => readdirSync(path.join(fixtures, folder)).filter(name => statSync(path.join(fixtures, folder, name)).isDirectory()).sort();

let helper: BackendClient;
let wasm: WasmEngine;

before(async () => {
  if (skip) return;
  helper = await BackendClient.start(HELPER, { client: { name: "comparecraft-parity-test", version: "0" } });
  wasm = await WasmEngine.load(readFileSync(WASM_FILE));
});

after(async () => {
  await helper?.dispose();
});

test("text.diff matches the helper for every engine fixture and rule variant", { skip }, async () => {
  let compared = 0;
  const timings = { helper: 0, wasm: 0 };
  for (const name of cases("engine")) {
    const lines = (file: string) => wasm.call<{ lines: string[] }>("text.decode", { name: file }, readFileSync(path.join(fixtures, "engine", name, file))).lines;
    const left = lines("a.txt"), right = lines("b.txt");
    for (const [variant, rules] of Object.entries(VARIANTS)) {
      const params = { left, right, rules };
      let started = performance.now();
      const native = await helper.request("text.diff", params);
      timings.helper += performance.now() - started;
      started = performance.now();
      const web = wasm.call("text.diff", params);
      timings.wasm += performance.now() - started;
      assert.deepEqual(web, native, `${name} (${variant})`);
      compared++;
    }
  }
  assert.equal(compared, cases("engine").length * Object.keys(VARIANTS).length);
  console.log(`text.diff parity: ${compared} comparisons; helper ${Math.round(timings.helper)} ms (including IPC), WebAssembly ${Math.round(timings.wasm)} ms.`);
});

test("text.load and kind detection match text.decode and kind.detect", { skip }, async () => {
  const files = [
    ...cases("engine").map(name => path.join(fixtures, "engine", name, "a.txt")),
    ...cases("hex").map(name => path.join(fixtures, "hex", name, "a.bin")),
    ...cases("pix").flatMap(name => readdirSync(path.join(fixtures, "pix", name)).filter(file => /^[ab]\./.test(file)).map(file => path.join(fixtures, "pix", name, file))),
  ];
  for (const file of files) {
    const bytes = readFileSync(file);
    const native = await helper.request<Record<string, unknown>>("text.load", { path: file });
    const web = wasm.call<Record<string, unknown>>("text.decode", { name: file }, bytes);
    for (const key of ["path", "lines", "encoding", "bom", "eol", "finalNewline", "size", "binary"]) {
      // Without line breaks the desktop picks the platform's default ending; the browser engine says LF.
      if (key === "eol" && process.platform === "win32" && native.eol === "CRLF" && web.eol === "LF") continue;
      assert.deepEqual(web[key], native[key], `${file}: ${key}`);
    }
    const info = await helper.request<{ kind: string }>("path.info", { path: file });
    assert.equal(wasm.call("kind.detect", { name: file }, bytes.subarray(0, 8192)), info.kind, file);
  }
});

test("text.merge matches the helper for the merge fixtures", { skip }, async () => {
  const root = path.join(repository, "tests", "fixtures", "merge");
  const lines = (file: string) => wasm.call<{ lines: string[] }>("text.decode", { name: file }, readFileSync(path.join(root, file))).lines;
  const base = lines("base.txt");
  for (const [left, right] of [["l.txt", "r.txt"], ["cl.txt", "cr.txt"], ["r.txt", "l.txt"]] as const) {
    for (const rules of [VARIANTS.standard, VARIANTS.strict, VARIANTS.patience]) {
      const params = { base, left: lines(left), right: lines(right), rules };
      assert.deepEqual(wasm.call("text.merge", params), await helper.request("text.merge", params), `${left}/${right}`);
    }
  }
});

test("hex.alignData matches hex.align for every hex fixture and alignment", { skip }, async () => {
  for (const name of cases("hex")) {
    const a = path.join(fixtures, "hex", name, "a.bin"), b = path.join(fixtures, "hex", name, "b.bin");
    for (const align of ["none", "fast", "complete"]) {
      const native = await helper.request("hex.align", { left: a, right: b, align });
      assert.deepEqual(wasm.call("hex.alignData", { align }, readFileSync(a), readFileSync(b)), native, `${name} (${align})`);
    }
  }
});

test("pix.compareData and pix.imageData match the helper for every picture fixture", { skip }, async () => {
  for (const name of cases("pix")) {
    const files = readdirSync(path.join(fixtures, "pix", name));
    const a = path.join(fixtures, "pix", name, files.find(file => file.startsWith("a."))!);
    const b = path.join(fixtures, "pix", name, files.find(file => file.startsWith("b."))!);
    for (const options of [{}, { tolerance: 0 }, { mode: "blend", blendPct: 30 }, { rotate: [1, 0], flip: [false, true], autoScale: true }]) {
      const native = await helper.request("pix.compare", { left: a, right: b, options });
      const web = wasm.call("pix.compareData", { leftName: path.basename(a), rightName: path.basename(b), options }, readFileSync(a), readFileSync(b));
      assert.deepEqual(web, native, `${name} ${JSON.stringify(options)}`);
    }
    assert.equal(wasm.call("pix.imageData", { name: path.basename(a) }, readFileSync(a)), await helper.request("pix.image", { path: a }), name);
  }
});

test("table and quick comparisons of in-memory data match the helper's file methods", { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cc-parity-"));
  try {
    const inputs: Record<string, string | Buffer> = {
      "a.csv": "id,name,qty\n1,apple,3\n2,pear,5\n3,fig,1\n",
      "b.csv": "id,name,qty\n2,pear,6\n1,Apple,3\n4,kiwi,2\n",
      "c.tsv": "id\tname\n1\t\"a, b\"\n2\tc\n",
      "d.tsv": "id\tname\n1\t\"a, b\"\n2\td\n",
      "e.txt": "a\nb\n", "f.txt": "a  \r\nB\r\n", "g.txt": "\uFEFFa\nb", "h.bin": Buffer.from([0, 1, 2]), "i.bin": Buffer.from([0, 1, 3]),
    };
    for (const [file, content] of Object.entries(inputs)) await writeFile(path.join(dir, file), content);
    const at = (file: string) => path.join(dir, file);
    for (const [left, right] of [["a.csv", "b.csv"], ["c.tsv", "d.tsv"], ["a.csv", "c.tsv"]]) {
      for (const options of [{}, { header: true, keys: [0] }, { keys: [], ignoreCase: true }, { delimiter: ";" }, { unimportant: [2], numTolerance: 1 }]) {
        const native = await helper.request("table.compare", { left: at(left!), right: at(right!), options });
        const web = wasm.call("table.compareData", { leftName: left, rightName: right, options }, readFileSync(at(left!)), readFileSync(at(right!)));
        assert.deepEqual(web, native, `${left}/${right} ${JSON.stringify(options)}`);
      }
    }
    for (const [left, right] of [["e.txt", "f.txt"], ["e.txt", "g.txt"], ["e.txt", "e.txt"], ["h.bin", "i.bin"], ["a.csv", "b.csv"]]) {
      for (const mode of ["rules", "size", "crc", "binary"]) {
        const native = await helper.request("file.quickCompare", { left: at(left!), right: at(right!), mode });
        assert.equal(wasm.call("quick.compareData", { mode }, readFileSync(at(left!)), readFileSync(at(right!))), native, `${left}/${right} ${mode}`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
