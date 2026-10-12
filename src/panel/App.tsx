import React from "react";
import { Box, Text, useWindowSize, useInput, useStdin } from "ink";
import { readAll, type SessionRow } from "../aggregate.js";
import { pruneSession } from "../prune.js";
import { sanitize } from "../sanitize.js";
import { labelLead } from "../label.js";
import { numEnv } from "../env.js";
import {
  SessionCard,
  CompactRow,
  ConflictBand,
  PortsPane,
  PhasesPane,
  SessionsPane,
  FAZLAR_TOGGLE_HINT,
  SUBAGENT_COLOR,
} from "./Card.js";
import {
  discoverSessions,
  resumeScanMs,
  reconcileSelection,
  followOffset,
  RESUME_LIST_N,
  RESUME_VISIBLE_ROWS,
  readLiveRegistry,
  registryDirs,
  type ResumeRow,
} from "../sessions.js";
import { copyResume, openResume, type LaunchResult } from "./launch.js";
import {
  claimLaunch,
  settleLaunch,
  settleHolds,
  applyHolds,
  type LaunchHolds,
} from "./launch-hold.js";
import { detectConflicts, type Conflict } from "../conflicts.js";
import { scanPorts, portScanMs, type ScannedPort } from "../ports.js";
import { scanBranches, branchScanMs, liveBranch } from "../branch.js";
import {
  scanProgress,
  phaseScanMs,
  resolveGsdTools,
  resolvePlanningRoots,
  buildFocusSet,
  clampOffset,
  cycleIndex,
  FAZLAR_VISIBLE_ROWS,
  type Progress,
} from "../phases.js";

/** Poll cadence (Claude's Discretion): ~750ms comfortably meets criterion #1
 * ("a touch appears within about a second") without a file watcher. */
const POLL_MS = 750;

/** Which pane the RIGHT bottom slot shows (Phase 8, D-14): `r` flips it on a TTY. */
type RightPane = "fazlar" | "oturumlar";

/** How long a SUCCESSFUL copy/open result stays in the OTURUMLAR pane (D-15).
 * A failure message stays until the next action instead. */
const RESUME_FLASH_MS = 3000;

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
 * (D-13) via Ink's built-in `useWindowSize`.
 *
 * The RIGHT bottom slot holds the interactive FAZLAR pane (PANEL-07/08/09): a
 * SECOND, slower env-gated scan effect (`phaseScanMs`) resolves `.planning/`
 * roots OFF the render tick (`resolvePlanningRoots`) and spawns `scanProgress`
 * for the focused project, while a TTY-guarded `useInput`
 * (`isActive: isRawModeSupported`) drives Tab/Shift+Tab project cycling and
 * arrow/PageUp/PageDown FAZLAR scrolling. Raw mode is entered ONLY when a TTY is
 * present, so Ink's default `exitOnCtrlC` cleanly unmounts the alt-screen on
 * Ctrl+C, reconciled with the launcher's idempotent SIGINT/SIGTERM handlers
 * (D-07); on a non-TTY the handler is inert and the pane degrades to static
 * (D-08). The render tick itself does ZERO filesystem IO — `buildFocusSet` is a
 * pure derivation over the pre-resolved `planningRoots` set.
 *
 * Phase 8 (RESUME-04): on a TTY `r` flips the right slot between FAZLAR (the
 * default) and OTURUMLAR, the resumable-sessions picker (D-14); each pane shows
 * a dim toggle hint, and on a non-TTY the slot stays FAZLAR with no hint. The
 * OTURUMLAR list comes from a visibility-gated scan (D-19): one immediate
 * `discoverSessions` call when the pane opens, then a `resumeScanMs()` interval
 * that is cleared as soon as FAZLAR returns or App unmounts. The scan is async,
 * overlap-guarded and never part of the 750ms poll; its last-good rows stay
 * cached across toggles. The cursor is kept as a session id (D-17), Enter copies
 * and `o` opens the selected session through launch.ts (D-15, D-16).
 *
 * D-16 launch hold (review CR-01, 08-07): `o` claims the session id
 * synchronously, before anything is awaited (launch-hold.ts). A held id is
 * treated as live, so a second `o` (or Enter) on it copies and warns and never
 * starts a second `claude --resume` on the same transcript. Right before
 * launching, `o` also re-checks liveness from fresh sources (the CC registry
 * plus the current CSM store ids), because the scanned `live` flag can be one
 * scan interval old. Held rows render `· live` at once through an applyHolds
 * overlay (D-11). Only the claiming press's failed launch, or a later scan
 * (confirmation, or one started LAUNCH_HOLD_MS after the claim), releases a hold.
 */
