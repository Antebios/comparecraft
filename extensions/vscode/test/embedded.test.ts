import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import {
  ConflictError, dialogFilters, DocumentGuard, joinLines, parseSpec, specFromInputs, splitLines, textFileFromBuffer, titleOf, unsupportedCommand
} from "../src/embeddedCore";

const a = path.resolve("a.txt"), b = path.resolve("b.txt");

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
  await assert.rejects(specFromInputs([{ kind: "path", path: a }], disk), /exactly two/);
  await assert.rejects(specFromInputs([{ kind: "path", path: "rel.txt" }, { kind: "path", path: b }], disk), /absolute/);
});
