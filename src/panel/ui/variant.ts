/**
 * The UI variant switch (Phase 9 plan 09-04; default flipped in Phase 10 plan 10-17).
 *
 * D-22 (2.0.0): the new panel (v2) is the default. The previous 1.7.x/1.8.x
 * panel opens only when `CSM_UI`, trimmed, equals exactly `"legacy"`. It stays
 * for one release and is removed in 2.1.0. Plain `csm` (no `CSM_UI`), or ANY
 * other value (`""`, `"v2"`, `"v1"`, `"LEGACY"`, `"legacy2"`, …), opens the new
 * panel. The exact-match rule of T-09-13 is kept: no other env value is
 * interpreted here.
 */
export type UiVariant = "legacy" | "v2";

export function uiVariant(env: NodeJS.ProcessEnv = process.env): UiVariant {
  const raw = env.CSM_UI;
  return typeof raw === "string" && raw.trim() === "legacy" ? "legacy" : "v2";
}
