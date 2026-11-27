export interface ReleaseVersion { version: string; numeric: string; prerelease: string | null }
export function parseTag(tag: string): ReleaseVersion | null;
export function requireTag(tag: string): ReleaseVersion;
export function releaseConfig(version: Pick<ReleaseVersion, "version" | "numeric">, baseTargets?: string[]): Record<string, unknown>;
export function pkgver(describe: string): string;
export function appVersion(env?: Record<string, string | undefined>): string;
export const RELEASE_CONFIG: string;
