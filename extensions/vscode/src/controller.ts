import path from "node:path";
import type { LaunchMode, LocalResource, ResourceKind } from "./contracts";
import { comparisonArguments } from "./process";

export interface ComparisonHost {
  assertSupported(): void;
  resource(value: string): Promise<LocalResource>;
  pick(kind: ResourceKind, title: string): Promise<string | undefined>;
  defaultMode(): LaunchMode;
  confirmDesktop(): Promise<boolean>;
  assertSaved(resources: readonly LocalResource[]): void | Promise<void>;
  launch(args: readonly string[]): Promise<void>;
  setHasLeft(value: boolean): Promise<void>;
  notify(message: string): void;
}

export class ComparisonController {
  private readonly left: Partial<Record<ResourceKind, string>> = {};

  constructor(private readonly host: ComparisonHost) {}

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
    const key = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    if (key(left.path) === key(right.path)) throw new Error("Choose two different files or folders.");
    if ((mode ?? this.host.defaultMode()) === "embedded" && !(await this.host.confirmDesktop())) return;
    this.host.assertSupported();
    await this.host.assertSaved([left, right]);
    await this.host.launch(comparisonArguments({ left, right }));
  }

  async compare(paths: readonly string[], mode?: LaunchMode): Promise<void> {
    this.host.assertSupported();
    if (paths.length > 2) throw new Error("Select exactly two files or two folders.");
    const left = await this.single(paths.slice(0, 1));
    if (!left) return;
    const rightPath = paths[1] ?? await this.host.pick(left.kind, `Select right ${left.kind}`);
    if (!rightPath) return;
    await this.route(left, await this.host.resource(rightPath), mode);
  }

  async selectLeft(paths: readonly string[]): Promise<void> {
    this.host.assertSupported();
    const resource = await this.single(paths);
    if (!resource) return;
    this.left[resource.kind] = resource.path;
    await this.host.setHasLeft(true);
    this.host.notify(`Left ${resource.kind}: ${resource.path}`);
  }

  async compareWithLeft(paths: readonly string[]): Promise<void> {
    this.host.assertSupported();
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
    this.host.assertSupported();
    const left = await this.single(paths, kind, `Select left ${kind}`);
    if (!left) return;
    const rightPath = await this.host.pick(kind, `Compare ${left.kind} with`);
    if (rightPath) await this.route(left, await this.host.resource(rightPath));
  }

  async compareParent(paths: readonly string[]): Promise<void> {
    this.host.assertSupported();
    const file = await this.single(paths, "file");
    if (!file) return;
    await this.compareWithPicker([path.dirname(file.path)], "folder");
  }

  async openDesktop(): Promise<void> {
    this.host.assertSupported();
    await this.host.launch([]);
  }
}
