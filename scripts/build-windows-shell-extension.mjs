import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

if (process.platform !== "win32") {
  process.exit(0);
}

const manifest = resolve("src-tauri", "windows-shell-extension", "Cargo.toml");
const targetDir = resolve("src-tauri", "target");

for (const release of [false, true]) {
  const args = ["build", "--manifest-path", manifest, "--target-dir", targetDir];
  if (release) args.push("--release");
  const result = spawnSync("cargo", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
