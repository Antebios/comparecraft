// Remote smoke checks (Remote-SSH, Dev Containers), run in the remote extension host by
// scripts/test-remote.cjs. The remote extension host doesn't inherit the runner's environment and its
// console stays on the remote host, so the runner writes remote-test.json into the workspace and reads
// remote-test.log and remote-test.result back.
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { TestApi } from "../src/activate";
import type { EmbeddedPanel } from "../src/embedded";

interface Expectations {
  /** `vscode.env.remoteName`, for example "ssh-remote". */
  readonly remoteName: string;
  /** The window's remote authority, for example "ssh-remote+cc-remote-test". */
  readonly authority: string;
  /** How the environment is described, for example "a window connected to an SSH host". */
  readonly environment: string;
}

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) throw new Error("The runner opens the remote workspace folder.");
  const log = (line: string) => appendFile(path.join(folder, "remote-test.log"), `${line}\n`);
  const result = path.join(folder, "remote-test.result");
  try {
    await checks(folder, log);
  } catch (error) {
    await log(`FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    await writeFile(result, "fail");
    throw error;
  }
  await writeFile(result, "pass");
}

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, timeout = 30000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function checks(folder: string, log: (line: string) => Promise<void>): Promise<void> {
  const expected = JSON.parse(await readFile(path.join(folder, "remote-test.json"), "utf8")) as Expectations;
  assert.equal(vscode.env.remoteName, expected.remoteName);
  const extension = vscode.extensions.all.find(candidate => candidate.packageJSON.name === "comparecraft");
  assert.ok(extension, "the extension is installed");
  assert.equal(extension.extensionKind, vscode.ExtensionKind.Workspace, "runs beside the workspace");
  assert.equal(process.platform, "linux");
  const api = (await extension.activate()) as TestApi;
  assert.ok(api?.embedded, "test-mode activation exposes the panels");

  const helper = path.join(extension.extensionPath, "bin", "comparecraft-backend");
  const check = await vscode.commands.executeCommand<{ engine: string; executable?: string; version: string; environment: string } | undefined>("comparecraft.checkBackend");
  assert.equal(check?.engine, "helper", "the bundled helper runs on the remote host");
  assert.equal(await realpath(check.executable!), await realpath(helper));
  assert.equal(check.environment, expected.environment);
  await log(`PASS: activated in the ${expected.remoteName} extension host; the bundled helper ${check.version} runs there (${helper}).`);

  assert.match(api.denial("desktop")?.reason ?? "", /connected to/);
  assert.ok(api.denial("revealInOS"), "the local file manager can't show remote files");
  for (const operation of ["save", "git", "folder"] as const) assert.equal(api.denial(operation), undefined, operation);

  const opened = (before: Set<EmbeddedPanel>) => until("a new panel", () => api.embedded.all.find(panel => !before.has(panel)));
  const work = path.join(folder, "compare");
  await mkdir(path.join(work, "left"), { recursive: true });
  await mkdir(path.join(work, "right"), { recursive: true });
  const a = path.join(work, "left", "a.txt"), b = path.join(work, "right", "a.txt");
  await writeFile(a, "one\ntwo\n");
  await writeFile(b, "one\nthree\n");
  await writeFile(path.join(work, "left", "only.txt"), "left\n");

  let before = new Set(api.embedded.all);
  await vscode.commands.executeCommand("comparecraft.compareSelectedEmbedded", vscode.Uri.file(a), [vscode.Uri.file(a), vscode.Uri.file(b)]);
  const text = await opened(before);
  assert.deepEqual(text.state.spec.paths, [a, b], "sides are paths on the remote host");
  await until("the helper diff", () => text.received.includes("diff_texts"));
  const invoke = (panel: EmbeddedPanel, cmd: string, args: Record<string, unknown>) => panel.handle("invoke", { cmd, args });
  const loaded = await invoke(text, "load_text", { path: a }) as { lines: string[]; readOnly: boolean };
  assert.deepEqual(loaded.lines, ["one", "two"]);
  assert.equal(loaded.readOnly, false);
  await invoke(text, "save_text", { path: a, lines: ["one", "saved"], finalNewline: true });
  assert.equal(await readFile(a, "utf8"), "one\nsaved\n");
  assert.deepEqual(await text.handle("capabilities", {}), { desktop: false, revealInOS: false, restricted: false });
  // Explorer drops arrive as vscode-remote URIs and become paths on the remote host.
  assert.deepEqual(await text.handle("dropPaths", { uris: [`vscode-remote://${expected.authority}${b}`] }), [b]);
  text.panel.dispose();
  await log("PASS: embedded text comparison loads, diffs and saves remote files; Explorer drops become remote paths; the desktop app and the local file manager are unavailable.");

  const left = path.join(work, "left"), right = path.join(work, "right");
  before = new Set(api.embedded.all);
  await vscode.commands.executeCommand("comparecraft.compareSelectedEmbedded", vscode.Uri.file(left), [vscode.Uri.file(left), vscode.Uri.file(right)]);
  const folderPanel = await opened(before);
  assert.equal(folderPanel.state.spec.kind, "folder");
  await until("the folder scan", () => folderPanel.received.includes("compare_folders"));
  const options = { criteria: "binary", timeToleranceSecs: 2, include: "", exclude: "", ignoreCaseNames: false, followSymlinks: false };
  const scan = await invoke(folderPanel, "compare_folders", { left, right, options }) as { summary: { files: number; diff: number; leftOnly: number } };
  assert.equal(scan.summary.diff, 1);
  assert.equal(scan.summary.leftOnly, 1);
  folderPanel.panel.dispose();
  await log("PASS: embedded folder comparison scans remote folders with the bundled helper.");

  const git = promisify(execFile);
  const repo = path.join(folder, "repo");
  await mkdir(repo, { recursive: true });
  const tracked = path.join(repo, "tracked.txt");
  await writeFile(tracked, "base\n");
  for (const args of [["init", "-q"], ["add", "tracked.txt"], ["-c", "user.name=CompareCraft", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "base"]]) {
    await git("git", args, { cwd: repo });
  }
  await writeFile(tracked, "base\nchanged\n");
  before = new Set(api.embedded.all);
  await vscode.commands.executeCommand("comparecraft.gitCompareHead", vscode.Uri.file(tracked));
  const gitPanel = await opened(before);
  // HEAD is read-only content; the working file is the editable right side.
  assert.deepEqual(gitPanel.state.spec.paths, ["", tracked]);
  assert.deepEqual((gitPanel.state.spec.options.content as (string[] | null)[])[0], ["base"]);
  await until("the helper diff", () => gitPanel.received.includes("diff_texts"));
  gitPanel.panel.dispose();
  await log("PASS: Git compare with HEAD runs git on the remote host and opens an embedded comparison.");
}
