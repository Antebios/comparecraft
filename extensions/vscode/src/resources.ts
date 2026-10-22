import { realpath } from "node:fs/promises";
import path from "node:path";
import type { LocalResource } from "./contracts";

export async function assertSavedResources(
  resources: readonly LocalResource[],
  dirtyPaths: readonly string[]
): Promise<void> {
  for (const dirtyPath of dirtyPaths) {
    let canonical: string;
    try {
      canonical = await realpath(dirtyPath);
    } catch (error) {
      // A deleted dirty document still belongs to its original folder.
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      canonical = path.resolve(dirtyPath);
    }
    for (const resource of resources) {
      const relative = path.relative(resource.path, canonical);
      const within = relative === "" || (resource.kind === "folder" &&
        relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      if (within) {
        throw new Error(`Unsaved changes in ${dirtyPath}. Phase 1 compares saved files only; save intentionally before retrying. Buffer snapshots arrive in Phase 2.`);
      }
    }
  }
}
