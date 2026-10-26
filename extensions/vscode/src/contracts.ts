export type LaunchMode = "embedded" | "desktop";
export type ResourceKind = "file" | "folder";

export interface LocalResource {
  readonly path: string;
  readonly kind: ResourceKind;
}

/** One positional side passed to the desktop app: left, right, center (ancestor), output. */
export interface ComparisonSide {
  readonly path: string;
  readonly title?: string;
  readonly readOnly?: boolean;
}

export interface ComparisonRequest {
  readonly sides: readonly ComparisonSide[];
  /** Force a dedicated desktop process whose exit marks the end of the comparison. */
  readonly solo?: boolean;
}

/** Content that must be written to an owned read-only snapshot before launching. */
export interface ContentInput {
  readonly kind: "content";
  /** File name used for the snapshot, preserving the extension for viewer detection. */
  readonly name: string;
  readonly title: string;
  readonly content: string | Uint8Array;
}

export interface PathInput {
  readonly kind: "path";
  readonly path: string;
  readonly title?: string;
  readonly readOnly?: boolean;
}

export type SideInput = ContentInput | PathInput;
