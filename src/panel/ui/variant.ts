/**
 * The UI variant switch (Phase 9, plan 09-04).
 *
 * D-23: the v2 shell is opt-in through `CSM_UI`. It opens only when the
 * value, trimmed, equals exactly `"v2"`. Plain `csm` (no `CSM_UI`), or ANY
 * other value (`""`, `"v1"`, `"legacy"`, `"V2"`, `"v2x"`, …), opens the 1.6.x
 * panel unchanged. No other env value is interpreted here (T-09-13).
 */
export type UiVariant = "legacy" | "v2";

export function uiVariant(env: NodeJS.ProcessEnv = process.env): UiVariant {
  const raw = env.CSM_UI;
  return typeof raw === "string" && raw.trim() === "v2" ? "v2" : "legacy";
}
