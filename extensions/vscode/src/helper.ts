/** The native helper on a Node extension host (desktop or remote), located once and started on demand. */
import { BackendManager, type BackendClient, type BackendOptions } from "./backend";
import type { BackendSource } from "./discovery";
import type { HelperAccess } from "./engine";
import { InstallationError } from "./errors";

export interface LocatedHelper {
  readonly executable: string;
  readonly source: BackendSource;
}

export class NodeHelper implements HelperAccess {
  private located: Promise<LocatedHelper | undefined> | undefined;
  private readonly manager: BackendManager;

  constructor(private readonly locate: () => Promise<LocatedHelper | undefined>, options: BackendOptions) {
    this.manager = new BackendManager(async () => {
      const found = await this.find();
      if (!found) throw new InstallationError("The CompareCraft helper (comparecraft-backend) is not installed.");
      return found.executable;
    }, options);
  }

  /** The helper to use, or undefined when none is installed; cached until `reset`. */
  find(): Promise<LocatedHelper | undefined> {
    if (!this.located) {
      const locating = this.locate();
      this.located = locating;
      locating.catch(() => { if (this.located === locating) this.located = undefined; });
    }
    return this.located;
  }

  async client(): Promise<BackendClient | undefined> {
    return (await this.find()) ? this.manager.get() : undefined;
  }

  /** Stops the helper and forgets where it was found (after a settings change or install). */
  async reset(): Promise<void> {
    this.located = undefined;
    await this.manager.reset();
  }

  dispose(): Promise<void> {
    return this.manager.dispose();
  }
}
