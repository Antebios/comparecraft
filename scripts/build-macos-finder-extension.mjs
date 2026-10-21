import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";

const test = process.argv.includes("--test");
if (process.platform !== "darwin") {
  if (test)
    console.warn(
      "Native Finder tests require macOS and Xcode; no native tests executed.",
    );
  process.exit(0);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const output = resolve("src-tauri/target/finder-extension");
const bundle = resolve(output, "CompareCraftFinder.appex");
const contents = resolve(bundle, "Contents");
const executable = resolve(contents, "MacOS/CompareCraftFinder");
mkdirSync(resolve(contents, "MacOS"), { recursive: true });
const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
writeFileSync(
  resolve(contents, "Info.plist"),
  readFileSync("packaging/macos/finder/Info.plist", "utf8").replaceAll(
    "@VERSION@",
    config.version,
  ),
);
const sources = [
  "packaging/macos/finder/FinderMenuModel.swift",
  "packaging/macos/finder/FinderSync.swift",
];
const architectures = ["arm64", "x86_64"];
for (const architecture of architectures) {
  run("xcrun", [
    "swiftc",
    "-swift-version",
    "5",
    "-parse-as-library",
    "-emit-executable",
    "-application-extension",
    "-module-name",
    "CompareCraftFinder",
    "-target",
    `${architecture}-apple-macos12.0`,
    "-Xlinker",
    "-e",
    "-Xlinker",
    "_NSExtensionMain",
    "-framework",
    "Cocoa",
    "-framework",
    "FinderSync",
    ...sources,
    "-o",
    resolve(output, `finder-${architecture}`),
  ]);
}
run("xcrun", [
  "lipo",
  "-create",
  ...architectures.map((architecture) =>
    resolve(output, `finder-${architecture}`),
  ),
  "-output",
  executable,
]);
const profile = process.env.COMPARECRAFT_FINDER_PROVISIONING_PROFILE;
if (profile)
  copyFileSync(profile, resolve(contents, "embedded.provisionprofile"));
else if (existsSync(resolve(contents, "embedded.provisionprofile"))) {
  throw new Error(
    "Stale Finder provisioning profile present; remove the generated finder-extension directory before an unsigned build.",
  );
}
const identity = process.env.APPLE_SIGNING_IDENTITY || "-";
run("codesign", [
  "--force",
  "--sign",
  identity,
  "--options",
  "runtime",
  "--entitlements",
  "packaging/macos/finder/Extension.entitlements",
  ...(identity === "-" ? [] : ["--timestamp"]),
  bundle,
]);
run("codesign", ["--verify", "--strict", bundle]);
run("plutil", ["-lint", resolve(contents, "Info.plist")]);
if (test) {
  const fixture = resolve(output, "finder-menu-fixture.json");
  run("cargo", [
    "run",
    "--quiet",
    "--manifest-path",
    "src-tauri/shell-menu/Cargo.toml",
    "--example",
    "finder-fixture",
    "--",
    fixture,
  ]);
  const tests = resolve(output, "finder-menu-tests");
  run("xcrun", [
    "swiftc",
    "-swift-version",
    "5",
    "-parse-as-library",
    sources[0],
    "tests/FinderMenuTests.swift",
    "-o",
    tests,
  ]);
  run(tests, [fixture]);
}
