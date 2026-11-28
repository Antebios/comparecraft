// Bundles the browser entry point (vscode.dev, github.dev) and the browser test suite with esbuild.
// The browser platform has no Node built-ins: importing one (directly or through a shared module) fails
// the build, which keeps Node-only code out of the web extension.
const esbuild = require("esbuild");
const path = require("node:path");

const root = path.join(__dirname, "..");
const common = {
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "warning",
  absWorkingDir: root,
};

async function main() {
  await esbuild.build({ ...common, entryPoints: ["src/web/extension.ts"], outfile: "out/web/extension.js" });
  if (process.argv.includes("--tests")) {
    // The suite asserts with its own helpers; Node's assert module isn't available in the browser.
    await esbuild.build({ ...common, entryPoints: ["test/web/suite.ts"], outfile: "out/web/test/suite.js" });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
