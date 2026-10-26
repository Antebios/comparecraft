import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ConflictError, dialogFilters, DocumentGuard, joinLines, MAX_READ_BYTES, pairViewKind, parseSpec, readBytes, readDataUrl, specFromInputs, splitLines,
  textFileFromBuffer, titleOf, unsupportedCommand, VIEW_METHODS
} from "../src/embeddedCore";
import { desktopViewArguments } from "../src/process";

const a = path.resolve("a.txt"), b = path.resolve("b.txt");

test("read-only view specs keep their kind, files, titles and options only", () => {
  const bin = path.resolve("a.bin"), png = path.resolve("b.png");
  assert.deepEqual(parseSpec({ kind: "hex", paths: [bin, ""], titles: ["L", null], readOnly: [false], options: { x: 1 }, restore: [["ignored"], null], dirty: [true, false] }),
    { kind: "hex", paths: [bin, ""], titles: ["L", null], readOnly: [true, true], options: { x: 1 } });
  assert.deepEqual(parseSpec({ kind: "patch", paths: [a] }), { kind: "patch", paths: [a], titles: [], readOnly: [true], options: {} });
  for (const bad of [{ kind: "hex", paths: [bin, png, bin] }, { kind: "table", paths: ["rel.csv"] }, { kind: "picture", paths: [png], titles: [1] },
    { kind: "picture", paths: [png], options: [] }, { kind: "patch", paths: [] }, { kind: "patch", paths: [a, b] }, { kind: "patch", paths: [""] },
    { kind: "folder", paths: [a, b] }, { kind: "edit", paths: [a] }]) {
    assert.throws(() => parseSpec(bad), Error, JSON.stringify(bad));
  }
  assert.equal(titleOf(parseSpec({ kind: "hex", paths: [bin, path.resolve("c.bin")] })), "Hex: a.bin ↔ c.bin");
  assert.equal(titleOf(parseSpec({ kind: "table", paths: [a, a] })), "Table: a.txt");
  assert.equal(titleOf(parseSpec({ kind: "picture", paths: [png, ""], titles: [null, "Right"] })), "Picture: b.png ↔ Right");
  assert.equal(titleOf(parseSpec({ kind: "patch", paths: [path.resolve("fix.patch")] })), "Patch: fix.patch");
  assert.deepEqual(VIEW_METHODS.patch, []);
  assert.deepEqual(VIEW_METHODS.picture, ["pix.compare", "pix.image"]);
});

test("file pairs pick the view of the first existing file; text and folders stay text", () => {
  const file = (kind: string, exists = true) => ({ exists, isDir: false, kind });
  assert.equal(pairViewKind([file("hex"), file("text")]), "hex");
  assert.equal(pairViewKind([file("text", false), file("picture")]), "picture");
  assert.equal(pairViewKind([file("table"), file("table")]), "table");
  assert.equal(pairViewKind([file("text"), file("hex")]), undefined);
  assert.equal(pairViewKind([{ exists: true, isDir: true, kind: "folder" }, file("hex")]), undefined);
  assert.equal(pairViewKind([file("hex", false), file("hex", false)]), undefined);
});

