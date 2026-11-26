import { test, expect } from "./fixtures";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

const leftPane = (page: Page) => page.locator(".tab-view:visible .tpane").nth(0);
const rightPane = (page: Page) => page.locator(".tab-view:visible .tpane").nth(1);
const texts = (pane: Locator) => pane.locator(".trow .tx").allTextContents();

async function open(page: Page, folders: { left: string; right: string; pair: (n: string, l: string, r: string) => Promise<void> }) {
  await folders.pair("select.txt", "one\ntwo\nthree\nfour\n", "ONE\nTWO\nTHREE\nfour\n");
  const path = (dir: string) => join(dir, "select.txt");
  await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind: "text", paths: [path(folders.left), path(folders.right)] }))}`);
  await expect(page.locator(".tab-view:visible .trow").first()).toBeVisible({ timeout: 15000 });
}

/** Drags across the first `lines` rows of the right pane, from their first character. */
async function dragRight(page: Page, lines: number) {
  const pane = rightPane(page);
  const start = await pane.locator(".trow").nth(0).locator(".tx").boundingBox();
  const end = await pane.locator(".trow").nth(lines - 1).locator(".tx").boundingBox();
  expect(start && end).toBeTruthy();
  await page.mouse.move(start!.x + 2, start!.y + start!.height / 2);
  await page.mouse.down();
  // A drag inside one line still has to move over some text to select anything.
  await page.mouse.move(end!.x + (lines > 1 ? 2 : 40), end!.y + end!.height / 2, { steps: 8 });
  await page.mouse.up();
}

test("dragging text selects the lines it touches, and the gutter arrow copies them", async ({ page, folders }) => {
  await open(page, folders);
  await dragRight(page, 2);
  await expect(rightPane(page).locator(".trow.rsel")).toHaveCount(2);
  // The arrow sits on the first selected row and is the "selected lines" variant.
  const arrow = rightPane(page).locator(".trow").nth(0).locator(".gbtn.line");
  await expect(arrow).toBeVisible();
  await arrow.click();
  // Only the two selected lines moved: the third line keeps its own text.
  await expect.poll(() => texts(leftPane(page))).toEqual(["ONE", "TWO", "three", "four"]);
});

test("dragging text and pressing Ctrl+L copies only the selected lines", async ({ page, folders }) => {
  await open(page, folders);
  await dragRight(page, 1);
  await expect(rightPane(page).locator(".trow.rsel")).toHaveCount(1);
  await page.keyboard.press("Control+l");
  await expect.poll(() => texts(leftPane(page))).toEqual(["ONE", "two", "three", "four"]);
});
