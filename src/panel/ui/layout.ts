/**
 * The v2 height-budget core (Phase 9, plan 09-03; UI-SPEC § Height allocation
 * priority and § Shrink order under pressure).
 *
 * `allocate(total, demands, growOrder)` hands out `total` rows in two passes:
 *
 *   1. Minimums, in `demands` ARRAY order (the most protected first). Each
 *      demand gets `min(d.min, remaining)`, so under pressure the earlier
 *      demand keeps its minimum and the later ones get what is left (down to
 *      0, never negative).
 *   2. Growth, in `growOrder` order (default: array order). Each id grows
 *      toward `d.max` with the rows still left. A stepped demand (`step`) only
 *      ever grows by whole steps, so it is granted `min + k*step` rows (one
 *      more card row is 8 rows, never 5). Ids missing from `growOrder` never
 *      grow past their minimum.
 *
 * It never hands out more than `max(0, total)` rows and no value exceeds its
 * `max`, so a frame built from it never overflows the terminal (T-09-14a).
 *
 * How callers map the UI-SPEC priority list onto it:
 *   - demands, in priority order: header, footer, conflict rows, detail strip,
 *     AGENTS grid (min 1 card row, step = card row pitch), FILES ticker
 *     (min 3, max 6), the right column / bottom band panes, then spacers;
 *   - growOrder: grid, files, phases/sessions, ports, then spacers;
 *   - so under pressure spacers collapse first, then the FILES ticker shrinks
 *     to 3, then the grid to one card row.
 *
 * Pure: no Ink/React and no measuring loop.
 */

export interface Demand {
  id: string;
  /** Rows this demand needs before anything later is served. */
  min: number;
  /** Rows this demand may grow to. */
  max: number;
  /** Grow in whole steps only (e.g. the card row pitch). */
  step?: number;
}

function toRows(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

export function allocate(
  total: number,
  demands: readonly Demand[],
  growOrder?: readonly string[],
): Record<string, number> {
  let remaining = toRows(total);
  const out: Record<string, number> = {};
  const byId = new Map<string, Demand>();

  // Pass 1: minimums in priority (array) order.
  for (const d of demands) {
    if (byId.has(d.id)) continue;
    byId.set(d.id, d);
    const max = toRows(d.max);
    const min = Math.min(toRows(d.min), max);
    const grant = Math.min(min, remaining);
    out[d.id] = grant;
    remaining -= grant;
  }

  // Pass 2: growth in growOrder, toward each max.
  const order = growOrder ?? demands.map((d) => d.id);
  const grown = new Set<string>();
  for (const id of order) {
    if (remaining <= 0) break;
    const d = byId.get(id);
    if (!d || grown.has(id)) continue;
    grown.add(id);
    const cur = out[id]!;
    const max = toRows(d.max);
    const min = Math.min(toRows(d.min), max);
    // A demand still below its minimum only happens when rows ran out in pass 1.
    if (cur < min) continue;
    const room = Math.min(max - cur, remaining);
    if (room <= 0) continue;
    const step = d.step !== undefined && Number.isFinite(d.step) && d.step >= 1 ? Math.trunc(d.step) : 1;
    const add = Math.floor(room / step) * step;
    out[id] = cur + add;
    remaining -= add;
  }

  return out;
}
