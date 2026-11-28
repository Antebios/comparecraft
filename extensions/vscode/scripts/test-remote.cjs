// Remote smoke test: runs test/remote.ts in the remote extension host of a Remote-SSH or Dev Containers
// window connected to a disposable local container, using the extension from a platform VSIX.
//
//   node scripts/test-remote.cjs --vsix comparecraft-<version>-linux-x64.vsix --via ssh|container [--keep]
//
// --via ssh connects Remote-SSH to a container running sshd on 127.0.0.1 with a throwaway key; --via
// container opens a folder in a dev container (Dev Containers) built from the same image. Needs Docker, an
// OpenSSH client (for --via ssh), a display (xvfb-run on CI) and network access: the Remote-SSH or Dev
// Containers extension comes from the Marketplace and VS Code downloads its server into the container.
// Everything uses a temporary VS Code profile and extensions folder, removed afterwards with the
// containers (the test image is kept for reruns: docker image rm comparecraft-remote-test). --keep leaves
// the containers and the profile (with VS Code's logs) in place after a failure.
const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require("@vscode/test-electron");
const { killTree } = require("@vscode/test-electron/out/util");
const { spawn, spawnSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveVSCodeExecutable } = require("./vscode-executable.cjs");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const IMAGE = "comparecraft-remote-test";
const HOST = "cc-remote-test";
const HOME = "/home/tester";
const DOCKERFILE = `FROM debian:bookworm-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends openssh-server git ca-certificates curl wget tar procps \\
 && rm -rf /var/lib/apt/lists/* \\
 && useradd -m -s /bin/bash tester \\
 && mkdir -p /run/sshd \\
 && git config --system --add safe.directory '*'
`;
const REMOTES = {
  ssh: { extension: "ms-vscode-remote.remote-ssh", remoteName: "ssh-remote", environment: "a window connected to an SSH host" },
  container: { extension: "ms-vscode-remote.remote-containers", remoteName: "dev-container", environment: "a window connected to a dev container" },
};

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return result.stdout;
}

