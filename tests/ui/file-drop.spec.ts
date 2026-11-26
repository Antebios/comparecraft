import { test, expect, type Folders } from "./fixtures";
import type { Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dropPoint } from "../../src/host";

/** A file inside the fixture directory, so every drop targets a real path. */
async function file(folders: Folders, name: string, content: string): Promise<string> {
  const path = join(folders.left, name);
  await writeFile(path, content);
  return path;
}

/** Dispatches a drag event carrying a file list, the way an embedding host delivers a drop. */
async function drag(page: Page, paths: string[], type: "dragenter" | "dragover" | "dragleave" | "drop", at?: { x: number; y: number }) {
  await page.evaluate(
    ({ uris, type, at }) => {
      const data = new DataTransfer();
      data.setData("text/uri-list", uris.join("\r\n"));
      const event = new DragEvent(type, {
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
        clientX: at?.x ?? 0,
        clientY: at?.y ?? 0,
      });
      document.body.dispatchEvent(event);
    },
    { uris: paths.map((path) => pathToFileURL(path).href), type, at },
  );
}

const tab = (page: Page, label: string) => page.locator(".tab").filter({ hasText: label });
/** The Home tab is a .tab too, so it is excluded wherever opened tabs are counted. */
const openTabs = (page: Page) => page.locator(".tab:not(.home-tab)");

test("shows a hint while files are dragged over the window and hides it on leave", async ({ page, folders }) => {
  const one = await file(folders, "one.txt", "a\n");
  await page.goto("/tests/ui/");
  const hint = page.locator(".drop-overlay");
  await expect(hint).toHaveCount(0);
  await drag(page, [one], "dragenter");
  await expect(hint).toBeVisible();
  await drag(page, [one], "dragleave");
  await expect(hint).toHaveCount(0);
});

test("two dropped files open a text comparison", async ({ page, folders }) => {
  const left = await file(folders, "left.txt", "one\ntwo\n");
  const right = await file(folders, "right.txt", "one\n2\n");
  await page.goto("/tests/ui/");
  await drag(page, [left, right], "dragenter");
  await expect(page.locator(".drop-overlay")).toBeVisible();
  await drag(page, [left, right], "drop");
  await expect(tab(page, "Text Compare")).toBeVisible();
  await expect(page.locator(".drop-overlay")).toHaveCount(0);
});

test("three dropped files open a text merge", async ({ page, folders }) => {
  const mine = await file(folders, "mine.txt", "a\n");
  const theirs = await file(folders, "theirs.txt", "b\n");
  const base = await file(folders, "base.txt", "a\n");
  await page.goto("/tests/ui/");
  await drag(page, [mine, theirs, base], "drop");
  await expect(tab(page, "Text Merge")).toBeVisible();
});

test("a dropped folder fills one side of a folder comparison", async ({ page, folders }) => {
  const folder = join(folders.left, "tree");
  await mkdir(folder);
  await writeFile(join(folder, "a.txt"), "a\n");
  await page.goto("/tests/ui/");
  await drag(page, [folder], "drop");
  await expect(tab(page, "Folder Compare")).toBeVisible();
});

async function openTextCompare(page: Page, left: string, right: string) {
  const spec = encodeURIComponent(JSON.stringify({ kind: "text", paths: [left, right] }));
  await page.goto(`/tests/ui/?spec=${spec}`);
  await expect(page.locator(".paths .pathbar").first()).toBeVisible();
}

test("a file dropped on the left half replaces the left side", async ({ page, folders }) => {
  const left = await file(folders, "left.txt", "one\ntwo\n");
  const right = await file(folders, "right.txt", "one\n2\n");
  const third = await file(folders, "third.txt", "one\nthree\n");
  await openTextCompare(page, left, right);
  const box = (await page.locator(".paths").first().boundingBox())!;
  // Below the path bars, so the drop resolves to a pane half rather than a bar it sits on.
  await drag(page, [third], "drop", { x: box.x + box.width * 0.25, y: box.y + box.height + 40 });
  await expect(page.locator(".tab-title")).toContainText("third.txt");
  await expect(page.locator(".tab-title")).toContainText("right.txt");
  await expect(openTabs(page)).toHaveCount(1);
});

test("a file dropped on the right half replaces the right side", async ({ page, folders }) => {
  const left = await file(folders, "left.txt", "one\ntwo\n");
  const right = await file(folders, "right.txt", "one\n2\n");
  const fourth = await file(folders, "fourth.txt", "one\nfour\n");
  await openTextCompare(page, left, right);
  const box = (await page.locator(".paths").first().boundingBox())!;
  await drag(page, [fourth], "drop", { x: box.x + box.width * 0.75, y: box.y + box.height / 2 });
  await expect(page.locator(".tab-title")).toContainText("fourth.txt");
  await expect(page.locator(".tab-title")).toContainText("left.txt");
  await expect(openTabs(page)).toHaveCount(1);
});

test("a dropped item that cannot be read reports instead of opening a tab", async ({ page, folders }) => {
  await page.goto("/tests/ui/");
  await drag(page, [join(folders.left, "missing.txt")], "drop");
  await expect(page.locator(".toast")).toContainText("could not be read");
  await expect(openTabs(page)).toHaveCount(0);
});

test("the side under the pointer is marked before the drop", async ({ page, folders }) => {
  const left = await file(folders, "left.txt", "one\ntwo\n");
  const right = await file(folders, "right.txt", "one\n2\n");
  const third = await file(folders, "third.txt", "one\nthree\n");
  await openTextCompare(page, left, right);
  const bar = page.locator(".paths .pathbar").nth(1);
  const box = (await bar.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await drag(page, [third], "dragenter", at);
  await drag(page, [third], "dragover", at);
  await expect(page.locator(".paths .pathbar.drop-target")).toHaveCount(1);
  await expect(bar).toHaveClass(/drop-target/);
  await drag(page, [third], "dragleave");
  await expect(page.locator(".pathbar.drop-target")).toHaveCount(0);
});

/**
 * The desktop handler can report a drop with no usable point (wry reports 0, 0 until the pointer has
 * moved, and the point is only physical on Windows). Such a drop fills the side the drag was shown
 * over instead of the left one.
 */
test("a drop without a point fills the side the drag was over", async ({ page, folders }) => {
  const left = await file(folders, "left.txt", "one\ntwo\n");
  const right = await file(folders, "right.txt", "one\n2\n");
  const fourth = await file(folders, "fourth.txt", "one\nfour\n");
  await openTextCompare(page, left, right);
  const box = (await page.locator(".paths .pathbar").nth(1).boundingBox())!;
  await drag(page, [fourth], "dragover", { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await drag(page, [fourth], "drop");
  await expect(page.locator(".tab-title")).toContainText("fourth.txt");
  await expect(page.locator(".tab-title")).toContainText("left.txt");
  await expect(openTabs(page)).toHaveCount(1);
});

test("a native drop point is scaled only where the platform reports physical pixels", () => {
  // GTK widget coordinates and AppKit points already are CSS pixels, at any display scale.
  expect(dropPoint({ x: 1050, y: 480 }, "Linux x86_64", 2)).toEqual({ x: 1050, y: 480 });
  expect(dropPoint({ x: 1050, y: 480 }, "Macintosh", 2)).toEqual({ x: 1050, y: 480 });
  // Win32 client coordinates are physical pixels.
  expect(dropPoint({ x: 2100, y: 960 }, "Windows NT 10.0", 2)).toEqual({ x: 1050, y: 480 });
  expect(dropPoint({ x: 1050, y: 480 }, "Windows NT 10.0", 1)).toEqual({ x: 1050, y: 480 });
});
