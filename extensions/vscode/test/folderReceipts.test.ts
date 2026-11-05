import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { diskVerdict, withinFolder } from "../src/folderReceipts";
import type { EmbeddedSpec } from "../src/embeddedCore";

test("origin files must be descendants, not siblings or prefix lookalikes", () => {
  const base = path.resolve("folder");
  assert.equal(withinFolder(base, path.join(base, "sub", "file")), true);
  for (const candidate of [base, "", path.resolve("folder-other", "file"), path.resolve("file")]) {
    assert.equal(withinFolder(base, candidate), false);
  }
});

test("text disk verdicts reload saved files and never use restored or content buffers", async () => {
  const calls: string[] = [];
  const spec: EmbeddedSpec = { paths: [path.resolve("left"), path.resolve("right")], titles: [], readOnly: [],
    options: { rules: { ignoreCase: true }, content: [["dirty"], ["dirty"]] }, restore: [["dirty"], null] };
  const request = async <T>(method: string, params: unknown): Promise<T> => {
    calls.push(method);
    if (method === "text.load") return { lines: ["disk"], binary: false } as T;
    assert.deepEqual(params, { left: ["disk"], right: ["disk"], rules: { ignoreCase: true } });
    return { identical: false, important: 0 } as T;
  };
  assert.equal(await diskVerdict(spec, request), "similar");
  assert.deepEqual(calls, ["text.load", "text.load", "text.diff"]);
});

test("table, picture and binary disk verdicts retain view semantics", async () => {
  const spec: EmbeddedSpec = { paths: [path.resolve("left"), path.resolve("right")], titles: [], readOnly: [], options: {} };
  const request = <T>(result: unknown) => async (): Promise<T> => result as T;
  assert.equal(await diskVerdict({ ...spec, kind: "hex" }, request(1)), "sameBinary");
  assert.equal(await diskVerdict({ ...spec, kind: "hex" }, request(11)), "differentBinary");
  await assert.rejects(diskVerdict({ ...spec, kind: "hex" }, request(100)), /Invalid binary/);
  assert.equal(await diskVerdict({ ...spec, kind: "table" }, request({ rows: [{ k: "unimportant" }] })), "similar");
  assert.equal(await diskVerdict({ ...spec, kind: "picture" }, request({ counts: { important: 0, unimportant: 0, leftOrphan: 1, rightOrphan: 0 } })), "different");
  await assert.rejects(diskVerdict({ ...spec, kind: "table" }, request({ rows: [{ k: "invalid" }] })), /Invalid table row/);
  await assert.rejects(diskVerdict({ ...spec, kind: "picture" }, request({ counts: { important: -1 } })), /Invalid picture/);
});
