export type ContentMode = "crc" | "binary" | "rules";
export type ComparisonScope = "all" | "selected";

export interface ComparisonPreset {
  id: string;
  name: string;
  method: ContentMode;
  scope: ComparisonScope;
}

export interface ComparisonPresetState {
  activePresetId: string;
  pinnedPresetIds: string[];
}

export interface ComparisonPresetSettings {
  library: ComparisonPreset[];
  defaults: ComparisonPresetState;
}

export const METHOD_LABELS: Record<ContentMode, string> = { crc: "CRC", binary: "Binary", rules: "Rules-based" };
export const BUILTIN_PRESETS: readonly ComparisonPreset[] = (["all", "selected"] as const).flatMap((scope) =>
  (["crc", "binary", "rules"] as const).map((method) => ({
    id: `builtin:${scope}:${method}`, name: `Compare ${scope === "all" ? "All" : "Selected"}: ${METHOD_LABELS[method]}`, method, scope,
  })),
);
export const DEFAULT_PRESET_ID = "builtin:all:rules";
export const defaultPresetState = (): ComparisonPresetState => ({ activePresetId: DEFAULT_PRESET_ID, pinnedPresetIds: [] });
export const defaultPresetSettings = (): ComparisonPresetSettings => ({ library: [], defaults: defaultPresetState() });
export const presetDescription = (p: ComparisonPreset) =>
  `${p.name} (${METHOD_LABELS[p.method]}, ${p.scope === "all" ? "all included files" : "selected items"})`;

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const method = (v: unknown): v is ContentMode => v === "crc" || v === "binary" || v === "rules";
const scope = (v: unknown): v is ComparisonScope => v === "all" || v === "selected";

export function presetLibraryError(library: readonly ComparisonPreset[]): string | undefined {
  const ids = new Set(BUILTIN_PRESETS.map((p) => p.id));
  const names = new Set(BUILTIN_PRESETS.map((p) => p.name.toLowerCase()));
  for (const p of library) {
    if (!p.name.trim()) return "Every preset needs a name.";
    if (!p.id || p.id.startsWith("builtin:") || ids.has(p.id)) return "Preset identifiers must be unique.";
    if (names.has(p.name.trim().toLowerCase())) return "Preset names must be unique (ignoring case).";
    if (!method(p.method) || !scope(p.scope)) return "Choose a valid comparison method and scope.";
    ids.add(p.id);
    names.add(p.name.trim().toLowerCase());
  }
}

export function resolvePresetState(raw: unknown, presets: readonly ComparisonPreset[]): { state: ComparisonPresetState; warning?: string } {
  if (raw === undefined) return { state: defaultPresetState() };
  const ids = new Set(presets.map((p) => p.id));
  const valid = record(raw) && typeof raw.activePresetId === "string" && ids.has(raw.activePresetId) &&
    Array.isArray(raw.pinnedPresetIds) && raw.pinnedPresetIds.every((id) => typeof id === "string" && ids.has(id)) &&
    new Set(raw.pinnedPresetIds).size === raw.pinnedPresetIds.length;
  const state = {
    activePresetId: record(raw) && typeof raw.activePresetId === "string" && ids.has(raw.activePresetId) ? raw.activePresetId : DEFAULT_PRESET_ID,
    pinnedPresetIds: record(raw) && Array.isArray(raw.pinnedPresetIds)
      ? [...new Set(raw.pinnedPresetIds.filter((id): id is string => typeof id === "string" && ids.has(id)))] : [],
  };
  return { state, warning: valid ? undefined : "Unavailable comparison presets were removed. Check the comparison choice before running." };
}

export function normalizePresetSettings(raw: unknown): { value: ComparisonPresetSettings; warnings: string[] } {
  if (raw === undefined) return { value: defaultPresetSettings(), warnings: [] };
  const warnings: string[] = [];
  const library: ComparisonPreset[] = [];
  if (!record(raw) || !Array.isArray(raw.library)) warnings.push("Invalid comparison preset library was reset.");
  else for (const p of raw.library) {
    if (!record(p) || typeof p.id !== "string" || typeof p.name !== "string" || !method(p.method) || !scope(p.scope)) {
      warnings.push("An invalid comparison preset was removed.");
      continue;
    }
    const candidate: ComparisonPreset = { id: p.id, name: p.name.trim(), method: p.method, scope: p.scope };
    const error = presetLibraryError([...library, candidate]);
    if (error) warnings.push(error);
    else library.push(candidate);
  }
  const defaults = resolvePresetState(record(raw) ? raw.defaults : null, [...BUILTIN_PRESETS, ...library]);
  if (defaults.warning) warnings.push(defaults.warning);
  return { value: { library, defaults: defaults.state }, warnings: [...new Set(warnings)] };
}
