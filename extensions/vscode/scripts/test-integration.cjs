const { runTests } = require("@vscode/test-electron");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "comparecraft-vscode-host-"));
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, ".."),
      extensionTestsPath: path.resolve(__dirname, "..", "out", "test", "host.js"),
      ...(process.env.VSCODE_EXECUTABLE_PATH ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH } : {}),
      launchArgs: [
        directory, "--disable-extensions", "--disable-workspace-trust",
        "--skip-welcome", "--skip-release-notes", "--user-data-dir", path.join(directory, "profile")
      ],
      extensionTestsEnv: {
        COMPARECRAFT_TEST_NODE: process.execPath,
        COMPARECRAFT_TEST_DIRECTORY: directory,
        ...(process.env.COMPARECRAFT_BACKEND ? { COMPARECRAFT_TEST_BACKEND: process.env.COMPARECRAFT_BACKEND } : {})
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
