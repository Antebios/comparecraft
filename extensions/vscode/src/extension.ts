/** Entry point of the Node extension host: VS Code desktop and remote windows (SSH, WSL, Dev Containers). */
import type * as vscode from "vscode";
import { activateCompareCraft } from "./activate";
import { createNodePlatform } from "./nodePlatform";

export function activate(context: vscode.ExtensionContext): ReturnType<typeof activateCompareCraft> {
  return activateCompareCraft(context, log => createNodePlatform(context, log));
}
