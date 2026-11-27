// Release versioning: the GitHub release tag (vN.N.N or vN.N.N-pre.N) is the version.
// CI and the Arch package pass it to builds as COMPARECRAFT_VERSION; tracked files keep their
// development defaults.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Version parts of a release tag, or null when the tag is not a release tag. */
export function parseTag(tag) {
  const m = TAG.exec(String(tag).trim());
  if (!m) return null;
  const [, major, minor, patch, pre] = m;
  // MSI versions are limited to 255.255.65535 and cannot carry pre-release text.
  if (+major > 255 || +minor > 255 || +patch > 65535) return null;
  const numeric = `${major}.${minor}.${patch}`;
  return { version: pre ? `${numeric}-${pre}` : numeric, numeric, prerelease: pre ?? null };
}

export function requireTag(tag) {
  const parsed = parseTag(tag);
  if (!parsed) throw new Error(`"${tag}" is not a release tag; use vN.N.N or vN.N.N-pre (for example v1.2.3 or v1.2.3-beta.1).`);
  return parsed;
}

/**
 * Tauri config overlay that names the installers and sets the bundle versions. MSI and the macOS
 * bundle version must be numeric. RPM versions cannot contain "-", so pre-releases skip the RPM.
 */
export function releaseConfig({ version, numeric }, baseTargets = BASE_TARGETS()) {
  const bundle = {
    windows: { wix: { version: numeric } },
    macOS: { bundleVersion: numeric },
  };
  if (version !== numeric) bundle.targets = baseTargets.filter((target) => target !== "rpm");
  return { version, bundle };
}

const BASE_TARGETS = () =>
  JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")).bundle.targets;

/** pacman pkgver for `git describe --tags --long` output such as v1.2.3-beta.1-4-gabc123. */
export function pkgver(describe) {
  const m = /^(v.+)-(\d+)-g([0-9a-f]+)$/.exec(String(describe).trim());
  if (!m) throw new Error(`Unexpected git describe output: ${describe}`);
  const { numeric, prerelease } = requireTag(m[1]);
  // pacman orders "1.2.3beta.1" before "1.2.3"; hyphens are not allowed in pkgver.
  const base = prerelease ? `${numeric}${prerelease.replaceAll("-", "_")}` : numeric;
  return m[2] === "0" ? base : `${base}.r${m[2]}.g${m[3]}`;
}

/** Version shown by the app: COMPARECRAFT_VERSION when set, otherwise `<package.json version>-dev`. */
export function appVersion(env = process.env) {
  const stamped = env.COMPARECRAFT_VERSION?.trim();
  if (stamped) return stamped;
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return `${version}-dev`;
}

export const RELEASE_CONFIG = resolve("src-tauri/tauri.release.conf.json");

function writeRelease(tag, env = process.env) {
  const parsed = requireTag(tag);
  writeFileSync(RELEASE_CONFIG, `${JSON.stringify(releaseConfig(parsed), null, 2)}\n`);
  if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `COMPARECRAFT_VERSION=${parsed.version}\n`);
  return parsed;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function main([mode, value]) {
  switch (mode) {
    case "--github": {
      // Writes the overlay and exports COMPARECRAFT_VERSION for later workflow steps.
      const { version } = writeRelease(value);
      console.log(version);
      return;
    }
    case "--git": {
      // Prints the version when HEAD is exactly on a release tag; prints nothing otherwise.
      let tag;
      try {
        tag = git("describe", "--tags", "--exact-match", "--match", "v*");
      } catch {
        return;
      }
      const parsed = parseTag(tag);
      if (parsed) console.log(parsed.version);
      return;
    }
    case "--pkgver": {
      let describe;
      try {
        describe = git("describe", "--tags", "--long", "--match", "v*");
      } catch {
        // No release tag reachable (for example a shallow clone).
        console.log(`0.0.0.r${git("rev-list", "--count", "HEAD")}.g${git("rev-parse", "--short", "HEAD")}`);
        return;
      }
      console.log(pkgver(describe));
      return;
    }
    case "--check":
      console.log(requireTag(value).version);
      return;
    default:
      throw new Error("Usage: node scripts/version.mjs --github <tag> | --git | --pkgver | --check <tag>");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
