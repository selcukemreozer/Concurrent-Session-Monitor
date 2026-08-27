/**
 * Numeric env tunable parsing (WR-02).
 *
 * Every CSM_* numeric knob is optional and MUST degrade to a sane default. The
 * naive `Number(process.env.X ?? def)` only guards *undefined* — a set-but-non
 * numeric value (`CSM_STALE_MS="2m"`, `CSM_GRACE_MS="off"`) yields `NaN`, and
 * every comparison against `NaN` is `false`, silently disabling windowing,
 * staleness, and prune. Route all numeric env reads through `numEnv` so an
 * invalid value falls back to the default instead of corrupting behavior.
 */
export function numEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}
