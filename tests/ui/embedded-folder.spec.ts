import { test, expect, type Page } from "@playwright/test";

type Harness = { calls: { method: string; params?: Record<string, unknown> }[]; states: Record<string, unknown>[] };
const harness = (page: Page) => page.evaluate(() => (window as unknown as { harness: Harness }).harness);
test.setTimeout(60_000);

/** Mock only the platform transport: this exercises the actual bundled shared folder frontend. */
async function openFolder(page: Page, config: { failOpen?: boolean; failSave?: boolean; earlyReceipt?: boolean; locked?: boolean } = {}) {
  await page.addInitScript((config) => {
    const w = window as unknown as {
      acquireVsCodeApi: () => unknown;
      harness: Harness;
    };
    w.harness = { calls: [], states: [] };
    let state: unknown;
    let token = 0;
    const event = (name: string, payload: unknown) => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "event", event: name, payload },
    }));
    w.acquireVsCodeApi = () => ({
      getState: () => state,
      setState: (value: unknown) => { state = value; },
      postMessage: (m: { type: string; id?: number; method: string; params?: Record<string, unknown>; state?: Record<string, unknown> }) => {
        if (m.type === "state") { w.harness.states.push(m.state!); return; }
        w.harness.calls.push({ method: m.method, params: m.params });
        let result: unknown = null;
        let error: string | undefined;
        if (m.method === "init") result = {
          kind: "folder", paths: ["/left", "/right"], sessionId: "restored-id", sessionName: "Saved Folder",
          locked: !!config.locked, options: { folder: { criteria: "timesize" } },
        };
        if (m.method === "invoke") {
          const cmd = m.params?.cmd;
          const args = (m.params?.args ?? {}) as Record<string, unknown>;
          if (cmd === "load_settings") result = { openWith: [{ name: "Dangerous external", command: "external %F" }] };
          if (cmd === "list_sessions") result = [];
          if (cmd === "find_session") result = { id: "saved-id", name: "Saved Folder", kind: "folder", paths: ["/left", "/right"], options: {}, saved: true, locked: !!config.locked };
          if (cmd === "save_session" && config.failSave && (args.session as { saved: boolean }).saved) error = "Storage unavailable";
          if (cmd === "path_info") result = { path: args.path, exists: true, isDir: false, size: 5, modified: 1000, kind: "text" };
          if (cmd === "compare_folders") result = {
            root: {
              name: "", rel: "", dir: true, status: "diff",
              children: [{
                name: "pair.txt", rel: "pair.txt", dir: false, status: "diff",
                left: { name: "pair.txt", size: 5, modified: 1000 },
                right: { name: "pair.txt", size: 5, modified: 2000 },
              }],
            },
            summary: { files: 1, same: 0, similar: 0, diff: 1, leftOnly: 0, rightOnly: 0, errors: 0 },
          };
        }
        if (m.method === "openTab") {
          if (config.failOpen) error = "Child panel unavailable";
          else result = m.params?.origin ? { originToken: `token-${++token}` } : null;
        }
        queueMicrotask(() => {
          window.dispatchEvent(new MessageEvent("message", { data: { type: "response", id: m.id, ok: !error, result, error } }));
          if (m.method === "openTab" && config.earlyReceipt && result) event("folder-comparison", {
            token: (result as { originToken: string }).originToken,
            receipt: { paths: ["/left/pair.txt", "/right/pair.txt"], result: { status: "same", content: "same" } },
          });
        });
      },
    });
  }, config);
  await page.goto("/tests/ui/embedded.html");
  await expect(page.locator(".frow")).toBeVisible();
}

