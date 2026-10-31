import { test, expect, folderTab } from "./fixtures";

test("double-click automatically updates the originating folder glyph and summary", async ({ page, folders }) => {
  await folders.pair("pair.txt", "same content\n", "same content\n", false);
  await folders.open(page);
  const row = page.locator(".frow").filter({ hasText: "pair.txt" });
  await expect(row.locator(".fstatus")).toHaveText("≠");
  await row.dblclick();
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("Files are identical");
  await folderTab(page).click();
  await expect(row.locator(".fstatus")).toHaveText("=");
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("1 same");
});

test("differences update ancestors and remove the row from the Same filter", async ({ page, folders }) => {
  await folders.pair("nested/pair.txt", "aaaa\n", "bbbb\n");
  await folders.open(page);
  const parent = page.locator(".frow").filter({ hasText: "nested" });
  await parent.dblclick();
  const row = page.locator(".frow").filter({ hasText: "pair.txt" });
  await expect(row.locator(".fstatus")).toHaveText("=");
  await row.click();
  await page.keyboard.press("Enter");
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("1 difference section");
  await folderTab(page).click();
  await expect(row.locator(".fstatus")).toHaveText("≠");
  await expect(parent.locator(".fstatus")).toHaveText("≠");
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("1 different");
  await page.locator(".tab-view:visible .toolbar").getByRole("button", { name: "Same", exact: true }).click();
  await expect(row).toHaveCount(0);
});

test("only unimportant differences retain the similar verdict", async ({ page, folders }) => {
  await folders.pair("pair.txt", "hello\n", "HELLO\n");
  await folders.open(page);
  const row = page.locator(".frow").filter({ hasText: "pair.txt" });
  await row.dblclick();
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("Only unimportant differences");
  await folderTab(page).click();
  await expect(row.locator(".fstatus")).toHaveText("≈");
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("1 similar");
});

for (const [name, left, right] of [
  ["pair.bin", Buffer.from([0, 1, 2]), Buffer.from([0, 1, 3])],
  ["pair.csv", "key,value\n1,aa\n", "key,value\n1,bb\n"],
  ["pair.png",
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")],
] as const) {
  test(`${name} automatic comparison updates its folder status`, async ({ page, folders }) => {
    await folders.pair(name, left, right, !name.endsWith("png"));
    await folders.open(page);
    const row = page.locator(".frow").filter({ hasText: name });
    await expect(row.locator(".fstatus")).toHaveText(name.endsWith("png") ? "≠" : "=");
    await row.dblclick();
    await expect(page.locator(".tab.active .tab-kind")).toHaveText(name.endsWith("bin") ? "Hex Compare" : name.endsWith("csv") ? "Table Compare" : "Picture Compare");
    await folderTab(page).click();
    await expect(row.locator(".fstatus")).toHaveText(name.endsWith("png") ? "=" : "≠");
    await expect(page.locator(".tab-view:visible .statusbar")).toContainText(name.endsWith("png") ? "1 same" : "1 different");
  });
}

test("Open With reports the forced viewer result without a second comparison", async ({ page, folders }) => {
  await folders.pair("pair.txt", "same\n", "same\n", false);
  let comparisons = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/test-invoke") && request.postDataJSON().cmd === "hex_align") comparisons++;
  });
  await folders.open(page);
  const row = page.locator(".frow").filter({ hasText: "pair.txt" });
  await row.click({ button: "right" });
  await page.locator(".ctx-menu").getByText("Open With", { exact: true }).hover();
  await page.getByText("Hex Compare", { exact: true }).last().click();
  await expect(page.locator(".tab.active .tab-kind")).toHaveText("Hex Compare");
  await folderTab(page).click();
  await expect(row.locator(".fstatus")).toHaveText("=");
  expect(comparisons).toBe(1);
});

test("Compare To does not overwrite either original paired row", async ({ page, folders }) => {
  await folders.pair("a.txt", "same\n", "aaaa\n", false);
  await folders.pair("b.txt", "bbbb\n", "same\n", false);
  await folders.open(page);
  await page.locator(".frow").filter({ hasText: "a.txt" }).locator(".fside").first().click();
  await page.keyboard.press("F7");
  await page.locator(".frow").filter({ hasText: "b.txt" }).locator(".fside").last().click();
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("Files are identical");
  await folderTab(page).click();
  await expect(page.locator(".frow .fstatus")).toHaveText(["≠", "≠"]);
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("2 different");
});

test("a folder refresh restores the configured metadata comparison", async ({ page, folders }) => {
  await folders.pair("pair.txt", "same\n", "same\n", false);
  await folders.open(page);
  await page.locator(".frow").dblclick();
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("Files are identical");
  await folderTab(page).click();
  await expect(page.locator(".frow .fstatus")).toHaveText("=");
  await page.keyboard.press("F5");
  await expect(page.locator(".frow .fstatus")).toHaveText("≠");
});
