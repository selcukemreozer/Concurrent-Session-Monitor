import React from "react";
import { Box, Text, useWindowSize } from "ink";
import { readAll, type SessionRow } from "../aggregate.js";
import { pruneSession } from "../prune.js";
import { sanitize } from "../sanitize.js";
import { numEnv } from "../env.js";
import { SessionCard, CompactRow, ConflictBand, PortsPane } from "./Card.js";
import { detectConflicts, type Conflict } from "../conflicts.js";
import { scanPorts, portScanMs, type ScannedPort } from "../ports.js";

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

/**
 * Vertical lines the borderless header box occupies: two content rows (the
 * title/clock line and the summary line) + its `marginBottom`. There is no
 * round border, so no top/bottom border rows are counted. Reserved from the
 * terminal height so the overflow-to-compact switch (D-13) still accounts for
 * the header's real height — it feeds `capacity = termRows - HEADER_LINES`.
 */
const HEADER_LINES = 3;

/**
 * Vertical lines the bottom two-column ports/extras shell reserves from the
 * roster capacity (Pitfall 4). Bounds the LEFT `PortsPane` — at most `PORTS_CAP`
 * (6) port rows + their group headings + the `marginTop` gap — so the ports
 * region can never grow enough to push the roster off the alternate screen.
 * Subtracted from `capacity` alongside `HEADER_LINES` so the overflow-to-compact
 * switch (D-13) accounts for the shell's real height.
 */
const PORTS_LINES = 10;

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
  /** Cross-session file conflicts detected this tick (PANEL-04, D-13). Re-derived
   * every poll from the raw live `rows` (never the grace-ghost `display` list), so
   * a cleared overlap disappears next tick with no stored conflict state. */
  conflicts: Conflict[];
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
  // Detect on the raw live `rows` (D-12 filters non-live inside), NOT `display`
  // — a grace-ghost must never contribute a conflict (SC-3). One detection per
  // tick, re-derived every poll so a cleared overlap auto-clears (D-13, SC-4).
  const conflicts = detectConflicts(rows, now);
  return { display, live: liveCount, idle: idleCount, conflicts };
}

/** First 8 chars of the session id (D-05), sanitized (WR-04). */
function shortId(session_id: string): string {
  return sanitize(String(session_id).slice(0, 8));
}

/**
 * Live wall-clock stamp `YYYY-MM-DD HH:MM:SS` (local time) for the header band.
 * Recomputed on every render; since the ~750ms poll re-renders App each tick,
 * the clock advances on its own with no dedicated timer — this is what gives the
 * panel its "live" feel.
 */
function fmtClock(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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

  // Cached last-good scan result + an in-flight guard so scans never overlap.
  const [ports, setPorts] = React.useState<ScannedPort[]>([]);
  const scanning = React.useRef(false);

  // SECOND, slower timer (D-05, PORT-06): spawn scanPorts() asynchronously off
  // the render thread at portScanMs() cadence — independent of and NEVER inside
  // the 750ms poll. An in-flight scan is skipped (overlap guard); the resolved
  // ScannedPort[] is cached in state and rendered between scans. On unmount the
  // interval is cleared and a late resolve is ignored (alive flag). scanPorts()
  // never rejects, but the catch still resets to [] defensively.
  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      if (scanning.current) return; // prior scan still running — skip, no overlap
      scanning.current = true;
      scanPorts()
        .then((p) => { if (alive) setPorts(p); })
        .catch(() => { if (alive) setPorts([]); })
        .finally(() => { scanning.current = false; });
    };
    tick(); // scan once on mount
    const t = setInterval(tick, portScanMs());
    return () => { alive = false; clearInterval(t); };
  }, []);

  const { rows: termRows, columns: termCols } = useWindowSize();
  const capacity = Math.max(1, termRows - HEADER_LINES - PORTS_LINES);
  const compact = state.display.length * CARD_LINES > capacity;

  // Live (non-grace) rows feed the PortsPane attribution join so ownership stays
  // fresh against the 750ms liveness — a grace-ghost never claims a port.
  const liveRows = state.display.filter((d) => !d.ended).map((d) => d.row);

  const nConf = state.conflicts.length;
  const summaryLead = sanitize(`${state.live} live · ${state.idle} idle · `);
  const conflictLabel = sanitize(`${nConf} conflicts`);
  const clock = sanitize(fmtClock(Date.now()));

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        paddingX={1}
        marginBottom={1}
        width={termCols}
      >
        <Box justifyContent="space-between">
          <Text bold color="cyan">
            {"◆ Concurrent Session Monitor"}
          </Text>
          <Text dimColor>{clock}</Text>
        </Box>
        <Text>
          {summaryLead}
          <Text color={nConf > 0 ? "red" : undefined} bold={nConf > 0}>
            {conflictLabel}
          </Text>
        </Text>
      </Box>
      <ConflictBand conflicts={state.conflicts} />
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
      <Box flexDirection="row" width={termCols} marginTop={1}>
        <Box flexDirection="column" flexBasis="50%" flexGrow={1} flexShrink={1} paddingX={1}>
          <PortsPane ports={ports} rows={liveRows} />
        </Box>
        <Box flexDirection="column" flexBasis="50%" flexGrow={1} flexShrink={1} paddingX={1}>
          {/* RIGHT — FAZLAR placeholder reserved for Phase 04.2; renders nothing. */}
        </Box>
      </Box>
    </Box>
  );
}
