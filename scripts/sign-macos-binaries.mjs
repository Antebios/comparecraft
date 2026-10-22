import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Command-line helpers Tauri copies into Contents/MacOS; each must be signed before the app is.
export const MACOS_HELPERS = ["ccomp", "comparecraft-backend"];

export function signMacosBinaries({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  run = spawnSync,
} = {}) {
  if (platform !== "darwin") return;

  const targetDirectory = resolve(env.CARGO_TARGET_DIR || "src-tauri/target");
  const profile = env.TAURI_ENV_DEBUG === "true" ? "debug" : "release";
  const directories = [targetDirectory];
  if (env.TAURI_ENV_TARGET_TRIPLE)
    directories.push(resolve(targetDirectory, env.TAURI_ENV_TARGET_TRIPLE));
  const binaries = MACOS_HELPERS.flatMap((helper) => {
    const found = directories
      .map((directory) => resolve(directory, profile, helper))
      .filter((binary) => exists(binary));
    if (found.length === 0)
      throw new Error(`No built macOS ${helper} binary found before bundling.`);
    return found;
  });

  const identity = env.APPLE_SIGNING_IDENTITY || "-";
  for (const binary of binaries) {
    for (const args of [
      [
        "--force",
        "--sign",
        identity,
        "--options",
        "runtime",
        ...(identity === "-" ? [] : ["--timestamp"]),
        binary,
      ],
      ["--verify", "--strict", binary],
    ]) {
      const result = run("codesign", args, { stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(`codesign failed for ${binary} (exit ${result.status}).`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  signMacosBinaries();