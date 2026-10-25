import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { desktopCandidates, discoverDesktop, InstallationError } from "../src/discovery";
import { ComparisonController, type ComparisonHost, type LaunchTracking } from "../src/controller";
import { comparisonArguments, launchDesktop } from "../src/process";
import type { LaunchMode, LocalResource, ResourceKind, SideInput } from "../src/contracts";
import { assertSavedResources } from "../src/resources";
import { SnapshotStore, type SnapshotSession } from "../src/snapshots";

const file = (name: string): LocalResource => ({ path: path.resolve(name), kind: "file" });
const folder = (name: string): LocalResource => ({ path: path.resolve(name), kind: "folder" });

class FakeHost implements ComparisonHost {
  mode: LaunchMode = "desktop";
  resources = new Map<string, LocalResource>();
  picks: (string | undefined)[] = [];
  launches: string[][] = [];
  embeddedAccepted = false;
  embeddedNotices = 0;
  dirty = false;
  trusted = true;
  leftContext = false;
  notices: string[] = [];
  buffers = new Map<string, string>();
  tracking: (LaunchTracking | undefined)[] = [];
  snapshotRoot = path.join(tmpdir(), `comparecraft-core-${process.pid}`);
  async bufferText(filePath: string) { return this.buffers.get(filePath); }
  async createSnapshots(): Promise<SnapshotSession> { return new SnapshotStore(this.snapshotRoot).create(); }
  assertSupported() { if (!this.trusted) throw new Error("Trust required"); }
  async resource(value: string) {
    const resource = this.resources.get(value);
    if (!resource) throw new Error("Missing resource");
    return resource;
  }
  async pick(_kind: ResourceKind, _title: string) { return this.picks.shift(); }
  defaultMode() { return this.mode; }
  async confirmDesktop() { this.embeddedNotices++; return this.embeddedAccepted; }
  embedded: string[][] = [];
  async openEmbedded(inputs: readonly SideInput[]) { this.embedded.push(inputs.map(input => input.kind === "path" ? input.path : `content:${input.name}`)); }
  assertSaved(_resources: readonly LocalResource[]) { if (this.dirty) throw new Error("Unsaved changes"); }
  async launch(args: readonly string[], tracking?: LaunchTracking) { this.launches.push([...args]); this.tracking.push(tracking); }
  async setHasLeft(value: boolean) { this.leftContext = value; }
  notify(message: string) { this.notices.push(message); }
  add(...resources: LocalResource[]) { for (const resource of resources) this.resources.set(resource.path, resource); }
}

test("platform discovery uses standard installed locations, never the working directory", () => {
  assert.deepEqual(desktopCandidates({
    platform: "win32", home: "C:\\Users\\tester",
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local", ProgramFiles: "C:\\Program Files" }
  }), [
    "C:\\Users\\tester\\AppData\\Local\\CompareCraft\\comparecraft.exe",
    "C:\\Program Files\\CompareCraft\\comparecraft.exe"
  ]);
  assert.deepEqual(desktopCandidates({ platform: "darwin", home: "/Users/tester", env: {} }), [
    "/Applications/CompareCraft.app/Contents/MacOS/comparecraft",
    "/Users/tester/Applications/CompareCraft.app/Contents/MacOS/comparecraft"
  ]);
  assert.deepEqual(desktopCandidates({ platform: "linux", home: "/home/tester", env: {} }), [
    "/usr/bin/comparecraft", "/usr/local/bin/comparecraft", "/home/tester/.local/bin/comparecraft"
  ]);
});

test("an invalid explicit path never silently falls back to a discovered installation", async () => {
  let checked = 0;
  await assert.rejects(discoverDesktop({
    platform: "win32", home: "C:\\Users\\tester", env: {},
    override: "C:\\Missing\\comparecraft.exe",
    isExecutable: async () => { checked++; return false; }
  }), InstallationError);
  assert.equal(checked, 1);
  await assert.rejects(discoverDesktop({
    platform: "linux", home: "/home/tester", env: {}, override: "comparecraft",
    isExecutable: async () => true
  }), /absolute path/);
});

test("discovery supports explicit AppImages and reports all missing candidates", async () => {
  assert.equal(await discoverDesktop({
    platform: "linux", home: "/home/tester", env: {}, override: "/opt/Compare Craft.AppImage",
    isExecutable: async value => value.endsWith(".AppImage")
  }), "/opt/Compare Craft.AppImage");
  await assert.rejects(discoverDesktop({
    platform: "linux", home: "/home/tester", env: {}, isExecutable: async () => false
  }), /\/usr\/bin\/comparecraft/);
});

