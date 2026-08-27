import React from "react";
import { Box, Text, useWindowSize } from "ink";
import { readAll, type SessionRow } from "../aggregate.js";
import { pruneSession } from "../prune.js";
import { sanitize } from "../sanitize.js";
import { numEnv } from "../env.js";
import { SessionCard, CompactRow } from "./Card.js";

/** Poll cadence (Claude's Discretion): ~750ms comfortably meets criterion #1
 * ("a touch appears within about a second") without a file watcher. */
const POLL_MS = 750;

/**
 * Estimated vertical cost of one full `SessionCard` (round border top+bottom,
 * one header line, one file/"no files" line, plus the marginBottom). Used only
 * as a threshold to decide when the roster no longer fits and must collapse to
 * one-line `CompactRow`s (D-13) — a deliberate over-estimate so the switch trips
 * a little early rather than letting cards overflow the alternate screen.
 */
const CARD_LINES = 4;

/** Grace window (D-05, RESEARCH Open Q3): render a dead/vanished session dim-grey
 * as "ended" for ~1.2s (one–two poll ticks) BEFORE pruning it, so the user sees
 * it die rather than blink out. Env-gated for tuning/tests. */
function graceMs(): number {
  return numEnv("CSM_GRACE_MS", 1200);
}

/** One row as the panel will display it: the last-known session data plus whether
 * it is in its post-death "ended" grace (D-08). */
interface DisplayRow {
  id: string;
  row: SessionRow;
  ended: boolean;
}

/** What a reconcile tick hands back to render: the ordered display list plus the
 * header counts. */
interface Reconciled {
  display: DisplayRow[];
  live: number;
  idle: number;
}

/** Per-session memory across ticks: the last row we saw and, once it dies or
 * vanishes, when its grace started (D-05/D-06/D-08). */
interface SeenEntry {
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
function reconcile(seen: Map<string, SeenEntry>, rows: SessionRow[], now: number): Reconciled {
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
  return { display, live: liveCount, idle: idleCount };
}

/** First 8 chars of the session id (D-05), sanitized (WR-04). */
function shortId(session_id: string): string {
  return sanitize(String(session_id).slice(0, 8));
}

/**
 * The live cross-session panel (PANEL-01, PANEL-03, PANEL-05).
 *
 * Seeds its rows from a synchronous `readAll()` on mount, then arms a ~750ms
 * interval that re-reads the FULL store each tick, reconciles it through the
 * grace-then-prune lifecycle, and re-renders. A full re-read (not event deltas)
 * is self-healing across the store's atomic temp+rename writes and any missed
 * touch (Pattern 7 / Pitfall 4). The interval is cleared on unmount so the
 * process exits cleanly.
 *
 * A `seen` Map (session_id -> { row, endedAt? }) drives D-05/D-06/D-08: a dead or
 * vanished session renders dim-grey as "ended" for the grace, then App calls
 * `pruneSession(id)` exactly once (SC-3). A summary header reports live/idle
 * counts and a Phase-3 conflicts placeholder (D-15). When the roster would
 * overflow the terminal height, every row collapses to a one-line `CompactRow`
 * (D-13) via Ink's built-in `useWindowSize`. No raw-mode keyboard input — the
 * panel is read-only; the launcher owns SIGINT/SIGTERM shutdown.
 */
export function App() {
  const seen = React.useRef<Map<string, SeenEntry>>(new Map());
  const [state, setState] = React.useState<Reconciled>(() =>
    reconcile(seen.current, readAll(), Date.now()),
  );

  React.useEffect(() => {
    const timer = setInterval(
      () => setState(reconcile(seen.current, readAll(), Date.now())),
      POLL_MS,
    );
    return () => clearInterval(timer);
  }, []);

  const { rows: termRows } = useWindowSize();
  const capacity = Math.max(1, termRows - 1); // reserve one line for the header
  const compact = state.display.length * CARD_LINES > capacity;

  const header = sanitize(`${state.live} live · ${state.idle} idle · 0 conflicts`);

  return (
    <Box flexDirection="column">
      <Text>{header}</Text>
      {state.display.map((d) =>
        d.ended ? (
          <Text key={d.id} dimColor color="grey">
            {`● ${sanitize(d.row.folder)} · ${shortId(d.id)} · ended`}
          </Text>
        ) : compact ? (
          <CompactRow key={d.id} s={d.row} />
        ) : (
          <SessionCard key={d.id} s={d.row} />
        ),
      )}
    </Box>
  );
}
