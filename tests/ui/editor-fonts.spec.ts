import { type Page } from "@playwright/test";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { fontSettingForFamily, quoteFontFamily, singleFontFamily } from "../../src/editorFonts";

test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"], executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined } });

async function fontHost(page: Page, initial: Record<string, unknown> = {}, families = ["A Font", "Comma, Font", 'Quoted "Font"', "Z Font"]) {
  let settings = initial;
  let fail = false;
  let calls = 0;
  await page.route("**/test-fonts", (route) => {
    calls++;
    return route.fulfill(fail
      ? { status: 500, json: { error: "Font service unavailable" } }
      : { json: families });
  });
  await page.route("**/test-invoke", (route) => {
    const { cmd, args } = route.request().postDataJSON();
    if (cmd === "load_settings") return route.fulfill({ json: settings });
    if (cmd === "save_settings") {
      settings = args.value ?? args.settings;
      return route.fulfill({ json: null });
    }
    if (cmd === "shell_integration_status") return route.fulfill({ json: { supported: false, items: [] } });
    return route.continue();
  });
  return { settings: () => settings, fail: (value: boolean) => { fail = value; }, calls: () => calls };
}

async function options(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("comparecraft:options", { detail: "colors" })));
  await expect(page.getByRole("dialog", { name: "Options", exact: true })).toBeVisible();
}

const combo = (page: Page) => page.getByRole("combobox", { name: "Editor font:", exact: true });
const preview = (page: Page) => page.getByLabel("Editor font preview", { exact: true });
const apply = (page: Page) => page.getByRole("button", { name: "Apply", exact: true });
const fontStatus = (page: Page) => page.locator(".font-status");

async function textWidth(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getBoundingClientRect().width;
  });
}

test("literal family serialization preserves punctuation and distinguishes quoted generics", () => {
  for (const name of ["A Font", "Comma, Font", 'Quoted "Font"', "Back\\Slash", "New\nLine", "Ä Font"]) {
    expect(singleFontFamily(fontSettingForFamily(name))).toEqual({ name, generic: false });
  }
  expect(singleFontFamily("serif")).toEqual({ name: "serif", generic: true });
  expect(singleFontFamily('"serif"')).toEqual({ name: "serif", generic: false });
  expect(singleFontFamily("Ä Font")).toEqual({ name: "Ä Font", generic: false });
  expect(singleFontFamily('"A Font", monospace')).toBeUndefined();
  expect(quoteFontFamily('A"\\B')).toBe('"A\\"\\\\B"');
});

