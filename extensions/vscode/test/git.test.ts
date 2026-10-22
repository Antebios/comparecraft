import assert from "node:assert/strict";
import { test } from "node:test";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SnapshotStore, MARKER, snapshotName } from "../src/snapshots";
import { ConflictError, conflictPlan, hasConflictMarkers, isBinary } from "../src/conflicts";
import { Git, type RevisionEntry } from "../src/git";
import { GitWorkflows, type GitHost } from "../src/gitWorkflows";
import type { CompareOptions } from "../src/controller";
import type { SideInput } from "../src/contracts";
import { applySettings, proposedSettings, removeSettings, shellQuote, toolCommand } from "../src/gitTools";

async function temp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

const exists = (file: string) => access(file).then(() => true, () => false);

// ---------------------------------------------------------------- snapshots

test("snapshots keep the file name, are read-only, and are removed on release", async () => {
  const root = await temp("cc-snap-");
  try {
    const session = await new SnapshotStore(root).create();
    const file = await session.write("left", "src/../My File.ts", "content");
    assert.equal(path.basename(file), "My File.ts");
    assert.equal(await readFile(file, "utf8"), "content");
    if (process.getuid?.() !== 0) await assert.rejects(writeFile(file, "changed"));
    await assert.rejects(session.write("left", "My File.ts", "again"), /EEXIST/);
    await session.release();
    assert.equal(await exists(session.directory), false);
    await assert.rejects(session.write("right", "x.txt", ""), /released/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot names are sanitized but never empty", () => {
  assert.equal(snapshotName("a<b>:c.txt"), "a_b__c.txt");
  assert.equal(snapshotName("C:\\dir\\file.rs"), "file.rs");
  assert.equal(snapshotName("..."), "snapshot.txt");
});

test("sweep removes only marked sessions whose process ended or that expired", async () => {
  const root = await temp("cc-sweep-");
  try {
    let now = 1_000_000;
    const store = new SnapshotStore(root, () => now);
    const running = await store.create();
    await running.attach(111);
    now += 1;
    const ended = await store.create();
    await ended.attach(222);
    now += 1;
    const fresh = await store.create();
    const foreign = path.join(root, "not-ours");
    await mkdir(foreign);
    await writeFile(path.join(foreign, "data.txt"), "keep");
    const isAlive = (pid: number) => pid === 111;

    let removed = await store.sweep({ isAlive, now });
    assert.deepEqual(removed, [ended.directory]);
    removed = await store.sweep({ isAlive, now: now + 25 * 3600_000 });
    assert.deepEqual(removed, [fresh.directory]);
    removed = await store.sweep({ isAlive, now: now + 8 * 24 * 3600_000 });
    assert.deepEqual(removed, [running.directory]);
    assert.deepEqual(await readdir(root), ["not-ours"]);
    assert.equal(await exists(path.join(foreign, MARKER)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- conflict helpers

test("conflict plans require both sides and reject links and submodules", () => {
  const entry = (stage: 1 | 2 | 3, mode = "100644") => ({ stage, mode, object: `${stage}`.repeat(40) });
  assert.throws(() => conflictPlan("a", []), /no unresolved conflict/);
  assert.throws(() => conflictPlan("a", [entry(1), entry(2)]), /deleted on the incoming side/);
  assert.throws(() => conflictPlan("a", [entry(1), entry(3)]), /deleted on the current side/);
  assert.throws(() => conflictPlan("a", [entry(2, "120000"), entry(3)]), /symbolic link/);
  assert.throws(() => conflictPlan("a", [entry(2), entry(3, "160000")]), /submodule/);
  assert.equal(conflictPlan("a", [entry(2), entry(3)]).base, undefined);
});

test("binary detection and conflict marker detection", () => {
  assert.equal(isBinary(Buffer.from("text")), false);
  assert.equal(isBinary(Buffer.from([65, 0, 66])), true);
  assert.equal(hasConflictMarkers("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> x\n"), true);
  assert.equal(hasConflictMarkers("a\r\n=======\r\nb"), true);
  assert.equal(hasConflictMarkers("a ======= b\n<<<<<<<<not\n"), false);
});

// ---------------------------------------------------------------- real Git fixtures

interface Fixture {
  readonly dir: string;
  readonly repo: string;
  readonly git: Git;
  run(...args: string[]): Promise<string>;
  tryRun(...args: string[]): Promise<number>;
  write(name: string, content: string): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const dir = await temp("cc-git-");
  const repo = path.join(dir, "repo");
  await mkdir(repo);
  const globalConfig = path.join(dir, "global.gitconfig");
  await writeFile(globalConfig, "");
  const git = new Git("git", {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Tester", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "Tester", GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no"
  });
  const run = (...args: string[]) => git.text(repo, args);
  await run("init", "-q", "-b", "main");
  await run("config", "core.autocrlf", "false");
  return {
    dir, repo, git, run,
    tryRun: async (...args) => (await git.run(repo, args)).code,
    write: async (name, content) => {
      await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
      await writeFile(path.join(repo, name), content);
    }
  };
}

/** main and feature both change line two of "file name.txt". */
async function divergent(f: Fixture): Promise<void> {
  await f.write("file name.txt", "one\ntwo\nthree\n");
  await f.run("add", ".");
  await f.run("commit", "-q", "-m", "base");
  await f.run("checkout", "-q", "-b", "feature");
  await f.write("file name.txt", "one\nfeature\nthree\n");
  await f.run("commit", "-q", "-am", "feature change");
  await f.run("checkout", "-q", "main");
  await f.write("file name.txt", "one\nmain\nthree\n");
  await f.run("commit", "-q", "-am", "main change");
}

class FakeGitHost implements GitHost {
  buffers = new Map<string, string>();
  dirty = new Set<string>();
  answers: boolean[] = [];
  confirms: string[] = [];
  notices: string[] = [];
  warnings: string[] = [];
  stage = false;
  revision?: (entries: readonly RevisionEntry[]) => RevisionEntry | undefined;
  assertSupported() {}
  async bufferText(file: string) { return this.buffers.get(file); }
  async isDirty(file: string) { return this.dirty.has(file); }
  async confirm(message: string) { this.confirms.push(message); return this.answers.shift() ?? true; }
  async pickRevision(entries: readonly RevisionEntry[]) { return this.revision?.(entries) ?? entries[0]; }
  async offerStage() { return this.stage; }
  notify(message: string) { this.notices.push(message); }
  warn(message: string) { this.warnings.push(message); }
}

function workflows(f: Fixture) {
  const host = new FakeGitHost();
  const calls: { inputs: readonly SideInput[]; options?: CompareOptions }[] = [];
  const flows = new GitWorkflows(f.git, async (inputs, options) => { calls.push({ inputs, options }); return true; }, host);
  return { host, calls, flows };
}

const text = (input: SideInput) => input.kind === "content" ? Buffer.from(input.content).toString("utf8") : `path:${input.path}`;

test("merge conflicts open current, incoming, base snapshots and the working file as output", async () => {
  const f = await fixture();
  try {
    await divergent(f);
    assert.notEqual(await f.tryRun("merge", "-q", "feature"), 0);
    const { host, calls, flows } = workflows(f);
    const target = path.join(f.repo, "file name.txt");
    await flows.resolveConflict(target);
    const [current, incoming, base, output] = calls[0]!.inputs;
    assert.equal(current!.title, "Current: HEAD (main)");
    assert.match(incoming!.title!, /^Incoming: merging [0-9a-f]+ feature change$/);
    assert.equal(base!.title, "Base: common ancestor");
    assert.deepEqual([text(current!), text(incoming!), text(base!)], ["one\nmain\nthree\n", "one\nfeature\nthree\n", "one\ntwo\nthree\n"]);
    assert.deepEqual(output, { kind: "path", path: target, title: "Result: file name.txt" });
    assert.equal(calls[0]!.options!.mode, "desktop");

    await assert.rejects(flows.compareIndexWorking(target), /unresolved conflicts/);
    host.dirty.add(target);
    await assert.rejects(flows.resolveConflict(target), /Save or revert/);
    host.dirty.clear();

    // Closing without changes leaves the conflict alone.
    await calls[0]!.options!.onClosed!();
    assert.match(host.notices.at(-1)!, /without changing/);

    // Leftover markers require explicit confirmation; declining stages nothing.
    host.answers.push(false);
    assert.equal(await flows.stageResolved(target), false);
    assert.equal((await f.git.unmerged(f.repo, "file name.txt")).length, 3);

    await new Promise(resolve => setTimeout(resolve, 20));
    await writeFile(target, "one\nmerged\nthree\n");
    host.stage = true;
    host.answers.push(true);
    await calls[0]!.options!.onClosed!();
    assert.equal((await f.git.unmerged(f.repo, "file name.txt")).length, 0);
    assert.equal(await f.run("show", ":0:file name.txt"), "one\nmerged\nthree");
    assert.equal(await f.tryRun("rev-parse", "-q", "--verify", "MERGE_HEAD"), 0, "merge was not continued or committed");
    assert.match(host.notices.at(-1)!, /Continue the merge/);
    await assert.rejects(flows.stageResolved(target), /not an unresolved conflict/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("rebase conflicts describe the replayed commit as incoming", async () => {
  const f = await fixture();
  try {
    await divergent(f);
    await f.run("checkout", "-q", "feature");
    assert.notEqual(await f.tryRun("rebase", "main"), 0);
    const operation = await f.git.operation(f.repo);
    assert.equal(operation.kind, "rebase");
    assert.match(operation.current, /^Current: rebase base [0-9a-f]{7} \+ replayed commits$/);
    assert.match(operation.incoming, /^Incoming: replaying [0-9a-f]+ feature change from feature$/);
    const { calls, flows } = workflows(f);
    await flows.resolveConflict(path.join(f.repo, "file name.txt"));
    const [current, incoming] = calls[0]!.inputs;
    assert.equal(text(current!), "one\nmain\nthree\n");
    assert.equal(text(incoming!), "one\nfeature\nthree\n");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("add/add conflicts use an empty base and modify/delete conflicts are refused", async () => {
  const f = await fixture();
  try {
    await f.write("keep.txt", "keep\n");
    await f.write("gone.txt", "original\n");
    await f.run("add", ".");
    await f.run("commit", "-q", "-m", "base");
    await f.run("checkout", "-q", "-b", "other");
    await f.write("new.txt", "other\n");
    await f.write("gone.txt", "modified\n");
    await f.run("add", ".");
    await f.run("commit", "-q", "-m", "other");
    await f.run("checkout", "-q", "main");
    await f.write("new.txt", "main\n");
    await f.run("rm", "-q", "gone.txt");
    await f.run("add", ".");
    await f.run("commit", "-q", "-m", "main");
    assert.notEqual(await f.tryRun("merge", "-q", "other"), 0);
    const { calls, flows } = workflows(f);
    await flows.resolveConflict(path.join(f.repo, "new.txt"));
    const base = calls[0]!.inputs[2]!;
    assert.equal(base.title, "Base: none (added on both sides)");
    assert.equal(text(base), "");
    await assert.rejects(flows.resolveConflict(path.join(f.repo, "gone.txt")), ConflictError);
    await assert.rejects(flows.resolveConflict(path.join(f.repo, "gone.txt")), /modify\/delete/);
    assert.equal(calls.length, 1);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("HEAD, index, working tree, and revision comparisons use the right content", async () => {
  const f = await fixture();
  try {
    await f.write("dir/a.txt", "v1\n");
    await f.run("add", ".");
    await f.run("commit", "-q", "-m", "first");
    await f.write("dir/a.txt", "v2\n");
    await f.run("commit", "-q", "-am", "second");
    await f.write("dir/a.txt", "staged\n");
    await f.run("add", ".");
    await f.write("dir/a.txt", "working\n");
    const { host, calls, flows } = workflows(f);
    const target = path.join(f.repo, "dir", "a.txt");

    await flows.compareHeadWorking(target);
    await flows.compareHeadIndex(target);
    await flows.compareIndexWorking(target);
    host.buffers.set(target, "buffer\n");
    host.revision = entries => entries.find(entry => entry.subject === "first");
    await flows.compareRevision(target);
    assert.deepEqual(calls.map(call => call.inputs.map(text)), [
      ["v2\n", `path:${target}`],
      ["v2\n", "staged\n"],
      ["staged\n", `path:${target}`],
      ["v1\n", "buffer\n"]
    ]);
    assert.deepEqual(calls.map(call => call.inputs.map(input => input.title)), [
      ["a.txt (HEAD)", "a.txt (working tree)"],
      ["a.txt (HEAD)", "a.txt (index)"],
      ["a.txt (index)", "a.txt (working tree)"],
      [`a.txt (${(await f.git.log(f.repo, "dir/a.txt")).at(-1)!.short})`, "a.txt (unsaved buffer)"]
    ]);

    await f.write("untracked.txt", "new\n");
    await flows.compareHeadWorking(path.join(f.repo, "untracked.txt"));
    assert.equal(calls.at(-1)!.inputs[0]!.title, "untracked.txt (not in HEAD)");
    await assert.rejects(flows.compareRevision(path.join(f.repo, "untracked.txt")), /no committed history/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("staging is refused when the conflict state changed after launch", async () => {
  const f = await fixture();
  try {
    await divergent(f);
    assert.notEqual(await f.tryRun("merge", "-q", "feature"), 0);
    const { host, calls, flows } = workflows(f);
    const target = path.join(f.repo, "file name.txt");
    await flows.resolveConflict(target);
    await f.run("merge", "--abort");
    await f.write("file name.txt", "one\nmain again\nthree\n");
    await f.run("commit", "-q", "-am", "main again");
    assert.notEqual(await f.tryRun("cherry-pick", "feature"), 0);
    await calls[0]!.options!.onClosed!();
    assert.match(host.warnings[0]!, /changed while CompareCraft was open/);

    await flows.resolveConflict(target);
    await f.run("cherry-pick", "--abort");
    await f.write("file name.txt", "one\nmain third\nthree\n");
    await f.run("commit", "-q", "-am", "main third");
    assert.notEqual(await f.tryRun("cherry-pick", "feature"), 0);
    await f.write("file name.txt", "resolved\n");
    await assert.rejects(flows.stageResolved(target), /changed since CompareCraft opened it/);
    assert.equal((await f.git.unmerged(f.repo, "file name.txt")).length, 3);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- Git tool configuration

test("tool commands quote executables for Git's shell and pass -solo before --", () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(
    toolCommand("C:\\Program Files\\CompareCraft\\ccomp.exe", ["LOCAL", "REMOTE"], "win32"),
    `'C:/Program Files/CompareCraft/ccomp.exe' -solo -- "$LOCAL" "$REMOTE"`
  );
  const settings = proposedSettings("/usr/bin/ccomp", "merge", "linux");
  assert.deepEqual(Object.keys(settings), ["merge.tool", "mergetool.comparecraft.cmd", "mergetool.comparecraft.trustExitCode"]);
  assert.equal(settings["mergetool.comparecraft.trustExitCode"], "false");
  assert.equal(proposedSettings("/x", "diff", "linux")["difftool.comparecraft.cmd"], `'/x' -solo -- "$LOCAL" "$REMOTE"`);
});

test("applying and removing tool settings restores earlier values and keeps later user edits", async () => {
  const f = await fixture();
  try {
    for (const scope of ["local", "global"] as const) {
      await f.git.configSet(f.repo, scope, "merge.tool", "meld");
      const settings = proposedSettings("/opt/cc/ccomp", "both", "linux");
      const first = await applySettings(f.git, f.repo, scope, settings);
      const again = await applySettings(f.git, f.repo, scope, settings, first);
      assert.equal(again.entries.find(entry => entry.key === "merge.tool")!.previous, "meld");
      assert.deepEqual(await f.git.configValues(f.repo, scope, "diff.tool"), ["comparecraft"]);
      await f.git.configSet(f.repo, scope, "diff.tool", "vimdiff");
      const result = await removeSettings(f.git, again);
      assert.deepEqual(result.skipped, ["diff.tool"]);
      assert.deepEqual(await f.git.configValues(f.repo, scope, "merge.tool"), ["meld"]);
      assert.deepEqual(await f.git.configValues(f.repo, scope, "mergetool.comparecraft.cmd"), []);
      assert.deepEqual(await f.git.configValues(f.repo, scope, "diff.tool"), ["vimdiff"]);
    }
    assert.match(await readFile(path.join(f.dir, "global.gitconfig"), "utf8"), /meld/);
    await f.run("config", "--add", "diff.tool", "second");
    await assert.rejects(applySettings(f.git, f.repo, "local", proposedSettings("/x", "diff", "linux")), /multiple/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("git mergetool runs the configured command with LOCAL REMOTE BASE MERGED", async () => {
  const f = await fixture();
  try {
    await divergent(f);
    assert.notEqual(await f.tryRun("merge", "-q", "feature"), 0);
    const tools = path.join(f.dir, "tool dir with 'quote'");
    await mkdir(tools);
    const script = path.join(tools, "fake ccomp.cjs");
    const record = path.join(f.dir, "argv.json");
    await writeFile(script, [
      "const fs = require('fs');",
      "const args = process.argv.slice(2);",
      `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, contents: args.slice(2, 5).map(f => fs.readFileSync(f, 'utf8')) }));`,
      "fs.writeFileSync(args[5], 'one\\nresolved\\nthree\\n');"
    ].join("\n"));
    const settings = proposedSettings(process.execPath, "merge");
    settings["mergetool.comparecraft.cmd"] = toolCommand(process.execPath, ["LOCAL", "REMOTE", "BASE", "MERGED"], process.platform, [script]);
    await applySettings(f.git, f.repo, "local", settings);
    await f.run("config", "mergetool.keepBackup", "false");
    await f.run("mergetool", "--no-prompt");
    const { args, contents } = JSON.parse(await readFile(record, "utf8")) as { args: string[]; contents: string[] };
    assert.deepEqual(args.slice(0, 2), ["-solo", "--"]);
    assert.equal(args.length, 6);
    assert.equal(path.basename(args[5]!), "file name.txt");
    assert.deepEqual(contents, ["one\nmain\nthree\n", "one\nfeature\nthree\n", "one\ntwo\nthree\n"]);
    assert.equal((await f.git.unmerged(f.repo, "file name.txt")).length, 0);
    assert.equal(await f.run("show", ":0:file name.txt"), "one\nresolved\nthree");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