test("embedded folder hides deferred commands, nested external apps, shortcuts and snapshot settings", async ({ page }) => {
  await openFolder(page);
  await expect(page.getByText("Folder comparison reads saved files on disk.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Copy|Delete|Synchronize/ })).toHaveCount(0);
  await page.locator(".frow").click({ button: "right" });
  await expect(page.locator(".ctx-menu").getByText(/Copy to|Move to|Delete|Rename|Attributes|Touch|New Folder|Report|Synchronize/)).toHaveCount(0);
  await page.locator(".ctx-menu").getByText("Open With", { exact: true }).hover();
  await expect(page.getByText("Text Compare", { exact: true })).toBeVisible();
  await expect(page.getByText(/Dangerous external|Associated Application|File Manager|Folder Sync/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.locator(".frow").click();
  for (const key of ["Control+r", "Control+l", "Delete", "Shift+Delete", "F2", "Insert", "Control+Shift+r"]) await page.keyboard.press(key);
  expect((await harness(page)).calls.filter((c) => c.method === "invoke").some((c) => /execute|sync|spawn|report/.test(String(c.params?.cmd)))).toBe(false);
  await page.getByRole("button", { name: "Session", exact: true }).click();
  await expect(page.getByText(/Merge Base Folders|Sync Base Folders|Folder Compare Report/)).toHaveCount(0);
  await page.getByText("Session Settings…", { exact: true }).click();
  await expect(page.getByText(/snapshot file/)).toHaveCount(0);
});

test("folder reload state preserves identity/options/lock and desktop launch is explicit", async ({ page }) => {
  await openFolder(page, { locked: true });
  await expect.poll(async () => (await harness(page)).states.length).toBeGreaterThan(0);
  const states = (await harness(page)).states;
  expect(states.at(-1)).toMatchObject({
    kind: "folder", paths: ["/left", "/right"], readOnly: [true, true],
    sessionId: "restored-id", sessionName: "Saved Folder", locked: true,
    options: { folder: { criteria: "timesize" }, comparisonPresets: { activePresetId: expect.any(String), pinnedPresetIds: expect.any(Array) } },
  });
  expect(states.at(-1)).not.toHaveProperty("restore");
  expect(states.at(-1)).not.toHaveProperty("output");
  await page.getByRole("button", { name: "Session", exact: true }).click();
  await page.getByText("Session Settings…", { exact: true }).click();
  await expect(page.getByRole("option", { name: "Also update saved session" })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Open in Desktop App" }).click();
  expect((await harness(page)).calls.some((c) => c.method === "desktopFolder")).toBe(true);
});

test("host receipts update disk verdict repeatedly and stale/wrong-path completions are ignored", async ({ page }) => {
  await openFolder(page);
  await page.locator(".frow").dblclick();
  await expect.poll(async () => (await harness(page)).calls.filter((c) => c.method === "openTab").length).toBe(1);
  expect((await harness(page)).calls.find((c) => c.method === "openTab")?.params).toMatchObject({
    kind: "text", paths: ["/left/pair.txt", "/right/pair.txt"], origin: true, readOnly: [],
  });
  const receipt = async (status: string, paths = ["/left/pair.txt", "/right/pair.txt"]) => page.evaluate(({ status, paths }) => {
    window.dispatchEvent(new MessageEvent("message", { data: {
      type: "event", event: "folder-comparison", payload: { token: "token-1", receipt: { paths, result: { status } } },
    } }));
  }, { status, paths });
  await receipt("same", ["/wrong", "/right/pair.txt"]);
  await expect(page.locator(".frow .fstatus")).toHaveText("≠");
  await receipt("same");
  await expect(page.locator(".frow .fstatus")).toHaveText("=");
  await receipt("similar");
  await expect(page.locator(".frow .fstatus")).toHaveText("≈");
  await page.keyboard.press("F5");
  await expect(page.locator(".frow .fstatus")).toHaveText("≠");
  await receipt("same");
  await expect(page.locator(".frow .fstatus")).toHaveText("≠");
});

test("an early child completion is retained while its openTab response resolves", async ({ page }) => {
  await openFolder(page, { earlyReceipt: true });
  await page.locator(".frow").dblclick();
  await expect(page.locator(".frow .fstatus")).toHaveText("=");
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "event", event: "folder-origin-disposed", payload: { token: "token-1" },
  } })));
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "event", event: "folder-comparison",
    payload: { token: "token-1", receipt: { paths: ["/left/pair.txt", "/right/pair.txt"], result: { status: "diff" } } },
  } })));
  await expect(page.locator(".frow .fstatus")).toHaveText("=");
});

test("child open and named-session persistence errors are surfaced without success", async ({ page }) => {
  await openFolder(page, { failOpen: true, failSave: true });
  await page.locator(".frow").dblclick();
  await expect(page.getByRole("alert")).toContainText("Child panel unavailable");
  await page.getByRole("button", { name: "★ Save Session", exact: true }).click();
  await expect.poll(async () => (await harness(page)).calls.filter((c) => c.method === "message").length).toBeGreaterThan(1);
  expect((await harness(page)).calls.filter((c) => c.method === "message").map((c) => c.params?.message)).toContain("Storage unavailable");
  await expect(page.locator(".statusbar")).not.toContainText("Saved session");
  await page.getByRole("button", { name: "Session", exact: true }).click();
  await page.getByText("Session Settings…", { exact: true }).click();
  await page.locator(".modal-foot select").selectOption("saved");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.locator(".modal-backdrop")).toBeVisible();
  await expect(page.locator(".modal-backdrop").getByRole("alert")).toContainText("Storage unavailable");
});

test("settings broadcasts reload the shared library without overwriting folder session choices", async ({ page }) => {
  await openFolder(page);
  await expect.poll(async () => (await harness(page)).states.length).toBeGreaterThan(0);
  const before = (await harness(page)).states.at(-1);
  const loads = (await harness(page)).calls.filter((c) => c.params?.cmd === "load_settings").length;
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: "settings-changed" } })));
  await expect.poll(async () => (await harness(page)).calls.filter((c) => c.params?.cmd === "load_settings").length).toBe(loads + 1);
  expect((await harness(page)).states.at(-1)?.options).toEqual(before?.options);
});
