import { parseSpec, requireObject, requireString, type EmbeddedSpec } from "./embeddedCore";

export const FOLDER_SESSIONS_KEY = "comparecraft.folderSessions";

export interface FolderSession {
  id: string;
  name: string;
  kind: "folder";
  paths: string[];
  options: Record<string, unknown>;
  modified: number;
  saved: boolean;
  locked?: boolean;
}

export function parseFolderSession(value: unknown): FolderSession {
  const v = requireObject(value, "folder session");
  if (v.kind !== "folder") throw new Error("Only folder sessions can be stored here.");
  const id = requireString(v.id, "session ID"), name = requireString(v.name, "session name");
  if (!id || (v.saved === true && !name.trim())) throw new Error("A saved folder session needs an identity and name.");
  if (typeof v.modified !== "number" || !Number.isFinite(v.modified) || typeof v.saved !== "boolean") throw new Error("Invalid session metadata.");
  if (v.locked !== undefined && typeof v.locked !== "boolean") throw new Error("Invalid session lock.");
  const spec = parseSpec({ kind: "folder", paths: v.paths, options: v.options });
  return { id, name, kind: "folder", paths: spec.paths, options: spec.options, modified: v.modified, saved: v.saved,
    ...(typeof v.locked === "boolean" ? { locked: v.locked } : {}) };
}

export function sessionSpec(session: FolderSession): EmbeddedSpec {
  return parseSpec({ kind: "folder", paths: session.paths, options: session.options,
    sessionId: session.id, sessionName: session.saved ? session.name : undefined, locked: session.locked });
}