/**
 * The panel keyboard handler (PANEL-09, Phase 8 D-15), isolated into its own
 * component so `useInput` — which enters raw mode and takes over
 * `process.stdin` — is invoked ONLY when App mounts it, i.e. on a TTY (D-08).
 * Tab/Shift+Tab cycle the focused project; arrows move by one row and
 * PageUp/PageDown by a full window (FAZLAR scroll or the OTURUMLAR cursor);
 * Enter copies and `o` opens the selected OTURUMLAR session; `r` toggles the
 * right pane (D-14). `r` / `o` are ignored with Ctrl or Meta held. No other key
 * is bound — j/k/x/y/n/Esc stay free (quick task 260927-8ge) — and Ctrl+C is
 * left to Ink's default `exitOnCtrlC` (04.2 D-07, locked). Renders nothing.
 */
function PanelKeyboard({
  onCycle,
  onScroll,
  onToggle,
  onEnter,
  onOpen,
}: {
  onCycle: (dir: 1 | -1) => void;
  onScroll: (dir: 1 | -1, page: boolean) => void;
  onToggle: () => void;
  onEnter: () => void;
  onOpen: () => void;
}) {
  useInput((input, key) => {
    if (key.tab) onCycle(key.shift ? -1 : 1);
    else if (key.upArrow) onScroll(-1, false);
    else if (key.downArrow) onScroll(1, false);
    else if (key.pageUp) onScroll(-1, true);
    else if (key.pageDown) onScroll(1, true);
    else if (key.return) onEnter();
    else if (!key.ctrl && !key.meta && input === "r") onToggle();
    else if (!key.ctrl && !key.meta && input === "o") onOpen();
  });
  return null;
}

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

  // Cached live-branch map (cwd -> current checkout) + an in-flight overlap guard.
  const [branches, setBranches] = React.useState<Map<string, string>>(() => new Map());
  const scanningBranches = React.useRef(false);

  // THIRD, slow scan effect (LB-02, D-LB-04): a sibling of the port-scan effect,
  // NEVER inside the 750ms poll. Each non-overlapping tick derives each LIVE
  // (non-grace) session's CURRENT git branch from its cwd off the render thread at
  // branchScanMs() cadence, caches the resolved Map in state, and merges it into
  // the rows via liveBranch(). It reads liveRowsRef.current (declared below, the
  // freshest live rows) so it never re-arms every render. scanBranches() never
  // rejects, but the catch still resets to an empty Map defensively; on unmount
  // the interval is cleared and a late resolve is ignored (alive flag).
  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      if (scanningBranches.current) return; // prior scan still running — skip, no overlap
      scanningBranches.current = true;
      scanBranches(liveRowsRef.current)
        .then((m) => { if (alive) setBranches(m); })
        .catch(() => { if (alive) setBranches(new Map()); })
        .finally(() => { scanningBranches.current = false; });
    };
    tick(); // scan once on mount
    const t = setInterval(tick, branchScanMs());
    return () => { alive = false; clearInterval(t); };
  }, []);

  const { rows: termRows, columns: termCols } = useWindowSize();
  const capacity = Math.max(1, termRows - HEADER_LINES - PORTS_LINES);
  const compact = state.display.length * CARD_LINES > capacity;

  // Live (non-grace) rows feed the PortsPane attribution join so ownership stays
  // fresh against the 750ms liveness — a grace-ghost never claims a port.
  const liveRows = state.display.filter((d) => !d.ended).map((d) => d.row);

  // ── FAZLAR (RIGHT pane) state ──────────────────────────────────────────────
  // Cached per-root Progress + the async-resolved planningRoots set (the ONLY
  // place `.planning/` existence is probed, off the render tick), plus the Tab
  // focus index and the FAZLAR scroll offset. `scanningPhases` is the overlap
  // guard; `shimRef` caches the resolved gsd-tools shim (resolved once).
  const [progress, setProgress] = React.useState<Map<string, Progress>>(() => new Map());
  const [planningRoots, setPlanningRoots] = React.useState<Set<string>>(() => new Set());
  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const [scrollOffset, setScrollOffset] = React.useState(0);
  const scanningPhases = React.useRef(false);
  const shimRef = React.useRef<string | null | undefined>(undefined);
  if (shimRef.current === undefined) shimRef.current = resolveGsdTools();

  // Component-lifetime "mounted" flag so a late scan resolve is dropped only on a
  // REAL unmount — NOT when the reconciler re-runs the (focus-keyed) scan effect
  // or dev-double-invokes passive effects. A per-effect `let alive` closure would
  // be flipped false by that teardown and silently swallow the first scan; this
  // `[]`-scoped ref settles back true after any remount, so the async result
  // reaches the live component's stable state setters.
  const mounted = React.useRef(false);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // PURE, fs-free render-path derivation (D-01): the switchable focus set is just
  // buildFocusSet over the pre-resolved planningRoots — NO existsSync/statSync on
  // the Ink render tick. idx is the clamped focus; focusRoot the current root.
  const focusSet = buildFocusSet(liveRows, planningRoots);
  const idx = focusSet.length ? focusedIndex % focusSet.length : 0;
  const focusRoot = focusSet.length ? focusSet[idx].root : null;
  const focusProgress = focusRoot ? progress.get(focusRoot) ?? null : null;
  const totalPhases = focusProgress ? focusProgress.phases.length : 0;

  // Refs so the slow scan interval reads the freshest liveRows / focus index
  // without re-arming every 750ms render (avoids stale closures, Pattern 1).
  const liveRowsRef = React.useRef(liveRows);
  liveRowsRef.current = liveRows;
  const focusedIndexRef = React.useRef(focusedIndex);
  focusedIndexRef.current = focusedIndex;

  // SECOND, slower scan timer (PANEL-08) — a sibling of the port-scan effect,
  // NEVER inside the 750ms poll. Each non-overlapping tick FIRST resolves the
  // `.planning/` roots off the render tick (setPlanningRoots), THEN — using the
  // just-resolved roots so a fresh focus is scanned immediately — spawns
  // scanProgress for the focused project and caches it under its root. Always
  // non-fatal; re-runs on a focus change (dep on focusedIndex) so Tab surfaces
  // the newly-focused project's progress promptly. Cleared on unmount.
  React.useEffect(() => {
    const tick = () => {
      if (scanningPhases.current) return; // prior scan still running — no overlap
      scanningPhases.current = true;
      resolvePlanningRoots(liveRowsRef.current)
        .then((roots) => {
          if (!mounted.current) return undefined;
          setPlanningRoots(roots);
          const fs = buildFocusSet(liveRowsRef.current, roots);
          const i = fs.length ? focusedIndexRef.current % fs.length : 0;
          const root = fs.length ? fs[i].root : null;
          const shim = shimRef.current;
          if (shim && root) {
            return scanProgress(root, shim).then((p) => {
              if (mounted.current && p) setProgress((prev) => new Map(prev).set(root, p));
            });
          }
          return undefined;
        })
        .catch(() => {
          /* non-fatal: a scan/probe failure just leaves the last-good cache */
        })
        .finally(() => {
          scanningPhases.current = false;
        });
    };
    tick(); // run once on mount so planningRoots populates near-immediately
    const t = setInterval(tick, phaseScanMs());
    return () => {
      // Release the overlap guard on teardown so a re-armed effect (focus change
      // or dev re-invoke) is never dead-locked by an in-flight scan's stale flag.
      scanningPhases.current = false;
      clearInterval(t);
    };
  }, [focusedIndex]);

  // Reset the FAZLAR scroll window to the top whenever the focused project
  // changes (D-04) — a fresh project always starts at its first phase.
  React.useEffect(() => {
    setScrollOffset(0);
  }, [idx]);

  // ── OTURUMLAR (RIGHT pane, Phase 8) state ──────────────────────────────────
  // Which pane the right slot shows (FAZLAR by default, D-14), the cached
  // last-good resume rows (null until the first scan resolves), the cursor kept
  // as a session id (D-17), the list scroll offset and the copy/open result line.
  const [rightPane, setRightPane] = React.useState<RightPane>("fazlar");
  const [resumeRows, setResumeRows] = React.useState<ResumeRow[] | null>(null);
  const [selId, setSelId] = React.useState<string | null>(null);
  const [resumeOffset, setResumeOffset] = React.useState(0);
  const [resumeStatus, setResumeStatus] = React.useState<string | null>(null);
  // Overlap guard for the resume scan, plus refs holding the latest values so the
  // key handlers never act on a stale list (T-08-11) and quick successive keys
  // see each other's effect before React re-renders.
  const scanningResume = React.useRef(false);
  // Generation of the current OTURUMLAR visible period (D-19) and the tick of
  // the live scan effect, so a discarded scan can kick a fresh one at once.
  const resumeScanGen = React.useRef(0);
  const resumeTickRef = React.useRef<(() => void) | null>(null);
  const rightPaneRef = React.useRef(rightPane);
  rightPaneRef.current = rightPane;
  const resumeRowsRef = React.useRef(resumeRows);
  resumeRowsRef.current = resumeRows;
  const selIdRef = React.useRef(selId);
  selIdRef.current = selId;
  // Last known index of the selected row; only updated while the id is still
  // in the list, so reconcileSelection can fall back to the nearest row when
  // the selected session drops out (D-17).
  const selIdxRef = React.useRef(0);
  if (resumeRows !== null && selId !== null) {
    const i = resumeRows.findIndex((r) => r.id === selId);
    if (i >= 0) selIdxRef.current = i;
  }
  const resumeOffsetRef = React.useRef(resumeOffset);
  resumeOffsetRef.current = resumeOffset;
  // D-16 launch holds (launch-hold.ts): ids this panel is launching or has just
  // launched, keyed by session id, plus the per-press token counter. Kept in
  // refs so quick successive keys see each other's claim before React
  // re-renders; holdVersion only forces a re-render after a hold changes.
  const launchHolds = React.useRef<LaunchHolds>(new Map());
  const holdToken = React.useRef(0);
  const [, setHoldVersion] = React.useState(0);
  const bumpHolds = () => {
    if (mounted.current) setHoldVersion((v) => v + 1);
  };
  const flashTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = null;
    },
    [],
  );

  // Visibility-gated resume scan (D-19, RESUME-04): runs ONLY while OTURUMLAR is
  // visible — one immediate tick when `r` opens it, then a slow resumeScanMs()
  // interval; switching back to FAZLAR (or unmounting) clears the interval. It
  // is async and never part of the 750ms poll (T-08-12). liveIds are the
  // non-ended store rows' session ids, so a CSM-tracked live session is marked
  // live even without a registry entry (D-11); launch holds are never fed in.
  // A rejected scan keeps the last-good rows; rows are not reset on hide, so
  // reopening shows the cached list while the next scan runs.
  //
  // D-19 overlap rules (review WR-03, 08-07):
  // - The in-flight scan owns the overlap guard: only its own `finally` clears
  //   scanningResume, never the effect cleanup, so a quick r,r,r (show, hide,
  //   show) can never run two discoverSessions calls at once.
  // - Each visible period has a generation; the cleanup bumps it on hide or
  //   unmount. A scan's rows apply only when its generation is still current
  //   and App is mounted, so an older scan never overwrites fresher rows.
  // - When a discarded scan ends while OTURUMLAR is visible again, a fresh scan
  //   starts at once instead of waiting a full interval.
  // - Launch holds (D-16) are settled only from applied scans, using the time
  //   the scan started.
  React.useEffect(() => {
    if (rightPane !== "oturumlar") return undefined;
    const gen = ++resumeScanGen.current;
    const tick = () => {
      if (scanningResume.current) return; // prior scan still running — no overlap
      scanningResume.current = true;
      const startedAt = Date.now();
      // liveIds come from the store only, never from launch holds: settleHolds
      // reads the scan's live flag as the confirmation that releases a hold.
      discoverSessions({
        n: RESUME_LIST_N,
        liveIds: new Set(liveRowsRef.current.map((r) => r.session_id)),
      })
        .then((rows) => {
          if (!mounted.current || gen !== resumeScanGen.current) return; // stale scan
          if (settleHolds(launchHolds.current, rows, startedAt)) bumpHolds();
          setResumeRows(rows);
        })
        .catch(() => {
          /* non-fatal: keep the last-good rows */
        })
        .finally(() => {
          scanningResume.current = false;
          // A discarded scan blocked the reopened pane's first tick: run it now.
          if (gen !== resumeScanGen.current && mounted.current) resumeTickRef.current?.();
        });
    };
    resumeTickRef.current = tick;
    tick();
    const t = setInterval(tick, resumeScanMs());
    return () => {
      clearInterval(t);
      // Discard results of scans started in this visible period from now on.
      // scanningResume is deliberately left alone: only the scan's finally
      // releases it.
      resumeScanGen.current += 1;
      if (resumeTickRef.current === tick) resumeTickRef.current = null;
    };
  }, [rightPane]);

  // Keep the cursor on the same session id when a scan reorders or drops rows,
  // falling back to the nearest row; the scroll offset follows the cursor (D-17).
  React.useEffect(() => {
    if (resumeRows === null) return;
    const r = reconcileSelection(resumeRows, selIdRef.current, selIdxRef.current);
    selIdRef.current = r.selId;
    if (r.idx >= 0) selIdxRef.current = r.idx;
    const off = followOffset(Math.max(0, r.idx), resumeOffsetRef.current, resumeRows.length, RESUME_VISIBLE_ROWS);
    resumeOffsetRef.current = off;
    setSelId(r.selId);
    setResumeOffset(off);
  }, [resumeRows]);

  // Raw-mode is entered ONLY on a TTY (D-08, Pitfall 1). Rather than call
  // `useInput` with `{isActive:false}` on a non-TTY — which still makes Ink
  // reference/handle `process.stdin` and perturbs render/timer scheduling in a
  // piped run — the keyboard handler lives in a child (`PanelKeyboard`) that is
  // mounted ONLY when `isRawModeSupported`. On a non-TTY the child never mounts,
  // so `useInput` is never called and the panel degrades to a pure, inert render
  // that always shows FAZLAR (OTURUMLAR is unreachable and never scanned).
  const { isRawModeSupported } = useStdin();

  const clearResumeStatus = () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = null;
    setResumeStatus(null);
  };
  // Show a copy/open result in the pane: a success clears after RESUME_FLASH_MS,
  // a failure stays until the next action (D-15).
  const showResult = (r: LaunchResult) => {
    if (!mounted.current) return;
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = null;
    setResumeStatus(r.message);
    if (r.ok) {
      flashTimer.current = setTimeout(() => {
        flashTimer.current = null;
        if (mounted.current) setResumeStatus(null);
      }, RESUME_FLASH_MS);
    }
  };
  // The selected OTURUMLAR row, read from the refs (never a stale closure).
  const selectedRow = (): ResumeRow | null => {
    if (rightPaneRef.current !== "oturumlar") return null;
    const rows = resumeRowsRef.current;
    const id = selIdRef.current;
    if (rows === null || id === null) return null;
    return rows.find((r) => r.id === id) ?? null;
  };
  // A row counts as live when the last scan said so OR this panel holds it
  // (launching or just launched, D-16).
  const isLive = (row: ResumeRow): boolean => row.live || launchHolds.current.has(row.id);

  const onToggle = () => {
    const next: RightPane = rightPaneRef.current === "fazlar" ? "oturumlar" : "fazlar";
    rightPaneRef.current = next;
    setRightPane(next);
    clearResumeStatus();
  };
  // Tab cycles the FAZLAR project; it is a no-op while OTURUMLAR is visible.
  const onCycle = (dir: 1 | -1) => {
    if (rightPaneRef.current !== "fazlar") return;
    setFocusedIndex((i) => cycleIndex(i, focusSet.length, dir));
  };
  const onScroll = (dir: 1 | -1, page: boolean) => {
    if (rightPaneRef.current === "fazlar") {
      const delta = dir * (page ? FAZLAR_VISIBLE_ROWS : 1);
      setScrollOffset((o) => clampOffset(o + delta, totalPhases, FAZLAR_VISIBLE_ROWS));
      return;
    }
    // OTURUMLAR: move the cursor by one row (arrows) or one window (PgUp/PgDn).
    const rows = resumeRowsRef.current;
    if (rows === null || rows.length === 0) return;
    const found = rows.findIndex((r) => r.id === selIdRef.current);
    const cur = found >= 0 ? found : Math.min(rows.length - 1, Math.max(0, selIdxRef.current));
    const step = page ? RESUME_VISIBLE_ROWS : 1;
    const next = Math.min(rows.length - 1, Math.max(0, cur + dir * step));
    const id = rows[next]!.id;
    const off = followOffset(next, resumeOffsetRef.current, rows.length, RESUME_VISIBLE_ROWS);
    selIdRef.current = id;
    selIdxRef.current = next;
    resumeOffsetRef.current = off;
    setSelId(id);
    setResumeOffset(off);
    clearResumeStatus();
  };
  // Enter: copy the resume line for the selected row (D-15). The row's cwd is
  // passed so launch.ts can build the session-cwd form (D-10 REVISED), and the
  // live flag (scan OR launch hold) so launch.ts warns on a live session (D-16).
  const onEnter = () => {
    const row = selectedRow();
    if (row === null) return;
    copyResume({ id: row.id, cwd: row.cwd, live: isLive(row) }).then(showResult, () => {});
  };
  // `o`: open the selected session in a new terminal window/tab. A live row is
  // never opened — launch.ts copies and warns instead (D-16, T-08-09). To keep
  // a double `o`, or an `o` during a pending launch, from starting a second
  // process (review CR-01), the id is claimed synchronously BEFORE anything is
  // awaited; a held id is treated as live. Liveness is then re-checked from
  // fresh sources (CC registry + current store ids), since the scanned flag can
  // be one scan interval old. Only this press's own failed launch (token-
  // checked) releases the claim; a success stays held until a scan settles it.
  const onOpen = () => {
    const row = selectedRow();
    if (row === null) return;
    // `row` is a const snapshot of an immutable scan row, so a later cursor
    // move cannot change what this in-flight press launches (T-08-11).
    const id = row.id;
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = null;
    setResumeStatus("opening…");
    if (isLive(row)) {
      // Live or held: copy and warn only; no claim, and the result never
      // touches the holds.
      openResume({ id, cwd: row.cwd, live: true }).then(showResult, () => {});
      return;
    }
    const token = ++holdToken.current;
    claimLaunch(launchHolds.current, id, Date.now(), token);
    bumpHolds(); // the row shows `· live` at once (D-11)
    readLiveRegistry(registryDirs())
      .catch(() => new Set<string>())
      .then((registry) => {
        const fresh = new Set(registry);
        for (const r of liveRowsRef.current) fresh.add(r.session_id);
        return openResume({ id, cwd: row.cwd, live: fresh.has(id) });
      })
      .then(
        (r) => {
          settleLaunch(launchHolds.current, id, token, r.ok);
          bumpHolds();
          showResult(r);
        },
        () => {
          settleLaunch(launchHolds.current, id, token, false);
          bumpHolds();
        },
      );
  };

  const nConf = state.conflicts.length;
  const summaryLead = sanitize(`${state.live} live · ${state.idle} idle · `);
  const conflictLabel = sanitize(`${nConf} conflicts`);
  // "N waiting" / "N asking" needs-you counters (ATTN-03 D-01; 260926-vfm D-04):
  // count ONLY non-ended display rows (Pitfall 5) — an ended/grey row in its
  // prune grace must never inflate the count nor resurrect a pruned session.
  // Consumes the pre-gated d.row.asking / d.row.attention booleans; no
  // window/newer-than re-check here. Asking wins, so a row carrying both flags
  // is counted exactly once, under asking (the reader already guarantees this).
  const nAsking = state.display.filter((d) => !d.ended && d.row.asking).length;
  const nWaiting = state.display.filter(
    (d) => !d.ended && d.row.attention && !d.row.asking,
  ).length;
  const waitingLabel = sanitize(`${nWaiting} waiting`);
  const askingLabel = sanitize(`${nAsking} asking`);
  // "N subagent" counter (260927-73b D-05): same rules — non-ended display rows
  // only, consuming the pre-gated d.row.subagent (already false whenever asking
  // or waiting holds). Counts rows, not background agents.
  const nSubagent = state.display.filter((d) => !d.ended && d.row.subagent).length;
  const subagentLabel = sanitize(`${nSubagent} subagent`);
  const clock = sanitize(fmtClock(Date.now()));
  // OTURUMLAR display rows: held ids read as live at once (D-11, D-16). Cursor,
  // scroll and selection stay on the RAW resumeRows; the ids are identical.
  const shownRows = applyHolds(resumeRows, launchHolds.current);

  // Merge the live-derived branch into each roster row (D-LB-03): App overrides
  // the `branch` field so SessionCard's `s.branch` display AND its 260914-507
  // target-mismatch flag (which compares target_branch vs s.branch) both operate
  // on the LIVE checkout automatically — Card.tsx is intentionally unchanged. Falls
  // back to the session-start snapshot until/unless the scan resolves (liveBranch).
  // Identity-preserving: an unchanged branch returns the same row reference. NOTE:
  // PortsPane/ConflictBand stay on the snapshot row — live-branch merge is scoped
  // to the roster display here and out of scope for those panes.
  const withLiveBranch = (row: SessionRow): SessionRow => {
    const b = liveBranch(row, branches);
    return b === row.branch ? row : { ...row, branch: b };
  };

  return (
    <Box flexDirection="column">
      {isRawModeSupported ? (
        <PanelKeyboard
          onCycle={onCycle}
          onScroll={onScroll}
          onToggle={onToggle}
          onEnter={onEnter}
          onOpen={onOpen}
        />
      ) : null}
      <Box
        flexDirection="column"
        paddingX={1}
        marginBottom={1}
        width={termCols}
      >
        <Box justifyContent="space-between">
          <Text bold color="green">
            {"◆ Concurrent Session Monitor"}
          </Text>
          <Text dimColor>{clock}</Text>
        </Box>
        <Text>
          {summaryLead}
          <Text color={nConf > 0 ? "red" : undefined} bold={nConf > 0}>
            {conflictLabel}
          </Text>
          {" · "}
          <Text color={nWaiting > 0 ? "yellowBright" : undefined} bold={nWaiting > 0}>
            {waitingLabel}
          </Text>
          {" · "}
          <Text color={nAsking > 0 ? "magenta" : undefined} bold={nAsking > 0}>
            {askingLabel}
          </Text>
          {" · "}
          <Text color={nSubagent > 0 ? SUBAGENT_COLOR : undefined} bold={nSubagent > 0}>
            {subagentLabel}
          </Text>
        </Text>
      </Box>
      <ConflictBand conflicts={state.conflicts} />
      {state.display.map((d) =>
        d.ended ? (
          <Text key={d.id} dimColor color="grey">
            {/* NAME-02 / D-08: the fading row keeps the native name (labelLead:
                sanitized, 24-grapheme cap) so it never flips to the folder; an
                unnamed row keeps the folder lead, no (unnamed). */}
            {`● ${labelLead(d.row)} · ${shortId(d.id)} · ended`}
          </Text>
        ) : compact ? (
          <CompactRow key={d.id} s={withLiveBranch(d.row)} />
        ) : (
          <SessionCard key={d.id} s={withLiveBranch(d.row)} />
        ),
      )}
      <Box flexDirection="row" width={termCols} marginTop={1}>
        <Box flexDirection="column" flexBasis="50%" flexGrow={1} flexShrink={1} paddingX={1}>
          <PortsPane ports={ports} rows={liveRows} />
        </Box>
        <Box flexDirection="column" flexBasis="50%" flexGrow={1} flexShrink={1} paddingX={1}>
          {/* RIGHT — FAZLAR (the Tab-focused project's GSD phase progress, 04.2)
              by default; `r` swaps in OTURUMLAR, the resume picker (D-14). */}
          {rightPane === "oturumlar" ? (
            <SessionsPane
              rows={shownRows}
              cursorId={selId}
              scrollOffset={resumeOffset}
              status={resumeStatus}
              now={Date.now()}
            />
          ) : (
            <PhasesPane
              focus={focusSet.length ? focusSet[idx] : null}
              index={idx}
              count={focusSet.length}
              progress={focusProgress}
              scrollOffset={scrollOffset}
              interactive={isRawModeSupported}
              paneHint={isRawModeSupported ? FAZLAR_TOGGLE_HINT : null}
            />
          )}
        </Box>
      </Box>
    </Box>
  );
}
