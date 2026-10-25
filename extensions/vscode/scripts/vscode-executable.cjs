const childProcess = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

function resolveVSCodeExecutable(executable, platform = process.platform) {
  if (platform !== "darwin" || existsSync(executable)) return executable;

  const contents = path.dirname(path.dirname(executable));
  const plist = path.join(contents, "Info.plist");
  const name = childProcess
    .execFileSync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleExecutable", "raw", "-o", "-", plist],
      { encoding: "utf8" },
    )
    .trim();
  if (!name || name !== path.basename(name)) {
    throw new Error(`Invalid CFBundleExecutable in ${plist}: ${name}`);
  }
  const resolved = path.join(contents, "MacOS", name);
  if (!existsSync(resolved)) {
    throw new Error(
      `VS Code bundle executable not found: ${resolved} (reported path: ${executable})`,
    );
  }
  return resolved;
}

module.exports = { resolveVSCodeExecutable };
