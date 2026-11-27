const childProcess = require("node:child_process");
const { existsSync, readFileSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getProfileArguments, killTree } = require("@vscode/test-electron/out/util");

const number = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * Same launch as `runTests` from @vscode/test-electron, plus a watchdog. The host tests write
 * "pass" or "fail" to COMPARECRAFT_TEST_RESULT when they finish. Some VS Code builds never exit
 * after the tests are done (1.148 hangs shutting down its Agent Host), so once the result exists
 * VS Code gets a grace period to quit and is then killed; the recorded result decides the run.
 */
async function runHostTests({ vscodeExecutablePath, extensionDevelopmentPath, extensionTestsPath, launchArgs = [], extensionTestsEnv = {} }) {
  const result = path.join(os.tmpdir(), `comparecraft-host-result-${process.pid}-${Date.now()}`);
  rmSync(result, { force: true });
  const grace = number("COMPARECRAFT_HOST_EXIT_GRACE_MS", 30_000);
  const timeout = number("COMPARECRAFT_HOST_TIMEOUT_MS", 20 * 60_000);
  const args = [
    ...launchArgs,
    "--no-sandbox", "--disable-gpu-sandbox", "--disable-updates", "--skip-welcome", "--skip-release-notes",
    "--disable-workspace-trust",
    `--extensionTestsPath=${extensionTestsPath}`,
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
  ];
  args.push(...getProfileArguments(args));
  const shell = process.platform === "win32";
  const child = childProcess.spawn(shell ? `"${vscodeExecutablePath}"` : vscodeExecutablePath, args, {
    env: { ...process.env, ...extensionTestsEnv, COMPARECRAFT_TEST_RESULT: result },
    shell,
  });
  child.stdout.on("data", (data) => process.stdout.write(data));
  child.stderr.on("data", (data) => process.stderr.write(data));
  const recorded = () => (existsSync(result) ? readFileSync(result, "utf8").trim() : undefined);

  try {
    const outcome = await new Promise((resolve) => {
      let done = false;
      let stopping = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(deadline);
        resolve(value);
      };
      const kill = async (reason) => {
        if (done || stopping) return;
        stopping = true;
        console.log(`Host tests: ${reason}; stopping VS Code (pid ${child.pid}).`);
        await killTree(child.pid, true).catch((error) => console.error(error));
        finish({ killed: true, value: recorded() });
      };
      let finishedAt;
      const poll = setInterval(() => {
        const value = recorded();
        if (value === undefined) return;
        finishedAt ??= Date.now();
        if (Date.now() - finishedAt >= grace) void kill(`tests finished (${value}) but VS Code did not exit within ${grace} ms`);
      }, 1000);
      const deadline = setTimeout(() => void kill(`no result after ${timeout} ms`), timeout);
      child.on("error", (error) => console.error(`Host tests: ${error}`));
      child.on("exit", (code, signal) => finish(stopping ? { killed: true, value: recorded() } : { code, signal, value: recorded() }));
    });
    if (outcome.killed) {
      if (outcome.value !== "pass") throw new Error(`Host tests did not pass (result: ${outcome.value ?? "none"}).`);
      return 0;
    }
    console.log(`Exit code:   ${outcome.code ?? outcome.signal}`);
    if (outcome.code !== 0) throw new Error(`Host tests failed: VS Code exited with ${outcome.code ?? outcome.signal}.`);
    return 0;
  } finally {
    rmSync(result, { force: true });
  }
}

module.exports = { runHostTests };
