import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MAX_OUTPUT = 256 * 1024 * 1024;

export class GitError extends Error {}

export interface GitResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

export interface StageEntry {
  readonly mode: string;
  readonly object: string;
  readonly stage: 1 | 2 | 3;
}

export type OperationKind = "merge" | "rebase" | "cherry-pick" | "revert" | "unknown";

export interface GitOperation {
  readonly kind: OperationKind;
  /** Side 2 ("ours" in Git's index), described for the actual operation. */
  readonly current: string;
  /** Side 3 ("theirs" in Git's index), described for the actual operation. */
  readonly incoming: string;
}

export interface RevisionEntry {
  readonly hash: string;
  readonly short: string;
  readonly date: string;
  readonly author: string;
  readonly subject: string;
}

export interface RepositoryFile {
  readonly root: string;
  /** Repository-relative path with forward slashes. */
  readonly relative: string;
  readonly absolute: string;
}

export class Git {
  constructor(private readonly executable = "git", private readonly env: NodeJS.ProcessEnv = process.env) {}

  run(cwd: string, args: readonly string[], input?: string): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, ["-c", "core.quotepath=off", ...args], {
        cwd, shell: false, windowsHide: true, env: { ...this.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT) child.kill();
        else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE")
          reject(
            new GitError(
              `Could not write to Git (${this.executable}): ${error.message}`,
            ),
          );
      });
      child.once("error", error => reject(new GitError(`Could not run Git (${this.executable}): ${error.message}`)));
      child.once("close", code => {
        if (size > MAX_OUTPUT) reject(new GitError("Git output exceeded the supported size."));
        else resolve({ code: code ?? 1, stdout: Buffer.concat(chunks), stderr: stderr.trim() });
      });
      if (input === undefined) child.stdin.end();
      else child.stdin.end(input);
    });
  }

  async text(cwd: string, args: readonly string[]): Promise<string> {
    const result = await this.run(cwd, args);
    if (result.code !== 0) throw new GitError(result.stderr || `git ${args.join(" ")} failed with code ${result.code}`);
    return result.stdout.toString("utf8").replace(/\r?\n$/, "");
  }

  /** Top-level directory of the repository containing a folder, or undefined outside Git. */
  async root(directory: string): Promise<string | undefined> {
    const result = await this.run(directory, ["rev-parse", "--show-toplevel"]);
    return result.code === 0 ? realpath(result.stdout.toString("utf8").trim()) : undefined;
  }

  async file(filePath: string): Promise<RepositoryFile> {
    const absolute = path.resolve(filePath);
    let directory = path.dirname(absolute);
    try {
      if ((await stat(absolute)).isDirectory()) directory = absolute;
    } catch {
      // A deleted working-tree file is still resolved through its parent folder.
    }
    const result = await this.run(directory, ["rev-parse", "--show-toplevel"]);
    if (result.code !== 0) throw new GitError(`${absolute} is not inside a Git repository.`);
    const root = await realpath(result.stdout.toString("utf8").trim());
    let canonical: string;
    try {
      canonical = await realpath(absolute);
    } catch {
      canonical = path.join(await realpath(path.dirname(absolute)), path.basename(absolute));
    }
    const relative = path.relative(root, canonical);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new GitError(`${absolute} is not a file inside repository ${root}.`);
    }
    return { root, relative: relative.split(path.sep).join("/"), absolute: canonical };
  }

  /** Raw bytes for a revision spec, or undefined when it does not name a blob (e.g. file added later). */
  async blob(root: string, spec: string): Promise<Buffer | undefined> {
    // `<rev>:<path>^{blob}` would treat the suffix as part of the path, so check the type instead.
    const type = await this.run(root, ["cat-file", "-t", spec]);
    if (type.code !== 0 || type.stdout.toString("utf8").trim() !== "blob") return undefined;
    const result = await this.run(root, ["cat-file", "blob", spec]);
    if (result.code !== 0) throw new GitError(result.stderr || `Could not read ${spec}`);
    return result.stdout;
  }

  async unmerged(root: string, relative: string): Promise<StageEntry[]> {
    const output = (await this.run(root, ["--literal-pathspecs", "ls-files", "-u", "-z", "--", relative]));
    if (output.code !== 0) throw new GitError(output.stderr);
    const entries: StageEntry[] = [];
    for (const record of output.stdout.toString("utf8").split("\0")) {
      const match = /^(\d+) ([0-9a-f]+) ([123])\t(.*)$/s.exec(record);
      if (match && match[4] === relative) {
        entries.push({ mode: match[1]!, object: match[2]!, stage: Number(match[3]) as 1 | 2 | 3 });
      }
    }
    return entries.sort((a, b) => a.stage - b.stage);
  }

  private async exists(root: string, ref: string): Promise<boolean> {
    return (await this.run(root, ["rev-parse", "-q", "--verify", ref])).code === 0;
  }

  private async summary(root: string, ref: string): Promise<string> {
    const result = await this.run(root, ["log", "-1", "--format=%h %s", ref, "--"]);
    return result.code === 0 ? result.stdout.toString("utf8").trim() : ref;
  }

  private async branch(root: string): Promise<string> {
    const result = await this.run(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
    return result.code === 0 ? result.stdout.toString("utf8").trim() : "detached HEAD";
  }

  private async rebaseDirectory(root: string): Promise<string | undefined> {
    for (const name of ["rebase-merge", "rebase-apply"]) {
      const candidate = path.resolve(root, await this.text(root, ["rev-parse", "--git-path", name]));
      try {
        if ((await stat(candidate)).isDirectory()) return candidate;
      } catch {
        // Not in this kind of rebase.
      }
    }
    return undefined;
  }

  /**
   * Describes index stages 2 and 3 for the operation in progress. During a rebase, stage 2 is the
   * new base plus already replayed commits and stage 3 is the commit being replayed.
   */
  async operation(root: string): Promise<GitOperation> {
    const rebase = await this.rebaseDirectory(root);
    if (rebase) {
      const read = async (name: string) => (await readFile(path.join(rebase, name), "utf8").catch(() => "")).trim();
      const onto = await read("onto");
      const head = (await read("head-name")).replace(/^refs\/heads\//, "");
      const replayed = await this.exists(root, "REBASE_HEAD") ? await this.summary(root, "REBASE_HEAD") : "commit being replayed";
      return {
        kind: "rebase",
        current: `Current: rebase base${onto ? ` ${onto.slice(0, 7)}` : ""} + replayed commits`,
        incoming: `Incoming: replaying ${replayed}${head ? ` from ${head}` : ""}`
      };
    }
    const branch = await this.branch(root);
    if (await this.exists(root, "MERGE_HEAD")) {
      return { kind: "merge", current: `Current: HEAD (${branch})`, incoming: `Incoming: merging ${await this.summary(root, "MERGE_HEAD")}` };
    }
    if (await this.exists(root, "CHERRY_PICK_HEAD")) {
      return { kind: "cherry-pick", current: `Current: HEAD (${branch})`, incoming: `Incoming: cherry-pick ${await this.summary(root, "CHERRY_PICK_HEAD")}` };
    }
    if (await this.exists(root, "REVERT_HEAD")) {
      return { kind: "revert", current: `Current: HEAD (${branch})`, incoming: `Incoming: revert of ${await this.summary(root, "REVERT_HEAD")}` };
    }
    return { kind: "unknown", current: `Current: HEAD (${branch})`, incoming: "Incoming: stash or other change" };
  }

  async log(root: string, relative: string, limit = 50): Promise<RevisionEntry[]> {
    const output = await this.text(root, [
      "--literal-pathspecs", "log", `-n${limit}`, "--date=short", "--format=%H%x1f%h%x1f%ad%x1f%an%x1f%s%x1e", "--", relative
    ]);
    return output.split("\x1e").map(record => record.trim()).filter(Boolean).map(record => {
      const [hash = "", short = "", date = "", author = "", subject = ""] = record.split("\x1f");
      return { hash, short, date, author, subject };
    });
  }

  async add(root: string, relative: string): Promise<void> {
    await this.text(root, ["--literal-pathspecs", "add", "--", relative]);
  }

  /** All values of a configuration key at the given scope (empty when unset). */
  async configValues(cwd: string, scope: "local" | "global", key: string): Promise<string[]> {
    const result = await this.run(cwd, ["config", `--${scope}`, "--null", "--get-all", key]);
    if (result.code === 1) return [];
    if (result.code !== 0) throw new GitError(result.stderr || `Could not read ${key}`);
    return result.stdout.toString("utf8").split("\0").filter((value, index, all) => index < all.length - 1 || value !== "");
  }

  async configSet(cwd: string, scope: "local" | "global", key: string, value: string): Promise<void> {
    await this.text(cwd, ["config", `--${scope}`, "--replace-all", key, value]);
  }

  async configUnset(cwd: string, scope: "local" | "global", key: string): Promise<void> {
    const result = await this.run(cwd, ["config", `--${scope}`, "--unset-all", key]);
    if (result.code !== 0 && result.code !== 5) throw new GitError(result.stderr || `Could not unset ${key}`);
  }
}
