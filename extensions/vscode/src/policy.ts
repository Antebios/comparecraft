/**
 * What CompareCraft may do in the current VS Code environment. One decision table for every command,
 * webview request and menu context key; enforced where the work happens, not only by hiding menus.
 * Pure: no VS Code or Node imports, so the browser bundle and unit tests share it.
 */
import { isUriString, schemeOf } from "./paths";

/** Where the extension host runs: this computer, a remote host (SSH, WSL, container, ...), or a browser. */
export type HostKind = "desktop" | "remote" | "web";

export interface HostState {
  readonly kind: HostKind;
  /** `vscode.env.remoteName` (for example "ssh-remote", "wsl", "dev-container"). */
  readonly remoteName?: string;
  readonly trusted: boolean;
}

/**
 * - `desktop`: launch the installed desktop app (also Git tools waiting for it).
 * - `save`: write a comparison side or merge result.
 * - `git`: run Git (comparisons with revisions, conflict merges, staging, tool configuration).
 * - `folder`: compare folders inside VS Code.
 * - `revealInOS`: show a file in the operating system's file manager.
 */
export type Operation = "desktop" | "save" | "git" | "folder" | "revealInOS";

export interface Denial {
  readonly reason: string;
  /** Trusting the workspace would allow the operation. */
  readonly fix?: "trust";
}

const REMOTES: Record<string, string> = {
  "ssh-remote": "an SSH host",
  "wsl": "WSL",
  "dev-container": "a dev container",
  "attached-container": "a container",
  "codespaces": "a codespace",
  "tunnel": "a remote tunnel"
};

/** Human-readable name of the current remote ("an SSH host", "WSL", ...). */
export const remoteLabel = (remoteName: string | undefined): string =>
  remoteName ? REMOTES[remoteName] ?? `a remote host (${remoteName})` : "a remote host";

/** Describes the environment for reports and notices. */
export function hostLabel(state: HostState): string {
  const where = state.kind === "web" ? "VS Code in a browser" : state.kind === "remote" ? `a window connected to ${remoteLabel(state.remoteName)}` : "VS Code desktop";
  return state.trusted ? where : `${where} (Restricted Mode)`;
}

const virtualScheme = (paths: readonly string[]): string | undefined => {
  const virtual = paths.find(item => item && isUriString(item));
  return virtual ? schemeOf(virtual) : undefined;
};

/** Why `operation` isn't available for `paths` here, or undefined when it is allowed. */
export function denial(state: HostState, operation: Operation, paths: readonly string[] = []): Denial | undefined {
  const virtual = state.kind === "web" ? undefined : virtualScheme(paths);
  switch (operation) {
    case "desktop":
      if (state.kind === "web") return { reason: "The CompareCraft desktop app can't be started from VS Code in a browser. Compare in VS Code instead." };
      if (state.kind === "remote") {
        return { reason: `This window is connected to ${remoteLabel(state.remoteName)}. The CompareCraft desktop app runs on your local computer and can't open files on the remote host, so compare in VS Code instead.` };
      }
      if (!state.trusted) return { reason: "Restricted Mode: trust this workspace to open comparisons in the CompareCraft desktop app.", fix: "trust" };
      if (virtual) return { reason: `"${virtual}" resources aren't files on this computer's disk, so the desktop app can't open them. Compare in VS Code instead.` };
      return undefined;
    case "save":
      if (!state.trusted) return { reason: "Restricted Mode: saving is turned off until you trust this workspace.", fix: "trust" };
      return undefined;
    case "git":
      if (state.kind === "web") return { reason: "Git commands need VS Code desktop or a remote window; they aren't available in VS Code in a browser." };
      if (!state.trusted) {
        return { reason: "Restricted Mode: Git commands are turned off because a repository's Git configuration can run programs. Trust this workspace to use them.", fix: "trust" };
      }
      if (virtual) return { reason: `Git commands need a working tree on disk; "${virtual}" resources aren't files on disk.` };
      return undefined;
    case "folder":
      if (state.kind === "web") {
        return { reason: "Folder comparison needs the CompareCraft helper, which can't run in VS Code in a browser. Compare individual files instead." };
      }
      return undefined;
    case "revealInOS":
      if (state.kind !== "desktop") return { reason: "The file manager of this computer can't show files of this window." };
      if (virtual) return { reason: `"${virtual}" resources aren't files on this computer's disk.` };
      return undefined;
  }
}

/** Menu and Command Palette context keys (each set as `comparecraft.<key>`). */
export interface ContextKeys {
  readonly desktop: boolean;
  readonly git: boolean;
  readonly folders: boolean;
  /** `resourceScheme` values the comparison commands accept. */
  readonly schemes: string[];
  /** `resourceScheme` values of files on the extension host's own disk (Git commands). */
  readonly localSchemes: string[];
}

/** `workspaceSchemes` are the URI schemes of the open workspace folders (as the UI sees them). */
export function contextKeys(state: HostState, workspaceSchemes: readonly string[]): ContextKeys {
  const local = state.kind === "web" ? [] : state.kind === "remote" ? ["file", "vscode-remote"] : ["file"];
  return {
    desktop: !denial(state, "desktop"),
    git: !denial(state, "git"),
    folders: !denial(state, "folder"),
    schemes: [...new Set([...local, ...(state.kind === "web" ? ["file"] : []), ...workspaceSchemes])].filter(scheme => scheme !== "untitled"),
    localSchemes: local
  };
}
