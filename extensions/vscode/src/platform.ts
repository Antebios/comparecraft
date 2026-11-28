/**
 * Services that differ between extension hosts. The Node host (VS Code desktop and remote windows)
 * provides all of them; browser VS Code provides only file access and the WebAssembly engine.
 */
import type * as vscode from "vscode";
import type { ComparisonController, LaunchTracking } from "./controller";
import type { LocalResource } from "./contracts";
import type { FolderCopies } from "./embedded";
import type { HelperAccess } from "./engine";
import type { FileAccess } from "./fileAccess";
import type { Operation } from "./policy";
import type { SnapshotSession } from "./snapshots";

export interface LocatedHelper {
  readonly executable: string;
  /** Where it was found: comparecraft.backendPath, bundled with the extension, or next to the desktop app. */
  readonly source: "setting" | "bundled" | "desktop";
}

export interface PlatformHelper extends HelperAccess {
  find(): Promise<LocatedHelper | undefined>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

/** The CompareCraft desktop app on the extension host's computer. */
export interface DesktopApp {
  /** `onError` receives failures after the process started (exit codes, close handlers). */
  launch(args: readonly string[], tracking?: LaunchTracking, onError?: (error: unknown) => void): Promise<void>;
  createSnapshots(): Promise<SnapshotSession>;
  /** Rejects folders that contain unsaved VS Code documents (`dirtyPaths`), which the app can't see. */
  assertSaved(resources: readonly LocalResource[], dirtyPaths: readonly string[]): Promise<void>;
  /** Lets the user choose the desktop executable (Locate Desktop Executable). */
  locate(): Promise<void>;
  /** Arguments that open `paths` in a specific desktop view. */
  viewArguments(kind: string, paths: readonly string[]): string[];
}

/** What the Git commands need from the shared activation. */
export interface GitServices {
  readonly context: vscode.ExtensionContext;
  readonly controller: ComparisonController;
  readonly desktop?: DesktopApp;
  register(id: string, callback: (first: unknown, selected: unknown) => Promise<unknown>): void;
  /** Throws `UnavailableError` when policy denies `operation` for `paths`. */
  require(operation: Operation, paths?: readonly string[]): void;
  bufferText(file: string): Promise<string | undefined>;
  isDirty(file: string): Promise<boolean>;
  /** Path string of a URI (see `uris.ts`). */
  pathOf(uri: vscode.Uri): string;
  report(error: unknown): Promise<void>;
  log(line: string): void;
}

export interface GitIntegration {
  /** Called after an embedded merge wrote its result; offers explicit staging. */
  afterMergeSaved(file: string): Promise<void>;
}

export interface Platform {
  readonly kind: "node" | "web";
  readonly files: FileAccess;
  readonly helper?: PlatformHelper;
  readonly desktop?: DesktopApp;
  readonly folderCopies?: FolderCopies;
  /** The WebAssembly engine module (`media/engine/comparecraft-engine.wasm`). */
  wasmBytes(): Promise<Uint8Array>;
  /** Registers the Git commands; browser VS Code has none. */
  registerGit?(services: GitServices): GitIntegration;
  dispose?(): void | Promise<void>;
}
