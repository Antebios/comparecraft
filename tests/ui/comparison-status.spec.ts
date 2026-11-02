import { test, expect } from "@playwright/test";
import { contentStatus, hexStatus, pictureStatus, tableStatus, textStatus } from "../../src/comparisonStatus";
import type { DiffResult, HexAlignment, PixResult, TableResult } from "../../src/api";

test("text and binary verdicts preserve importance and orphan differences", () => {
  const text: DiffResult = { rows: [], hunks: [], important: 0, unimportant: 0, sameLines: 0, identical: true };
  expect(textStatus(text)).toEqual({ status: "same", content: "same" });
  expect(textStatus({ ...text, identical: false, unimportant: 1 })).toEqual(contentStatus(false, true));
  expect(textStatus({ ...text, identical: false, important: 1, unimportant: 1 })).toEqual(contentStatus(true));
  const hex: HexAlignment = { leftSize: 1, rightSize: 1, align: "complete", map: [], counts: [1, 0, 0, 0] };
  expect(hexStatus(hex)).toEqual({ status: "same", content: "sameBinary" });
  for (const counts of [[0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] as [number, number, number, number][])
    expect(hexStatus({ ...hex, counts })).toEqual({ status: "diff", content: "differentBinary" });
});

test("table verdicts count all row kinds including one-sided rows", () => {
  const table: TableResult = { header: [], left: [], right: [], rows: [], delimiter: ",", columns: 0 };
  expect(tableStatus(table).status).toBe("same");
  expect(tableStatus({ ...table, rows: [{ k: "unimportant" }] }).status).toBe("similar");
  for (const k of ["changed", "left", "right"] as const)
    expect(tableStatus({ ...table, rows: [{ k }, { k: "unimportant" }] }).status).toBe("diff");
});

test("picture verdicts distinguish tolerance from important and orphan pixels", () => {
  const info = { width: 1, height: 1, format: "PNG", hasAlpha: false };
  const picture: PixResult = {
    left: info, right: info, width: 1, height: 1, image: "", sides: [null, null],
    counts: { same: 1, unimportant: 0, important: 0, leftOrphan: 0, rightOrphan: 0 },
  };
  expect(pictureStatus(picture).status).toBe("same");
  expect(pictureStatus({ ...picture, counts: { ...picture.counts, unimportant: 1 } }).status).toBe("similar");
  for (const key of ["important", "leftOrphan", "rightOrphan"] as const)
    expect(pictureStatus({ ...picture, counts: { ...picture.counts, [key]: 1 } }).status).toBe("diff");
});
