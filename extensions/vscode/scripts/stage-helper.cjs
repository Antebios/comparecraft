// Builds the comparecraft-backend helper without the desktop app (no Tauri or WebView: the `native`
// feature only) and stages it for scripts/package-targets.cjs as <out>/<target>/comparecraft-backend[.exe].
//
//   node scripts/stage-helper.cjs --target linux-x64 [--also alpine-x64] [--rust-target <triple>] [--out helpers]
//
// Linux helpers link statically (musl), so one binary runs on every distribution, Alpine included, and in
// containers without extra libraries; other architectures cross-compile with Rust's bundled rust-lld.
// Builds go to src-tauri/target/portable, apart from desktop builds.
const { spawnSync } = require("node:child_process");
const { chmodSync, copyFileSync, mkdirSync, statSync } = require("node:fs");
const path = require("node:path");

const RUST_TARGETS = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "alpine-x64": "x86_64-unknown-linux-musl",
  "alpine-arm64": "aarch64-unknown-linux-musl",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
};

const root = path.join(__dirname, "..");
const crate = path.resolve(root, "..", "..", "src-tauri");

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

const target = option("--target");
if (!target || !RUST_TARGETS[target]) fail(`Usage: node scripts/stage-helper.cjs --target <${Object.keys(RUST_TARGETS).join("|")}> [--also <target>] [--rust-target <triple>] [--out <directory>]`);
const also = (option("--also") ?? "").split(",").filter(Boolean);
for (const extra of also) {
  if (RUST_TARGETS[extra] !== RUST_TARGETS[target]) fail(`--also ${extra} needs a different build than ${target}.`);
}
const rustTarget = option("--rust-target") ?? RUST_TARGETS[target];
const out = path.resolve(option("--out") ?? path.join(root, "helpers"));
const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(crate, "target", "portable");

// The target's standard library (a no-op when installed); without rustup, cargo reports what's missing.
spawnSync("rustup", ["target", "add", rustTarget], { stdio: "inherit" });

const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
const hostArch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
const linker = `CARGO_TARGET_${rustTarget.toUpperCase().replace(/-/g, "_")}_LINKER`;
if (rustTarget.endsWith("-linux-musl") && !rustTarget.startsWith(`${hostArch}-`) && !env[linker]) env[linker] = "rust-lld";

const build = spawnSync("cargo", [
  "build", "--release", "--no-default-features", "--features", "native",
  "--bin", "comparecraft-backend", "--target", rustTarget,
], { cwd: crate, stdio: "inherit", env });
if (build.error) fail(`Could not run cargo: ${build.error.message}`);
if (build.status !== 0) process.exit(build.status ?? 1);

const name = rustTarget.includes("windows") ? "comparecraft-backend.exe" : "comparecraft-backend";
const binary = path.join(targetDir, rustTarget, "release", name);
for (const staged of [target, ...also]) {
  const directory = path.join(out, staged);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  copyFileSync(binary, file);
  if (!name.endsWith(".exe")) chmodSync(file, 0o755);
  console.log(`Staged ${file} (${rustTarget}, ${(statSync(file).size / (1 << 20)).toFixed(1)} MB)`);
}
