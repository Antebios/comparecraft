import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures";

test("About shows the build version, marked -dev outside release builds", async ({ page }) => {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const expected = process.env.COMPARECRAFT_VERSION?.trim() || `${version}-dev`;
  await page.goto("/tests/ui/");
  await page.locator(".menu-title", { hasText: "Help" }).click();
  await page.getByRole("menuitem", { name: "About CompareCraft", exact: true }).click();
  await expect(page.locator(".modal", { hasText: "About CompareCraft" })).toContainText(`CompareCraft ${expected}:`);
});
