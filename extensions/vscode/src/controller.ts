import type { ComparisonSide, LaunchMode, LocalResource, ResourceKind, SideInput } from "./contracts";
import { comparisonArguments } from "./desktopArgs";
import { UnavailableError } from "./errors";
import { basename, dirname, pathKey } from "./paths";
import type { SnapshotSession } from "./snapshots";

export interface LaunchTracking {
  readonly session?: SnapshotSession;
  /** Runs after the dedicated desktop process exits (only while this extension host is alive). */
  readonly onClosed?: () => Promise<void>;
}

export interface ComparisonHost {
  /** Throws `UnavailableError` when the desktop app can't open these paths here (remote, browser, untrusted). */
  checkDesktop(paths: readonly string[]): void;
  /**
   * Explains why the desktop app is unavailable (offering Manage Workspace Trust when that would help);
   * true when the user chooses to compare in VS Code instead.
   */
  offerEmbedded(reason: UnavailableError): Promise<boolean>;
  resource(value: string): Promise<LocalResource>;
  pick(kind: ResourceKind, title: string): Promise<string | undefined>;
  defaultMode(): LaunchMode;
  /** Explicit notice for comparisons the embedded UI cannot show yet; true opens the desktop app. */
  confirmDesktop(): Promise<boolean>;
  /** Opens a two-sided comparison in the embedded CompareCraft text comparison panel. */
  openEmbedded(inputs: readonly SideInput[]): Promise<void>;
  /** Rejects folders that contain unsaved VS Code documents, which cannot be snapshotted. */
  assertSaved(resources: readonly LocalResource[]): void | Promise<void>;
  /** Current text of an open document with unsaved changes, if any. */
  bufferText(filePath: string): Promise<string | undefined>;
  createSnapshots(): Promise<SnapshotSession>;
  launch(args: readonly string[], tracking?: LaunchTracking): Promise<void>;
  setHasLeft(value: boolean): Promise<void>;
  notify(message: string): void;
}

export interface CompareOptions {
  readonly mode?: LaunchMode;
  readonly onClosed?: () => Promise<void>;
}

const SIDE_DIRECTORIES = ["left", "right", "center", "output"];

export class ComparisonController {
  private readonly left: Partial<Record<ResourceKind, string>> = {};

  constructor(private readonly host: ComparisonHost) {}

  /**
   * Opens two (compare) or four (merge) sides. Embedded mode shows two-sided comparisons and
   * merges that do not wait for a desktop process in a VS Code panel; anything else asks before
   * using the desktop.
   * Desktop content inputs become owned read-only snapshots released when the process exits.
   * Returns false when the user declines the explicit embedded-mode notice.
   */
  async compareInputs(inputs: readonly SideInput[], options: CompareOptions = {}): Promise<boolean> {
    const embeddable = (inputs.length === 2 || inputs.length === 4) && !options.onClosed;
    const paths = inputs.flatMap(input => input.kind === "path" ? [input.path] : []);
    if ((options.mode ?? this.host.defaultMode()) === "embedded") {
      if (embeddable) {
        await this.host.openEmbedded(inputs);
        return true;
      }
      this.host.checkDesktop(paths);
      if (!(await this.host.confirmDesktop())) return false;
    } else if (!(await this.desktopAvailable(paths, embeddable ? inputs : undefined))) {
      return true;
    }
    let session: SnapshotSession | undefined;
    try {
      const sides: ComparisonSide[] = [];
      for (const [index, input] of inputs.entries()) {
        if (input.kind === "path") {
          sides.push({ path: input.path, title: input.title, readOnly: input.readOnly });
        } else {
          session ??= await this.host.createSnapshots();
          const file = await session.write(SIDE_DIRECTORIES[index] ?? `side${index + 1}`, input.name, input.content);
          sides.push({ path: file, title: input.title, readOnly: true });
        }
      }
      const tracked = Boolean(session || options.onClosed);
      await this.host.launch(
        comparisonArguments({ sides, solo: tracked }),
        tracked ? { session, onClosed: options.onClosed } : undefined
      );
      return true;
    } catch (error) {
      await session?.release();
      throw error;
    }
  }

