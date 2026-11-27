import type { Page } from "@playwright/test";
import { join } from "node:path";
import { test, expect } from "./fixtures";

async function settingsHost(page: Page, initial: Record<string, unknown> = {}) {
  let settings = initial;
  await page.route("**/test-invoke", (route) => {
    const { cmd, args } = route.request().postDataJSON();
    if (cmd === "load_settings") return route.fulfill({ json: settings });
    if (cmd === "save_settings") {
      settings = args.value ?? args.settings;
      return route.fulfill({ json: null });
    }
    return route.continue();
  });
  return () => settings;
}

const open = (page: Page, kind: string, paths: string[]) => page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind, paths }))}`);

const sentence = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `word${i}`).join(" ") + tag;

/** Per pane: [top, height] of every rendered row, in document order. */
const rowBoxes = (page: Page) =>
  page.locator(".tab-view:visible .tpane").evaluateAll((panes) =>
    panes.map((pane) => [...pane.querySelectorAll<HTMLElement>(".trow")].map((row) => [row.offsetTop, row.offsetHeight])),
  );

test("text compare wraps long lines by default, keeps both sides aligned and toggles with Alt+Z", async ({ page, folders }) => {
  await settingsHost(page);
  const left = ["short", sentence(120, " LEFT-END"), "middle", sentence(80), "tail"];
  const right = ["short", sentence(120, " RIGHT-END"), "middle", "tail"];
  await folders.pair("wrap.txt", left.join("\n"), right.join("\n"));
  await page.setViewportSize({ width: 1200, height: 800 });
  await open(page, "text", [join(folders.left, "wrap.txt"), join(folders.right, "wrap.txt")]);
  const panes = page.locator(".tab-view:visible .tpane");
  await expect(panes.first().locator(".trow").first()).toBeVisible({ timeout: 15000 });
  await expect(panes.first()).toHaveClass(/wrapped/);

  for (const pane of await panes.all()) expect(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const rowH = await panes.first().locator(".trow").first().evaluate((el) => (el as HTMLElement).offsetHeight);
  const [l, r] = await rowBoxes(page);
  expect(l).toEqual(r);
  expect(l[1][1]).toBeGreaterThan(rowH * 2);
  // The left-only long line has a filler opposite it that is just as tall.
  expect(l.some(([, h], i) => i !== 1 && h > rowH)).toBe(true);
  await expect(panes.last().locator(".hl", { hasText: "RIGHT" })).toBeVisible();

  await panes.first().locator(".trow").nth(1).click();
  const details = page.locator(".tab-view:visible .details");
  await expect(details).toHaveClass(/wrapped/);
  expect(await details.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(details.getByText("LEFT-END")).toBeVisible();

  await page.keyboard.press("Alt+z");
  await expect(panes.first()).not.toHaveClass(/wrapped/);
  expect(await panes.first().evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const [l2] = await rowBoxes(page);
  expect(l2.every(([, h]) => h === rowH)).toBe(true);
});

test("global default off is respected and navigation lands on wrapped rows", async ({ page, folders }) => {
  await settingsHost(page, { textWordWrap: false });
  const left = Array.from({ length: 200 }, (_, i) => `${i}: ${sentence(60)}`);
  const right = left.map((line, i) => (i === 150 ? `${line} CHANGED` : line));
  await folders.pair("nav.txt", left.join("\n"), right.join("\n"));
  await page.setViewportSize({ width: 1200, height: 800 });
  await open(page, "text", [join(folders.left, "nav.txt"), join(folders.right, "nav.txt")]);
  const panes = page.locator(".tab-view:visible .tpane");
  await expect(panes.first().locator(".trow").first()).toBeVisible({ timeout: 15000 });
  await expect(panes.first()).not.toHaveClass(/wrapped/);

  await page.getByRole("button", { name: /Wrap/ }).click();
  await expect(panes.first()).toHaveClass(/wrapped/);
  await page.keyboard.press("Control+n");
  const changed = panes.last().locator(".hl", { hasText: "CHANGED" });
  await expect(changed).toBeVisible();
  const [pane, hit] = [await panes.last().boundingBox(), await changed.boundingBox()];
  expect(hit!.y).toBeGreaterThanOrEqual(pane!.y);
  expect(hit!.y + hit!.height).toBeLessThanOrEqual(pane!.y + pane!.height);
  const [l, r] = await rowBoxes(page);
  expect(l).toEqual(r);
});

test("text merge and text edit wrap long lines", async ({ page, folders }) => {
  await settingsHost(page);
  await folders.pair("m.txt", ["a", sentence(150), "c"].join("\n"), ["a", sentence(150), "C"].join("\n"));
  await folders.pair("base.txt", ["a", sentence(150), "c"].join("\n"), "");
  await page.setViewportSize({ width: 1200, height: 800 });
  await open(page, "merge", [join(folders.left, "m.txt"), join(folders.right, "m.txt"), join(folders.left, "base.txt")]);
  const top = page.locator(".tab-view:visible .mtop");
  await expect(top.locator(".mrow").first()).toBeVisible({ timeout: 15000 });
  await expect(top).toHaveClass(/wrapped/);
  await expect(top.locator(".seg").first()).toBeVisible();
  const boxes = await top.locator(".mrow").evaluateAll((rows) => rows.map((row) => [(row as HTMLElement).offsetTop, (row as HTMLElement).offsetHeight]));
  for (let i = 1; i < boxes.length; i++) expect(boxes[i][0]).toBe(boxes[i - 1][0] + boxes[i - 1][1]);
  expect(await top.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.locator(".tab-view:visible .mbottom .seg").first()).toBeVisible();

  await open(page, "edit", [join(folders.left, "m.txt")]);
  const area = page.locator(".tab-view:visible textarea.text-edit");
  await expect(area).toHaveValue(/word149/);
  await expect(area).toHaveAttribute("wrap", "soft");
  expect(await area.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByRole("button", { name: /Wrap/ }).click();
  await expect(area).toHaveAttribute("wrap", "off");
  expect(await area.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});
