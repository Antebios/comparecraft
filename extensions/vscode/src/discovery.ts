import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

interface DiscoveryOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  override?: string;
  isExecutable?: (value: string) => Promise<boolean>;
}

export class InstallationError extends Error {}

export function desktopCandidates(options: DiscoveryOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  if (platform === "win32") {
    const directories = [
      env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local"),
      env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]
    ].filter((value): value is string => Boolean(value));
    return [...new Set(directories.map(dir => path.win32.join(dir, "CompareCraft", "comparecraft.exe")))];
  }
  if (platform === "darwin") {
    return [
      "/Applications/CompareCraft.app/Contents/MacOS/comparecraft",
      path.posix.join(home, "Applications", "CompareCraft.app", "Contents", "MacOS", "comparecraft")
    ];
  }
  if (platform === "linux") {
    return ["/usr/bin/comparecraft", "/usr/local/bin/comparecraft", path.posix.join(home, ".local", "bin", "comparecraft")];
  }
  throw new InstallationError(`CompareCraft does not support the ${platform} platform.`);
}

async function isExecutable(value: string): Promise<boolean> {
  try {
    if (!(await stat(value)).isFile()) return false;
    await access(value, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error &&
        ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))) return false;
    throw error;
  }
}

export async function discoverDesktop(options: DiscoveryOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const override = options.override ?? "";
  const check = options.isExecutable ?? isExecutable;
  if (override) {
    if (!paths.isAbsolute(override)) {
      throw new InstallationError("comparecraft.desktopPath must be an absolute path to an executable, not a directory or command.");
    }
    if (platform === "win32" && paths.extname(override).toLowerCase() !== ".exe") {
      throw new InstallationError("On Windows, comparecraft.desktopPath must point to an .exe file.");
    }
    if (!(await check(override))) {
      throw new InstallationError(`The configured CompareCraft executable is missing or not executable: ${override}. Correct comparecraft.desktopPath; automatic discovery was not used.`);
    }
    return override;
  }
  const candidates = desktopCandidates(options);
  for (const candidate of candidates) {
    if (await check(candidate)) return candidate;
  }
  throw new InstallationError(`CompareCraft was not found. Install the desktop app or use Locate Desktop Executable. Checked: ${candidates.join(", ")}.`);
}
