import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const environment = join(root, ".venv-docs");
const windows = process.platform === "win32";
const python = join(environment, windows ? "Scripts/python.exe" : "bin/python");
const action = process.argv[2];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (action === "install") {
  run(windows ? "python" : "python3", ["-m", "venv", environment]);
  run(python, ["-m", "pip", "install", "-r", "docs/requirements.txt"]);
} else if (action === "serve" || action === "build") {
  if (!existsSync(python)) {
    console.error("Run npm run docs:install first to create the docs environment.");
    process.exit(1);
  }
  run(python, ["-m", "mkdocs", action, ...(action === "build" ? ["--strict"] : [])]);
} else {
  console.error("Usage: node scripts/docs.mjs install|serve|build");
  process.exit(1);
}