const docker = (...args) => run("docker", args);
const step = message => console.log(`REMOTE: ${message}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const via = option("--via") ?? "ssh";
  const remote = REMOTES[via];
  const vsix = path.resolve(option("--vsix") ?? path.join(root, `${manifest.name}-${manifest.version}-linux-x64.vsix`));
  if (!remote) throw new Error(`--via must be ${Object.keys(REMOTES).join(" or ")}.`);
  if (!existsSync(vsix)) throw new Error(`${vsix} not found. Package it with npm run package:targets.`);
  const suite = path.join(root, "out", "test", "remote.js");
  if (!existsSync(suite)) throw new Error(`${suite} not found. Run npm run build.`);

  const executable = process.env.VSCODE_EXECUTABLE_PATH ?? resolveVSCodeExecutable(await downloadAndUnzipVSCode());
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
  const directory = mkdtempSync(path.join(os.tmpdir(), "comparecraft-remote-"));
  const container = `comparecraft-remote-${process.pid}`;
  const extensionsDir = path.join(directory, "extensions");
  const profile = path.join(directory, "profile");
  const code = (...args) => run(cli, [...cliArgs, "--extensions-dir", extensionsDir, "--user-data-dir", path.join(directory, "cli-profile"), ...args]);
  let window, passed = false;
  try {
    step(`VS Code ${code("--version").split(/\r?\n/)[0]}; package ${path.basename(vsix)}; via ${via}`);
    code("--install-extension", remote.extension);
    step(`installed ${remote.extension} in the temporary profile`);

    // VS Code unpacks the VSIX exactly as an install would; the remote window runs that copy.
    const unpacked = path.join(directory, "unpacked");
    run(cli, [...cliArgs, "--extensions-dir", unpacked, "--user-data-dir", path.join(directory, "cli-profile"), "--install-extension", vsix]);
    const installed = readdirSync(unpacked).find(name => name.toLowerCase().startsWith(`${manifest.publisher}.${manifest.name}-`.toLowerCase()));
    if (!installed) throw new Error(`The VSIX didn't unpack into ${unpacked}.`);

    run("docker", ["build", "-q", "-t", IMAGE, "-"], { input: DOCKERFILE });
    const settings = {
      "security.workspace.trust.enabled": false,
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "update.mode": "none",
      "telemetry.telemetryLevel": "off",
    };
    // Where the extension, the suite and the results live on the remote host.
    let authority, folder, extension, tests, read, containers;
    const local = path.join(directory, `cc-remote-${process.pid}`);
    if (via === "ssh") {
      docker("run", "-d", "--name", container, "-p", "127.0.0.1::22", IMAGE, "/usr/sbin/sshd", "-D", "-e");
      const port = docker("port", container, "22/tcp").trim().split(/\r?\n/)[0].split(":").pop();
      const key = path.join(directory, "id_ed25519");
      run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "comparecraft-remote-test", "-f", key]);
      run("docker", ["exec", "-i", container, "sh", "-c",
        `mkdir -p ${HOME}/.ssh && cat > ${HOME}/.ssh/authorized_keys && chown -R tester:tester ${HOME}/.ssh && chmod 700 ${HOME}/.ssh && chmod 600 ${HOME}/.ssh/authorized_keys`],
        { input: readFileSync(`${key}.pub`, "utf8") });
      const config = path.join(directory, "ssh_config");
      writeFileSync(config, [
        `Host ${HOST}`, "  HostName 127.0.0.1", `  Port ${port}`, "  User tester", `  IdentityFile ${key}`, "  IdentitiesOnly yes",
        "  StrictHostKeyChecking no", "  UserKnownHostsFile /dev/null", "  LogLevel ERROR", "",
      ].join("\n"));
      Object.assign(settings, {
        "remote.SSH.configFile": config,
        "remote.SSH.remotePlatform": { [HOST]: "linux" },
        "remote.SSH.showLoginTerminal": false,
        "remote.SSH.useLocalServer": false,
        "remote.SSH.localServerDownload": "off",
        "remote.SSH.connectTimeout": 120,
      });
      authority = `ssh-remote+${HOST}`;
      [folder, extension, tests] = [`${HOME}/work`, `${HOME}/ext`, `${HOME}/tests/remote.js`];
      docker("exec", container, "mkdir", "-p", `${HOME}/ext`, `${HOME}/tests`, folder);
      docker("cp", `${path.join(unpacked, installed)}/.`, `${container}:${extension}/`);
      docker("cp", suite, `${container}:${tests}`);
      run("docker", ["exec", "-i", container, "sh", "-c", `cat > ${folder}/remote-test.json`], {
        input: JSON.stringify({ remoteName: remote.remoteName, authority, environment: remote.environment }),
      });
      docker("exec", container, "chown", "-R", "tester:tester", `${HOME}/ext`, `${HOME}/tests`, folder);
      read = file => spawnSync("docker", ["exec", container, "cat", `${folder}/${file}`], { encoding: "utf8" }).stdout ?? "";
      containers = () => [container];
      step(`SSH container ${container} listening on 127.0.0.1:${port} (key-only, throwaway key)`);
    } else {
      // The folder is mounted at /workspaces/<name>; the container keeps running after the window closes
      // so the helper check below means something.
      const name = path.basename(local);
      mkdirSync(path.join(local, ".devcontainer"), { recursive: true });
      writeFileSync(path.join(local, ".devcontainer", "devcontainer.json"), JSON.stringify({
        name: "CompareCraft remote test", image: IMAGE, remoteUser: "tester", shutdownAction: "none",
      }, null, 2));
      cpSync(path.join(unpacked, installed), path.join(local, ".cc", "ext"), { recursive: true });
      mkdirSync(path.join(local, ".cc", "tests"), { recursive: true });
      cpSync(suite, path.join(local, ".cc", "tests", "remote.js"));
      authority = `dev-container+${Buffer.from(local).toString("hex")}`;
      [folder, extension, tests] = [`/workspaces/${name}`, `/workspaces/${name}/.cc/ext`, `/workspaces/${name}/.cc/tests/remote.js`];
      writeFileSync(path.join(local, "remote-test.json"), JSON.stringify({ remoteName: remote.remoteName, authority, environment: remote.environment }));
      read = file => (existsSync(path.join(local, file)) ? readFileSync(path.join(local, file), "utf8") : "");
      containers = () => docker("ps", "-aq", "--filter", `label=devcontainer.local_folder=${local}`).split(/\s+/).filter(Boolean);
      Object.assign(settings, {
        // Keep this computer's Git identity, credentials and display sockets out of the throwaway container.
        "dev.containers.copyGitConfig": false,
        "dev.containers.gitCredentialHelperConfigLocation": "none",
        "dev.containers.dockerCredentialHelper": false,
        "dev.containers.mountWaylandSocket": false,
      });
      step(`dev container folder ${local}`);
    }

    mkdirSync(path.join(profile, "User"), { recursive: true });
    writeFileSync(path.join(profile, "User", "settings.json"), JSON.stringify(settings, null, 2));
    const base = `vscode-remote://${authority}`;
    window = spawn(executable, [
      "--user-data-dir", profile, "--extensions-dir", extensionsDir,
      "--no-sandbox", "--disable-gpu-sandbox", "--disable-updates", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust",
      `--folder-uri=${base}${folder}`,
      `--extensionDevelopmentPath=${base}${extension}`,
      `--extensionTestsPath=${base}${tests}`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    for (const stream of [window.stdout, window.stderr]) stream.on("data", data => output.push(String(data)));
    let exited = false;
    window.on("exit", () => { exited = true; });
    step(`opened ${base}${folder}`);

    let shown = 0, result = "";
    const deadline = Date.now() + Number(process.env.COMPARECRAFT_REMOTE_TIMEOUT_MS || 15 * 60_000);
    while (!result && Date.now() < deadline) {
      await sleep(2000);
      const lines = read("remote-test.log").split("\n").filter(Boolean);
      for (const line of lines.slice(shown)) console.log(line);
      shown = lines.length;
      result = read("remote-test.result").trim();
      if (!result && exited) break;
    }
    if (result !== "pass") {
      console.error(output.join("").split("\n").slice(-60).join("\n"));
      throw new Error(`Remote tests did not pass (result: ${result || "none"}).`);
    }

    // The remote extension host ends with the tests; the helper it started must end with it.
    const [remoteContainer] = containers();
    if (!remoteContainer) throw new Error("The remote container is gone.");
    const helpers = () => spawnSync("docker", ["exec", remoteContainer, "pgrep", "-f", "comparecraft-backend"], { encoding: "utf8" }).stdout.trim();
    const quiet = Date.now() + 60_000;
    while (helpers() && Date.now() < quiet) await sleep(1000);
    if (helpers()) throw new Error(`comparecraft-backend is still running on the remote host: ${helpers()}`);
    step("PASS: the remote extension host stopped the bundled helper when the tests ended");
    console.log("REMOTE: PASS");
    passed = true;
  } finally {
    if (window && window.exitCode === null) await killTree(window.pid, true).catch(() => undefined);
    const created = [container, ...devContainers(directory)];
    if (!passed && process.argv.includes("--keep")) {
      step(`kept ${directory} and containers ${created.join(", ")}; remove them with: docker rm -f ${created.join(" ")}; rm -rf ${directory}`);
    } else {
      spawnSync("docker", ["rm", "-f", ...created], { encoding: "utf8" });
      // Dev Containers derives an image per folder (vsc-<folder>-<hash>...) when it adjusts the user.
      const images = spawnSync("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"], { encoding: "utf8" }).stdout
        .split(/\r?\n/).filter(image => image.startsWith(`vsc-cc-remote-${process.pid}-`));
      if (images.length) spawnSync("docker", ["image", "rm", ...images], { encoding: "utf8" });
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  }
}

/** Containers Dev Containers created for folders under `directory`. */
function devContainers(directory) {
  const result = spawnSync("docker", ["ps", "-a", "--format", "{{.ID}} {{.Label \"devcontainer.local_folder\"}}"], { encoding: "utf8" });
  return (result.stdout ?? "").split(/\r?\n/).map(line => line.split(" ")).filter(([, folder]) => folder?.startsWith(directory)).map(([id]) => id);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
