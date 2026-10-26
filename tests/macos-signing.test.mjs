import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { signMacosBinaries } from "../scripts/sign-macos-binaries.mjs";

for (const target of ["x86_64-apple-darwin", "aarch64-apple-darwin"]) {
  test(`signs and verifies the ${target} helpers before bundling`, () => {
    const binaries = ["ccomp", "comparecraft-backend"].map((helper) => resolve("src-tauri/target", target, "release", helper));
    const calls = [];
    signMacosBinaries({
      platform: "darwin",
      env: { TAURI_ENV_TARGET_TRIPLE: target },
      exists: (path) => binaries.includes(path),
      run: (command, args) => {
        calls.push([command, args]);
        return { status: 0 };
      },
    });
    assert.deepEqual(calls, binaries.flatMap((binary) => [
      ["codesign", ["--force", "--sign", "-", "--options", "runtime", binary]],
      ["codesign", ["--verify", "--strict", binary]],
    ]));
  });
}

test("signs native debug output with a configured identity and target directory", () => {
  const binary = resolve("custom-target/debug/ccomp");
  const backend = resolve("custom-target/debug/comparecraft-backend");
  const calls = [];
  signMacosBinaries({
    platform: "darwin",
    env: {
      CARGO_TARGET_DIR: "custom-target",
      TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin",
      TAURI_ENV_DEBUG: "true",
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Test",
    },
    exists: (path) => path === binary || path === backend,
    run: (command, args) => {
      calls.push(args);
      return { status: 0 };
    },
  });
  assert.deepEqual(calls[0], [
    "--force", "--sign", "Developer ID Application: Test",
    "--options", "runtime", "--timestamp", binary,
  ]);
  assert.deepEqual(calls[1], ["--verify", "--strict", binary]);
  assert.deepEqual(calls[3], ["--verify", "--strict", backend]);
  assert.equal(calls.length, 4);
});

test("does nothing outside macOS", () => {
  signMacosBinaries({
    platform: "linux",
    exists: () => assert.fail("must not inspect binaries"),
    run: () => assert.fail("must not run codesign"),
  });
});

test("rejects a missing helper", () => {
  assert.throws(() => signMacosBinaries({
    platform: "darwin", env: {}, exists: () => false,
  }), /No built macOS ccomp/);
  assert.throws(() => signMacosBinaries({
    platform: "darwin", env: {}, exists: (path) => path.endsWith("ccomp"),
    run: () => assert.fail("must not sign before every helper is found"),
  }), /No built macOS comparecraft-backend/);
});

for (const failingCall of [1, 2]) {
  test(`stops bundling when codesign call ${failingCall} fails`, () => {
    let calls = 0;
    assert.throws(() => signMacosBinaries({
      platform: "darwin", env: {}, exists: () => true,
      run: () => ({ status: ++calls === failingCall ? 1 : 0 }),
    }), /codesign failed/);
    assert.equal(calls, failingCall);
  });
}