test("bytes and pictures are read like the desktop commands", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cc-view-"));
  try {
    const bin = path.join(dir, "data.bin");
    await writeFile(bin, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    assert.deepEqual([...Buffer.from(await readBytes(bin, 2, 3), "base64")], [2, 3, 4]);
    assert.deepEqual([...Buffer.from(await readBytes(bin, 6, 100), "base64")], [6, 7]);
    assert.equal(await readBytes(bin, 100, 10), "");
    await truncate(bin, MAX_READ_BYTES + 10);
    assert.equal(Buffer.from(await readBytes(bin, 0, MAX_READ_BYTES * 2), "base64").length, MAX_READ_BYTES);
    await assert.rejects(readBytes(path.join(dir, "missing.bin"), 0, 1));

    const jpg = path.join(dir, "photo.JPEG");
    await writeFile(jpg, "abc");
    assert.deepEqual(await readDataUrl(jpg), { url: "data:image/jpeg;base64,YWJj", size: 3 });
    const other = path.join(dir, "x.tga");
    await writeFile(other, "abc");
    assert.match((await readDataUrl(other)).url, /^data:application\/octet-stream;base64,/);
    await assert.rejects(readDataUrl(jpg, 2), /too large/);
    await assert.rejects(readDataUrl(dir), /not a file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("desktop fallbacks request the matching viewer type", () => {
  assert.deepEqual(desktopViewArguments("hex", [a, b]), ["-fv=hex", "--", a, b]);
  assert.deepEqual(desktopViewArguments("patch", [a]), ["-fv=patch", "--", a]);
  assert.deepEqual(desktopViewArguments("bogus", [a, b]), ["--", a, b]);
});

test("persisted and webview specs are validated before use", () => {
  assert.deepEqual(parseSpec({ paths: [a, b] }), { paths: [a, b], titles: [], readOnly: [], options: {} });
  assert.deepEqual(parseSpec({ paths: ["", b], titles: ["HEAD", null], readOnly: [true], options: { content: [["x"], null] }, restore: [null, ["y"]] }),
    { paths: ["", b], titles: ["HEAD", null], readOnly: [true], options: { content: [["x"], null] }, restore: [null, ["y"]] });
  for (const bad of [null, [], { paths: "a" }, { paths: ["relative.txt"] }, { paths: [a, b, a] }, { paths: [a], titles: [1] },
    { paths: [a], readOnly: ["yes"] }, { paths: [a], options: [] }, { paths: [a], restore: [["x"]] }, { paths: [a], restore: [[1], null] }]) {
    assert.throws(() => parseSpec(bad), Error, JSON.stringify(bad));
  }
});

test("line splitting and joining round-trip text exactly", () => {
  for (const [text, eol] of [["", "\n"], ["\n", "\n"], ["a", "\n"], ["a\n", "\n"], ["a\nb", "\n"], ["a\r\nb\r\n", "\r\n"], ["a\n\n", "\n"]] as const) {
    const file = textFileFromBuffer(a, text, eol, { size: 0, modified: null, readOnly: false });
    assert.equal(joinLines(file.lines, eol, file.finalNewline), text, JSON.stringify(text));
  }
  assert.deepEqual(splitLines("a\r\nb\rc\n"), ["a", "b", "c"]);
  assert.equal(joinLines([], "\n", true), "");
  const file = textFileFromBuffer(a, "x\r\n", "\r\n", { size: 3, modified: 5, readOnly: true });
  assert.deepEqual([file.eol, file.finalNewline, file.encoding, file.binary, file.readOnly, file.modified], ["CRLF", true, "UTF-8", false, true, 5]);
});

test("the document guard rejects saves over text changed after load", () => {
  const guard = new DocumentGuard();
  guard.remember(a, "one");
  assert.ok(guard.has(a));
  assert.doesNotThrow(() => guard.assertUnchanged(a, "one"));
  assert.throws(() => guard.assertUnchanged(a, "two"), ConflictError);
  assert.deepEqual(guard.changed(a, "two"), [a]);
  assert.deepEqual(guard.changed(a, "one"), []);
  assert.deepEqual(guard.changed(b, "anything"), []);
  if (process.platform === "win32") assert.throws(() => guard.assertUnchanged(a.toUpperCase(), "two"), ConflictError);
  guard.remember(a, "two");
  assert.doesNotThrow(() => guard.assertUnchanged(a, "two"));
  guard.forget(a);
  assert.equal(guard.has(a), false);
  assert.deepEqual(guard.paths(), []);
});

test("dialog filters, unsupported commands, and titles", () => {
  assert.deepEqual(dialogFilters([{ name: "Text", extensions: ["txt", "md"] }, { name: 1 }, "x"]), { Text: ["txt", "md"] });
  assert.equal(dialogFilters("x"), undefined);
  assert.equal(dialogFilters([]), undefined);
  assert.match(unsupportedCommand("compare_folders").message, /compare_folders.*not available/);
  assert.equal(titleOf({ paths: [a, b], titles: [], readOnly: [], options: {} }), "a.txt ↔ b.txt");
  assert.equal(titleOf({ paths: ["", a], titles: ["a.txt", null], readOnly: [], options: {} }), "a.txt");
});

test("controller inputs become live files or read-only content sides", async () => {
  const loaded: string[] = [];
  const disk = async (file: string) => { loaded.push(file); return ["disk"]; };
  assert.deepEqual(await specFromInputs([{ kind: "path", path: a }, { kind: "path", path: b, title: "B" }], disk),
    { paths: [a, b], titles: [null, "B"], readOnly: [false, false], options: {} });
  assert.deepEqual(await specFromInputs([
    { kind: "path", path: a, title: "a.txt (saved on disk)", readOnly: true },
    { kind: "content", name: "a.txt", title: "a.txt (buffer)", content: "x\ny\n" }
  ], disk), {
    paths: ["", ""], titles: ["a.txt (saved on disk)", "a.txt (buffer)"], readOnly: [true, true], options: { content: [["disk"], ["x", "y"]] }
  });
  assert.deepEqual(loaded, [a]);
  await assert.rejects(specFromInputs([{ kind: "path", path: a }], disk), /two sides/);
  await assert.rejects(specFromInputs([{ kind: "path", path: "rel.txt" }, { kind: "path", path: b }], disk), /absolute/);
});

test("merge specs carry three read-only sides and a writable result", async () => {
  const disk = async () => ["disk"];
  const out = path.resolve("result.txt");
  const spec = await specFromInputs([
    { kind: "content", name: "r.txt", title: "Current", content: "c\n" },
    { kind: "content", name: "r.txt", title: "Incoming", content: "i\n" },
    { kind: "content", name: "r.txt",     title: "Base", content: "b\n" },
    { kind: "path", path: out, title: "Result" }
  ], disk);
  assert.deepEqual(spec, {
    kind: "merge", paths: ["", "", "", out], titles: ["Current", "Incoming", "Base", "Result"],
    readOnly: [true, true, true, false], options: { content: [["c"], ["i"], ["b"]] }
  });
  assert.deepEqual(parseSpec(spec), spec);
  assert.equal(titleOf(spec), "Merge: result.txt");
  const sides = spec.options.content as string[][];
  await assert.rejects(specFromInputs([
    { kind: "content", name: "r", title: "x", content: "" }, { kind: "content", name: "r", title: "x", content: "" },
    { kind: "content", name: "r", title: "x", content: "" }, { kind: "path", path: out, readOnly: true }
  ], disk), /writable result/);
  assert.ok(sides.length === 3);
  for (const bad of [
    { kind: "merge", paths: ["", "", "", ""] }, { kind: "merge", paths: ["", "", ""] }, { kind: "merge", paths: [a, b, a, b, a] },
    { kind: "other", paths: [a] }, { kind: "merge", paths: ["", "", "", out], options: { content: [[1]] } },
    { kind: "merge", paths: ["", "", "", out], output: [1] }
  ]) assert.throws(() => parseSpec(bad), Error, JSON.stringify(bad));
  assert.deepEqual(parseSpec({ ...spec, output: ["merged"] }).output, ["merged"]);
  assert.equal(parseSpec({ paths: [a, b], output: ["x"] }).kind, undefined);
});
