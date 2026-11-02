import { test, expect, folderTab } from "./fixtures";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
