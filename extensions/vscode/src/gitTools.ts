import type { Git } from "./git";

export type ConfigScope = "local" | "global";
export type ToolKinds = "both" | "merge" | "diff";

export const TOOL_NAME = "comparecraft";

/** Quotes one word for the POSIX shell Git uses to run tool commands (also Git for Windows). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Git for Windows' shell treats backslashes specially in some contexts; forward slashes are unambiguous. */
export function toolExecutablePath(executable: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? executable.replace(/\\/g, "/") : executable;
}

/**
 * Builds a Git tool command. `-solo` precedes `--` so the desktop process stays tied to this
 * invocation (ccomp only appends it after the arguments, where `--` would make it a path).
 */
export function toolCommand(
  executable: string,
  variables: readonly string[],
  platform: NodeJS.Platform = process.platform,
  leading: readonly string[] = []
): string {
  return [
    shellQuote(toolExecutablePath(executable, platform)),
    ...leading.map(shellQuote),
    "-solo", "--",
    ...variables.map(name => `"$${name}"`)
  ].join(" ");
}

export function proposedSettings(
  executable: string,
  kinds: ToolKinds,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const settings: Record<string, string> = {};
  if (kinds !== "diff") {
    settings["merge.tool"] = TOOL_NAME;
    settings[`mergetool.${TOOL_NAME}.cmd`] = toolCommand(executable, ["LOCAL", "REMOTE", "BASE", "MERGED"], platform);
    // The desktop exit code does not distinguish a saved resolution from a cancel.
    settings[`mergetool.${TOOL_NAME}.trustExitCode`] = "false";
  }
  if (kinds !== "merge") {
    settings["diff.tool"] = TOOL_NAME;
    settings[`difftool.${TOOL_NAME}.cmd`] = toolCommand(executable, ["LOCAL", "REMOTE"], platform);
  }
  return settings;
}

export interface ToolEntry {
  readonly key: string;
  readonly applied: string;
  /** Value before CompareCraft first applied it; undefined means it was unset. */
  readonly previous?: string;
}

export interface ToolRecord {
  readonly scope: ConfigScope;
  /** Repository root for local scope; working directory used for global scope. */
  readonly cwd: string;
  readonly entries: readonly ToolEntry[];
}

export interface ExistingValue {
  readonly key: string;
  readonly current?: string;
  readonly proposed: string;
}

export async function inspectSettings(git: Git, cwd: string, scope: ConfigScope, settings: Record<string, string>): Promise<ExistingValue[]> {
  const result: ExistingValue[] = [];
  for (const [key, proposed] of Object.entries(settings)) {
    const values = await git.configValues(cwd, scope, key);
    if (values.length > 1) {
      throw new Error(`${key} has multiple ${scope} values. Edit it manually; CompareCraft will not replace multi-valued settings.`);
    }
    result.push({ key, current: values[0], proposed });
  }
  return result;
}

/**
 * Applies settings and returns a record for reversal. When reapplying over an earlier record whose
 * value is still in place, the originally preserved value is kept rather than CompareCraft's own.
 */
export async function applySettings(
  git: Git, cwd: string, scope: ConfigScope, settings: Record<string, string>, earlier?: ToolRecord
): Promise<ToolRecord> {
  const existing = await inspectSettings(git, cwd, scope, settings);
  const entries: ToolEntry[] = [];
  for (const value of existing) {
    const prior = earlier?.entries.find(entry => entry.key === value.key);
    const previous = prior && prior.applied === value.current ? prior.previous : value.current;
    await git.configSet(cwd, scope, value.key, value.proposed);
    entries.push({ key: value.key, applied: value.proposed, previous });
  }
  for (const prior of earlier?.entries ?? []) {
    if (!(prior.key in settings)) entries.push(prior);
  }
  return { scope, cwd, entries };
}

export interface RemovalResult {
  readonly restored: string[];
  /** Keys changed by the user after setup; left untouched. */
  readonly skipped: string[];
}

export async function removeSettings(git: Git, record: ToolRecord): Promise<RemovalResult> {
  const restored: string[] = [], skipped: string[] = [];
  for (const entry of record.entries) {
    const values = await git.configValues(record.cwd, record.scope, entry.key);
    if (values.length !== 1 || values[0] !== entry.applied) {
      skipped.push(entry.key);
      continue;
    }
    if (entry.previous === undefined) await git.configUnset(record.cwd, record.scope, entry.key);
    else await git.configSet(record.cwd, record.scope, entry.key, entry.previous);
    restored.push(entry.key);
  }
  return { restored, skipped };
}
