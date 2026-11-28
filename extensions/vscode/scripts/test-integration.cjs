const { downloadAndUnzipVSCode } = require("@vscode/test-electron");
const { runHostTests } = require("./run-host-tests.cjs");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { resolveVSCodeExecutable } = require("./vscode-executable.cjs");

async function main() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "comparecraft-vscode-host-"),
  );
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH ?? resolveVSCodeExecutable(await downloadAndUnzipVSCode());
  try {
    await runHostTests({
      extensionDevelopmentPath: path.resolve(__dirname, ".."),
      extensionTestsPath: path.resolve(
        __dirname,
        "..",
        "out",
        "test",
        "host.js",
      ),
      vscodeExecutablePath,
      launchArgs: [
        directory,
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        "--user-data-dir",
        path.join(directory, "profile"),
      ],
      extensionTestsEnv: {
        COMPARECRAFT_TEST_NODE: process.execPath,
        COMPARECRAFT_TEST_DIRECTORY: directory,
        ...(process.env.COMPARECRAFT_BACKEND
          ? { COMPARECRAFT_TEST_BACKEND: process.env.COMPARECRAFT_BACKEND }
          : {}),
      },
    });
    await restrictedMode(vscodeExecutablePath);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500,
    });
  }
}

/** A second window whose folder opens untrusted (Restricted Mode), with workspace trust left on. */
async function restrictedMode(vscodeExecutablePath) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "comparecraft-vscode-restricted-"));
  try {
    const folder = path.join(directory, "untrusted");
    const profile = path.join(directory, "profile");
    await mkdir(folder);
    await mkdir(path.join(profile, "User"), { recursive: true });
    await writeFile(path.join(profile, "User", "settings.json"), JSON.stringify({
      "security.workspace.trust.enabled": true,
      "security.workspace.trust.startupPrompt": "never",
      "security.workspace.trust.banner": "never",
    }));
    await runHostTests({
      extensionDevelopmentPath: path.resolve(__dirname, ".."),
      extensionTestsPath: path.resolve(__dirname, "..", "out", "test", "restricted.js"),
      vscodeExecutablePath,
      workspaceTrust: true,
      launchArgs: [folder, "--disable-extensions", "--user-data-dir", profile],
      extensionTestsEnv: {
        COMPARECRAFT_TEST_DIRECTORY: folder,
        ...(process.env.COMPARECRAFT_BACKEND ? { COMPARECRAFT_TEST_BACKEND: process.env.COMPARECRAFT_BACKEND } : {}),
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
