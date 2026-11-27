// Replaced at build time by the Vite configs (scripts/version.mjs).
declare const __APP_VERSION__: string;

/** The release version for release builds, otherwise `<package.json version>-dev`. */
export const APP_VERSION: string = __APP_VERSION__;
