import { test, expect, folderTab } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import type { FolderComparisonProgress, Session } from "../../src/api";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function sendFolderProgress(page: Page, payload: FolderComparisonProgress) {
  await page.evaluate((payload) => window.dispatchEvent(new CustomEvent("comparecraft-test-event", {
    detail: { name: "folder-comparison-progress", payload },
  })), payload);
}

async function holdFolderComparisons(page: Page) {
  const pending: { requestId: string; release: () => void; finished: Promise<void> }[] = [];
  await page.route("**/test-invoke", async (route) => {
    const { cmd, args } = route.request().postDataJSON();
    if (cmd !== "compare_folders") { await route.fallback(); return; }
    const response = await route.fetch();
    let release!: () => void;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    pending.push({ requestId: args.requestId, release, finished });
    try { await gate; await route.fulfill({ response }); }
    finally { finish(); }
  });
  return pending;
}

test("folder progress shows scanning then completed files and clears on success", async ({ page, folders }, testInfo) => {
  test.slow();
  await folders.pair("same.txt", "same", "same");
  const pending = await holdFolderComparisons(page);
  await page.setViewportSize({ width: 1536, height: 864 });
  await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind: "folder", paths: [folders.left, folders.right] }))}`);
  const bar = page.getByRole("progressbar", { name: "Folder comparison progress" });
  try {
    await expect(bar).toBeVisible();
    await expect(page.locator(".folder-progress-label")).toHaveText("Scanning folders...");
    await expect(bar).not.toHaveAttribute("value", /.+/);
    await expect.poll(() => pending.length).toBe(1);
    const requestId = pending[0].requestId;
    expect(requestId).toBeTruthy();
    await sendFolderProgress(page, { requestId, phase: "scanning", completed: 0, total: null, discovered: 4 });
    await expect(page.locator(".folder-progress-count")).toHaveText("4 files found");
    await sendFolderProgress(page, { requestId, phase: "comparing", completed: 2, total: 4, discovered: 4 });
    await expect(bar).toHaveAttribute("value", "2");
    await expect(bar).toHaveAttribute("max", "4");
    await expect(page.locator(".folder-progress-count")).toHaveText("2 / 4 files");
    await sendFolderProgress(page, { requestId: "another-session", phase: "comparing", completed: 9, total: 10, discovered: 10 });
    await expect(bar).toHaveAttribute("value", "2");
    await page.screenshot({ path: testInfo.outputPath("folder-progress-desktop.png") });
    await page.setViewportSize({ width: 480, height: 800 });
    await expect(bar).toBeVisible();
    const fits = await page.locator(".folder-progress").evaluate((strip) => {
      const bounds = strip.getBoundingClientRect();
      return [...strip.children].every((child) => {
        const box = child.getBoundingClientRect();
        return box.left >= bounds.left && box.right <= bounds.right;
      });
    });
    expect(fits).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("folder-progress-mobile.png") });
    pending[0].release();
    await pending[0].finished;
    await expect(bar).toHaveCount(0);
    await expect(page.locator(".frow")).toHaveCount(1);
  } finally { pending.forEach((request) => request.release()); }
});

test("folder progress handles an empty comparison without an invalid percentage", async ({ page, folders }) => {
  const pending = await holdFolderComparisons(page);
  await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind: "folder", paths: [folders.left, folders.right] }))}`);
  try {
    await expect.poll(() => pending.length).toBe(1);
    await sendFolderProgress(page, { requestId: pending[0].requestId, phase: "comparing", completed: 0, total: 0, discovered: 0 });
    await expect(page.locator(".folder-progress-count")).toHaveText("0 / 0 files");
    await expect(page.getByRole("progressbar")).toHaveAttribute("max", "1");
    pending[0].release();
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await expect(page.locator(".tab-view:visible .statusbar")).toContainText("0 files");
  } finally { pending.forEach((request) => request.release()); }
});

