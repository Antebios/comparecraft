// Packages the platform-specific VSIX files, each bundling the comparecraft-backend helper for its
// platform, and the universal VSIX (no helper: WebAssembly engine only, for other platforms and the web).
//
//   node scripts/package-targets.cjs --helpers <directory> [--targets linux-x64,darwin-arm64,...] [--no-universal]
//
// <directory>/<target>/ holds comparecraft-backend (comparecraft-backend.exe for win32 targets). Targets
// without a helper there are skipped with a warning. Build outputs come from `npm run build:all` (run here
// unless COMPARECRAFT_PREBUILT=1).
const { spawnSync } = require("node:child_process");
const { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");

const TARGETS = ["win32-x64", "win32-arm64", "linux-x64", "linux-arm64", "alpine-x64", "alpine-arm64", "darwin-x64", "darwin-arm64"];
const root = path.join(__dirname, "..");
const bin = path.join(root, "bin");
const { version } = require(path.join(root, "package.json"));

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const helpers = option("--helpers");
if (!helpers) {
  console.error("Usage: node scripts/package-targets.cjs --helpers <directory> [--targets a,b] [--no-universal]");
  process.exit(2);
}
const targets = (option("--targets") ?? TARGETS.join(",")).split(",").filter(Boolean);
for (const target of targets) {
  if (!TARGETS.includes(target)) {
    console.error(`Unknown target ${target}. Valid targets: ${TARGETS.join(", ")}`);
    process.exit(2);
  }
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const vsce = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
if (process.env.COMPARECRAFT_PREBUILT !== "1") run(npm, ["run", "build:all"]);

const packaged = [];
try {
  for (const target of targets) {
    const name = target.startsWith("win32") ? "comparecraft-backend.exe" : "comparecraft-backend";
    const helper = path.resolve(helpers, target, name);
    if (!existsSync(helper)) {
      console.warn(`Skipping ${target}: ${helper} not found.`);
      continue;
    }
    rmSync(bin, { recursive: true, force: true });
    mkdirSync(bin, { recursive: true });
    copyFileSync(helper, path.join(bin, name));
    if (!target.startsWith("win32")) chmodSync(path.join(bin, name), 0o755);
    const out = `comparecraft-${version}-${target}.vsix`;
    run(vsce, ["package", "--no-dependencies", "--target", target, "--out", out], { COMPARECRAFT_PREBUILT: "1" });
    packaged.push(out);
  }
  if (!process.argv.includes("--no-universal")) {
    rmSync(bin, { recursive: true, force: true });
    const out = `comparecraft-${version}.vsix`;
    run(vsce, ["package", "--no-dependencies", "--out", out], { COMPARECRAFT_PREBUILT: "1" });
    packaged.push(out);
  }
} finally {
  rmSync(bin, { recursive: true, force: true });
}
console.log(`Packaged: ${packaged.join(", ") || "nothing"}`);
