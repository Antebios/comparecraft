import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { locateBackend } from "../src/discovery";
import { InstallationError, UnavailableError } from "../src/errors";
import type { EntryType, FileAccess, FileInfo } from "../src/fileAccess";
import { basename, dirname, extname, fileUrlToPath, isAbsolutePath, isUriString, joinPath, pathKey, schemeOf, withinFolder } from "../src/paths";
import { contextKeys, denial, hostLabel, type HostState } from "../src/policy";
import { VirtualFolderSnapshots } from "../src/virtualFolders";

const desktop: HostState = { kind: "desktop", trusted: true };
const restricted: HostState = { kind: "desktop", trusted: false };
const ssh: HostState = { kind: "remote", remoteName: "ssh-remote", trusted: true };
const web: HostState = { kind: "web", trusted: true };
const VFS = "vscode-vfs://github/owner/repo/src/a.ts";

test("path strings: file-system paths and URI strings", () => {
  const file = path.resolve("dir", "name.txt");
  assert.equal(isUriString(VFS), true);
  assert.equal(isUriString(file), false);
  assert.equal(isUriString("C:\\x"), false, "a drive letter is not a URI scheme");
  assert.equal(isAbsolutePath(file), true);
  assert.equal(isAbsolutePath(VFS), true);
  assert.equal(isAbsolutePath("relative.txt"), false);
  assert.equal(isAbsolutePath(""), false);
  assert.equal(basename(file), "name.txt");
  assert.equal(basename("vscode-vfs://github/owner/repo/my%20file%23.txt"), "my file#.txt");
  assert.equal(extname("vscode-vfs://github/owner/repo/a.test.TS"), ".TS");
  assert.equal(extname(path.resolve(".bashrc")), "");
  assert.equal(dirname(file), path.dirname(file));
  assert.equal(dirname(VFS), "vscode-vfs://github/owner/repo/src");
  assert.equal(dirname("vscode-vfs://github/owner"), "vscode-vfs://github/");
  assert.equal(joinPath("vscode-vfs://github/owner/repo", "a b/c#.txt"), "vscode-vfs://github/owner/repo/a%20b/c%23.txt");
  assert.equal(joinPath(path.resolve("base"), "a/b.txt"), path.join(path.resolve("base"), "a", "b.txt"));
  assert.equal(schemeOf(VFS), "vscode-vfs");
  assert.equal(schemeOf(file), "file");
});

test("path identity ignores URI encoding differences and checks containment by segment", () => {
  // VS Code encodes "(" in URIs; the webview's joinPath does not.
  assert.equal(pathKey("vscode-vfs://GitHub/o/r/a(1).txt"), pathKey("VSCODE-VFS://github/o/r/a%281%29.txt"));
  assert.notEqual(pathKey("vscode-vfs://github/o/r/a.txt"), pathKey("vscode-vfs://github/o/r/A.txt"));
  const base = path.resolve("project");
  assert.equal(pathKey(path.join(base, "a", "..", "b")), pathKey(path.join(base, "b")));
  assert.equal(withinFolder(base, path.join(base, "a", "b.txt")), true);
  assert.equal(withinFolder(base, `${base}-sibling${path.sep}x`), false);
  assert.equal(withinFolder(base, base), false);
  assert.equal(withinFolder("vscode-vfs://github/o/r", "vscode-vfs://github/o/r/src/a.ts"), true);
  assert.equal(withinFolder("vscode-vfs://github/o/r", "vscode-vfs://github/o/r2/a.ts"), false);
  assert.equal(withinFolder("vscode-vfs://github/o/r", "vscode-vfs://other/o/r/a.ts"), false);
  assert.equal(withinFolder(base, "vscode-vfs://github/o/r/a.ts"), false);
});

test("file URLs convert like Node's fileURLToPath", () => {
  for (const file of [path.resolve("with space & 100%.txt"), path.resolve("ünïcødé", "#hash?.txt")]) {
    const href = pathToFileURL(file).href;
    assert.equal(fileUrlToPath(href), fileURLToPath(href));
  }
  assert.throws(() => fileUrlToPath("https://example.com/a"), /Not a file URL/);
});

