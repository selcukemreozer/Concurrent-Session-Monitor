import React from "react";
import { readAll, type SessionRow } from "../../aggregate.js";
import { pruneSession } from "../../prune.js";
import { numEnv } from "../../env.js";
import { detectConflicts, type Conflict } from "../../conflicts.js";
import { usePoll } from "./usePoll.js";

/** Poll cadence (Claude's Discretion): ~750ms comfortably meets criterion #1
 * ("a touch appears within about a second") without a file watcher. */
export const POLL_MS = 750;

/** Grace window (D-05, RESEARCH Open Q3): render a dead/vanished session dim-grey
 * as "ended" for ~1.2s (one–two poll ticks) BEFORE pruning it, so the user sees
 * it die rather than blink out. Env-gated for tuning/tests. */
function graceMs(): number {
  return numEnv("CSM_GRACE_MS", 1200);
}

/** One row as the panel will display it: the last-known session data plus whether
 * it is in its post-death "ended" grace (D-08). */
export interface DisplayRow {
  id: string;
  row: SessionRow;
  ended: boolean;
}

/** What a reconcile tick hands back to render: the ordered display list plus the
 * header counts. */
export interface Reconciled {
  display: DisplayRow[];
  live: number;
  idle: number;
  /** Cross-session file conflicts detected this tick (PANEL-04, D-13). Re-derived
   * every poll from the raw live `rows` (never the grace-ghost `display` list), so
   * a cleared overlap disappears next tick with no stored conflict state. */
  conflicts: Conflict[];
}

/** Per-session memory across ticks: the last row we saw and, once it dies or
 * vanishes, when its grace started (D-05/D-06/D-08). */
export interface SeenEntry {
  row: SessionRow;
  endedAt?: number;
}

/**
 * The reader-side grace-then-prune reducer (RESEARCH Pattern 2), owned by App so
 * `readAll` stays a pure, disk-mutation-free reducer (Anti-Pattern: no rmSync in
 * readAll). Pure w.r.t. render — the ONLY side effect is the idempotent
 * `pruneSession(id)` call after the grace elapses.
 *
 * Each tick, for every current row: refresh its `seen` entry, clearing `endedAt`
 * while alive and starting the grace clock the instant it becomes not-alive /
 * readyToPrune (D-06). For any previously-seen id NOT in the current rows, start
 * the grace too — this gives a consistent "ended" ghost even on a clean
 * SessionEnd disappearance (D-08). When `now - endedAt >= graceMs`, call
 * `pruneSession(id)` exactly once (then delete the id, so it never fires twice —
 * idempotent regardless, per prune.ts). Live present rows render first in
 * `readAll`'s most-recently-active order (D-09); vanished-but-in-grace rows are
 * appended so the user still sees them fade.
 */
export function reconcile(seen: Map<string, SeenEntry>, rows: SessionRow[], now: number): Reconciled {
  const live = new Map(rows.map((r) => [r.session_id, r]));

  // Present rows: refresh/adopt, (re)starting the grace clock only on death.
  for (const [id, r] of live) {
    const dead = !r.alive || r.readyToPrune;
    const prev = seen.get(id);
    seen.set(id, { row: r, endedAt: dead ? prev?.endedAt ?? now : undefined });
  }

  // Vanished rows (clean SessionEnd or an already-reaped shard): start the grace.
  for (const [id, entry] of seen) {
    if (!live.has(id) && entry.endedAt == null) {
      seen.set(id, { row: entry.row, endedAt: now });
    }
  }

  // Prune anything whose grace has elapsed — exactly once per id.
  for (const id of [...seen.keys()]) {
    const entry = seen.get(id)!;
    if (entry.endedAt != null && now - entry.endedAt >= graceMs()) {
      pruneSession(id);
      seen.delete(id);
    }
  }

  // Display order: live/present rows first (D-09 order), then vanished-in-grace.
  const display: DisplayRow[] = [];
  for (const r of rows) {
    const entry = seen.get(r.session_id);
    if (!entry) continue; // pruned on this very tick
    display.push({ id: r.session_id, row: entry.row, ended: entry.endedAt != null });
  }
  for (const [id, entry] of seen) {
    if (live.has(id)) continue;
    display.push({ id, row: entry.row, ended: true });
  }

  const liveCount = rows.filter((r) => r.alive).length;
  const idleCount = rows.filter((r) => r.dotState === "idle").length;
  // Detect on the raw live `rows` (D-12 filters non-live inside), NOT `display`
  // — a grace-ghost must never contribute a conflict (SC-3). One detection per
  // tick, re-derived every poll so a cleared overlap auto-clears (D-13, SC-4).
  const conflicts = detectConflicts(rows, now);
  return { display, live: liveCount, idle: idleCount, conflicts };
}

/**
 * The live roster (PANEL-01/03/05): seeds from a synchronous `readAll()` on
 * mount, then re-reads the FULL store every POLL_MS and reconciles it through
 * the grace-then-prune lifecycle. A full re-read (not event deltas) is
 * self-healing across the store's atomic temp+rename writes and any missed
 * touch (Pattern 7 / Pitfall 4). The interval is cleared on unmount (usePoll)
 * so the process exits cleanly. The `seen` Map (session_id -> { row, endedAt? })
 * lives for the component's lifetime and drives D-05/D-06/D-08.
 */
export function useRoster(): Reconciled {
  const seen = React.useRef<Map<string, SeenEntry>>(new Map());
  const [state, setState] = React.useState<Reconciled>(() =>
    reconcile(seen.current, readAll(), Date.now()),
  );
  usePoll(
    () => {
      setState(reconcile(seen.current, readAll(), Date.now()));
    },
    POLL_MS,
    { immediate: false },
  );
  return state;
}
