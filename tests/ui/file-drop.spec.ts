import type { Locator, Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./fixtures";

type Point = { x: number; y: number };
const send = (page: Page, detail: { type: string; paths?: string[] } & Point) =>
  page.evaluate((detail) => window.dispatchEvent(new CustomEvent("comparecraft-test-drop", { detail })), detail);

/** Centre of an element, or a point inside it at the given fractions of its size. */
async function at(target: Locator, fx = 0.5, fy = 0.5): Promise<Point> {
  const box = (await target.boundingBox())!;
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

/** A native file drag: enters, moves to the point and drops the paths there. */
async function drop(page: Page, paths: string[], point: Point) {
  await send(page, { type: "enter", paths, ...point });
  await send(page, { type: "over", paths, ...point });
  await send(page, { type: "drop", paths, ...point });
}

const open = (page: Page, kind: string, paths: string[]) => page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind, paths }))}`);
const view = (page: Page) => page.locator(".tab-view:visible");
const pathBox = (page: Page, side: number) => view(page).locator(`.pathbar[data-side="${side}"] .path-input`);
const firstLine = (page: Page, side: number) => view(page).locator(".tpane").nth(side).locator(".trow .tx").first();

test("dropping files on a text comparison replaces the side under the pointer, or both sides", async ({ page, folders }) => {
  await folders.pair("a.txt", "left one\n", "right one\n");
  const extra = join(folders.left, "..");
  const [c, d] = [join(extra, "c.txt"), join(extra, "d.txt")];
  await writeFile(c, "dropped c\n");
  await writeFile(d, "dropped d\n");
  await open(page, "text", [join(folders.left, "a.txt"), join(folders.right, "a.txt")]);
  await expect(firstLine(page, 0)).toHaveText("left one");

  // While dragging over the right half, the right path box shows where the item will go.
  const right = await at(view(page).locator(".tpane").nth(1));
  await send(page, { type: "enter", paths: [c], ...right });
  await send(page, { type: "over", ...right });
  await expect(view(page).locator('.pathbar[data-side="1"]')).toHaveClass(/drop-target/);
  await expect(view(page).locator('.pathbar[data-side="0"]')).not.toHaveClass(/drop-target/);
  await send(page, { type: "leave", x: 0, y: 0 });
  await expect(page.locator(".drop-target")).toHaveCount(0);

  await drop(page, [c], right);
  await expect(pathBox(page, 1)).toHaveValue(c);
  await expect(firstLine(page, 1)).toHaveText("dropped c");
  await expect(pathBox(page, 0)).toHaveValue(join(folders.left, "a.txt"));

  // Two items replace left and right in order, wherever they are dropped.
  await drop(page, [d, c], await at(view(page).locator(".tpane").nth(1)));
  await expect(pathBox(page, 0)).toHaveValue(d);
  await expect(firstLine(page, 0)).toHaveText("dropped d");
  await expect(pathBox(page, 1)).toHaveValue(c);
  await expect(page.locator(".tab")).toHaveCount(2);
});

test("a dropped item on a side with unsaved changes asks before replacing it", async ({ page, folders }) => {
  await folders.pair("a.txt", "same\nleft\n", "same\nright\n");
  const other = join(folders.right, "b.txt");
  await writeFile(other, "other\n");
  await open(page, "text", [join(folders.left, "a.txt"), join(folders.right, "a.txt")]);
  await view(page).locator(".tpane").first().locator(".trow", { hasText: "left" }).click();
  await page.keyboard.press("Control+r");
  await expect(page.locator(".tab-dirty")).toBeVisible();
  const asked = page.evaluate(() => new Promise<string>((resolve) => window.addEventListener("comparecraft-test-ask", (e) => resolve((e as CustomEvent<{ text: string }>).detail.text), { once: true })));
  await page.evaluate(() => ((window as Window & { __comparecraftAskResult?: boolean }).__comparecraftAskResult = false));
  await drop(page, [other], await at(pathBox(page, 1)));
  expect(await asked).toMatch(/Discard unsaved changes/);
  await expect(pathBox(page, 1)).toHaveValue(join(folders.right, "a.txt"));
});

test("folders dropped on a folder comparison replace a side; files open in a new tab", async ({ page, folders }) => {
  await folders.pair("x.txt", "same", "same");
  const otherLeft = join(folders.left, "..", "other-left");
  await mkdir(otherLeft);
  await writeFile(join(otherLeft, "y.txt"), "y");
  await folders.open(page);
  await drop(page, [otherLeft], await at(view(page).locator('.pathbar[data-side="0"]')));
  await expect(pathBox(page, 0)).toHaveValue(otherLeft);
  await expect(view(page).locator(".frow", { hasText: "y.txt" })).toBeVisible();

  const file = join(folders.right, "x.txt");
  await drop(page, [join(otherLeft, "y.txt"), file], await at(view(page).locator(".fscroll")));
  await expect(page.locator(".tab.active .tab-kind")).toHaveText("Text Compare");
  await expect(pathBox(page, 1)).toHaveValue(file);
});

test("on Home one item fills the next quick compare box, two open the comparison; the tab bar opens a tab and the menu bar ignores drops", async ({ page, folders }) => {
  await folders.pair("a.txt", "one\n", "two\n");
  const [l, r] = [join(folders.left, "a.txt"), join(folders.right, "a.txt")];
  await page.goto("/tests/ui/");
  const home = page.locator(".home");
  await expect(home).toBeVisible();
  const boxes = home.locator(".quick .path-input");
  await drop(page, [l], await at(home, 0.8, 0.3));
  await expect(boxes.nth(0)).toHaveValue(l);
  await drop(page, [r], await at(home, 0.8, 0.3));
  await expect(boxes.nth(1)).toHaveValue(r);
  await drop(page, [folders.left], await at(boxes.nth(1)));
  await expect(boxes.nth(1)).toHaveValue(folders.left);

  await drop(page, [l, r], await at(home, 0.8, 0.3));
  await expect(page.locator(".tab.active .tab-kind")).toHaveText("Text Compare");
  await expect(firstLine(page, 1)).toHaveText("two");

  // The outline shows where the items go: the tab bar itself, and nothing over the menu bar.
  const tabbar = await at(page.locator(".tabbar"), 0.9, 0.5);
  await send(page, { type: "enter", paths: [folders.left], ...tabbar });
  await send(page, { type: "over", ...tabbar });
  await expect(page.locator(".tabbar")).toHaveClass(/drop-target/);
  await expect(page.locator(".drop-target")).toHaveCount(1);
  const menu = await at(page.locator(".menubar"), 0.9, 0.5);
  await send(page, { type: "over", ...menu });
  await expect(page.locator(".drop-target")).toHaveCount(0);
  await send(page, { type: "drop", paths: [folders.left, folders.right], ...menu });
  await expect(page.locator(".tab:not(.home-tab)")).toHaveCount(1);

  await drop(page, [folders.left, folders.right], tabbar);
  await expect(page.locator(".tab.active .tab-kind")).toHaveText("Folder Compare");
  await expect(page.locator(".tab:not(.home-tab)")).toHaveCount(2);
});

test("folders dropped one at a time on a new folder comparison go to the side where they are released", async ({ page, folders }) => {
  await folders.pair("x.txt", "same", "same");
  const third = join(folders.left, "..", "third");
  await mkdir(third);
  await open(page, "folder", []);
  const list = view(page).locator(".fscroll");
  const [leftHalf, rightHalf] = [await at(list, 0.25, 0.5), await at(list, 0.75, 0.5)];

  await drop(page, [folders.left], leftHalf);
  await expect(pathBox(page, 0)).toHaveValue(folders.left);
  await expect(pathBox(page, 1)).toHaveValue("");

  await send(page, { type: "enter", paths: [folders.right], ...rightHalf });
  await send(page, { type: "over", ...rightHalf });
  await expect(view(page).locator('.pathbar[data-side="1"]')).toHaveClass(/drop-target/);
  await expect(view(page).locator('.pathbar[data-side="0"]')).not.toHaveClass(/drop-target/);
  await send(page, { type: "drop", paths: [folders.right], ...rightHalf });
  await expect(pathBox(page, 1)).toHaveValue(folders.right);
  await expect(view(page).locator(".frow", { hasText: "x.txt" })).toBeVisible();

  // A side that is already set is replaced.
  await drop(page, [third], await at(view(page).locator('.pathbar[data-side="0"]')));
  await expect(pathBox(page, 0)).toHaveValue(third);
  await expect(pathBox(page, 1)).toHaveValue(folders.right);
});
