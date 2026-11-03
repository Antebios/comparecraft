import { test, expect, folderTab } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import type { Session } from "../../src/api";

async function expectNames(names: Locator, expected: string[]) {
  await expect.poll(() => names.evaluateAll((entries) => entries.map((entry) => Array.from(entry.childNodes)
    .filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent).join("").trim()))).toEqual(expected);
}

async function sortingPersistence(page: Page) {
  const state = { settings: {} as Record<string, unknown>, sessions: [] as (Omit<Session, "options"> & { options: Record<string, unknown> })[] };
  await page.route("**/test-invoke", async (route) => {
    const { cmd, args } = route.request().postDataJSON();
    let result: unknown;
    if (cmd === "load_settings") result = state.settings;
    else if (cmd === "save_settings") { state.settings = args.settings; result = null; }
    else if (cmd === "list_sessions") result = state.sessions;
    else if (cmd === "find_session") result = state.sessions.find((session) => session.name === args.name) ?? null;
    else if (cmd === "save_session") {
      state.sessions = [...state.sessions.filter((session) => session.id !== args.session.id), args.session];
      result = null;
    } else { await route.continue(); return; }
    await route.fulfill({ json: result });
  });
  return state;
}

async function openSorting(page: Page) {
  await page.locator('button[title^="Edit file filters"]').click();
  const dialog = page.locator(".modal");
  await dialog.getByRole("button", { name: "Handling", exact: true }).click();
  return dialog;
}

async function globalSorting(page: Page, enabled: boolean) {
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText(/^Options/).click();
  const dialog = page.getByRole("dialog", { name: "Options", exact: true });
  await dialog.getByRole("button", { name: "Colors, Fonts", exact: true }).click();
  await dialog.getByLabel("Dot-prefixed names first", { exact: true }).setChecked(enabled);
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
}

test("dot sorting groups directories before files and updates only inheriting sessions", async ({ page, folders }) => {
  test.slow();
  const state = await sortingPersistence(page);
  for (const name of ["api/a.txt", ".github/workflow.yml", ".streamlit/config.toml", ".vscode/settings.json", ".git", ".env", "app.yml", "README.md"]) {
    await folders.pair(name, "same", "same");
  }
  await folders.open(page);
  const names = page.locator(".frow .fside:first-child .fname");
  const first = [".github", ".streamlit", ".vscode", "api", ".env", ".git", "app.yml", "README.md"];
  const alphabetical = ["api", ".github", ".streamlit", ".vscode", "app.yml", ".env", ".git", "README.md"];
  await expectNames(names, first);
  await expectNames(page.locator(".frow .fside:last-child .fname"), first);
  await globalSorting(page, false);
  await expectNames(names, alphabetical);
  let dialog = await openSorting(page);
  const choice = () => dialog.getByLabel(/^Dot-prefixed names:/);
  await expect(choice()).toHaveValue("inherit");
  await choice().selectOption("first");
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expectNames(names, first);
  await globalSorting(page, true);
  await globalSorting(page, false);
  await expectNames(names, first);
  dialog = await openSorting(page);
  await expect(choice()).toHaveValue("first");
  await choice().selectOption("alphabetical");
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expectNames(names, alphabetical);
  await globalSorting(page, true);
  await expectNames(names, alphabetical);
  dialog = await openSorting(page);
  await choice().selectOption("inherit");
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expectNames(names, first);
  await expect.poll(() => state.settings.folderDotNamesFirst).toBe(true);
  await page.reload();
  await expectNames(names, first);
});

test("dot sorting overrides survive named save and reopen", async ({ page, folders }) => {
  const state = await sortingPersistence(page);
  await folders.pair("api/a.txt", "same", "same");
  await folders.pair(".vscode/settings.json", "same", "same");
  await folders.open(page);
  const dialog = await openSorting(page);
  await dialog.getByLabel(/^Dot-prefixed names:/).selectOption("alphabetical");
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await page.locator('.toolbar button').filter({ hasText: "Save Session" }).click();
  await page.getByLabel("Session name:").fill("Dot order regression");
  await page.locator(".prompt-form").getByRole("button", { name: "OK", exact: true }).click();
  await expect.poll(() => state.sessions.find((session) => session.saved)?.options.folderView).toMatchObject({ dotNameOrder: "alphabetical" });
  const spec = { kind: "session", session: "Dot order regression", paths: [] };
  await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify(spec))}`);
  await expectNames(page.locator(".frow .fside:first-child .fname"), ["api", ".vscode"]);
  const reopened = await openSorting(page);
  await expect(reopened.getByLabel(/^Dot-prefixed names:/)).toHaveValue("alphabetical");
  await reopened.getByRole("button", { name: "Cancel", exact: true }).click();
  const saved = state.sessions.find((session) => session.saved)!;
  delete saved.options.folderView;
  await page.reload();
  await expectNames(page.locator(".frow .fside:first-child .fname"), [".vscode", "api"]);
});

test("dot sorting session defaults update the global preference", async ({ page, folders }) => {
  const state = await sortingPersistence(page);
  await folders.pair("api/a.txt", "same", "same");
  await folders.pair(".vscode/settings.json", "same", "same");
  await folders.open(page);
  const dialog = await openSorting(page);
  await dialog.getByLabel(/^Dot-prefixed names:/).selectOption("alphabetical");
  await dialog.locator(".modal-foot select").selectOption("defaults");
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect.poll(() => state.settings.folderDotNamesFirst).toBe(false);
  await page.reload();
  await expectNames(page.locator(".frow .fside:first-child .fname"), ["api", ".vscode"]);
  const inherited = await openSorting(page);
  await expect(inherited.getByLabel(/^Dot-prefixed names:/)).toHaveValue("inherit");
});

test("dot sorting ignores a stale refresh using the old global preference", async ({ page, folders }) => {
  await sortingPersistence(page);
  await folders.pair("api/a.txt", "same", "same");
  await folders.pair(".vscode/settings.json", "same", "same");
  await folders.open(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  await page.route("**/test-invoke", async (route) => {
    const request = route.request().postDataJSON();
    if (request.cmd === "compare_folders" && request.args.options.dotNamesFirst && !held) {
      held = true;
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    } else await route.fallback();
  });
  await page.keyboard.press("F5");
  await expect.poll(() => held).toBe(true);
  try {
    await globalSorting(page, false);
    await expectNames(page.locator(".frow .fside:first-child .fname"), ["api", ".vscode"]);
    const staleResponse = page.waitForResponse((response) => {
      const request = response.request().postDataJSON();
      return request?.cmd === "compare_folders" && request.args.options.dotNamesFirst;
    });
    release();
    await (await staleResponse).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expectNames(page.locator(".frow .fside:first-child .fname"), ["api", ".vscode"]);
  } finally { release(); }
});

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
