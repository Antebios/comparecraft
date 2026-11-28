// Runs test/web/suite.ts in VS Code for the Web (headless Chromium) with the browser entry point.
const { runTests } = require("@vscode/test-web");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function main() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "comparecraft-web-"));
  try {
    const files = {
      "a.txt": "one\ntwo\n",
      "b.txt": "one\nthree\n",
      "one.bin": Buffer.from([0, 1, 2, 3]),
      "two.bin": Buffer.from([0, 1, 9, 3, 4]),
      "one.csv": "id,name\n1,a\n",
      "two.csv": "id,name\n1,b\n",
      "one.png": Buffer.from(PIXEL, "base64"),
      "two.png": Buffer.from(PIXEL, "base64"),
    };
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(folder, name), content);
    await runTests({
      browserType: "chromium",
      headless: true,
      quality: "stable",
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, "out", "web", "test", "suite.js"),
      folderPath: folder,
      testRunnerDataDir: path.join(root, ".vscode-test-web"),
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
