import * as fs from "node:fs";
import * as path from "node:path";
import { sessionsDir } from "./paths.js";
import { numEnv } from "./env.js";
import type { SessionState, TouchEvent } from "./schema.js";
import {
  isProcessAlive,
  resolveLastSeen,
  staleMs,
  activeMs,
  defaultProbe,
  defaultStartedProbe,
  type Probe,
  type StartedProbe,
} from "./liveness.js";

/**
 * The rolling active window (D-02), config-adjustable via CSM_WINDOW_MS.
 * A touch is "active" only if it happened within this many ms of `now`.
 * Read lazily (not module-const) so tests can flip the env per-case.
 */
function windowMs(): number {
  return numEnv("CSM_WINDOW_MS", 5 * 60 * 1000);
}

/**
 * The SHORT read-activity window (D-04/D-05), config-adjustable via
 * CSM_READ_WINDOW_MS (default 30s). This is a DISTINCT semantic axis from
 * `windowMs()` (CSM_WINDOW_MS, the 5-min write window) and from `activeMs()`
 * (CSM_ACTIVE_MS, the dot-recency window) — a read decays ~10x faster than a
 * write. Read lazily (not module-const) so tests can flip the env per-case.
 */
function readWindowMs(): number {
  return numEnv("CSM_READ_WINDOW_MS", 30_000);
}

/** One file a session is actively touching within the window. */
export interface ActiveFile {
  file_path: string;
  ts: string;
}

/** A single aggregated session row the panel renders. */
export type SessionRow = SessionState & {
  /** Files touched within the active window, excluding released ones. */
  files: ActiveFile[];
  /**
   * Files READ within the short `CSM_READ_WINDOW_MS` window (D-04/D-06),
   * write-suppressed (D-07: a path in `files[]` is filtered out) and card-only —
   * reads NEVER drive sort, liveness, or conflict detection (D-02/D-03).
   */
  reads: ActiveFile[];
  /** Newest surviving touch ts (ISO-8601), or undefined if no active files. */
  last_active?: string;
  /** Resolved last-seen ts (ISO-8601) from the heartbeat sidecar, when present. */
  last_seen?: string;
  /**
   * Whether the session is shown at all (LIFE-01). TTL-authoritative:
   * `fresh || procAlive` — a fresh heartbeat keeps a row alive even when its
   * captured pid probes dead (SC-4).
   */
  alive: boolean;
  /** D-06 conjunction: heartbeat stale AND process gone. Consumed by the panel's prune path. */
  readyToPrune: boolean;
  /**
   * The status dot (D-12). A dead pid probe (or stale heartbeat) ALWAYS forces
   * "stale" (grey) — it keys off procAlive/fresh directly, never the
   * TTL-authoritative `alive` flag — so a dead-but-fresh row can never show
   * "active" (the SC-4 phantom guard at the compute layer).
   */
  dotState: "active" | "idle" | "stale";
};

/**
 * Reduce one session's files.jsonl into its currently-active files (D-02, D-04).
 *
 * Keeps, per file_path, the newest touch whose ts is within the window; a
 * file marked `released` is dropped entirely (D-04 forward-compat). Bad JSON
 * lines are skipped defensively — a half-written trailing line self-heals on
 * the next read tick.
 */
function activeFiles(dir: string, now: number): { files: ActiveFile[]; lastActive?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, "files.jsonl"), "utf8");
  } catch {
    return { files: [] };
  }

  const threshold = now - windowMs();
  const released = new Set<string>();
  const newest = new Map<string, number>(); // file_path -> newest ts (ms)

  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let evt: TouchEvent;
    try {
      evt = JSON.parse(line) as TouchEvent;
    } catch {
      continue; // skip a torn/partial line
    }
    if (typeof evt?.file_path !== "string" || typeof evt?.ts !== "string") continue;

    if (evt.released) {
      released.add(evt.file_path);
      continue;
    }

    const tsMs = Date.parse(evt.ts);
    if (Number.isNaN(tsMs) || tsMs < threshold) continue; // outside the active window

    const prev = newest.get(evt.file_path);
    if (prev === undefined || tsMs > prev) newest.set(evt.file_path, tsMs);
  }

  const files: ActiveFile[] = [];
  let lastActiveMs = -Infinity;
  for (const [file_path, tsMs] of newest) {
    if (released.has(file_path)) continue; // D-04: a released file is not active
    files.push({ file_path, ts: new Date(tsMs).toISOString() });
    if (tsMs > lastActiveMs) lastActiveMs = tsMs;
  }

  return {
    files,
    lastActive: lastActiveMs === -Infinity ? undefined : new Date(lastActiveMs).toISOString(),
  };
}

/**
 * Reduce one session's reads.jsonl into its currently-active reads (D-04/D-06).
 *
 * Mirrors {@link activeFiles} exactly — windowed reduce, torn/partial-line skip
 * (T-03.1-03 self-heal), `released` drop, newest-per-file_path — but keys on the
 * SHORT `readWindowMs()` window and returns ONLY `ActiveFile[]`: there is no
 * `lastActive`, because reads must never drive the sort key or liveness (D-02).
 * Returns `[]` when reads.jsonl does not exist yet.
 */