test("policy: what each host and trust state allows", () => {
  for (const state of [desktop, restricted, ssh, web]) assert.equal(Boolean(denial(state, "folder")), state === web);
  assert.equal(denial(desktop, "desktop"), undefined);
  assert.equal(denial(desktop, "save"), undefined);
  assert.equal(denial(desktop, "git"), undefined);
  assert.equal(denial(desktop, "revealInOS"), undefined);
  // Restricted Mode: read-only comparisons; saving, Git and the desktop app need trust.
  for (const operation of ["save", "git", "desktop"] as const) assert.equal(denial(restricted, operation)?.fix, "trust", operation);
  assert.match(denial(restricted, "git")!.reason, /Git configuration can run programs/);
  // Remote windows: everything runs on the remote host except the local desktop app and file manager.
  assert.match(denial(ssh, "desktop")!.reason, /connected to an SSH host/);
  assert.equal(denial(ssh, "desktop")!.fix, undefined);
  assert.equal(denial(ssh, "git"), undefined);
  assert.equal(denial(ssh, "save"), undefined);
  assert.ok(denial(ssh, "revealInOS"));
  // Virtual resources: no desktop app, Git or file manager.
  assert.match(denial(desktop, "desktop", [VFS])!.reason, /"vscode-vfs" resources/);
  assert.match(denial(desktop, "git", [VFS])!.reason, /working tree on disk/);
  assert.ok(denial(desktop, "revealInOS", [VFS]));
  assert.equal(denial(desktop, "save", [VFS]), undefined);
  // Browser VS Code: comparisons only.
  for (const operation of ["desktop", "git", "folder", "revealInOS"] as const) assert.ok(denial(web, operation), operation);
  assert.equal(denial(web, "save", ["file:///x"]), undefined);
  assert.equal(hostLabel(ssh), "a window connected to an SSH host");
  assert.equal(hostLabel(restricted), "VS Code desktop (Restricted Mode)");
  assert.equal(hostLabel({ kind: "remote", remoteName: "unknown-remote", trusted: true }), "a window connected to a remote host (unknown-remote)");
});

test("policy context keys show the menus that work in each host", () => {
  assert.deepEqual(contextKeys(desktop, ["file"]), { desktop: true, git: true, folders: true, schemes: ["file"], localSchemes: ["file"] });
  assert.deepEqual(contextKeys(restricted, ["file"]), { desktop: false, git: false, folders: true, schemes: ["file"], localSchemes: ["file"] });
  assert.deepEqual(contextKeys(ssh, ["file"]), { desktop: false, git: true, folders: true, schemes: ["file", "vscode-remote"], localSchemes: ["file", "vscode-remote"] });
  assert.deepEqual(contextKeys(web, ["vscode-vfs"]), { desktop: false, git: false, folders: false, schemes: ["file", "vscode-vfs"], localSchemes: [] });
  assert.deepEqual(contextKeys(desktop, ["vscode-vfs", "untitled"]).schemes, ["file", "vscode-vfs"]);
});

test("helper discovery: setting, then bundled, then the desktop install, else none", async () => {
  const exists = (files: string[]) => async (value: string) => files.includes(value);
  const base = { platform: "linux" as const, home: "/home/me", env: {} };
  assert.deepEqual(await locateBackend({ ...base, override: "/opt/cc", bundled: "/ext/bin/comparecraft-backend", isExecutable: exists(["/opt/cc", "/ext/bin/comparecraft-backend"]) }),
    { executable: "/opt/cc", source: "setting" });
  await assert.rejects(locateBackend({ ...base, override: "/missing", bundled: "/ext/bin/comparecraft-backend", isExecutable: exists(["/ext/bin/comparecraft-backend"]) }), InstallationError);
  assert.deepEqual(await locateBackend({ ...base, bundled: "/ext/bin/comparecraft-backend", isExecutable: exists(["/ext/bin/comparecraft-backend", "/usr/bin/comparecraft", "/usr/bin/comparecraft-backend"]) }),
    { executable: "/ext/bin/comparecraft-backend", source: "bundled" });
  assert.deepEqual(await locateBackend({ ...base, bundled: "/ext/bin/comparecraft-backend", isExecutable: exists(["/usr/bin/comparecraft", "/usr/bin/comparecraft-backend"]) }),
    { executable: "/usr/bin/comparecraft-backend", source: "desktop" });
  assert.equal(await locateBackend({ ...base, isExecutable: exists(["/usr/bin/comparecraft"]) }), undefined, "a desktop install without the helper");
  assert.equal(await locateBackend({ ...base, isExecutable: exists([]) }), undefined, "nothing installed");
  await assert.rejects(locateBackend({ ...base, desktopOverride: "/missing/comparecraft", isExecutable: exists([]) }), InstallationError);
  assert.equal(await locateBackend({ platform: "freebsd" as NodeJS.Platform, home: "/home/me", env: {} }), undefined, "unsupported desktop platform");
});

