/** Converts between VS Code URIs and the path strings of `paths.ts`. */
import * as vscode from "vscode";
import { dropPaths } from "./embeddedCore";
import { isUriString } from "./paths";

let nativePaths = false;

/** Node extension hosts use file-system paths for `file:` URIs; browser VS Code uses URI strings throughout. */
export function setNativePaths(value: boolean): void {
  nativePaths = value;
}

export function toUri(path: string): vscode.Uri {
  return isUriString(path) ? vscode.Uri.parse(path, true) : vscode.Uri.file(path);
}

export function pathOf(uri: vscode.Uri): string {
  return nativePaths && uri.scheme === "file" ? uri.fsPath : uri.toString();
}

/** Paths of URIs dropped on a webview in this window (see `dropPaths`). */
export const droppedPaths = (value: unknown): string[] => dropPaths(value, { native: nativePaths, remoteName: vscode.env.remoteName });
