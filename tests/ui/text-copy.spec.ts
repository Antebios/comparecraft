import type { Page } from "@playwright/test";
import { join } from "node:path";
import { test, expect } from "./fixtures";

const panes = (page: Page) => page.locator(".tab-view:visible .tpane");

async function openText(page: Page, folders: { left: string; right: string; pair(n: string, l: string, r: string): Promise<void> }, left: string[], right: string[]) {
  await folders.pair("a.txt", left.join("\n"), right.join("\n"));
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind: "text", paths: [join(folders.left, "a.txt"), join(folders.right, "a.txt")] }))}`);
  await expect(panes(page).first().locator(".trow").first()).toBeVisible({ timeout: 15000 });
  // Word wrap off keeps one row per line.
  if (await panes(page).first().evaluate((el) => el.classList.contains("wrapped"))) await page.keyboard.press("Alt+z");
  await expect(panes(page).first()).not.toHaveClass(/wrapped/);
}

/** Rendered lines of a pane, top to bottom, skipping filler rows. */
const paneLines = (page: Page, side: 0 | 1) =>
  panes(page).nth(side).evaluate((pane) =>
    [...pane.querySelectorAll<HTMLElement>(".trow:not(.filler)")]
      .sort((a, b) => a.offsetTop - b.offsetTop)
      .map((row) => row.querySelector(".tx")?.textContent ?? ""),
  );

/** Viewport point just inside the boundary before column `col` of line number `line` in a pane. */
const pointAt = (page: Page, side: 0 | 1, line: number, col: number) =>
  panes(page).nth(side).evaluate((pane, [line, col]) => {
    const row = [...pane.querySelectorAll<HTMLElement>(".trow")].find((r) => r.querySelector(".ln")?.textContent === String(line))!;
    const tx = row.querySelector(".tx")!;
    const y = row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
    const walker = document.createTreeWalker(tx, NodeFilter.SHOW_TEXT);
    let rest = col;
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null) && rest > node.length) rest -= node.length;
    if (!node) return { x: tx.getBoundingClientRect().right + 2, y };
    const range = document.createRange();
    range.setStart(node, rest);
    range.setEnd(node, rest);
    return { x: range.getBoundingClientRect().left + 1, y };
  }, [line, col]);

async function drag(page: Page, side: 0 | 1, from: [number, number], to: [number, number]) {
  const a = await pointAt(page, side, ...from);
  const b = await pointAt(page, side, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
}

test("dragged lines spanning several sections copy to the other side from the context menu", async ({ page, folders }) => {
  const left = ["# Log", "", "## 56001 2026_11_06", "", "* fix: models", "Replace NAM", "Add model AI", "Remove models", "```", "", "* tool/lib updates", "", "## 56000 2026_11_02", "* fdroid tag"];
  const right = ["# Log", "", "## 56001 2026_11_05", "", "* fix: models", "Replace NAM", "```", "", "## 56000 2026_11_02", "* fdroid tag"];
  await openText(page, folders, left, right);
  await drag(page, 0, [3, 0], [12, 0]);
  await expect(panes(page).first().locator(".trow.rsel")).not.toHaveCount(0);
  // Right-clicking inside the selection keeps it for the menu.
  const inside = await pointAt(page, 0, 6, 2);
  await page.mouse.click(inside.x, inside.y, { button: "right" });
  await page.locator(".ctx-menu").getByText("Copy to Right", { exact: true }).click();
  await expect.poll(() => paneLines(page, 1)).toEqual(left);
});

test("part of a line copies to the left with Ctrl+L, keeping the rest of the target line", async ({ page, folders }) => {
  const left = ["## 56001 2026_11_06 draft", "same"];
  const right = ["## 56002 2026_11_05 final", "same"];
  await openText(page, folders, left, right);
  await drag(page, 1, [1, 17], [1, 19]);
  await page.keyboard.press("Control+l");
  await expect.poll(() => paneLines(page, 0)).toEqual(["## 56001 2026_11_05 draft", "same"]);
});

test("partial selections map onto the matching text of changed lines and undo in one step", async ({ page, folders }) => {
  const left = ["a X b Y c", "one two", "three", "four five", "end"];
  const right = ["a P b Q c", "one TWO", "THREE!", "four FIVE", "end"];
  await openText(page, folders, left, right);
  await drag(page, 0, [1, 6], [1, 7]);
  await page.keyboard.press("Control+r");
  await expect.poll(() => paneLines(page, 1)).toEqual(["a P b Y c", "one TWO", "THREE!", "four FIVE", "end"]);

  // From "two" to just before "five": the right keeps "one " before and "FIVE" after.
  await drag(page, 0, [2, 4], [4, 5]);
  await page.keyboard.press("Control+r");
  await expect.poll(() => paneLines(page, 1)).toEqual(["a P b Y c", "one two", "three", "four FIVE", "end"]);
  await page.keyboard.press("Control+z");
  await expect.poll(() => paneLines(page, 1)).toEqual(["a P b Y c", "one TWO", "THREE!", "four FIVE", "end"]);
});

test("a click still copies the whole difference section and Shift+click selects lines", async ({ page, folders }) => {
  const left = ["same", "l1", "l2", "same 2", "l3"];
  const right = ["same", "r1", "r2", "same 2", "r3"];
  await openText(page, folders, left, right);
  await panes(page).first().locator(".trow", { hasText: "l2" }).click();
  await page.keyboard.press("Control+r");
  await expect.poll(() => paneLines(page, 1)).toEqual(["same", "l1", "l2", "same 2", "r3"]);
  await page.keyboard.press("Control+z");
  await panes(page).last().locator(".trow", { hasText: "r1" }).click();
  await panes(page).last().locator(".trow", { hasText: "r3" }).click({ modifiers: ["Shift"] });
  await page.keyboard.press("Control+l");
  await expect.poll(() => paneLines(page, 0)).toEqual(right);
});

test("dragging past the bottom auto-scrolls and copies rows that were out of view", async ({ page, folders }) => {
  const left = Array.from({ length: 300 }, (_, i) => `L${i + 1}`);
  const right = Array.from({ length: 300 }, (_, i) => `R${i + 1}`);
  await openText(page, folders, left, right);
  const pane = panes(page).first();
  const start = await pointAt(page, 0, 1, 0);
  const box = (await pane.boundingBox())!;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, box.y + box.height + 40, { steps: 5 });
  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(500);
  await page.mouse.up();
  const end = Number(await pane.locator(".trow.kb-target .ln").textContent());
  expect(end).toBeGreaterThan(40);
  await page.keyboard.press("Control+r");
  const right2 = panes(page).last();
  await expect(right2.locator(".trow", { has: page.locator(".ln", { hasText: new RegExp(`^${end}$`) }) }).locator(".tx")).toHaveText(`L${end}`);
  await expect(right2.locator(".trow", { has: page.locator(".ln", { hasText: new RegExp(`^${end + 1}$`) }) }).locator(".tx")).toHaveText(`R${end + 1}`);
  await pane.evaluate((el) => (el.scrollTop = 0));
  await expect(right2.locator(".trow").filter({ has: page.locator(".ln", { hasText: /^1$/ }) }).locator(".tx")).toHaveText("L1");
});
