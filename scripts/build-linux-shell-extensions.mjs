import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

if (process.platform !== "linux") process.exit(0);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const release = process.argv.includes("--release");
const test = process.argv.includes("--test");
const target = resolve("src-tauri/target");
run("cargo", [
  "build",
  "--manifest-path",
  "src-tauri/shell-menu/Cargo.toml",
  "--target-dir",
  target,
  ...(release ? ["--release"] : []),
]);
const flags = spawnSync("pkg-config", ["--cflags", "--libs", "thunarx-3"], {
  encoding: "utf8",
});
if (flags.status !== 0) {
  console.warn(
    "Thunar development files unavailable; skipping optional Thunar provider.",
  );
}
const output = resolve(target, release ? "release" : "debug");
if (flags.status === 0) {
  run("cc", [
    "-shared",
    "-fPIC",
    "-Wall",
    "-Wextra",
    "-Werror",
    "packaging/linux/thunar/comparecraft.c",
    "-o",
    resolve(output, "libcomparecraft-thunar.so"),
    "-L" + output,
    "-lcomparecraft_menu",
    "-Wl,-rpath,$ORIGIN:$ORIGIN/../comparecraft",
    ...flags.stdout.trim().split(/\s+/),
  ]);
  if (test) {
    const executable = resolve(output, "test-thunar-menu");
    run("cc", [
      "-Wall",
      "-Wextra",
      "-Werror",
      "tests/shell_menus_thunar.c",
      "-o",
      executable,
      "-L" + output,
      "-lcomparecraft_menu",
      "-Wl,-rpath," + output,
      ...flags.stdout.trim().split(/\s+/),
    ]);
    run(executable, []);
  }
}
if (existsSync("/usr/lib/cmake/KF6KIO")) {
  const build = resolve(target, release ? "dolphin-release" : "dolphin-debug");
  run("cmake", [
    "-S",
    "packaging/linux/dolphin",
    "-B",
    build,
    "-DCMAKE_BUILD_TYPE=" + (release ? "Release" : "Debug"),
    "-DBUILD_TESTING=" + (test ? "ON" : "OFF"),
    "-DCOMPARECRAFT_MENU_LIBRARY=" + resolve(output, "libcomparecraft_menu.so"),
    "-DCOMPARECRAFT_MENU_DIRECTORY=" + output,
  ]);
  run("cmake", ["--build", build]);
  if (test) run("ctest", ["--test-dir", build, "--output-on-failure"]);
} else {
  console.warn(
    "KDE development files unavailable; skipping optional Dolphin provider.",
  );
}
if (test) {
  run("cargo", ["test", "--manifest-path", "src-tauri/shell-menu/Cargo.toml"]);
  run("python3", [
    "tests/test_shell_menus.py",
    resolve(output, "libcomparecraft_menu.so"),
  ]);
}
