export type LaunchMode = "embedded" | "desktop";
export type ResourceKind = "file" | "folder";

export interface LocalResource {
  readonly path: string;
  readonly kind: ResourceKind;
}

export interface ComparisonRequest {
  readonly left: LocalResource;
  readonly right: LocalResource;
}
