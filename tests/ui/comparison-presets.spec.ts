import { type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { defaultPresetSettings, normalizePresetSettings, presetLibraryError, resolvePresetState, BUILTIN_PRESETS, type ComparisonPresetSettings } from "../../src/comparisonPresets";
import type { FolderResult } from "../../src/api";

interface QuickCall { left: string; right: string; mode: string }

test.describe.configure({ timeout: 60_000 });

async function presetHost(page: Page, initial: ComparisonPresetSettings = defaultPresetSettings()) {
  let settings: Record<string, unknown> = { comparisonPresets: initial };
  const calls: QuickCall[] = [];
  const sessions: { options: Record<string, unknown>; name: string; saved: boolean; id: string }[] = [];
  let quick = async (_args: QuickCall): Promise<number> => 1;
  let folder = (result: FolderResult, _options: Record<string, unknown>): FolderResult => result;
  let saveError = "";
  await page.route("**/test-invoke", async (route) => {
    const { cmd, args } = route.request().postDataJSON();
    let response: unknown;
    if (cmd === "load_settings") response = settings;
    else if (cmd === "save_settings") {
      if (saveError) return route.fulfill({ status: 500, json: { error: saveError } });
      settings = args.value ?? args.settings;
      response = null;
    } else if (cmd === "quick_compare") {
      calls.push(args);
      try { response = await quick(args); }
      catch (e) { return route.fulfill({ status: 500, json: { error: String(e) } }); }
    } else if (cmd === "compare_folders") {
      const actual = await route.fetch();
      response = folder(await actual.json(), args.options);
    } else if (cmd === "save_session") {
      sessions.push(args.session);
      response = null;
    } else return route.continue();
    await route.fulfill({ json: response });
  });
  return {
    calls, sessions,
    settings: () => settings,
    quick: (handler: typeof quick) => { quick = handler; },
    folder: (handler: typeof folder) => { folder = handler; },
    saveError: (message: string) => { saveError = message; },
  };
}

const choose = async (page: Page, scope: "All included files" | "Selected items", method: string) => {
  await page.getByRole("button", { name: "Choose comparison preset", exact: true }).click();
  await page.getByRole("menuitem", { name: scope, exact: true }).hover();
  await page.getByRole("menuitemcheckbox", { name: new RegExp(`Compare .*: ${method} \\(`) }).click();
};
const run = (page: Page) => page.getByRole("button", { name: /^Run Compare / });
const status = (page: Page) => page.locator(".tab-view:visible .statusbar");
const manage = async (page: Page) => {
  await page.getByRole("button", { name: "Choose comparison preset", exact: true }).click();
  await page.getByRole("menuitem", { name: "Manage Comparison Presets...", exact: true }).click();
};

test("All compares collapsed and display-hidden pairs without selection or a popup", async ({ page, folders }) => {
  const host = await presetHost(page);
  await folders.pair("same.txt", "same", "same", false);
  await folders.pair("nested/child.txt", "same", "same");
  await folders.open(page);
  await page.locator(".toolbar").getByRole("button", { name: "Diffs", exact: true }).click();
  await run(page).click();
  await expect(status(page)).toContainText("Compared 2 file(s): 2 same");
  expect(host.calls).toHaveLength(2);
  expect(host.calls.some((c) => c.left.endsWith(join("nested", "child.txt")))).toBe(true);
  await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  await expect(status(page)).not.toContainText("Selected:");
});

for (const scope of ["All included files", "Selected items"] as const) {
  for (const [label, mode] of [["CRC", "crc"], ["Binary", "binary"], ["Rules-based", "rules"]] as const) {
    test(`${scope} / ${label}: choosing never executes, Run dispatches the method`, async ({ page, folders }) => {
      const host = await presetHost(page);
      await folders.pair("one.txt", "same", "same");
      await folders.pair("two.txt", "same", "same");
      await folders.open(page);
      await page.locator(".frow").filter({ hasText: "one.txt" }).locator(".fside").first().click();
      await choose(page, scope, label);
      expect(host.calls).toHaveLength(0);
      await run(page).click();
      await expect(status(page)).toContainText(`Compared ${scope === "Selected items" ? 1 : 2} file(s)`);
      expect(host.calls.every((c) => c.mode === mode)).toBe(true);
      expect(host.calls).toHaveLength(scope === "Selected items" ? 1 : 2);
      await expect(page.locator(".frow").filter({ hasText: "one.txt" }).locator(".fside").first()).toHaveClass(/selc/);
    });
  }
}

test("Selected with no selection stays disabled rather than falling back to All", async ({ page, folders }) => {
  const host = await presetHost(page);
  await folders.pair("one.txt", "same", "same");
  await folders.open(page);
  await choose(page, "Selected items", "Binary");
  await expect(run(page)).toBeDisabled();
  await expect(page.locator(".preset-run-wrap")).toHaveAttribute("title", /Select files or folders/);
  expect(host.calls).toHaveLength(0);
});

test("overlapping parent/child selections compare each descendant once", async ({ page, folders }) => {
  const host = await presetHost(page);
  await folders.pair("nested/one.txt", "same", "same");
  await folders.open(page);
  await page.locator(".frow").filter({ hasText: "nested" }).dblclick();
  await page.keyboard.press("Control+a");
  await choose(page, "Selected items", "Binary");
  await run(page).click();
  await expect(status(page)).toContainText("Compared 1 file(s)");
  expect(host.calls).toHaveLength(1);
});

test("Peek uses authoritative configured-filter eligibility without hiding excluded rows", async ({ page, folders }) => {
  const host = await presetHost(page);
  await folders.pair("included.txt", "same", "same", false);
  await folders.pair("excluded.txt", "same", "same", false);
  host.folder((result, options) => {
    if (options.criteria === "size") result.root.children = result.root.children?.filter((n) => n.name === "included.txt");
    return result;
  });
  await folders.open(page);
  await page.getByRole("button", { name: /Peek$/ }).click();
  await run(page).click();
  await expect(status(page)).toContainText("Compared 1 file(s)");
  expect(host.calls[0].left).toContain("included.txt");
  await expect(page.locator(".frow").filter({ hasText: "excluded.txt" }).locator(".fstatus")).toHaveText("≠");
  await expect(page.getByText("Peeking at excluded items")).toBeVisible();
});

test("flattened eligibility keys both physical paths rather than synthetic row IDs", async ({ page, folders }) => {
  const host = await presetHost(page);
  await folders.pair("a.txt", "same", "same", false);
  await folders.pair("b.txt", "same", "same", false);
  host.folder((result, options) => {
    const nodes = result.root.children!;
    if (options.criteria === "size") {
      result.root.children = [{ ...nodes[1], rel: "different-synthetic-id", leftPath: "b.txt", rightPath: "b.txt" }];
    } else {
      result.root.children = nodes.map((n) => ({ ...n, leftPath: n.name, rightPath: n.name }));
    }
    return result;
  });
  await folders.open(page);
  await page.getByRole("button", { name: /Peek$/ }).click();
  await run(page).click();
  await expect(status(page)).toContainText("Compared 1 file(s)");
  expect(host.calls.map((c) => c.left)).toEqual([join(folders.left, "b.txt")]);
});

test("same, similar, different, and failed comparisons are counted separately", async ({ page, folders }) => {
  const host = await presetHost(page);
  for (const name of ["same", "similar", "different", "error"]) await folders.pair(`${name}.txt`, "aaaa", "bbbb");
  host.quick(async ({ left }) => {
    if (left.endsWith("error.txt")) throw new Error("Read access denied");
    return left.endsWith("same.txt") ? 1 : left.endsWith("similar.txt") ? 12 : 13;
  });
  await folders.open(page);
  await run(page).click();
  await expect(status(page)).toContainText("1 same, 1 similar, 1 different, 1 errors");
  await expect(page.locator(".frow").filter({ hasText: "error.txt" }).locator(".fstatus")).toHaveText("!");
});

test("late quick results cannot overwrite refreshed metadata and double execution is disabled", async ({ page, folders }) => {
  const host = await presetHost(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  host.quick(async () => { await gate; return 1; });
  await folders.pair("one.txt", "same", "same", false);
  await folders.open(page);
  await run(page).click();
  await expect.poll(() => host.calls.length).toBe(1);
  await expect(run(page)).toBeDisabled();
  await page.keyboard.press("F5");
  await expect(page.locator(".frow .fstatus")).toHaveText("≠");
  release();
  await expect(run(page)).toBeEnabled();
  await expect(page.locator(".frow .fstatus")).toHaveText("≠");
});

test("named presets save, pin, select without running, and survive reload", async ({ page, folders }) => {
  const host = await presetHost(page);
  await folders.pair("one.txt", "same", "same");
  await folders.open(page);
  await manage(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("My CRC");
  await page.getByRole("combobox", { name: "Method", exact: true }).selectOption("crc");
  await page.getByLabel("Pin in this folder session", { exact: true }).check();
  await page.screenshot({ path: test.info().outputPath("preset-editor.png") });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  expect(host.calls).toHaveLength(0);
  const saved = host.settings().comparisonPresets as ComparisonPresetSettings;
  expect(saved.library[0]).toMatchObject({ name: "My CRC", method: "crc", scope: "all" });
  await page.getByRole("button", { name: "Choose comparison preset" }).click();
  await page.getByRole("menuitem", { name: "My presets", exact: true }).hover();
  await page.getByRole("menuitemcheckbox", { name: /^My CRC / }).click();
  await expect(run(page)).toHaveCount(0);
  const main = page.getByRole("button", { name: /^Run My CRC / });
  await expect(main).toBeEnabled();
  expect(host.calls).toHaveLength(0);
  await manage(page);
  await page.getByLabel(/Use the current comparison choice/).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  await page.reload();
  await expect(main).toBeVisible();
  await main.click();
  await expect.poll(() => host.calls.length).toBe(1);
  expect(host.calls[0].mode).toBe("crc");
});

test("management validates names, discards Cancel, and keeps save failures visible", async ({ page, folders }) => {
  const host = await presetHost(page);
  await folders.pair("one.txt", "same", "same");
  await folders.open(page);
  await manage(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("needs a name");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((host.settings().comparisonPresets as ComparisonPresetSettings).library).toHaveLength(0);
  await manage(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  host.saveError("Cannot write settings");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Cannot write settings");
  await expect(page.locator(".modal-backdrop")).toHaveCount(1);
  expect(host.calls).toHaveLength(0);
});

test("deleting an active shared preset explicitly resets its reference", async ({ page, folders }) => {
  const host = await presetHost(page, { library: [{ id: "custom", name: "Mine", method: "crc", scope: "all" }],
    defaults: { activePresetId: "custom", pinnedPresetIds: ["custom"] } });
  await folders.pair("one.txt", "same", "same");
  await folders.open(page);
  await manage(page);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete preset", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(run(page)).toBeVisible();
  await expect(status(page)).toContainText("unavailable active preset was reset");
  expect(host.calls).toHaveLength(0);
});

test("invalid saved references show a warning and initialize a safe non-running choice", async ({ page, folders }) => {
  const host = await presetHost(page, { library: [], defaults: { activePresetId: "deleted", pinnedPresetIds: ["deleted"] } });
  await folders.pair("one.txt", "same", "same");
  await folders.open(page);
  await expect(status(page)).toContainText("Unavailable comparison presets");
  await expect(run(page)).toBeVisible();
  expect(host.calls).toHaveLength(0);
});

test("legacy dialog keeps its popup preference separate from quick presets", async ({ page, folders }) => {
  const host = await presetHost(page);
  await folders.pair("one.txt", "same", "same");
  await folders.open(page);
  await page.locator(".frow").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Compare Contents…", exact: true }).click();
  await page.getByLabel("Show results dialog", { exact: true }).check();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByText("Compare Contents Results", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await run(page).click();
  await expect.poll(() => host.calls.length).toBe(2);
  await expect(status(page)).toContainText("Compared 1 file(s)");
  await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  expect(host.calls).toHaveLength(2);
});

test("keyboard menus restore focus and long pinned presets overflow without horizontal scrolling", async ({ page, folders }) => {
  const library = Array.from({ length: 8 }, (_, i) => ({ id: `pin-${i}`, name: `Long named comparison preset number ${i}`, method: "binary" as const, scope: "all" as const }));
  const host = await presetHost(page, { library, defaults: { activePresetId: "builtin:all:rules", pinnedPresetIds: library.map((p) => p.id) } });
  await folders.pair("one.txt", "same", "same");
  await page.setViewportSize({ width: 1153, height: 768 });
  await folders.open(page);
  const dropdown = page.getByRole("button", { name: "Choose comparison preset", exact: true });
  await dropdown.focus();
  await page.keyboard.press("ArrowDown");
  await expect(dropdown).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(dropdown).toBeFocused();
  const more = page.getByRole("button", { name: "More pinned comparison presets", exact: true });
  await more.click();
  await page.getByRole("menuitem", { name: /^Long named comparison preset number 7 / }).click();
  await expect.poll(() => host.calls.length).toBe(1);
  await expect(run(page)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("preset-toolbar.png") });
  for (const width of [480, 1153, 1920]) {
    await page.setViewportSize({ width, height: 768 });
    await expect(dropdown).toBeVisible();
    const overflow = await page.locator(".toolbar").evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflow).toBe(false);
  }
  const pin = page.getByRole("button", { name: /^Run pinned Long named comparison preset number 0 / });
  await expect(pin).toBeVisible();
  await expect(pin).toBeEnabled();
  await pin.click();
  await expect.poll(() => host.calls.length).toBe(2);
  await expect(run(page)).toBeEnabled();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 480, height: 768 });
  await manage(page);
  await expect(page.locator(".modal")).toBeVisible();
  expect(await page.locator(".modal").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  await page.screenshot({ path: test.info().outputPath("preset-editor-dark-narrow.png") });
});

test("quick comparison uses real file paths while the existing host still reads fixture bytes", async ({ page, folders }) => {
  const host = await presetHost(page);
  await folders.pair("one.txt", "aaaa", "bbbb");
  host.quick(async ({ left, right }) => (await readFile(left)).equals(await readFile(right)) ? 1 : 11);
  await folders.open(page);
  await choose(page, "All included files", "Binary");
  await run(page).click();
  await expect(status(page)).toContainText("0 same, 0 similar, 1 different, 0 errors");
});

test("named sessions and restored workspaces retain their choice and pins independently of defaults", async ({ page, folders }) => {
  const host = await presetHost(page, {
    library: [{ id: "shared", name: "Shared CRC", method: "crc", scope: "selected" }],
    defaults: { activePresetId: "builtin:all:rules", pinnedPresetIds: ["shared"] },
  });
  await folders.pair("one.txt", "same", "same");
  await folders.open(page);
  await choose(page, "Selected items", "Binary");
  await expect.poll(() => host.sessions.filter((s) => !s.saved &&
    (s.options.comparisonPresets as { activePresetId?: string })?.activePresetId === "builtin:selected:binary").length).toBeGreaterThan(0);
  await page.getByRole("button", { name: /Save Session$/ }).click();
  await page.getByLabel("Session name:", { exact: true }).fill("Preset session");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect.poll(() => host.sessions.filter((s) => s.saved).length).toBe(1);
  const saved = host.sessions.find((s) => s.saved)!;
  expect(saved.options.comparisonPresets).toEqual({ activePresetId: "builtin:selected:binary", pinnedPresetIds: ["shared"] });
  expect((host.settings().comparisonPresets as ComparisonPresetSettings).defaults.activePresetId).toBe("builtin:all:rules");
  Object.assign(host.settings(), {
    workspaceLoad: "last",
    lastWorkspace: [{ kind: "folder", paths: [folders.left, folders.right], options: saved.options, sessionName: saved.name }],
  });
  await page.goto("/tests/ui/");
  await expect(page.getByRole("button", { name: /^Run Compare Selected: Binary / })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Run Compare Selected: Binary / })).toBeDisabled();
  expect(host.calls).toHaveLength(0);
});

test("filter-scan failures are visible and never permit excluded files", async ({ page, folders }) => {
  const host = await presetHost(page);
  await folders.pair("one.txt", "same", "same");
  await folders.open(page);
  await page.getByRole("button", { name: /Peek$/ }).click();
  await expect(run(page)).toBeEnabled();
  await page.route("**/test-invoke", async (route) => {
    const request = route.request().postDataJSON();
    if (request.cmd === "compare_folders" && request.args.options.criteria === "size")
      return route.fulfill({ status: 500, json: { error: "Filter scan unavailable" } });
    await route.fallback();
  });
  await run(page).click();
  await expect(status(page)).toContainText("Content comparison failed: Filter scan unavailable");
  await expect(run(page)).toBeEnabled();
  expect(host.calls).toHaveLength(0);
});

test("missing snapshot bytes are explicitly rejected without claiming a content verdict", async ({ page, folders }) => {
  const host = await presetHost(page);
  await folders.pair("one.txt", "same", "same", false);
  await folders.open(page);
  await page.route("**/test-invoke", async (route) => {
    const request = route.request().postDataJSON();
    if (request.cmd === "path_info") return route.fulfill({ json: { exists: true, isDir: false, size: 0, modified: null, kind: "text" } });
    await route.fallback();
  });
  await run(page).click();
  await expect(status(page)).toContainText("Snapshot content cannot be compared");
  await expect(page.locator(".frow .fstatus")).toHaveText("≠");
  expect(host.calls).toHaveLength(0);
});

test("stored preset normalization validates enums, names, IDs, and missing references", () => {
  const preset = { id: "custom", name: "Mine", method: "crc" as const, scope: "all" as const };
  expect(presetLibraryError([preset, { ...preset, id: "different", name: " mine " }])).toContain("names must be unique");
  const normalized = normalizePresetSettings({
    library: [preset, { ...preset, id: "second", method: "invalid" }, { ...preset, id: "third", name: "MINE" }],
    defaults: { activePresetId: "missing", pinnedPresetIds: ["custom", "custom", "missing"] },
  });
  expect(normalized.value.library).toEqual([preset]);
  expect(normalized.value.defaults).toEqual({ activePresetId: "builtin:all:rules", pinnedPresetIds: ["custom"] });
  expect(normalized.warnings.length).toBeGreaterThan(0);
  expect(resolvePresetState({ activePresetId: "builtin:all:crc", pinnedPresetIds: [] }, BUILTIN_PRESETS).warning).toBeUndefined();
  expect(normalizePresetSettings(undefined).warnings).toEqual([]);
});

test("the compare button's right border stays above the overlapping dropdown on hover and focus", async ({ page, folders }) => {
  await presetHost(page);
  await folders.pair("one.txt", "same", "same");
  await folders.open(page);
  const button = run(page);
  const borderIsVisible = () => button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.right - 0.5, r.top + r.height / 2));
  });
  await button.hover();
  expect(await borderIsVisible()).toBe(true);
  await page.mouse.move(0, 0);
  await page.getByRole("button", { name: "Choose comparison preset", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(button).toBeFocused();
  expect(await borderIsVisible()).toBe(true);
});