function activeReads(dir: string, now: number): ActiveFile[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, "reads.jsonl"), "utf8");
  } catch {
    return [];
  }

  const threshold = now - readWindowMs();
  const released = new Set<string>();
  const newest = new Map<string, number>(); // file_path -> newest ts (ms)

  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let evt: TouchEvent;
    try {
      evt = JSON.parse(line) as TouchEvent;
    } catch {
      continue; // skip a torn/partial line
    }
    if (typeof evt?.file_path !== "string" || typeof evt?.ts !== "string") continue;

    if (evt.released) {
      released.add(evt.file_path);
      continue;
    }

    const tsMs = Date.parse(evt.ts);
    if (Number.isNaN(tsMs) || tsMs < threshold) continue; // outside the read window

    const prev = newest.get(evt.file_path);
    if (prev === undefined || tsMs > prev) newest.set(evt.file_path, tsMs);
  }

  const reads: ActiveFile[] = [];
  for (const [file_path, tsMs] of newest) {
    if (released.has(file_path)) continue; // D-04: a released read is not active
    reads.push({ file_path, ts: new Date(tsMs).toISOString() });
  }
  return reads;
}

/**
 * The sole cross-session view (STATE-02): aggregate every session shard into
 * one array, apply the D-02 active window, and sort most-recently-active
 * first (D-09).
 *
 * A torn/missing session.json is skipped (try/catch), never thrown — the panel
 * self-heals on the next tick. Returns an empty array when the store dir does
 * not exist yet.
 */
export function readAll(
  now: number = Date.now(),
  probe: Probe = defaultProbe,
  startedProbe: StartedProbe = defaultStartedProbe,
): SessionRow[] {
  const root = sessionsDir();

  let ids: string[];
  try {
    ids = fs.readdirSync(root);
  } catch {
    return []; // store not created yet
  }

  const rows: SessionRow[] = [];
  for (const id of ids) {
    const dir = path.join(root, id);
    let state: SessionState;
    try {
      state = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8")) as SessionState;
    } catch {
      continue; // torn/missing snapshot self-heals next tick
    }

    const { files, lastActive } = activeFiles(dir, now);

    // Read-side aggregate (D-06), independent of the write window. D-07: a path
    // in this session's active write set is a WRITE, never also a read — filter
    // it out. Reads feed only the card, never liveness/sort/conflicts (D-02/D-03).
    const rawReads = activeReads(dir, now);
    const writeSet = new Set(files.map((f) => f.file_path));
    const reads = rawReads.filter((r) => !writeSet.has(r.file_path));

    // --- Liveness reduction (D-01/D-06/D-12), pure — NO disk mutation here.
    // last_seen priority: heartbeat sidecar -> newest active touch -> start_time.
    const heartbeatMs = resolveLastSeen(dir);
    const lastSeenMs = heartbeatMs ?? Date.parse(lastActive ?? state.start_time);
    const fresh = now - lastSeenMs < staleMs(); // TTL authoritative (D-07)
    // PID-reuse guard (CR-01/WR-03): consult the captured `pid_started` identity
    // token. When the pid probes alive but its re-derived start-time differs from
    // what SessionStart recorded, the numeric pid has been recycled by another
    // process -> the verdict is "dead", so a zombie can neither render active nor
    // dodge prune. The started-probe is injected (defaults to `ps -o lstart=`) so
    // this stays testable without spawning real long-lived processes.
    const verdict = isProcessAlive(state.pid, probe, state.pid_started, startedProbe);
    const procAlive = verdict === "alive";
    // "dead" is authoritative negative evidence: a KNOWN pid that probes gone
    // (ESRCH) or is a proven reuse (pid_started mismatch). "unknown" is NOT — it
    // means SessionStart could not capture a trustworthy pid (WR-01 sentinel),
    // so the reader must defer to the TTL/heartbeat for the dot rather than
    // asserting "stale" and mislabelling a genuinely-live session.
    const procDead = verdict === "dead";
    const alive = fresh || procAlive; // shown while EITHER says alive (SC-4)
    const readyToPrune = !fresh && !procAlive; // D-06: dead/unknown AND stale (SC-3)

    // dotState (D-12): an authoritative-dead pid (or stale heartbeat) forces
    // "stale" even when last_active is recent and the heartbeat is fresh — the
    // SC-4 phantom-dot guard. An "unknown" pid does NOT force stale: with no
    // trustworthy pid the TTL/heartbeat is the liveness authority for the dot
    // (WR-01). Key off procDead/fresh directly, NOT the TTL `alive` flag.
    let dotState: "active" | "idle" | "stale";
    if (!fresh || procDead) {
      dotState = "stale";
    } else {
      const touchMs = lastActive ? Date.parse(lastActive) : NaN;
      const recentTouch = !Number.isNaN(touchMs) && now - touchMs < activeMs();
      dotState = recentTouch ? "active" : "idle";
    }

    rows.push({
      ...state,
      files,
      reads,
      last_active: lastActive,
      last_seen: heartbeatMs !== undefined ? new Date(heartbeatMs).toISOString() : state.last_seen,
      alive,
      readyToPrune,
      dotState,
    });
  }

  // D-09: most-recently-active first. Fall back to start_time when a session
  // has no active touches yet.
  const key = (r: SessionRow): number => Date.parse(r.last_active ?? r.start_time) || 0;
  rows.sort((a, b) => key(b) - key(a));

  return rows;
}
