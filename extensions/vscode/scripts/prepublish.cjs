// Builds every file a VSIX contains: the shared webview bundle, the WebAssembly engine, the Node extension
// and the browser bundle. scripts/package-targets.cjs builds once and sets COMPARECRAFT_PREBUILT=1 so each
// platform package doesn't rebuild.
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const outputs = ["media/webview/webview.js", "media/engine/comparecraft-engine.wasm", "out/src/extension.js", "out/web/extension.js"];

if (process.env.COMPARECRAFT_PREBUILT === "1") {
  const missing = outputs.filter(file => !existsSync(path.join(root, file)));
  if (missing.length) {
    console.error(`COMPARECRAFT_PREBUILT=1, but these build outputs are missing: ${missing.join(", ")}. Run npm run build:all.`);
    process.exit(1);
  }
  process.exit(0);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["run", "build:all"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
