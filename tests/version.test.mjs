import assert from "node:assert/strict";
import test from "node:test";
import { parseTag, pkgver, releaseConfig } from "../scripts/version.mjs";

test("release tags give the asset version and a numeric installer version", () => {
  assert.deepEqual(parseTag("v0.5.0"), { version: "0.5.0", numeric: "0.5.0", prerelease: null });
  assert.deepEqual(parseTag("v1.2.3-beta.1"), { version: "1.2.3-beta.1", numeric: "1.2.3", prerelease: "beta.1" });
  assert.deepEqual(releaseConfig(parseTag("v1.2.3")), {
    version: "1.2.3",
    bundle: { windows: { wix: { version: "1.2.3" } }, macOS: { bundleVersion: "1.2.3" } },
  });
  // RPM versions cannot contain "-", so a pre-release builds every installer except the RPM.
  assert.deepEqual(releaseConfig(parseTag("v1.2.3-rc.2"), ["deb", "rpm", "msi"]), {
    version: "1.2.3-rc.2",
    bundle: { windows: { wix: { version: "1.2.3" } }, macOS: { bundleVersion: "1.2.3" }, targets: ["deb", "msi"] },
  });
});

test("anything other than vN.N.N[-pre] is rejected", () => {
  for (const tag of ["1.2.3", "v1.2", "v01.2.3", "v1.2.3-", "v1.2.3+build", "v256.0.0", "release-1", ""]) {
    assert.equal(parseTag(tag), null, tag);
  }
});

test("Arch pkgver follows git describe and stays valid for pacman", () => {
  assert.equal(pkgver("v0.5.0-0-g619a127"), "0.5.0");
  assert.equal(pkgver("v0.5.0-3-g619a127"), "0.5.0.r3.g619a127");
  assert.equal(pkgver("v0.6.0-beta.1-0-gabc1234"), "0.6.0beta.1");
  assert.equal(pkgver("v0.6.0-rc-1-2-gabc1234"), "0.6.0rc_1.r2.gabc1234");
  assert.throws(() => pkgver("abc1234"));
});
