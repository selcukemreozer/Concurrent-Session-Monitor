import type { Reconciled } from "../hooks/useRoster.js";
import type { HeaderModel } from "./models.js";
import { fmtClock24 } from "./draw/header.js";
import { updateLabel } from "../../update.js";

/**
 * The live v2 header model (Phase 9, plan 09-12; D-20: the header is live in
 * Phase 9 even though every pane shows the sample fixture).
 *
 * Counting follows the shipped legacy rules (App.tsx header counters):
 *   - `agents` counts the non-ended display rows only: a grace-ghost (ended)
 *     row never counts.
 *   - `asking` counts non-ended rows with the asking flag (AQ-04).
 *   - `waiting` counts non-ended rows with the attention flag and WITHOUT the
 *     asking flag, so a row that is both counts exactly once, under asking
 *     (ATTN-03 D-01, 260926-vfm D-04).
 *   - `conflicts` is the reconcile tick's conflict count (detected on the raw
 *     live rows, never the ghosts).
 *   - `update` is `updateLabel(updateTo)`: null for no or an invalid version.
 */
export function headerFromRoster(r: Reconciled, updateTo: string | null, nowMs: number): HeaderModel {
  const live = r.display.filter((d) => !d.ended);
  return {
    agents: live.length,
    asking: live.filter((d) => d.row.asking === true).length,
    waiting: live.filter((d) => d.row.attention === true && d.row.asking !== true).length,
    conflicts: r.conflicts.length,
    clock: fmtClock24(nowMs),
    update: updateLabel(updateTo),
  };
}