test("folder progress clears when comparison fails", async ({ page, folders }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/test-invoke", async (route) => {
    if (route.request().postDataJSON().cmd !== "compare_folders") { await route.fallback(); return; }
    await gate;
    await route.fulfill({ status: 500, json: { error: "Folder access denied" } });
  });
  await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind: "folder", paths: [folders.left, folders.right] }))}`);
  try {
    await expect(page.getByRole("progressbar")).toBeVisible();
    release();
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await expect(page.locator(".banner.err")).toHaveText("Folder access denied");
  } finally { release(); }
});

test("folder progress ignores superseded requests and closing tabs", async ({ page, folders }) => {
  await folders.pair("same.txt", "same", "same");
  await folders.open(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const pending = await holdFolderComparisons(page);
  try {
    await page.keyboard.press("F5");
    await expect.poll(() => pending.length).toBe(1);
    await sendFolderProgress(page, { requestId: pending[0].requestId, phase: "comparing", completed: 1, total: 9, discovered: 9 });
    await expect(page.locator(".folder-progress-count")).toHaveText("1 / 9 files");
    await page.keyboard.press("F5");
    await expect.poll(() => pending.length).toBe(2);
    expect(pending[1].requestId).not.toBe(pending[0].requestId);
    await sendFolderProgress(page, { requestId: pending[1].requestId, phase: "comparing", completed: 2, total: 5, discovered: 5 });
    await sendFolderProgress(page, { requestId: pending[0].requestId, phase: "comparing", completed: 8, total: 9, discovered: 9 });
    await expect(page.locator(".folder-progress-count")).toHaveText("2 / 5 files");
    pending[0].release();
    await pending[0].finished;
    await expect(page.locator(".folder-progress-count")).toHaveText("2 / 5 files");
    await folderTab(page).locator(".tab-close").click();
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await sendFolderProgress(page, { requestId: pending[1].requestId, phase: "comparing", completed: 5, total: 5, discovered: 5 });
    pending[1].release();
    await pending[1].finished;
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { pending.forEach((request) => request.release()); }
});

async function expectNames(names: Locator, expected: string[]) {
  await expect.poll(() => names.evaluateAll((entries) => entries.map((entry) => Array.from(entry.childNodes)
    .filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent).join("").trim()))).toEqual(expected);
}

async function sortingPersistence(page: Page) {
  const state = {
    settings: {} as Record<string, unknown>,
    sessions: [] as (Omit<Session, "options"> & { options: Record<string, unknown> })[],
    finds: 0,
    saves: 0,
    failSave: false,
  };
  await page.route("**/test-invoke", async (route) => {
    const { cmd, args } = route.request().postDataJSON();
    let result: unknown;
    if (cmd === "load_settings") result = state.settings;
    else if (cmd === "save_settings") { state.settings = args.settings; result = null; }
    else if (cmd === "list_sessions") result = state.sessions;
    else if (cmd === "find_session") {
      state.finds++;
      result = state.sessions.find((session) => session.saved && session.name.toLowerCase() === String(args.name).toLowerCase()) ?? null;
    }
    else if (cmd === "save_session") {
      state.saves++;
      if (state.failSave) { await route.fulfill({ status: 500, json: { error: "Session storage unavailable" } }); return; }
      const session = args.session as typeof state.sessions[number];
      state.sessions = [...state.sessions.filter((item) => item.id !== session.id
        && !(session.saved && item.saved && item.name.toLowerCase() === session.name.toLowerCase())), session];
      result = null;
    } else { await route.continue(); return; }
    await route.fulfill({ json: result });
  });
  return state;
}

test("session save split button prompts once, updates in place, and offers confirmed Save As", async ({ page, folders }) => {
  const state = await sortingPersistence(page);
  await page.addInitScript(() => {
    const target = window as Window & { __comparecraftAsks?: string[]; __comparecraftMessages?: string[] };
    target.__comparecraftAsks = [];
    target.__comparecraftMessages = [];
    window.addEventListener("comparecraft-test-ask", (event) => target.__comparecraftAsks?.push((event as CustomEvent<{ text: string }>).detail.text));
    window.addEventListener("comparecraft-test-message", (event) => target.__comparecraftMessages?.push((event as CustomEvent<{ text: string }>).detail.text));
  });
  await folders.pair("same.txt", "same", "same");
  await folders.open(page);
  const recentWrites = state.saves;
  const save = page.locator(".session-save-split > button").first();
  const menuButton = page.getByRole("button", { name: "More session save options" });
  await expect(save).toBeEnabled();
  await save.click();
  const prompt = page.locator(".modal").filter({ hasText: "Save Session As" });
  await expect(prompt).toBeVisible();
  await prompt.getByLabel("Session name:").fill("Primary comparison");
  await prompt.getByRole("button", { name: "OK", exact: true }).click();
  await expect.poll(() => state.sessions.filter((session) => session.saved).length).toBe(1);
  const original = state.sessions.find((session) => session.saved)!;
  expect(original.name).toBe("Primary comparison");
  expect(original.id).toBeTruthy();

  await save.click();
  await expect(page.locator(".modal").filter({ hasText: "Save Session As" })).toHaveCount(0);
  await expect.poll(() => state.saves).toBe(recentWrites + 2);
  expect(state.sessions.filter((session) => session.saved)).toHaveLength(1);
  expect(state.sessions.find((session) => session.saved)?.id).toBe(original.id);

  state.sessions.push({ ...original, id: "other-session", name: "Other comparison", modified: original.modified - 1 });
  await page.evaluate(() => { (window as Window & { __comparecraftAskResult?: boolean }).__comparecraftAskResult = false; });
  await menuButton.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Save Session", exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Save Session As…", exact: true }).click();
  const saveAs = page.locator(".modal").filter({ hasText: "Save Session As" });
  await saveAs.getByLabel("Session name:").fill("other comparison");
  await saveAs.getByRole("button", { name: "OK", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __comparecraftAsks?: string[] }).__comparecraftAsks)).toContain("A saved session named “Other comparison” already exists. Replace it?");
  expect(state.sessions.find((session) => session.id === "other-session")?.name).toBe("Other comparison");
  await page.evaluate(() => { (window as Window & { __comparecraftAskResult?: boolean }).__comparecraftAskResult = true; });
  await menuButton.click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Save Session As…", exact: true }).click();
  const confirmedSaveAs = page.locator(".modal").filter({ hasText: "Save Session As" });
  await confirmedSaveAs.getByLabel("Session name:").fill("other comparison");
  const savesBeforeReplacement = state.saves;
  await confirmedSaveAs.getByRole("button", { name: "OK", exact: true }).click();
  await expect.poll(() => state.saves).toBe(savesBeforeReplacement + 1);
  expect(state.sessions.find((session) => session.name === "other comparison")?.id).toBe("other-session");
  await expect(page.locator(".tab.active")).toContainText("other comparison");
  state.failSave = true;
  const savedBeforeFailure = { ...state.sessions.find((session) => session.id === "other-session")! };
  const savesBeforeFailure = state.saves;
  await page.locator(".session-save-split > button").first().click();
  await expect.poll(() => state.saves).toBe(savesBeforeFailure + 1);
  await expect.poll(() => page.evaluate(() => (window as Window & { __comparecraftMessages?: string[] }).__comparecraftMessages)).toContain("Session storage unavailable");
  expect(state.sessions.find((session) => session.id === "other-session")).toEqual(savedBeforeFailure);
});

test("refreshing and changing bases never replaces a named session with an automatic recent", async ({ page, folders }) => {
  const state = await sortingPersistence(page);
  await folders.pair("same.txt", "same", "same");
  await folders.open(page);
  await page.locator(".session-save-split > button").first().click();
  const prompt = page.locator(".modal").filter({ hasText: "Save Session As" });
  await prompt.getByLabel("Session name:").fill("Keep this comparison");
  await prompt.getByRole("button", { name: "OK", exact: true }).click();
  await expect.poll(() => state.sessions.filter((session) => session.saved).length).toBe(1);
  const saved = structuredClone(state.sessions.find((session) => session.saved)!);
  const replacement = join(folders.right, "replacement");
  await mkdir(replacement);
  await writeFile(join(replacement, "same.txt"), "changed");
  const rightPath = page.locator(".tab-view:visible .path-input").nth(1);
  const savesBefore = state.saves;
  await rightPath.fill(replacement);
  await rightPath.press("Enter");
  await expect.poll(() => state.saves).toBeGreaterThan(savesBefore);
  expect(state.sessions.find((session) => session.id === saved.id)).toEqual(saved);
  expect(state.sessions.find((session) => !session.saved && session.paths[1] === replacement)?.id).not.toBe(saved.id);
  await page.keyboard.press("F5");
  await expect(page.locator(".tab-view:visible .statusbar")).toContainText("1 different");
  expect(state.sessions.find((session) => session.id === saved.id)).toEqual(saved);
});

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
