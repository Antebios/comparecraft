// Builds the WebAssembly comparison engine from src-tauri (the same Rust engine as the desktop app and
// helper, without Tauri) into media/engine/comparecraft-engine.wasm.
const { spawnSync } = require("node:child_process");
const { copyFileSync, mkdirSync, statSync } = require("node:fs");
const path = require("node:path");

const TARGET = "wasm32-unknown-unknown";
const repository = path.resolve(__dirname, "..", "..", "..");
const manifest = path.join(repository, "src-tauri", "Cargo.toml");
const output = path.join(__dirname, "..", "media", "engine", "comparecraft-engine.wasm");

const result = spawnSync("cargo", ["build", "--manifest-path", manifest, "--lib", "--release", "--no-default-features", "--target", TARGET], {
  stdio: "inherit",
  shell: false,
});
if (result.error) {
  console.error(`Could not run cargo (${result.error.message}). Install Rust from https://rustup.rs, then run: rustup target add ${TARGET}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`The WebAssembly engine build failed. If the target is missing, run: rustup target add ${TARGET}`);
  process.exit(result.status ?? 1);
}
const targetDirectory = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(repository, "src-tauri", "target");
mkdirSync(path.dirname(output), { recursive: true });
copyFileSync(path.join(targetDirectory, TARGET, "release", "comparecraft_lib.wasm"), output);
console.log(`WebAssembly engine: ${path.relative(process.cwd(), output)} (${statSync(output).size} bytes)`);
