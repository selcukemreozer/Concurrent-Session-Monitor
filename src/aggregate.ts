import * as fs from "node:fs";
import * as path from "node:path";
import { sessionsDir } from "./paths.js";
import type { SessionState, TouchEvent } from "./schema.js";

/**
 * The rolling active window (D-02), config-adjustable via CSM_WINDOW_MS.
 * A touch is "active" only if it happened within this many ms of `now`.
 * Read lazily (not module-const) so tests can flip the env per-case.
 */
function windowMs(): number {
  return Number(process.env.CSM_WINDOW_MS ?? 5 * 60 * 1000);
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
  /** Newest surviving touch ts (ISO-8601), or undefined if no active files. */
  last_active?: string;
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
 * The sole cross-session view (STATE-02): aggregate every session shard into
 * one array, apply the D-02 active window, and sort most-recently-active
 * first (D-09).
 *
 * A torn/missing session.json is skipped (try/catch), never thrown — the panel
 * self-heals on the next tick. Returns an empty array when the store dir does
 * not exist yet.
 */
export function readAll(now: number = Date.now()): SessionRow[] {
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
    rows.push({ ...state, files, last_active: lastActive });
  }

  // D-09: most-recently-active first. Fall back to start_time when a session
  // has no active touches yet.
  const key = (r: SessionRow): number => Date.parse(r.last_active ?? r.start_time) || 0;
  rows.sort((a, b) => key(b) - key(a));

  return rows;
}