test("installed dropdown supports filtering, keyboard selection, unusual names and Escape", async ({ page }) => {
  const host = await fontHost(page);
  await page.goto("/tests/ui/");
  await expect(page.getByRole("button", { name: /CompareCraft/, exact: false }).first()).toBeVisible();
  expect(host.calls()).toBe(0);
  await options(page);
  await page.getByRole("button", { name: "Show installed fonts" }).click();
  await expect(page.getByRole("listbox").getByRole("option")).toHaveText(["Default monospace", "A Font", "Comma, Font", 'Quoted "Font"', "Z Font"]);
  await combo(page).fill("Comma");
  await expect(page.getByRole("listbox").getByRole("option")).toHaveText(["Default monospace", "Comma, Font"]);
  await combo(page).press("ArrowDown");
  await combo(page).press("ArrowDown");
  await combo(page).press("Enter");
  await expect(combo(page)).toHaveValue('"Comma, Font"');
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(preview(page)).toHaveCSS("font-family", '"Comma, Font", monospace');
  await apply(page).click();
  await expect.poll(() => host.settings().editorFont).toBe('"Comma, Font"');
  await page.getByRole("button", { name: "Show installed fonts" }).click();
  await expect(page.getByRole("option", { name: "Comma, Font", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("option", { name: 'Quoted "Font"', exact: true }).click();
  await expect(combo(page)).toHaveValue('"Quoted \\"Font\\""');
  await page.getByRole("button", { name: "Show installed fonts" }).click();
  await combo(page).press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(combo(page)).toBeVisible();
  await combo(page).press("Escape");
  await expect(page.getByRole("dialog", { name: "Options", exact: true })).toHaveCount(0);
  expect(host.settings().editorFont).toBe('"Comma, Font"');
});

test("preview is isolated; Apply uses latest input and persists visible font changes", async ({ page, folders }, testInfo) => {
  const host = await fontHost(page);
  await folders.pair("font.txt", "MMMMiiii0000[]", "MMMMiiii0000[] changed");
  await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind: "text", paths: [join(folders.left, "font.txt"), join(folders.right, "font.txt")] }))}`);
  const text = ".tab-view:visible .tpane .tx";
  await expect(page.locator(text).first()).toBeVisible();
  const original = await textWidth(page, text);
  await options(page);
  await combo(page).fill("serif");
  await expect(preview(page)).toHaveCSS("font-family", "serif, monospace");
  expect(await textWidth(page, text)).toBe(original);
  await combo(page).press("Escape");
  await combo(page).press("Tab");
  await preview(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("editor-font-preview.png") });
  await apply(page).click();
  await expect.poll(() => textWidth(page, text)).not.toBe(original);
  const applied = await textWidth(page, text);
  await combo(page).fill("monospace");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await textWidth(page, text)).toBe(applied);
  await expect.poll(() => host.settings().editorFont).toBe("serif");
  await page.reload();
  await expect(page.locator(text).first()).toBeVisible();
  expect(await textWidth(page, text)).toBe(applied);
  await options(page);
  await expect(combo(page)).toHaveValue("serif");
  await combo(page).fill("monospace");
  await combo(page).press("Escape");
  // Click OK directly after editing, without requiring the input's change/blur handler.
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect.poll(() => host.settings().editorFont).toBe("monospace");
  await options(page);
  await page.getByRole("button", { name: "Show installed fonts" }).click();
  await page.getByRole("option", { name: "Default monospace", exact: true }).click();
  await apply(page).click();
  await expect.poll(() => host.settings().editorFont).toBe("");
  expect(await textWidth(page, text)).toBe(original);
});

test("saved custom names and CSS fallback lists survive reload and missing fonts visibly fall back", async ({ page, folders }) => {
  const saved = '"Missing CompareCraft Test Font", monospace';
  const host = await fontHost(page, { editorFont: saved });
  await folders.pair("fallback.txt", "MMMMiiii0000[]", "MMMMiiii0000[] changed");
  await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind: "text", paths: [join(folders.left, "fallback.txt"), join(folders.right, "fallback.txt")] }))}`);
  const text = ".tab-view:visible .tpane .tx";
  await expect(page.locator(text).first()).toBeVisible();
  const fallbackWidth = await textWidth(page, text);
  await options(page);
  await expect(combo(page)).toHaveValue(saved);
  await expect(fontStatus(page)).toContainText("first usable family");
  await combo(page).fill("Missing CompareCraft Test Font");
  await expect(fontStatus(page)).toContainText("not listed among installed fonts");
  await expect(fontStatus(page)).toContainText("Could not verify local font loading");
  await combo(page).press("Escape");
  await apply(page).click();
  await expect.poll(() => host.settings().editorFont).toBe("Missing CompareCraft Test Font");
  expect(await textWidth(page, text)).toBe(fallbackWidth);
  await combo(page).fill("monospace");
  await combo(page).press("Escape");
  await apply(page).click();
  expect(await textWidth(page, text)).toBe(fallbackWidth);
});

