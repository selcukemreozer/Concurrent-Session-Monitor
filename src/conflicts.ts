import * as path from "node:path";
import type { SessionRow } from "./aggregate.js";

/**
 * Cross-session conflict detection — the "detect" half of the phase's
 * detect->surface slice (CONF-01).
 *
 * A PURE reducer over the `SessionRow[]` that {@link readAll} already returns.
 * The GREEN task (Plan 03-01 Task 2) will make it satisfy:
 *   - D-01: emit one grouped entry per realpath shared by >=2 DISTINCT live sessions.
 *   - D-04: resolve every `file_path` to its canonical realpath (symlinks/worktrees),
 *           never by filename — with a never-throw lexical fallback for missing files.
 *   - D-09: order each entry's `sessions` most-recently-touched first.
 *   - D-11: order the returned array most-recently-active file first.
 *   - D-12: filter to live rows (`alive && !readyToPrune`) BEFORE pairing, so a
 *           dead/stale session never enters a conflict (SC-3).
 *   - D-13: no stored conflict state — every tick re-derives, so a conflict clears
 *           purely by a file dropping out of a session's window (SC-4).
 *
 * Reuses Phase-1/2 windowing + liveness verbatim: it consumes `readAll`'s already
 * windowed `files[]`, `alive`, `readyToPrune`, and `cwd` — adding NO new aggregation,
 * liveness, or window pass, and NO write path (D-03/D-05). The only disk access is a
 * read-side `fs.realpathSync` stat.
 */

/** One live session involved in a conflict on a given realpath. */
export interface ConflictSession {
  session_id: string;
  folder: string;
  branch: string;
  /** ms of this session's newest touch on the file (D-09 ordering / display). */
  lastTouch: number;
}

/** A group-by-file conflict: one realpath claimed by >=2 distinct live sessions. */
export interface Conflict {
  /** Canonical resolved path — the group key (never a basename). */
  realpath: string;
  /** ALL involved live sessions (>=2), most-recently-touched first (D-09). */
  sessions: ConflictSession[];
  /** Max touch ts across involved sessions — array ordering key (D-11). */
  lastActive: number;
}

/**
 * SCAFFOLD STUB (RED). Returns the lexical anchor only — the never-throw
 * `fs.realpathSync` fold lands in the GREEN task. Absolute inputs pass through;
 * relative inputs anchor on `cwd ?? process.cwd()`.
 */
export function resolveRealpath(
  file_path: string,
  cwd: string | undefined,
  _cache?: Map<string, string>,
): string {
  return path.isAbsolute(file_path)
    ? file_path
    : path.resolve(cwd ?? process.cwd(), file_path);
}

/**
 * SCAFFOLD STUB (RED). Returns an empty array so the suite compiles and runs;
 * the real grouping reducer lands in the GREEN task (Task 2).
 */
export function detectConflicts(_rows: SessionRow[], _now: number = Date.now()): Conflict[] {
  return [];
}