  /**
   * True when the desktop app can open `paths`. Otherwise, for comparisons the embedded panel can show,
   * explains why and offers the panel explicitly (never switching silently) and returns false.
   */
  private async desktopAvailable(paths: readonly string[], embeddable?: readonly SideInput[]): Promise<boolean> {
    try {
      this.host.checkDesktop(paths);
      return true;
    } catch (error) {
      if (!(error instanceof UnavailableError) || !embeddable) throw error;
      if (await this.host.offerEmbedded(error)) await this.host.openEmbedded(embeddable);
      return false;
    }
  }

  private async fileInput(resource: LocalResource): Promise<SideInput> {
    if (resource.kind === "file") {
      const text = await this.host.bufferText(resource.path);
      if (text !== undefined) {
        const name = basename(resource.path);
        return { kind: "content", name, title: `${name} (unsaved buffer)`, content: text };
      }
    }
    return { kind: "path", path: resource.path };
  }

  private async single(paths: readonly string[], kind?: ResourceKind, title = "Select left file"): Promise<LocalResource | undefined> {
    if (paths.length > 1) throw new Error("Select exactly one file or folder for this command.");
    const value = paths[0] ?? await this.host.pick(kind ?? "file", title);
    if (!value) return undefined;
    const resource = await this.host.resource(value);
    if (kind && resource.kind !== kind) throw new Error(`Choose a ${kind}, not a ${resource.kind}.`);
    return resource;
  }

  private async route(left: LocalResource, right: LocalResource, mode?: LaunchMode): Promise<void> {
    if (left.kind !== right.kind) throw new Error("Cannot compare a file with a folder. Select two files or two folders.");
    if (pathKey(left.path) === pathKey(right.path)) throw new Error("Choose two different files or folders.");
    const sides: SideInput[] = [{ kind: "path", path: left.path }, { kind: "path", path: right.path }];
    if ((mode ?? this.host.defaultMode()) === "embedded") return this.host.openEmbedded(sides);
    if (!(await this.desktopAvailable([left.path, right.path], sides))) return;
    if (left.kind === "folder") await this.host.assertSaved([left, right]);
    await this.compareInputs([await this.fileInput(left), await this.fileInput(right)], { mode: "desktop" });
  }

  async compare(paths: readonly string[], mode?: LaunchMode): Promise<void> {
    if (paths.length > 2) throw new Error("Select exactly two files or two folders.");
    const left = await this.single(paths.slice(0, 1));
    if (!left) return;
    const rightPath = paths[1] ?? await this.host.pick(left.kind, `Select right ${left.kind}`);
    if (!rightPath) return;
    await this.route(left, await this.host.resource(rightPath), mode);
  }

  async selectLeft(paths: readonly string[]): Promise<void> {
    const resource = await this.single(paths);
    if (!resource) return;
    this.left[resource.kind] = resource.path;
    await this.host.setHasLeft(true);
    this.host.notify(`Left ${resource.kind}: ${resource.path}`);
  }

  async compareWithLeft(paths: readonly string[]): Promise<void> {
    const kind = this.left.file ? undefined : this.left.folder ? "folder" : undefined;
    const right = await this.single(paths, kind, "Select right item");
    if (!right) return;
    const leftPath = this.left[right.kind];
    if (!leftPath) throw new Error(`Select a left ${right.kind} first using CompareCraft: Select Left File or Folder.`);
    await this.route(await this.host.resource(leftPath), right);
  }

  async clearLeft(): Promise<void> {
    delete this.left.file;
    delete this.left.folder;
    await this.host.setHasLeft(false);
    this.host.notify("CompareCraft left selections cleared.");
  }

  async compareWithPicker(paths: readonly string[], kind: ResourceKind): Promise<void> {
    const left = await this.single(paths, kind, `Select left ${kind}`);
    if (!left) return;
    const rightPath = await this.host.pick(kind, `Compare ${left.kind} with`);
    if (rightPath) await this.route(left, await this.host.resource(rightPath));
  }

  async compareParent(paths: readonly string[]): Promise<void> {
    const file = await this.single(paths, "file");
    if (!file) return;
    await this.compareWithPicker([dirname(file.path)], "folder");
  }

  async openDesktop(): Promise<void> {
    this.host.checkDesktop([]);
    await this.host.launch([]);
  }
}