test("filesystem discovery rejects directories and accepts an executable file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "comparecraft-discovery-"));
  try {
    await assert.rejects(discoverDesktop({ override: dir }), InstallationError);
    const exe = path.join(dir, process.platform === "win32" ? "comparecraft.exe" : "comparecraft");
    await writeFile(exe, "");
    await chmod(exe, 0o755);
    assert.equal(await discoverDesktop({ override: exe }), exe);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("CLI arguments preserve side order and separate spaces and option-like names from switches", () => {
  const left = file("left with spaces.txt"), right = file("-right.txt");
  assert.deepEqual(comparisonArguments({ sides: [left, right] }), ["--", left.path, right.path]);
});

test("CLI arguments carry titles, read-only flags, and -solo before the separator", () => {
  assert.deepEqual(comparisonArguments({
    sides: [{ path: "a.txt", title: "Current:\nHEAD", readOnly: true }, { path: "b.txt" }, { path: "c.txt", readOnly: true }, { path: "-out.txt", title: "Result" }],
    solo: true
  }), ["-solo", "-title1=Current: HEAD", "-ro1", "-ro3", "-title4=Result", "--", "a.txt", "b.txt", "c.txt", "-out.txt"]);
});

test("two selected files launch the desktop without an embedded notice", async () => {
  const host = new FakeHost(), left = file("left.txt"), right = file("right.txt");
  host.add(left, right);
  await new ComparisonController(host).compare([left.path, right.path], "desktop");
  assert.deepEqual(host.launches, [["--", left.path, right.path]]);
  assert.equal(host.embeddedNotices, 0);
});

test("embedded/default mode opens two files in the embedded panel without launching", async () => {
  const host = new FakeHost(), left = file("left.txt"), right = file("right.txt");
  host.add(left, right);
  host.mode = "embedded";
  const controller = new ComparisonController(host);
  await controller.compare([left.path, right.path]);
  await controller.compare([left.path, right.path], "embedded");
  assert.deepEqual(host.embedded, [[left.path, right.path], [left.path, right.path]]);
  assert.equal(host.embeddedNotices, 0);
  assert.equal(host.launches.length, 0);
  host.trusted = false;
  await assert.rejects(controller.compare([left.path, right.path]), /Trust required/);
  assert.equal(host.embedded.length, 2);
});

test("embedded folder comparisons never silently fall back to the desktop", async () => {
  const host = new FakeHost(), left = folder("left"), right = folder("right");
  host.add(left, right);
  host.mode = "embedded";
  const controller = new ComparisonController(host);
  await controller.compare([left.path, right.path]);
  assert.equal(host.embeddedNotices, 1);
  assert.equal(host.launches.length, 0);
  host.embeddedAccepted = true;
  await controller.compare([left.path, right.path], "embedded");
  assert.deepEqual(host.launches, [["--", left.path, right.path]]);
  assert.equal(host.embedded.length, 0);
});

test("embedded mode shows two-sided content comparisons in the panel; merges ask before the desktop", async () => {
  const host = new FakeHost();
  host.mode = "embedded";
  const controller = new ComparisonController(host);
  const sides: SideInput[] = [{ kind: "content", name: "a.txt", title: "a.txt (HEAD)", content: "old" }, { kind: "path", path: path.resolve("a.txt") }];
  assert.equal(await controller.compareInputs(sides), true);
  assert.deepEqual(host.embedded, [["content:a.txt", path.resolve("a.txt")]]);
  assert.equal(await controller.compareInputs([...sides, ...sides], { onClosed: async () => {} }), false);
  assert.equal(host.embeddedNotices, 1);
  assert.equal(host.launches.length, 0);
  assert.equal(await controller.compareInputs([...sides, ...sides]), true, "an untracked four-input merge opens in the panel");
  assert.equal(host.embedded.length, 2);
  assert.equal(host.embeddedNotices, 1);
  assert.equal(host.launches.length, 0);
  assert.equal(await controller.compareInputs(sides, { mode: "desktop" }), true);
  assert.equal(host.launches.length, 1);
  await host.tracking[0]?.session?.release();
  assert.equal(host.embedded.length, 2);
});

test("canceling pickers does not launch, and invalid selections fail visibly", async () => {
  const host = new FakeHost(), left = file("left.txt"), right = folder("folder");
  host.add(left, right);
  const controller = new ComparisonController(host);
  await controller.compare([]);
  await controller.compare([left.path]);
  assert.equal(host.launches.length, 0);
  await assert.rejects(controller.compare([left.path, right.path]), /file with a folder/);
  await assert.rejects(controller.compare([left.path, left.path]), /different/);
  await assert.rejects(controller.compare([left.path, left.path, left.path]), /two/);
  await assert.rejects(controller.selectLeft([left.path, right.path]), /one/);
});

test("file and folder left selections are independent and cleared together", async () => {
  const host = new FakeHost(), l = file("left.txt"), r = file("right.txt");
  const lf = folder("left-folder"), rf = folder("right-folder");
  host.add(l, r, lf, rf);
  const controller = new ComparisonController(host);
  await controller.selectLeft([l.path]);
  await controller.selectLeft([lf.path]);
  assert.equal(host.leftContext, true);
  await controller.compareWithLeft([r.path]);
  await controller.compareWithLeft([rf.path]);
  assert.deepEqual(host.launches, [["--", l.path, r.path], ["--", lf.path, rf.path]]);
  await controller.clearLeft();
  assert.equal(host.leftContext, false);
  await assert.rejects(controller.compareWithLeft([r.path]), /Select a left file/);
});

test("picker workflows enforce kinds and compare a file's parent folder", async () => {
  const host = new FakeHost(), l = file("left.txt"), r = file("right.txt");
  const parent = folder(path.dirname(l.path)), other = folder("another-folder");
  host.add(l, r, parent, other);
  const controller = new ComparisonController(host);
  host.picks.push(r.path);
  await controller.compareWithPicker([l.path], "file");
  host.picks.push(other.path);
  await controller.compareParent([l.path]);
  assert.deepEqual(host.launches, [["--", l.path, r.path], ["--", parent.path, other.path]]);
  await assert.rejects(controller.compareWithPicker([other.path], "file"), /Choose a file/);
});

test("untrusted environments and folders with unsaved content never launch", async () => {
  const host = new FakeHost(), l = file("left.txt"), r = file("right.txt"), lf = folder("lf"), rf = folder("rf");
  host.add(l, r, lf, rf);
  const controller = new ComparisonController(host);
  host.trusted = false;
  await assert.rejects(controller.compare([l.path, r.path]), /Trust required/);
  host.trusted = true;
  host.dirty = true;
  await assert.rejects(controller.compare([lf.path, rf.path]), /Unsaved/);
  assert.equal(host.launches.length, 0);
});

test("a dirty file is compared through a read-only snapshot that is released when the desktop closes", async () => {
  const host = new FakeHost(), l = file("left.txt"), r = file("right.txt");
  host.add(l, r);
  host.buffers.set(l.path, "unsaved text");
  try {
    await new ComparisonController(host).compare([l.path, r.path]);
    const args = host.launches[0]!;
    const snapshot = args[args.indexOf("--") + 1]!;
    assert.deepEqual(args.slice(0, 3), ["-solo", "-title1=left.txt (unsaved buffer)", "-ro1"]);
    assert.equal(args.at(-1), r.path);
    assert.equal(path.basename(snapshot), "left.txt");
    const { readFile, access } = await import("node:fs/promises");
    assert.equal(await readFile(snapshot, "utf8"), "unsaved text");
    if (process.getuid?.() !== 0) await assert.rejects(writeFile(snapshot, "changed"));
    await host.tracking[0]!.session!.release();
    await assert.rejects(access(snapshot));
  } finally {
    await rm(host.snapshotRoot, { recursive: true, force: true });
  }
});

test("dirty-buffer guard protects files and folder descendants without rejecting siblings or unrelated deleted files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "comparecraft-dirty-"));
  try {
    const canonical = await import("node:fs/promises").then(fs => fs.realpath(dir));
    const dirty = path.join(canonical, "unsaved.txt");
    const resource = folder(canonical);
    await writeFile(dirty, "saved content");
    await assert.rejects(assertSavedResources([file(dirty)], [dirty]), /Unsaved changes/);
    await assert.rejects(assertSavedResources([resource], [path.join(canonical, "deleted.txt")]), /Unsaved changes/);
    await assertSavedResources([resource], [path.join(`${canonical}-sibling`, "deleted.txt")]);
    await assertSavedResources([file(dirty)], [path.join(canonical, "other-deleted.txt")]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("desktop process launch uses a real argument array and surfaces spawn and exit failures", { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "comparecraft-launch-"));
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const output = path.join(dir, "arguments.json");
    const script = path.join(dir, "left file.cjs");
    await writeFile(script, "require('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))");
    const exited = new Promise<void>((resolve, reject) => {
      void launchDesktop(process.execPath, ["--", script, output, "-right path"], reject, () => resolve()).catch(reject);
    });
    await exited;
    const { readFile } = await import("node:fs/promises");
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), ["-right path"]);
    await assert.rejects(launchDesktop(path.join(dir, "missing.exe"), [], () => {}), /Could not start/);
    await new Promise<void>((resolve, reject) => {
      void launchDesktop(process.execPath, ["-e", "process.exit(7)"], error => {
        try { assert.match(error.message, /code 7/); resolve(); } catch (failure) { reject(failure); }
      }).catch(reject);
    });
  } finally {
    clearInterval(keepAlive);
    await rm(dir, { recursive: true });
  }
});
