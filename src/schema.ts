/**
 * The cross-process on-disk contract.
 *
 * Every hook (writer) and the panel (reader) must agree on these shapes.
 * The store layout is `sessions/<safeId>/{session.json, files.jsonl}`:
 *   - session.json is a single SessionState snapshot (atomic temp+rename).
 *   - files.jsonl is an append-only log of one TouchEvent per line.
 */

/** Bump when the on-disk shape changes incompatibly. */
export const SESSION_SCHEMA_VERSION = 1 as const;

/**
 * A per-session identity snapshot written to `session.json`.
 *
 * The first six fields are the load-bearing minimum the panel renders; the
 * remaining fields are optional D-05 identity enrichment a writer may add.
 */
export interface SessionState {
  /** Schema version of this record (see SESSION_SCHEMA_VERSION). */
  schema_version: number;
  /** The Claude Code session_id (already passed through safeId at dir level). */
  session_id: string;
  /** Human-friendly folder/project label for the session. */
  folder: string;
  /** Current git branch, or a best-effort placeholder. */
  branch: string;
  /**
   * Model id/name as a plain string; the sentinel is the literal string
   * "unknown" when the hook can't determine it (WR-02, D-09). The reader never
   * handles a null here — an absent model is always the "unknown" string.
   */
  model: string;
  /** Session start time as an ISO-8601 string. */
  start_time: string;
  /** Absolute working directory (optional, D-05). */
  cwd?: string;
  /** Where the session was launched from, e.g. "startup" (optional, D-05). */
  source?: string;
  /** OS process id of the session (optional, D-05). */
  pid?: number;
  /**
   * ISO-8601 timestamp of the last heartbeat (optional, LIFE-01). The reader
   * (`resolveLastSeen`) prefers the on-disk `heartbeat` sidecar and falls back
   * to newest touch / `start_time` when this and the sidecar are absent.
   */
  last_seen?: string;
  /**
   * The `ps -o lstart=` start-time identity token captured at SessionStart,
   * guarding against PID reuse (optional, LIFE-01/D-01). A soft guard only —
   * the TTL stays authoritative when it is empty or cannot be re-derived.
   */
  pid_started?: string;
  /**
   * Warp go-to-pane enrichment (optional, D-05/D-06). The SessionStart hook
   * (01-03) writes `{ focus_url, session_uuid }` when running inside Warp, or
   * `null` otherwise. The panel renders a clickable OSC-8 link from focus_url.
   */
  warp?: { focus_url?: string; session_uuid?: string } | null;
  /**
   * The session's declared intent (optional, INT-01). Written to a SEPARATE
   * `intent.txt` shard by the `/csm-intent` command (scripts/csm-intent.mjs) —
   * a distinct writer from the SessionStart/heartbeat hooks, preserving the
   * one-writer-per-file invariant (D-01). Set explicitly only, never derived
   * from prompts (D-02). Sanitized (control-stripped, single-line, capped) at
   * write time. Additive optional field — SESSION_SCHEMA_VERSION is NOT bumped.
   */
  intent?: string;
  /** ISO-8601 timestamp the intent was last set (optional, INT-01). */
  intent_ts?: string;
}

/**
 * One file-touch event appended to `files.jsonl`.
 *
 * `released` is a D-04 forward-compat field ONLY: the Phase 4 /csm-done
 * command will set it to mark a file no longer actively edited. This schema
 * declares the field; it does NOT implement any release command here.
 */
export interface TouchEvent {
  /** The touched file path, stored verbatim as delivered (no realpath). */
  file_path: string;
  /** Touch timestamp as an ISO-8601 string. */
  ts: string;
  /** The tool that produced the touch, e.g. "Edit"|"Write" (optional). */
  tool?: string;
  /** D-04 forward-compat: true marks the file explicitly released. */
  released?: boolean;
}
