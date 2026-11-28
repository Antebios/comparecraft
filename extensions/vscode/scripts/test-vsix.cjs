// Verifies a packaged VSIX in an isolated VS Code profile: installs an older
// build, upgrades to the packaged one, checks the installed files, runs the host
// and Restricted Mode tests against the installed copy, then uninstalls it. Never publishes.
//
//   node scripts/test-vsix.cjs [comparecraft-<version>[-<target>].vsix]
//
// Platform packages (named with their target, from scripts/package-targets.cjs) must bundle the helper
// and are tested with it; the universal package must not, and is tested with COMPARECRAFT_BACKEND if set,
// otherwise with the WebAssembly engine alone.
const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require("@vscode/test-electron");
const { runHostTests, runRestrictedModeTests } = require("./run-host-tests.cjs");
const { spawnSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveVSCodeExecutable } = require("./vscode-executable.cjs");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
const olderVersion = "0.0.1";

function quote(arg) {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg}"`;
}

function run(command, args, options = {}) {
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const result = shell
    ? spawnSync([command, ...args].map(quote).join(" "), { ...options, shell: true, encoding: "utf8" })
    : spawnSync(command, args, { ...options, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args.join(" ")} exited with ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function packageOlderVsix(directory) {
  const staging = path.join(directory, "older");
  for (const item of [
    "README.md",
    "LICENSE",
    ".vscodeignore",
    manifest.icon,
    path.join("out", "src"),
    path.join("out", "web", "extension.js"),
    path.join("media", "webview"),
    path.join("media", "engine"),
  ]) {
    cpSync(path.join(root, item), path.join(staging, item), {
      recursive: true,
    });
  }
  const older = { ...manifest, version: olderVersion, scripts: {}, devDependencies: {} };
  writeFileSync(path.join(staging, "package.json"), JSON.stringify(older, null, 2));
  const output = path.join(directory, `${manifest.name}-${olderVersion}.vsix`);
  run(process.execPath, [path.join(root, "node_modules", "@vscode", "vsce", "vsce"), "package", "--no-dependencies", "--out", output], { cwd: staging });
  return output;
}

function listFiles(directory, prefix = "") {
  return readdirSync(directory).flatMap(name => {
    const relative = prefix ? `${prefix}/${name}` : name;
    return statSync(path.join(directory, name)).isDirectory() ? listFiles(path.join(directory, name), relative) : [relative];
  });
}

/** The installed folder; VS Code appends the target platform for platform-specific packages. */
function installedFolder(extensionsDir) {
  const prefix = `${id}-${manifest.version}`;
  const folder = readdirSync(extensionsDir).find(name => name.toLowerCase() === prefix || name.toLowerCase().startsWith(`${prefix}-`));
  if (!folder) throw new Error(`${prefix} isn't installed in ${extensionsDir}.`);
  return path.join(extensionsDir, folder);
}

function checkInstalledFiles(installed, helper) {
  const files = listFiles(installed);
  const lower = new Set(files.map(file => file.toLowerCase()));
  const screenshots = readdirSync(path.join(root, "media", "screenshots"))
    .filter(file => file.endsWith(".png"))
    .map(file => `media/screenshots/${file}`);
  const required = [
    "package.json",
    "readme.md",
    "changelog.md",
    "license.txt",
    manifest.icon,
    manifest.main.replace(/^\.\//, ""),
    manifest.browser.replace(/^\.\//, ""),
    "media/webview/webview.js",
    "media/webview/webview.css",
    "media/engine/comparecraft-engine.wasm",
    ...screenshots,
    ...(helper ? [helper] : []),
  ];
  const missing = required.filter(file => !lower.has(file.toLowerCase()));
  const forbidden = files.filter(file => /^(src|test|scripts|node_modules|helpers|out\/test|out\/web\/test)\//.test(file)
    || (!helper && file.startsWith("bin/"))
    || /\.(map|vsix)$/.test(file) || (/\.ts$/.test(file) && !/\.d\.ts$/.test(file))
    || /^(\.gitignore|tsconfig\.json|package-lock\.json|dev\.code-workspace|development\.md)$/i.test(file));
  if (missing.length || forbidden.length) {
    throw new Error(`Installed VSIX content check failed. Missing: ${missing.join(", ") || "none"}. Unexpected: ${forbidden.join(", ") || "none"}.`);
  }
  const readme = readFileSync(path.join(installed, files.find(file => file.toLowerCase() === "readme.md")), "utf8");
  for (const screenshot of screenshots) {
    if (!readme.includes(`](${manifest.vsce.baseImagesUrl}/${screenshot})`)) {
      throw new Error(`Packaged README must link to the repository subdirectory for ${screenshot}.`);
    }
  }
  const installedManifest = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
  if (installedManifest.version !== manifest.version || installedManifest.contributes.commands.length !== manifest.contributes.commands.length) {
    throw new Error("Installed package.json does not match the source manifest.");
  }
  return files.length;
}

async function main() {
  const vsix = path.resolve(process.argv[2] ?? path.join(root, `${manifest.name}-${manifest.version}.vsix`));
  if (!existsSync(vsix)) throw new Error(`${vsix} not found. Run npm run package first.`);
  const target = /-((?:win32|linux|alpine|darwin)-(?:x64|arm64|armhf))\.vsix$/.exec(path.basename(vsix))?.[1];
  const helper = target && `bin/${target.startsWith("win32") ? "comparecraft-backend.exe" : "comparecraft-backend"}`;
  // Platform packages are tested with their own helper, never one from the environment.
  const helperEnv = helper ? { COMPARECRAFT_TEST_BUNDLED: "1" }
    : process.env.COMPARECRAFT_BACKEND ? { COMPARECRAFT_TEST_BACKEND: process.env.COMPARECRAFT_BACKEND } : {};
  const executable = process.env.VSCODE_EXECUTABLE_PATH ?? resolveVSCodeExecutable(await downloadAndUnzipVSCode());
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
  const directory = mkdtempSync(path.join(os.tmpdir(), "comparecraft-vsix-"));
  const extensionsDir = path.join(directory, "extensions");
  const code = (...args) => run(cli, [...cliArgs, "--extensions-dir", extensionsDir, "--user-data-dir", path.join(directory, "cli-profile"), ...args]);
  const installedVersion = () => code("--list-extensions", "--show-versions").split(/\r?\n/)
    .map(line => line.trim().toLowerCase()).find(line => line.startsWith(`${id}@`))?.slice(id.length + 1);
  const step = message => console.log(`VSIX: ${message}`);
  try {
    step(`VS Code ${code("--version").split(/\r?\n/)[0]} (${process.platform}-${process.arch}), package ${path.basename(vsix)} (${target ?? "universal"})`);
    code("--install-extension", packageOlderVsix(directory));
    if (installedVersion() !== olderVersion) throw new Error(`Expected ${id}@${olderVersion} after installing the older VSIX.`);
    step(`installed older ${olderVersion}`);

    code("--install-extension", vsix);
    if (installedVersion() !== manifest.version) throw new Error(`Expected ${id}@${manifest.version} after upgrading.`);
    const installed = installedFolder(extensionsDir);
    const count = checkInstalledFiles(installed, helper);
    step(`upgraded to ${manifest.version}; ${count} installed files passed the content check${helper ? `, including ${helper}` : ", no helper"}`);

    if (process.env.COMPARECRAFT_VSIX_SKIP_HOST === "1") {
      step("host tests skipped (COMPARECRAFT_VSIX_SKIP_HOST=1)");
    } else {
      const workspace = path.join(directory, "workspace");
      mkdirSync(workspace, { recursive: true });
      await runHostTests({
        vscodeExecutablePath: executable,
        extensionDevelopmentPath: installed,
        extensionTestsPath: path.join(root, "out", "test", "host.js"),
        launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes",
          "--user-data-dir", path.join(directory, "host-profile")],
        extensionTestsEnv: {
          COMPARECRAFT_TEST_NODE: process.execPath,
          COMPARECRAFT_TEST_DIRECTORY: workspace,
          ...helperEnv
        }
      });
      step("host tests passed against the installed extension files");
      await runRestrictedModeTests({
        vscodeExecutablePath: executable,
        extensionDevelopmentPath: installed,
        extensionTestsPath: path.join(root, "out", "test", "restricted.js"),
        extensionTestsEnv: helperEnv,
        // Without a helper, keep an installed desktop app's helper out of the test: Node has none beside it.
        settings: Object.keys(helperEnv).length ? {} : { "comparecraft.desktopPath": process.execPath }
      });
      step("Restricted Mode tests passed against the installed extension files");
    }

    code("--uninstall-extension", id);
    if (installedVersion() !== undefined) throw new Error(`${id} is still listed after uninstalling.`);
    step("uninstalled; extension no longer listed");
    console.log("VSIX: PASS");
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
