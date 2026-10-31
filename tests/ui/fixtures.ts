import { test as base, expect, type Page } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface Folders {
  left: string;
  right: string;
  pair(name: string, l: string | Buffer, r: string | Buffer, sameTime?: boolean): Promise<void>;
  open(page: Page): Promise<void>;
}

export const test = base.extend<{ folders: Folders }>({
  folders: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "comparecraft-ui-"));
    const left = join(directory, "left");
    const right = join(directory, "right");
    await Promise.all([mkdir(left), mkdir(right)]);
    try {
      await use({
        left, right,
        async pair(name, l, r, sameTime = true) {
          await Promise.all([left, right].map(async (dir, i) => {
            const path = join(dir, name);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, i === 0 ? l : r);
            await utimes(path, 1000, sameTime || i === 0 ? 1000 : 2000);
          }));
        },
        async open(page) {
          await page.goto(`/tests/ui/?spec=${encodeURIComponent(JSON.stringify({ kind: "folder", paths: [left, right] }))}`);
          await expect(page.locator(".frow").first()).toBeVisible();
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
});
export { expect };

export const folderTab = (page: Page) => page.locator(".tab").filter({ hasText: "Folder Compare" });
