/**
 * Entry point of browser VS Code (vscode.dev, github.dev): comparisons through the WebAssembly engine and
 * VS Code's file system providers. Bundled by scripts/build-web.cjs without Node built-ins.
 */
import * as vscode from "vscode";
import { activateCompareCraft } from "../activate";
import type { Platform } from "../platform";
import { VscodeFiles } from "../vscodeFiles";

/** Reads a file of this extension: through the file system where possible, otherwise over HTTP. */
async function extensionFile(context: vscode.ExtensionContext, ...segments: string[]): Promise<Uint8Array> {
  const uri = vscode.Uri.joinPath(context.extensionUri, ...segments);
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch {
    const response = await fetch(uri.toString(true));
    if (!response.ok) throw new Error(`Could not load ${segments.join("/")} (${response.status} ${response.statusText}).`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

export function activate(context: vscode.ExtensionContext): ReturnType<typeof activateCompareCraft> {
  return activateCompareCraft(context, (): Platform => ({
    kind: "web",
    files: new VscodeFiles(),
    wasmBytes: () => extensionFile(context, "media", "engine", "comparecraft-engine.wasm")
  }));
}