test("discovery error is explicit, custom input still works, and retry recovers", async ({ page }) => {
  const host = await fontHost(page);
  host.fail(true);
  await page.goto("/tests/ui/");
  await options(page);
  await expect(page.getByRole("alert")).toContainText("Font service unavailable");
  await combo(page).fill("serif");
  await combo(page).press("Escape");
  await apply(page).click();
  await expect.poll(() => host.settings().editorFont).toBe("serif");
  host.fail(false);
  await page.getByRole("button", { name: "Retry fonts" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Show installed fonts" }).click();
  await expect(page.getByRole("option", { name: "A Font", exact: true })).toBeVisible();
});

test("stale local font probes cannot overwrite the current selection", async ({ page }) => {
  await fontHost(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "FontFace", { value: class {
      constructor(_family: string, private source: string) {}
      async load() {
        await new Promise((resolve) => setTimeout(resolve, this.source.includes("Slow") ? 800 : 10));
        if (this.source.includes("Slow")) throw new Error("Old font failed");
        return this;
      }
    } });
  });
  await page.goto("/tests/ui/");
  await options(page);
  await combo(page).fill("Slow Font");
  await page.waitForTimeout(300);
  await combo(page).fill("A Font");
  await expect(fontStatus(page)).toContainText("The WebView accepted a local font lookup");
  await page.waitForTimeout(900);
  await expect(fontStatus(page)).toContainText("The WebView accepted a local font lookup");
  await expect(fontStatus(page)).not.toContainText("Old font failed");
});

test("permissive WebView local lookup cannot hide an unlisted-family warning", async ({ page }) => {
  await fontHost(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "FontFace", { value: class { async load() { return this; } } });
  });
  await page.goto("/tests/ui/");
  await options(page);
  await combo(page).fill("Not An Installed Family");
  await expect(fontStatus(page)).toContainText("not listed among installed fonts");
  await page.waitForTimeout(350);
  await expect(fontStatus(page)).toContainText("not listed among installed fonts");
  await expect(fontStatus(page)).not.toContainText("The WebView accepted");
});

