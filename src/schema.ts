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
  /** Model id/name, or "unknown" when the hook can't determine it. */
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
   * Warp go-to-pane enrichment (optional, D-05/D-06). The SessionStart hook
   * (01-03) writes `{ focus_url, session_uuid }` when running inside Warp, or
   * `null` otherwise. The panel renders a clickable OSC-8 link from focus_url.
   */
  warp?: { focus_url?: string; session_uuid?: string } | null;
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