test("a bundled helper whose executable bit was dropped is made executable", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cc-bundled-"));
  try {
    const helper = path.join(dir, "comparecraft-backend");
    await writeFile(helper, "#!/bin/sh\n");
    await chmod(helper, 0o644);
    assert.deepEqual(await locateBackend({ bundled: helper, home: dir, env: {} }), { executable: helper, source: "bundled" });
    assert.ok(((await stat(helper)).mode & 0o111) !== 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A virtual workspace tree: URI string → contents (folders are objects). */
class TreeFiles implements FileAccess {
  readonly reads: string[] = [];
  constructor(private readonly root: string, private readonly tree: Record<string, unknown>, private readonly mtime = Date.UTC(2020, 0, 2, 3, 4, 5)) {}
  private node(file: string): unknown {
    if (!file.startsWith(this.root)) return undefined;
    let node: unknown = this.tree;
    for (const part of file.slice(this.root.length).split("/").filter(Boolean)) {
      node = node && typeof node === "object" && !(node instanceof Uint8Array) ? (node as Record<string, unknown>)[decodeURIComponent(part)] : undefined;
    }
    return node;
  }
  isLocal() { return false; }
  async stat(file: string): Promise<FileInfo | undefined> {
    const node = this.node(file);
    if (node === undefined) return undefined;
    return typeof node === "string" ? { type: "file", size: Buffer.byteLength(node), mtime: this.mtime, readOnly: true } : { type: "folder", size: 0, mtime: this.mtime, readOnly: true };
  }
  async readFile(file: string) {
    this.reads.push(file);
    return new TextEncoder().encode(this.node(file) as string);
  }
  async read(file: string, offset: number, length: number) { return (await this.readFile(file)).subarray(offset, offset + length); }
  async list(file: string): Promise<[string, EntryType][]> {
    return Object.entries(this.node(file) as Record<string, unknown>).map(([name, value]) => [name, typeof value === "string" ? "file" : "folder"]);
  }
  async create(): Promise<void> { throw new Error("read-only"); }
  async realpath(file: string) { return file; }
}

const progress = { report() {}, cancelled: () => false };

test("virtual folders are copied with their sizes and times, refreshed per item, bounded and released", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cc-copies-"));
  const base = "vscode-vfs://github/o/r";
  const tree = { "a b.txt": "alpha", src: { "main.ts": "export {}", empty: {} }, ".gitignore": "*.log\n" };
  const files = new TreeFiles(base, tree);
  const copies = new VirtualFolderSnapshots(root, files, { maxFiles: 10, maxBytes: 1000 });
  try {
    const local = await copies.copy("panel", "left", base, progress);
    assert.equal(local, copies.side("panel", "left"));
    assert.equal(await readFile(path.join(local, "a b.txt"), "utf8"), "alpha");
    assert.equal(await readFile(path.join(local, "src", "main.ts"), "utf8"), "export {}");
    assert.deepEqual(await readdir(path.join(local, "src", "empty")), []);
    assert.equal((await stat(path.join(local, "a b.txt"))).mtimeMs, Date.UTC(2020, 0, 2, 3, 4, 5));
    (tree.src as Record<string, unknown>)["main.ts"] = "changed";
    files.reads.length = 0;
    await copies.copy("panel", "right", base, progress);
    await copies.refresh("panel", [base, base], ["src/main.ts"], progress);
    assert.equal(await readFile(path.join(local, "src", "main.ts"), "utf8"), "changed");
    assert.deepEqual(files.reads.filter(item => item.endsWith("main.ts")).length, 3, "copied for the right side, then refreshed for both");
    await assert.rejects(copies.refresh("panel", [base, base], ["../escape"], progress), /Invalid item path/);

    const tooMany = new VirtualFolderSnapshots(root, new TreeFiles(base, Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}`, "x"]))), { maxFiles: 10, maxBytes: 1000 });
    await assert.rejects(tooMany.copy("big", "left", base, progress), (error: Error) => error instanceof UnavailableError && /more than 10 files/.test(error.message));
    await assert.rejects(stat(tooMany.side("big", "left")), "no partial copy is kept");
    const tooLarge = new VirtualFolderSnapshots(root, new TreeFiles(base, { a: "x".repeat(600), b: "y".repeat(600) }), { maxFiles: 10, maxBytes: 1000 });
    await assert.rejects(tooLarge.copy("big", "left", base, progress), /MB of files/);
    const badName = new VirtualFolderSnapshots(root, new TreeFiles(base, { "a\u0000b": "x" }));
    await assert.rejects(badName.copy("bad", "left", base, progress), /can't be stored as a file name/);
    await assert.rejects(copies.copy("cancel", "left", base, { report() {}, cancelled: () => true }), /cancelled/);
    await assert.rejects(stat(copies.side("cancel", "left")));

    await copies.release("panel");
    await assert.rejects(stat(copies.side("panel", "left")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("folder copies of extension hosts that ended are swept", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cc-sweep-"));
  try {
    await mkdir(path.join(root, "999999999-dead", "left"), { recursive: true });
    await mkdir(path.join(root, `${process.pid}-alive`), { recursive: true });
    await mkdir(path.join(root, "not-a-copy"));
    assert.equal(await new VirtualFolderSnapshots(root, new TreeFiles("x:", {})).sweep(), 1);
    assert.deepEqual((await readdir(root)).sort(), [`${process.pid}-alive`, "not-a-copy"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