for (const view of [
  { kind: "merge", selectors: [".mtop", ".mbottom"] },
  { kind: "edit", selectors: [".text-edit"] },
  { kind: "patch", selectors: [".patch-body"] },
  { kind: "hex", selectors: [".hscroll"] },
  { kind: "table", selectors: [".tscroll"] },
]) {
  test(`font applies to existing ${view.kind} views`, async ({ page, folders }) => {
    await fontHost(page);
    await folders.pair("view.txt", "base\nleft\n", "base\nright\n");
    const paths = [join(folders.left, "view.txt"), join(folders.right, "view.txt")];
    await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind: view.kind, paths }))}`);
    for (const selector of view.selectors) await expect(page.locator(selector).first()).toBeVisible();
    await options(page);
    await combo(page).fill("serif");
    await combo(page).press("Escape");
    await page.getByRole("spinbutton", { name: /Editor font size:/ }).fill("28");
    await page.getByRole("spinbutton", { name: /Interface font size:/ }).fill("24");
    await apply(page).click();
    for (const selector of view.selectors) {
      await expect(page.locator(selector).first()).toHaveCSS("font-family", "serif, monospace");
      await expect(page.locator(selector).first()).toHaveCSS("font-size", "28px");
    }
    await expect(page.locator(".tab-view:visible .path-input").first()).toHaveCSS("font-size", "24px");
    const row = page.locator(".tab-view:visible .mrow, .tab-view:visible .hrow, .tab-view:visible .trow2").first();
    if (await row.count()) await expect(row).toHaveCSS("height", "40px");
  });
}

test("folder listings receive editor family and size while paths follow interface size", async ({ page, folders }, testInfo) => {
  await fontHost(page);
  for (let i = 0; i < 80; i++) await folders.pair(`${String(i).padStart(3, "0")}-MMMMiiii.txt`, "left", "right");
  await folders.open(page);
  const name = ".tab-view:visible .fscroll .fname";
  const original = await textWidth(page, name);
  await options(page);
  await combo(page).fill("serif");
  await combo(page).press("Escape");
  await page.getByRole("spinbutton", { name: /Interface font size:/ }).fill("24");
  await page.getByRole("spinbutton", { name: /Editor font size:/ }).fill("28");
  await apply(page).click();
  await expect(page.locator(name).first()).toHaveCSS("font-family", "serif, monospace");
  await expect(page.locator(name).first()).toHaveCSS("font-size", "28px");
  await expect.poll(() => textWidth(page, name)).not.toBe(original);
  await expect(page.locator(".tab-view:visible .path-input").first()).toHaveCSS("font-size", "24px");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const scroller = page.locator(".tab-view:visible .fscroll");
  await expect(scroller.locator('[data-filler="1"]')).toHaveCSS("height", "3200px");
  await expect(scroller.locator(".frow").nth(1)).toHaveCSS("top", "40px");
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(scroller.locator(".fname").filter({ hasText: "079-MMMMiiii.txt" }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("folder-editor-font-28px.png") });
});

test("text size honors full range and keeps virtual rows, inline editing and minimap aligned", async ({ page, folders }) => {
  await fontHost(page);
  const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: MMMMiiii0000[]`);
  await folders.pair("sizes.txt", lines.join("\n"), lines.map((line, i) => i === 150 ? `${line} changed` : line).join("\n"));
  await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind: "text", paths: [join(folders.left, "sizes.txt"), join(folders.right, "sizes.txt")] }))}`);
  const pane = page.locator(".tab-view:visible .tpane").first();
  await expect(pane.locator(".tx").first()).toBeVisible();
  await options(page);
  for (const size of [8, 16, 28]) {
    await page.getByRole("spinbutton", { name: /Editor font size:/ }).fill(String(size));
    await apply(page).click();
    await expect(pane.locator(".tx").first()).toHaveCSS("font-size", `${size}px`);
    const height = Math.max(20, Math.ceil(size * 1.4));
    await expect(pane.locator(".trow").first()).toHaveCSS("height", `${height}px`);
    await expect(pane.locator(".trow").nth(1)).toHaveCSS("top", `${height}px`);
    await expect(pane.locator(".tpane-inner")).toHaveCSS("height", `${200 * height}px`);
  }
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const map = page.getByRole("scrollbar", { name: "Difference map" });
  await map.press("Home");
  await map.press("ArrowDown");
  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBe(40);
  await map.press("End");
  await expect(pane.getByText("Line 199: MMMMiiii0000[]", { exact: true })).toBeVisible();
  await map.press("Home");
  await pane.locator(".tx").first().dblclick();
  await expect(pane.locator(".line-edit")).toHaveCSS("font-size", "28px");
  await expect(pane.locator(".line-edit")).toHaveCSS("height", "40px");
});

test("mouse scrollbar drag keeps font dropdown open and outside clicks still dismiss it", async ({ page }) => {
  await fontHost(page, {}, Array.from({ length: 100 }, (_, i) => `Test Font ${String(i).padStart(3, "0")}`));
  await page.goto("/tests/ui/");
  await options(page);
  await page.addStyleTag({ content: ".font-list::-webkit-scrollbar { width: 16px; } .font-list::-webkit-scrollbar-thumb { background: #888; }" });
  await page.getByRole("button", { name: "Show installed fonts" }).click();
  const list = page.getByRole("listbox", { name: "Installed font families" });
  await expect(list).toBeVisible();
  await list.scrollIntoViewIfNeeded();
  const bounds = (await list.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width - 8, bounds.y + 8);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 8, bounds.y + bounds.height - 20, { steps: 15 });
  await page.mouse.up();
  await expect(list).toBeVisible();
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // WebKit can deliver a focusout without a relatedTarget when its scrollbar takes focus.
  await combo(page).evaluate((el) => el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null })));
  await expect(list).toBeVisible();
  await list.getByRole("option", { name: "Test Font 099", exact: true }).click();
  await expect(combo(page)).toHaveValue('"Test Font 099"');
  await page.getByRole("button", { name: "Show installed fonts" }).click();
  await page.getByRole("heading", { name: "Colors, Fonts", exact: true }).click();
  await expect(list).toHaveCount(0);
});
