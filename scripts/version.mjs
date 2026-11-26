// package.json holds the one release version. `npm version` bumps it, writes the release commit and
// tags it v<version>; `src-tauri/tauri.conf.json` points at it ("version": "../package.json"), so
// Tauri stamps the same number into the deb/rpm/AppImage, NSIS/MSI and app/dmg names and metadata.
// This script carries the number into the manifests npm cannot bump itself: Cargo (the console and
// backend helpers report it), the Arch PKGBUILD and the VS Code extension. npm's `version` lifecycle
// hook runs `set`, so a single `npm version minor` keeps every shipped version number identical.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAURI_CONFIG = "src-tauri/tauri.conf.json";

/** Patterns capture prefix, version and suffix so only the version itself is rewritten. The
 * package.json ones are anchored to a top-level key so nested `scripts.version` stays untouched. */
function targets(root) {
  const target = (file, pattern, count, label) => ({ file, path: resolve(root, file), pattern, count, label });
  const topLevel = /^((?: {2}|\t)"version"\s*:\s*")([^"]*)(")/gm;
  return [
    target("package.json", topLevel, 1, "release version"),
    target("package-lock.json", /("name"\s*:\s*"comparecraft"\s*,\s*"version"\s*:\s*")([^"]*)(")/g, 2, "lockfile version"),
    target("src-tauri/Cargo.toml", /(^version\s*=\s*")([^"]*)(")/gm, 1, "crate version"),
    target("src-tauri/Cargo.lock", /(\[\[package\]\]\r?\nname = "comparecraft"\r?\nversion = ")([^"]*)(")/g, 1, "lockfile crate version"),
    target("packaging/arch/PKGBUILD", /(^pkgver=)([^\r\n]+)(\r?$)/gm, 1, "Arch package version"),
    target("extensions/vscode/package.json", topLevel, 1, "VS Code extension version"),
    target("extensions/vscode/package-lock.json", /("name"\s*:\s*"comparecraft"\s*,\s*"version"\s*:\s*")([^"]*)(")/g, 2, "extension lockfile version"),
  ];
}

function entries(pattern, text) {
  return [...text.matchAll(pattern)].map((match) => ({ prefix: match[1], version: match[2], suffix: match[3] }));
}

/** The version every artifact must carry. */
export function readVersion(root = process.cwd()) {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
}

/** Every declaration that disagrees with package.json, or with the release tag. */
export function verifyVersions({ root = process.cwd(), tag } = {}) {
  const version = readVersion(root);
  const problems = [];
  if (!SEMVER.test(version)) {
    problems.push(`package.json uses "${version}", which is not a N.N.N version.`);
  }
  const config = readFileSync(resolve(root, TAURI_CONFIG), "utf8");
  if (!/"version"\s*:\s*"\.\.\/package\.json"/.test(config)) {
    problems.push(`${TAURI_CONFIG}: "version" must point at ../package.json so installers inherit the release version.`);
  }
  for (const target of targets(root)) {
    const found = entries(target.pattern, readFileSync(target.path, "utf8"));
    if (found.length !== target.count) {
      problems.push(`${target.file}: expected ${target.count} ${target.label} field(s), found ${found.length}.`);
      continue;
    }
    for (const entry of found) {
      if (entry.version !== version) {
        problems.push(`${target.file}: ${target.label} is ${entry.version}, but package.json is ${version}.`);
      }
    }
  }
  if (tag != null && tag !== `v${version}`) {
    problems.push(`Release tag ${tag} does not match the ${version} version in the tagged source.`);
  }
  return { version, problems };
}

/**
 * Rewrites every declaration to `version`, which defaults to the one package.json already holds
 * (npm has written it by the time the `version` lifecycle hook runs). Returns the files changed.
 */
export function setVersion(version, { root = process.cwd(), tag } = {}) {
  const target = version ?? readVersion(root);
  if (!SEMVER.test(target)) throw new Error(`Invalid version "${String(target)}"; expected N.N.N.`);
  if (tag != null && tag !== `v${target}`) throw new Error(`Release tag ${tag} does not match version v${target}.`);
  const updated = [];
  for (const item of targets(root)) {
    const text = readFileSync(item.path, "utf8");
    const found = entries(item.pattern, text);
    if (found.length !== item.count) {
      throw new Error(`${item.file}: expected ${item.count} ${item.label} field(s), found ${found.length}.`);
    }
    if (found.every((entry) => entry.version === target)) continue;
    const next = text.replace(item.pattern, (_match, prefix, _old, suffix) => `${prefix}${target}${suffix}`);
    writeFileSync(item.path, next);
    updated.push(item.file);
  }
  return updated;
}

function usage() {
  return [
    "Usage: node scripts/version.mjs [check|set] [version] [--tag vN.N.N]",
    "  check            verify every manifest agrees with package.json (default)",
    "  set [version]    write the version into every manifest (default: package.json's own)",
    "  --tag <tag>      also require v<version> to equal the release tag",
    "",
    "Releases run `npm version <major|minor|patch>`, which bumps package.json, calls `set` and tags v<version>.",
  ].join("\n");
}

function main(argv) {
  const tagAt = argv.indexOf("--tag");
  const tag = tagAt >= 0 ? argv[tagAt + 1] : undefined;
  if (tagAt >= 0 && (tag == null || tag.startsWith("--"))) throw new Error("--tag requires a value such as v1.2.3.");
  const positional = tagAt >= 0 ? argv.filter((_, index) => index !== tagAt && index !== tagAt + 1) : argv;
  const command = positional[0] ?? "check";
  if (command === "check") {
    const { version, problems } = verifyVersions({ tag });
    if (problems.length) {
      console.error(`Version ${version} is not consistent:\n  ${problems.join("\n  ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`CompareCraft ${version}: every artifact matches${tag ? ` the release tag ${tag}` : " the release."}`);
    return;
  }
  if (command === "set") {
    const updated = setVersion(positional[1], { tag });
    const version = readVersion();
    console.log(updated.length ? `Set version ${version} in:\n  ${updated.join("\n  ")}` : `Every manifest already uses ${version}.`);
    return;
  }
  throw new Error(`Unknown command "${command}".\n${usage()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}