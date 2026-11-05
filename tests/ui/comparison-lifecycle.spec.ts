import { test, expect, folderTab } from "./fixtures";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";

async function openMinimap(page: Page, left: string, right: string) {
  await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind: "text", paths: [left, right] }))}`);
  await expect(page.locator(".tab-view:visible .trow").first()).toBeVisible({ timeout: 15000 });
}

async function minimapMetrics(page: Page) {
  return page.locator(".tab-view:visible .tcompare").evaluate((comparison) => {
    const panes = comparison.querySelectorAll<HTMLDivElement>(".tpane");
    const map = comparison.querySelector<HTMLDivElement>(".overview")!;
    const indicator = comparison.querySelector<HTMLDivElement>(".ov-viewport");
    return {
      top: panes[0].scrollTop, rightTop: panes[1].scrollTop,
      leftX: panes[0].scrollLeft, rightX: panes[1].scrollLeft,
      height: panes[0].clientHeight, content: panes[0].scrollHeight,
      max: panes[0].scrollHeight - panes[0].clientHeight,
      track: map.clientHeight,
      indicatorTop: indicator ? indicator.getBoundingClientRect().top - map.getBoundingClientRect().top : 0,
      indicatorHeight: indicator?.getBoundingClientRect().height ?? 0,
    };
  });
}

test("minimap viewport follows both panes and track clicks preserve horizontal position", async ({ page, folders }, testInfo) => {
  test.slow();
  const left = Array.from({ length: 500 }, (_, index) => `Line ${index}: ${"text ".repeat(80)}`);
  const right = left.map((line, index) => [40, 240, 450].includes(index) ? `Changed ${line}` : line);
  await folders.pair("map.txt", left.join("\n"), right.join("\n"));
  await page.setViewportSize({ width: 1536, height: 864 });
  await openMinimap(page, join(folders.left, "map.txt"), join(folders.right, "map.txt"));
  const panes = page.locator(".tab-view:visible .tpane");
  const map = page.getByRole("scrollbar", { name: "Difference map" });
  await expect(page.locator(".ov-viewport")).toBeVisible();
  await panes.first().evaluate((pane) => { pane.scrollTop = 1800; pane.scrollLeft = 100; });
  await expect.poll(async () => (await minimapMetrics(page)).rightTop).toBe(1800);
  await expect.poll(async () => {
    const metrics = await minimapMetrics(page);
    return Math.abs(metrics.indicatorTop - metrics.top / metrics.max * (metrics.track - metrics.indicatorHeight));
  }).toBeLessThan(2);
  await panes.last().evaluate((pane) => { pane.scrollTop = 3200; });
  await expect.poll(async () => (await minimapMetrics(page)).top).toBe(3200);
  const before = await minimapMetrics(page);
  const bounds = (await map.boundingBox())!;
  await map.click({ position: { x: 1, y: bounds.height * 0.65 } });
  await expect.poll(async () => Math.abs((await minimapMetrics(page)).top - (before.content * 0.65 - before.height / 2))).toBeLessThan(before.content / bounds.height + 1);
  const jumped = await minimapMetrics(page);
  expect(jumped.rightTop).toBe(jumped.top);
  expect(jumped.leftX).toBe(before.leftX);
  expect(jumped.rightX).toBe(before.rightX);
  await map.press("End");
  await expect.poll(async () => { const metrics = await minimapMetrics(page); return metrics.top === metrics.max; }).toBe(true);
  const bottom = await minimapMetrics(page);
  expect(bottom.indicatorTop + bottom.indicatorHeight).toBeCloseTo(bottom.track, 0);
  await map.press("Home");
  await expect.poll(async () => (await minimapMetrics(page)).top).toBe(0);
  await map.press("ArrowDown");
  await expect.poll(async () => (await minimapMetrics(page)).top).toBe(20);
  await map.press("PageDown");
  await expect.poll(async () => (await minimapMetrics(page)).top).toBeGreaterThan(100);
  await page.screenshot({ path: testInfo.outputPath("minimap-desktop.png") });
  const originalHeight = (await minimapMetrics(page)).indicatorHeight;
  await page.setViewportSize({ width: 700, height: 600 });
  await expect.poll(async () => (await minimapMetrics(page)).indicatorHeight).toBeLessThan(originalHeight);
  await page.screenshot({ path: testInfo.outputPath("minimap-narrow.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: testInfo.outputPath("minimap-dark.png") });
  await map.press("End");
  await expect.poll(async () => { const metrics = await minimapMetrics(page); return metrics.top === metrics.max; }).toBe(true);
  const savedTop = (await minimapMetrics(page)).top;
  await page.getByRole("button", { name: "\u2302 CompareCraft", exact: true }).click();
  await page.locator(".tab").filter({ hasText: "Text Compare" }).click();
  await expect.poll(async () => (await minimapMetrics(page)).top).toBe(savedTop);
});

test("minimap follows displayed filters and keeps difference marker navigation", async ({ page, folders }) => {
  const left = Array.from({ length: 500 }, (_, index) => `Line ${index}`);
  const right = left.map((line, index) => [40, 240, 450].includes(index) ? `Changed ${line}` : line);
  await folders.pair("filtered-map.txt", left.join("\n"), right.join("\n"));
  await openMinimap(page, join(folders.left, "filtered-map.txt"), join(folders.right, "filtered-map.txt"));
  const marks = page.locator(".ov-mark");
  const toolbar = page.locator(".tab-view:visible .toolbar");
  await expect(marks).toHaveCount(3);
  await marks.last().click();
  await expect(marks.last()).toHaveClass(/cur/);
  await expect.poll(async () => {
    const metrics = await minimapMetrics(page);
    return Math.abs(metrics.top - (450 * 20 - metrics.height / 3));
  }).toBeLessThan(2);
  await toolbar.getByRole("button", { name: "Diffs", exact: true }).click();
  await expect(marks).toHaveCount(3);
  await expect.poll(async () => (await minimapMetrics(page)).top).toBe(0);
  const short = await minimapMetrics(page);
  expect(short.indicatorHeight).toBeCloseTo(short.track, 0);
  const positions = await marks.evaluateAll((entries) => entries.map((entry) => parseFloat((entry as HTMLElement).style.top)));
  expect(positions[1]).toBeCloseTo(100 / 3, 1);
  expect(positions[2]).toBeCloseTo(200 / 3, 1);
  await toolbar.getByRole("button", { name: "Context", exact: true }).click();
  await expect(marks).toHaveCount(3);
  const contextPositions = await marks.evaluateAll((entries) => entries.map((entry) => parseFloat((entry as HTMLElement).style.top)));
  expect(contextPositions[0]).toBeGreaterThan(0);
  expect(contextPositions[2]).toBeLessThan(90);
  await toolbar.getByRole("button", { name: "Same", exact: true }).click();
  await expect(marks).toHaveCount(0);
  await expect(page.locator(".ov-viewport")).toBeVisible();
  await toolbar.getByRole("button", { name: "All", exact: true }).click();
  await expect(marks).toHaveCount(3);
  const bounds = (await page.locator(".overview").boundingBox())!;
  await page.locator(".overview").click({ position: { x: 1, y: bounds.height - 1 } });
  await expect.poll(async () => { const metrics = await minimapMetrics(page); return metrics.top === metrics.max; }).toBe(true);
});

test("minimap handles short files and filters with no displayed rows", async ({ page, folders }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await folders.pair("short-map.txt", "same\n", "same\n");
  await openMinimap(page, join(folders.left, "short-map.txt"), join(folders.right, "short-map.txt"));
  const map = page.getByRole("scrollbar", { name: "Difference map" });
  await expect(map).toHaveAttribute("aria-valuemax", "0");
  await expect(map).toHaveAttribute("aria-valuenow", "0");
  await expect(map).toHaveAttribute("aria-disabled", "true");
  await map.click({ force: true });
  const metrics = await minimapMetrics(page);
  expect(metrics.indicatorTop).toBe(0);
  expect(metrics.indicatorHeight).toBeCloseTo(metrics.track, 0);
  await page.locator(".tab-view:visible .toolbar").getByRole("button", { name: "Diffs", exact: true }).click();
  await expect(page.locator(".ov-viewport")).toHaveCount(0);
  await expect(map).toHaveAttribute("aria-valuenow", "0");
  await expect(map).toHaveAttribute("tabindex", "-1");
  await map.click({ force: true });
  expect(errors).toEqual([]);
});

test("minimap excludes ignored changes from Same and handles one-sided rows", async ({ page, folders }) => {
  const left = Array.from({ length: 300 }, (_, index) => `Line ${index}`);
  const right = [...left];
  right[40] = "LINE 40";
  right[41] = "changed content";
  right.splice(180, 0, "inserted line");
  await folders.pair("mixed-map.txt", left.join("\n"), right.join("\n"));
  await openMinimap(page, join(folders.left, "mixed-map.txt"), join(folders.right, "mixed-map.txt"));
  const toolbar = page.locator(".tab-view:visible .toolbar");
  await expect(page.locator(".ov-mark").first()).toBeVisible();
  await toolbar.getByRole("button", { name: "Same", exact: true }).click();
  await expect(page.locator(".ov-mark")).toHaveCount(0);
  await toolbar.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.locator(".ov-mark").first()).toBeVisible();
  await toolbar.getByRole("button", { name: /Ignore unimportant/ }).click();
  await toolbar.getByRole("button", { name: "Diffs", exact: true }).click();
  await expect(page.locator(".trow").first()).toBeVisible();
  await page.locator(".ov-mark").last().click();
  const metrics = await minimapMetrics(page);
  expect(metrics.top).toBe(metrics.rightTop);
  expect(Number.isFinite(metrics.indicatorTop)).toBe(true);
  expect(metrics.indicatorTop + metrics.indicatorHeight).toBeLessThanOrEqual(metrics.track + 1);
});

test("unsaved edits do not change the folder, but saving does", async ({ page, folders }) => {
  await folders.pair("pair.txt", "aaaa\n", "bbbb\n");
  await folders.open(page);
  const row = page.locator(".frow").filter({ hasText: "pair.txt" });
  await row.dblclick();
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("1 difference section");
  await folderTab(page).click();
  await expect(row.locator(".fstatus")).toHaveText("≠");
  await page.locator(".tab").filter({ hasText: "Text Compare" }).click();
  await page.locator(".tab-view:visible .statusbar").getByRole("button", { name: "Edit left as text" }).click();
  await page.locator(".edit-all").fill("bbbb");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("Files are identical");
  await folderTab(page).click();
  await expect(row.locator(".fstatus")).toHaveText("≠");
  await page.locator(".tab").filter({ hasText: "Text Compare" }).click();
  await page.keyboard.press("Control+s");
  await expect(page.locator(".tab.active .tab-dirty")).toHaveCount(0);
  await expect.poll(() => readFile(join(folders.left, "pair.txt"), "utf8")).toBe("bbbb\n");
  await folderTab(page).click();
  await expect(row.locator(".fstatus")).toHaveText("=");
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("1 same");
});

test("a real file load error is propagated instead of comparing empty data as equal", async ({ page, folders }) => {
  await folders.pair("pair.txt", "same\n", "same\n");
  await folders.open(page);
  await rm(join(folders.left, "pair.txt"));
  await page.locator(".frow").dblclick();
  await expect(page.locator(".tab-view:visible .err-text")).toBeVisible();
  await folderTab(page).click();
  await expect(page.locator(".frow .fstatus")).toHaveText("!");
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("1 errors");
});

test("late comparison completion cannot overwrite changed folder bases", async ({ page, folders }) => {
  await folders.pair("pair.txt", "same\n", "same\n", false);
  const third = join(folders.right, "replacement");
  await mkdir(third);
  await writeFile(join(third, "pair.txt"), "different content\n");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/test-invoke", async (route) => {
    if (route.request().postDataJSON().cmd === "diff_texts") {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });

  await folders.open(page);
  await page.locator(".frow").filter({ hasText: "pair.txt" }).dblclick();
  await expect(page.locator(".tab.active .tab-kind")).toHaveText("Text Compare");
  await folderTab(page).click();
  const path = page.locator(".tab-view:visible .path-input").nth(1);
  await path.fill(third);
  await path.press("Enter");
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("1 different");
  release();
  await page.locator(".tab").filter({ hasText: "Text Compare" }).click();
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("Files are identical");
  await folderTab(page).click();
  await expect(page.locator(".frow .fstatus")).toHaveText("≠");
});

test("closing the parent before completion leaves the child working", async ({ page, folders }) => {
  await folders.pair("pair.txt", "same\n", "same\n", false);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/test-invoke", async (route) => {
    if (route.request().postDataJSON().cmd === "diff_texts") {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await folders.open(page);
  await page.locator(".frow").dblclick();
  await expect(page.locator(".tab.active .tab-kind")).toHaveText("Text Compare");
  await folderTab(page).locator(".tab-close").click();
  release();
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("Files are identical");
  await expect(folderTab(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("changing a child path prevents its new verdict from changing the original row", async ({ page, folders }) => {
  await folders.pair("pair.txt", "aaaa\n", "bbbb\n");
  await folders.pair("other.txt", "bbbb\n", "bbbb\n");
  await folders.open(page);
  const row = page.locator(".frow").filter({ hasText: "pair.txt" });
  await row.dblclick();
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("1 difference section");
  await folderTab(page).click();
  await expect(row.locator(".fstatus")).toHaveText("≠");
  await page.locator(".tab").filter({ hasText: "Text Compare" }).click();
  const path = page.locator(".tab-view:visible .path-input").first();
  await path.fill(join(folders.left, "other.txt"));
  await path.press("Enter");
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("Files are identical");
  await folderTab(page).click();
  await expect(row.locator(".fstatus")).toHaveText("≠");
});

test("reload updates the disk result while orphan opening preserves its status", async ({ page, folders }) => {
  await folders.pair("pair.txt", "aaaa\n", "bbbb\n");
  await writeFile(join(folders.left, "orphan.txt"), "only left\n");
  await folders.open(page);
  const row = page.locator(".frow").filter({ hasText: "pair.txt" });
  await row.dblclick();
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("1 difference section");
  await writeFile(join(folders.left, "pair.txt"), "bbbb\n");
  await page.keyboard.press("F5");
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("Files are identical");
  await folderTab(page).click();
  await expect(row.locator(".fstatus")).toHaveText("=");
  const orphan = page.locator(".frow").filter({ hasText: "orphan.txt" });
  await orphan.dblclick();
  await expect(page.locator(".tab.active .tab-kind")).toHaveText("Text Compare");
  await expect(page.locator(".tab-view:visible .trow").first()).toBeVisible();
  await folderTab(page).click();
  await expect(orphan.locator(".fstatus")).toHaveText("◧");
});
