import * as fs from "node:fs";
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
 * Resolve a possibly-relative, possibly-deleted `file_path` to a canonical
 * realpath string WITHOUT ever throwing (D-04).
 *
 * Steps: build a lexical absolute anchor (absolute inputs pass through; relative
 * inputs anchor on `cwd ?? process.cwd()`), then fold symlinks with
 * `fs.realpathSync` — which collapses git-worktree/symlink aliases and the macOS
 * `/var` -> `/private/var` firmlink so two aliases of one file match (SC-1/SC-2).
 * If the file is gone (`realpathSync` throws ENOENT) we degrade to the lexical
 * absolute so two sessions on the same intended path still match (SC-3/SC-4).
 * Mirrors `prune.ts`'s try/catch-and-recover shape — the catch is the fallback
 * and MUST swallow the error, never rethrow.
 *
 * Memoizes per `${cwd ?? ""} ${file_path}` key when a cache Map is supplied so a
 * per-tick reducer pass is O(distinct paths) (D-05, Pitfall 4).
 */
export function resolveRealpath(
  file_path: string,
  cwd: string | undefined,
  cache?: Map<string, string>,
): string {
  const key = `${cwd ?? ""} ${file_path}`;
  const memo = cache?.get(key);
  if (memo !== undefined) return memo;

  const lexical = path.isAbsolute(file_path)
    ? file_path
    : path.resolve(cwd ?? process.cwd(), file_path);

  let resolved: string;
  try {
    resolved = fs.realpathSync(lexical); // folds symlinks: worktrees, /tmp, /var
  } catch {
    resolved = lexical; // ENOENT (file gone) -> degrade to lexical (never throw)
  }
  cache?.set(key, resolved);
  return resolved;
}

/**
 * Group-by-file cross-session conflict detection (CONF-01, D-01/D-09/D-11/D-12/D-13).
 *
 * Pure reducer over `readAll`'s already-windowed `SessionRow[]`: skips non-live
 * rows BEFORE any pairing (D-12 / SC-3), resolves each active file to its realpath
 * (D-04), indexes realpath -> involved sessions counting each `session_id` once per
 * realpath (de-dupe, Pitfall 2), and emits one entry per realpath shared by >=2
 * DISTINCT live sessions (D-01). Each entry's `sessions` are sorted most-recently-
 * touched first (D-09) and the returned array most-recently-active file first (D-11).
 *
 * No stored state — every call re-derives, so a conflict clears the tick a file
 * drops out of a session's window (D-13 / SC-4). The ONLY disk access is the
 * read-side `fs.realpathSync` stat in {@link resolveRealpath}; no writes, no
 * `readAll` call, no schema change (D-03/D-05).
 *
 * Conflict window: intentionally NOT wired to a `CSM_CONFLICT_MS` knob (D-02,
 * deferred per RESEARCH Open-Q2). Because the reducer consumes `readAll`'s
 * `CSM_WINDOW_MS`-windowed `files[]`, the effective conflict window already equals
 * the active window with zero extra code. A future knob would mirror `aggregate.ts`'s
 * lazy-env `windowMs()` — e.g. `conflictMs() => numEnv("CSM_CONFLICT_MS", windowMs())`
 * — read here instead of relying on the upstream window; this JSDoc is that
 * extension point's marker and keeps the default-equals-window contract explicit.
 */
export function detectConflicts(rows: SessionRow[], now: number = Date.now()): Conflict[] {
  // `now` is part of the public signature (mirrors readAll) and reserved for a
  // future `CSM_CONFLICT_MS` re-window; the current default window is applied
  // upstream by readAll, so no per-file recency compare is needed here.
  void now;
  const cache = new Map<string, string>(); // per-tick memo (D-05)
  const groups = new Map<string, Conflict>();

  for (const r of rows) {
    if (!r.alive || r.readyToPrune) continue; // D-12 / SC-3: live-only, BEFORE pairing
    for (const f of r.files) {
      // already windowed by readAll (D-01)
      const rp = resolveRealpath(f.file_path, r.cwd, cache);
      const touch = Date.parse(f.ts) || 0;
      let g = groups.get(rp);
      if (!g) {
        g = { realpath: rp, sessions: [], lastActive: 0 };
        groups.set(rp, g);
      }
      // de-dupe: a session counts once per realpath even if it touched two
      // aliases (path + symlink) that fold to the same realpath (Pitfall 2).
      const existing = g.sessions.find((s) => s.session_id === r.session_id);
      if (existing) {
        existing.lastTouch = Math.max(existing.lastTouch, touch);
      } else {
        g.sessions.push({
          session_id: r.session_id,
          folder: r.folder,
          branch: r.branch,
          lastTouch: touch,
        });
      }
      g.lastActive = Math.max(g.lastActive, touch);
    }
  }

  const out: Conflict[] = [];
  for (const g of groups.values()) {
    if (g.sessions.length < 2) continue; // D-01: >=2 DISTINCT live sessions
    g.sessions.sort((a, b) => b.lastTouch - a.lastTouch); // D-09 within-entry order
    out.push(g);
  }
  out.sort((a, b) => b.lastActive - a.lastActive); // D-11: most-recently-active file first
  return out;
}
