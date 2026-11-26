import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readVersion, setVersion, verifyVersions } from "../scripts/version.mjs";

const script = fileURLToPath(new URL("../scripts/version.mjs", import.meta.url));
const lock = (version) =>
  `{\n  "name": "comparecraft",\n  "version": "${version}",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "comparecraft",\n      "version": "${version}"\n    }\n  }\n}\n`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "comparecraft-version-"));
  const files = {
    // The `version` lifecycle script must survive: only the top-level key is the release version.
    "package.json": '{\n  "name": "comparecraft",\n  "version": "0.1.0",\n  "scripts": {\n    "version": "node scripts/version.mjs set"\n  }\n}\n',
    "package-lock.json": lock("0.1.0"),
    // Tauri reads the release version from package.json, so installers can never lag behind it.
    "src-tauri/tauri.conf.json": '{\n  "productName": "CompareCraft",\n  "version": "../package.json",\n  "identifier": "dev.comparecraft.app"\n}\n',
    "src-tauri/Cargo.toml": '[package]\nname = "comparecraft"\nversion = "0.1.0"\nedition = "2021"\n',
    "src-tauri/Cargo.lock": '[[package]]\nname = "comparecraft"\nversion = "0.1.0"\ndependencies = []\n',
    "packaging/arch/PKGBUILD": "pkgname=comparecraft\npkgver=0.1.0\npkgrel=1\n",
    "extensions/vscode/package.json": '{\n  "name": "comparecraft",\n  "version": "0.1.0"\n}\n',
    "extensions/vscode/package-lock.json": lock("0.1.0"),
  };
  for (const [file, contents] of Object.entries(files)) {
    const path = resolve(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

/** What `npm version <bump>` leaves behind: only package.json and its lockfile changed. */
function bumpedByNpm(root, version) {
  writeFileSync(
    resolve(root, "package.json"),
    `{\n  "name": "comparecraft",\n  "version": "${version}",\n  "scripts": {\n    "version": "node scripts/version.mjs set"\n  }\n}\n`,
  );
  writeFileSync(resolve(root, "package-lock.json"), lock(version));
}

test("a consistent tree reports no problems", () => {
  const root = fixture();
  assert.deepEqual(verifyVersions({ root }), { version: "0.1.0", problems: [] });
  assert.deepEqual(verifyVersions({ root, tag: "v0.1.0" }).problems, []);
});

test("setVersion carries the version into every manifest", () => {
  const root = fixture();
  assert.equal(setVersion("1.2.3", { root }).length, 7);
  for (const file of ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "extensions/vscode/package.json", "extensions/vscode/package-lock.json"]) {
    assert.doesNotMatch(readFileSync(resolve(root, file), "utf8"), /0\.1\.0/, file);
  }
  assert.match(readFileSync(resolve(root, "packaging/arch/PKGBUILD"), "utf8"), /^pkgver=1\.2\.3$/m);
  assert.match(readFileSync(resolve(root, "package.json"), "utf8"), /"version": "node scripts\/version\.mjs set"/);
  assert.deepEqual(verifyVersions({ root, tag: "v1.2.3" }), { version: "1.2.3", problems: [] });
});

test("the npm version hook propagates the version npm just bumped", () => {
  const root = fixture();
  bumpedByNpm(root, "2.0.0");
  assert.equal(readVersion(root), "2.0.0");
  // package.json and its lockfile are already current, so only the other manifests change.
  assert.equal(setVersion(undefined, { root }).length, 5);
  assert.deepEqual(verifyVersions({ root, tag: "v2.0.0" }).problems, []);
});

test("a stale manifest, a hardcoded Tauri version and a wrong tag are reported", () => {
  const root = fixture();
  writeFileSync(resolve(root, "packaging/arch/PKGBUILD"), "pkgname=comparecraft\npkgver=9.9.9\n");
  writeFileSync(resolve(root, "src-tauri/tauri.conf.json"), '{\n  "version": "0.1.0"\n}\n');
  const { problems } = verifyVersions({ root, tag: "v0.2.0" });
  assert.equal(problems.length, 3);
  assert.ok(problems.some((problem) => problem.includes("packaging/arch/PKGBUILD")));
  assert.ok(problems.some((problem) => problem.includes("../package.json")));
  assert.ok(problems.some((problem) => problem.includes("v0.2.0")));
});

test("CRLF checkouts are handled without losing line endings", () => {
  const root = fixture();
  writeFileSync(resolve(root, "src-tauri/Cargo.lock"), '[[package]]\r\nname = "comparecraft"\r\nversion = "0.1.0"\r\n');
  writeFileSync(resolve(root, "packaging/arch/PKGBUILD"), "pkgname=comparecraft\r\npkgver=0.1.0\r\npkgrel=1\r\n");
  assert.deepEqual(verifyVersions({ root }).problems, []);
  setVersion("1.2.3", { root });
  assert.match(readFileSync(resolve(root, "packaging/arch/PKGBUILD"), "utf8"), /^pkgver=1\.2\.3\r$/m);
  assert.match(readFileSync(resolve(root, "src-tauri/Cargo.lock"), "utf8"), /name = "comparecraft"\r\nversion = "1\.2\.3"/);
});

test("the command line propagates the bumped version and rejects a wrong tag", () => {
  const root = fixture();
  bumpedByNpm(root, "2.3.4");
  const set = spawnSync(process.execPath, [script, "set"], { cwd: root, encoding: "utf8" });
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /Set version 2\.3\.4/);
  assert.equal(spawnSync(process.execPath, [script, "check", "--tag", "v2.3.4"], { cwd: root }).status, 0);
  const bad = spawnSync(process.execPath, [script, "check", "--tag", "v2.3.5"], { cwd: root, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /v2\.3\.5/);
});

test("setVersion refuses an invalid version or a tag that disagrees", () => {
  const root = fixture();
  assert.throws(() => setVersion("1.2", { root }), /expected N\.N\.N/);
  assert.throws(() => setVersion("1.2.3", { root, tag: "v1.2.4" }), /does not match/);
});