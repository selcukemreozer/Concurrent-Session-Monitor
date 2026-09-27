import * as fs from "node:fs";
import * as path from "node:path";
import { sessionsDir } from "./paths.js";
import { numEnv } from "./env.js";
import type {
  SessionState,
  TouchEvent,
  SkillEvent,
  AttentionState,
  AskingState,
  TurnState,
} from "./schema.js";
import {
  isProcessAlive,
  resolveLastSeen,
  resolveSidecarMs,
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

/**
 * The skill-activity decay window (SKILL-03/D-02), config-adjustable via
 * CSM_SKILL_WINDOW_MS (default 300000ms / 5 min, matching the write window).
 * A NEW numeric axis, DISTINCT from `windowMs()` and `readWindowMs()`: a skill
 * older than this leaves `SessionRow.skill` undefined. Read lazily (not
 * module-const) so tests can flip the env per-case.
 */
function skillWindowMs(): number {
  return numEnv("CSM_SKILL_WINDOW_MS", 5 * 60 * 1000);
}

/**
 * The attention "needs-you" safety-net ceiling (ATTN-02/03, 260926-r7n),
 * config-adjustable via CSM_ATTN_WINDOW_MS (default 1_800_000ms / 30 min). A
 * NEW numeric axis, DISTINCT from `windowMs()`/`readWindowMs()`/`skillWindowMs()`.
 *
 * This is a SAFETY NET, not the primary clear. The primary clears are the
 * resume sidecars (260927-1zw): ◉ waiting drops once the main-thread `resumed`
 * sidecar (on-activity for main-thread PostToolUse / Stop, on-user-prompt) is
 * at least as new as the attention ts; ◉ asking drops once the answer-specific
 * `ask-resolved` sidecar (main-thread AskUserQuestion completion, main-thread
 * Stop, on-user-prompt) is at least as new as the asking ts. Subagent activity
 * and sibling tools never clear a marker. When a sidecar is absent (hooks that
 * predate it) the heartbeat-derived last activity is the fallback clear.
 * Approving/denying a permission, rejecting a question and Esc fire no hook, so
 * after those the marker stays until the next prompt or this ceiling. The
 * ceiling was raised from the former 90-second TTL; an attention snapshot older
 * than this expires the flag if no resume signal ever follows. It also bounds
 * the needs-you liveness keepalive (WR-01), because the keepalive only holds
 * while a marker gate holds.
 *
 * Routed through `numEnv` so a NaN/negative override degrades to the 30-minute
 * default. Read lazily (not module-const) so tests can flip the env per-case.
 */
function attnWindowMs(): number {
  return numEnv("CSM_ATTN_WINDOW_MS", 1_800_000);
}

/**
 * The running-state safety net (260927-46l D-02), config-adjustable via
 * CSM_RUN_WINDOW_MS (default 1_800_000ms / 30 min). A turn marker older than
 * this, measured from the NEWER of the turn ts and the heartbeat, stops
 * counting as running. It bounds the Esc case (a user interrupt fires no Stop
 * hook, so turn.json keeps saying "running") and the running keepalive.
 * Routed through `numEnv` so a NaN/negative override degrades to the 30-min
 * default. Read lazily (not module-const) so tests can flip the env per-case.
 */
function runWindowMs(): number {
  return numEnv("CSM_RUN_WINDOW_MS", 1_800_000);
}

/**
 * The idle-waiting threshold (260927-4tv D-02), config-adjustable via
 * CSM_IDLE_WAIT_MS (default 10_000ms / 10 s). Once a main-thread Stop has left
 * `turn.json` "idle" for at least this long, the session is treated as waiting
 * on the human (◉ waiting), without waiting for Claude Code's ~60 s idle_prompt
 * Notification. Bounded above by `attnWindowMs()`: an idle turn older than the
 * ceiling no longer idle-waits. Routed through `numEnv` so a NaN/negative
 * override degrades to the 10 s default (0 is accepted). Read lazily (not
 * module-const) so tests can flip the env per-case.
 */
function idleWaitMs(): number {
  return numEnv("CSM_IDLE_WAIT_MS", 10_000);
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
  /**
   * The session's declared intent (INT-01), surfaced from the `intent.txt`
   * shard written by `/csm-intent`. Undefined when no intent was set or the
   * shard is absent/torn (D-11 self-heal) — a purely additive, card-only field
   * that NEVER drives sort, liveness, or conflict detection.
   */
  intent?: string;
  /** ISO-8601 timestamp the intent was last set, when present (INT-01). */
  intent_ts?: string;
  /**
   * The session's declared TARGET branch (TB-02), surfaced from the
   * `target-branch.txt` shard written by `/csm-branch`. Undefined when none was
   * declared or the shard is absent/torn (D-11 self-heal) — a purely additive,
   * card-only field that NEVER drives sort, liveness, or conflict detection
   * (D-BR-03/D-BR-05). Distinct from `branch` (the CURRENT checkout); the panel
   * flags a mismatch between the two.
   */
  target_branch?: string;
  /** ISO-8601 ts the target branch was last declared, when present (TB-02). */
  target_branch_ts?: string;
  /**
   * Most-recently model-invoked skill within CSM_SKILL_WINDOW_MS (SKILL-03),
   * surfaced from the `skill.jsonl` shard. Undefined when no in-window skill or
   * the shard is absent/torn (T-04.3-03 self-heal) — a purely additive,
   * card-only field that NEVER drives sort, liveness, or conflict detection.
   */
  skill?: string;
  /** ISO-8601 ts of that skill invocation, when present (SKILL-03). */
  skill_ts?: string;
  /**
   * Owning subagent's friendly agent_type when the skill was subagent-sourced
   * (SKILL-02); undefined for a main-loop invocation. Card-only passthrough.
   */
  skill_subagent?: string;
  /**
   * Whether this session currently needs the human's attention (ATTN-02/03),
   * PRE-GATED reader-side: true only while the `attention.json` snapshot ts is
   * BOTH within `attnWindowMs()` AND strictly NEWER than the main-thread
   * `resumed` sidecar (260927-1zw CR-01), falling back to the session's last
   * activity (`lastSeenMs`: heartbeat / newest touch / start_time) when that
   * sidecar is absent. The gate IS the race-free clear — a main-thread resume
   * or an expired window flips this false on the next read tick, with no second
   * writer. Subagent activity never clears it. Presentation-only for sort and
   * conflicts; an active marker (this or `asking`) IS liveness evidence
   * (260927-1zw WR-01 / D-03): it keeps a non-dead session fresh, so it is
   * neither stale nor readyToPrune while the marker holds. It is forced false
   * whenever `asking` is true (D-03 asking-wins precedence, 260926-vfm), so a
   * row is counted once.
   *
   * It is ALSO true for idle-waiting (260927-4tv D-02/D-03): `turn.json` has
   * said "idle" (a main-thread Stop) for at least CSM_IDLE_WAIT_MS and less
   * than `attnWindowMs()`, and the pid verdict is not "dead". Idle-waiting is
   * liveness evidence exactly like the Notification gate (D-05); the next
   * prompt (turn.json "running") clears it.
   */
  attention: boolean;
  /**
   * The narrowed attention kind ("permission_prompt" | "idle_prompt" |
   * "waiting"), passed through from the shard only when `attention` is true;
   * undefined otherwise. Card-only passthrough — drives nothing else. When
   * waiting comes from idle-waiting alone (260927-4tv D-03), "idle_prompt" is
   * synthesized and `attention_ts` is the turn.json ts; when the Notification
   * gate also holds, the Notification's own type/ts win.
   */
  attention_type?: string;
  /** ISO-8601 ts of that attention snapshot, present only when `attention` is true. */
  attention_ts?: string;
  /**
   * Whether Claude asked this session's user a question via AskUserQuestion and
   * it is still open (260926-vfm, AQ-02). PRE-GATED reader-side on the
   * `asking.json` shard: within `attnWindowMs()` AND strictly NEWER than the
   * answer-specific `ask-resolved` sidecar (260927-1zw WR-02), falling back to
   * `lastSeenMs` when that sidecar is absent. Sibling tool completions and
   * subagent activity never clear it. Asking takes precedence over attention.
   * It drives no sort or conflict detection; like `attention`, an open question
   * counts as liveness evidence (WR-01 keepalive) for a non-dead session.
   */
  asking: boolean;
  /** ISO-8601 ts the open question was asked, present only when `asking` is true. */
  asking_ts?: string;
  /**
   * Whether this session is working a turn right now (260927-46l D-02).
   * PRE-GATED display flag: true only while `turn.json` says "running", its ts
   * parses, the pid verdict is not "dead", and now minus max(turn ts,
   * heartbeat) is under `runWindowMs()`. Forced false when `asking` or
   * `attention` holds (D-04 precedence asking > waiting > running, one status
   * line). The raw gate (before precedence) is liveness evidence: it keeps the
   * row fresh (not stale, not readyToPrune) and, when displayed, the dot
   * active. It drives no sort or conflict logic. Additive;
   * SESSION_SCHEMA_VERSION unchanged.
   */
  running: boolean;
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
 * Read one session's declared intent from its `intent.txt` shard (INT-01).
 *
 * Mirrors {@link activeFiles}' try/catch self-heal: an absent or torn/partial
 * intent.txt is the NORMAL case (D-11 handles display), so any read/parse throw
 * returns `{}` and the session is never dropped from the roster. Returns
 * `{ intent, intent_ts }` only when the parsed `intent` is a non-empty string;
 * an empty-string intent is treated as absent. `intent_ts` comes from a string
 * `ts`, else undefined. This is a card-only read — it feeds neither sort,
 * liveness, nor conflict detection (D-02/D-03).
 */
function readIntent(dir: string): { intent?: string; intent_ts?: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "intent.txt"), "utf8"));
    if (typeof parsed?.intent === "string" && parsed.intent.length > 0) {
      return {
        intent: parsed.intent,
        intent_ts: typeof parsed.ts === "string" ? parsed.ts : undefined,
      };
    }
    return {};
  } catch {
    return {}; // absent/torn intent.txt self-heals (D-11)
  }
}

/**
 * Read one session's declared TARGET branch from its `target-branch.txt` shard
 * (TB-02). Mirrors {@link readIntent} EXACTLY: an absent or torn/partial shard is
 * the NORMAL case (D-11 self-heal), so any read/parse throw returns `{}` and the
 * session is never dropped from the roster. Returns `{ target_branch,
 * target_branch_ts }` only when the parsed `target_branch` is a non-empty string;
 * an empty-string target_branch is treated as absent. `target_branch_ts` comes
 * from a string `ts`, else undefined. Card-only — it feeds neither sort,
 * liveness, nor conflict detection (D-02/D-03/D-BR-05).
 */
function readTargetBranch(dir: string): { target_branch?: string; target_branch_ts?: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "target-branch.txt"), "utf8"));
    if (typeof parsed?.target_branch === "string" && parsed.target_branch.length > 0) {
      return {
        target_branch: parsed.target_branch,
        target_branch_ts: typeof parsed.ts === "string" ? parsed.ts : undefined,
      };
    }
    return {};
  } catch {
    return {}; // absent/torn target-branch.txt self-heals (D-11)
  }
}

/**
 * Reduce one session's `skill.jsonl` shard into the NEWEST in-window skill
 * (SKILL-03/D-02). Mirrors {@link activeReads}' torn-line-safe reduce — try/catch
 * read returning `{}` on throw (absent shard self-heals, T-04.3-03), per-line
 * `JSON.parse` skip (torn trailing line self-heals), `Date.parse` + `< threshold`
 * window drop — but reduces to a SINGLE newest-wins event on the
 * `skillWindowMs()` axis rather than a per-file_path map. Returns
 * `{ skill, skill_ts, skill_subagent }` for the newest event within the window,
 * where `skill_subagent` is the event's `subagent` only when a non-empty string
 * (SKILL-02 passthrough), else undefined; `{}` when no in-window event. A
 * card-only read — it feeds neither sort, liveness, nor conflict detection
 * (D-02/D-03), exactly like reads/intent.
 */
function readSkill(
  dir: string,
  now: number,
): { skill?: string; skill_ts?: string; skill_subagent?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, "skill.jsonl"), "utf8");
  } catch {
    return {}; // absent shard self-heals (T-04.3-03)
  }

  const threshold = now - skillWindowMs();
  let bestMs = -Infinity;
  let best: SkillEvent | undefined;

  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let e: SkillEvent;
    try {
      e = JSON.parse(line) as SkillEvent;
    } catch {
      continue; // skip a torn/partial line
    }
    if (typeof e?.skill !== "string" || typeof e?.ts !== "string") continue;

    const ms = Date.parse(e.ts);
    if (Number.isNaN(ms) || ms < threshold) continue; // outside the skill window

    if (ms > bestMs) {
      bestMs = ms;
      best = e; // newest-wins
    }
  }

  if (!best) return {};
  return {
    skill: best.skill,
    skill_ts: best.ts,
    skill_subagent:
      typeof best.subagent === "string" && best.subagent ? best.subagent : undefined,
  };
}

/**
 * Read one session's "needs-attention" snapshot from its `attention.json` shard
 * (ATTN-02/03). Mirrors {@link readIntent}'s try/catch self-heal but SIMPLER — a
 * single JSON snapshot, not a windowed jsonl reduce: an absent or torn/partial
 * attention.json is the NORMAL case (D-11 self-heal), so any read/parse throw
 * returns `{}` and the session is never dropped from the roster (T-06-07).
 * Returns `{ attention_type, attention_ts }` only when the parsed object has a
 * non-empty string `type` AND a string `ts`; else `{}`. This is a pass-through
 * of the shard fields ONLY (T-06-02: the `type` was already narrowed at write
 * time in 06-02) — the window/newer-than-activity GATE lives in readAll, not
 * here. A card-only read — it feeds neither sort, liveness, nor conflict
 * detection (D-02/D-03).
 */
function readAttention(dir: string): { attention_type?: string; attention_ts?: string } {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, "attention.json"), "utf8"),
    ) as Partial<AttentionState>;
    if (typeof parsed?.type === "string" && parsed.type.length > 0 && typeof parsed.ts === "string") {
      return { attention_type: parsed.type, attention_ts: parsed.ts };
    }
    return {};
  } catch {
    return {}; // absent/torn attention.json self-heals (D-11/T-06-07)
  }
}

/**
 * Read one session's "open question" snapshot from its `asking.json` shard
 * (260926-vfm, AQ-02), written by scripts/on-ask.mjs on PreToolUse
 * AskUserQuestion. Mirrors {@link readAttention}'s try/catch self-heal: an
 * absent or torn asking.json returns `{}` and the session is never dropped
 * (T-vfm-07). Returns `{ asking_ts }` only when the parsed object has a
 * non-empty string `ts`; it reads ONLY `ts` and ignores any other key
 * (T-vfm-03). The window/newer-than-activity GATE lives in readAll.
 */
function readAsking(dir: string): { asking_ts?: string } {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, "asking.json"), "utf8"),
    ) as Partial<AskingState>;
    if (typeof parsed?.ts === "string" && parsed.ts.length > 0) {
      return { asking_ts: parsed.ts };
    }
    return {};
  } catch {
    return {}; // absent/torn asking.json self-heals (T-vfm-07)
  }
}

/**
 * Read one session's turn-state snapshot from its `turn.json` shard
 * (260927-46l D-01), written by on-user-prompt ("running") and by on-activity
 * on a main-thread Stop ("idle"). Mirrors {@link readAsking}'s try/catch
 * self-heal: absent or torn turn.json returns `{}`. Returns
 * `{ turn_state, turn_ts }` only when `state` is exactly "running" or "idle"
 * AND `ts` is a non-empty string; nothing else passes through. The window /
 * pid GATE lives in readAll. "running" feeds the running gate; "idle" feeds
 * the idle-waiting gate (260927-4tv).
 */
function readTurn(dir: string): { turn_state?: TurnState["state"]; turn_ts?: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "turn.json"), "utf8")) as Partial<TurnState>;
    const state = parsed?.state;
    if ((state === "running" || state === "idle") && typeof parsed.ts === "string" && parsed.ts.length > 0) {
      return { turn_state: state, turn_ts: parsed.ts };
    }
    return {};
  } catch {
    return {}; // absent/torn turn.json self-heals (T-46l-04)
  }
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

    // --- Resume signals (260927-1zw CR-01 / WR-02). The heartbeat counts every
    // agent's activity (liveness), so it cannot be the clear signal: a subagent
    // or sibling tool finishing would hide a marker the human still has to act
    // on. `resumed` is written only by main-thread events (clears waiting) and
    // `ask-resolved` only by answer-specific events (clears asking).
    // DISC-1 fallback: a session whose hooks predate these sidecars (or that
    // has not seen its first prompt yet) has none, so fall back to the legacy
    // heartbeat-derived lastSeenMs. Such sessions then behave exactly as before,
    // instead of resurfacing already-answered markers for up to 30 minutes.
    const resumedMs = resolveSidecarMs(dir, "resumed") ?? lastSeenMs;
    const askResolvedMs = resolveSidecarMs(dir, "ask-resolved") ?? lastSeenMs;

    // --- Attention gate (ATTN-02/03), pure reader-side — the race-free clear.
    // attention shows ONLY while the snapshot ts is strictly newer than the
    // main-thread resume signal AND within attnWindowMs(). A main-thread tool
    // completion (e.g. the approved tool), a main-thread Stop or a new prompt
    // flips it false next tick. The 30-minute window is only the backstop for a
    // session where no resume signal ever follows (Esc / deny fire no hook).
    const attn = readAttention(dir);
    const attnMs = attn.attention_ts !== undefined ? Date.parse(attn.attention_ts) : NaN;
    const rawWaiting =
      !Number.isNaN(attnMs) && now - attnMs < attnWindowMs() && attnMs > resumedMs;

    // --- Asking gate (260926-vfm AQ-02, 260927-1zw WR-02): the same window on
    // the asking.json shard, compared against the answer-specific
    // `ask-resolved` sidecar. Asking WINS over attention: permission_prompt /
    // idle_prompt Notifications fire while a question is open, and the question
    // is the more specific signal. Answering fires the main-thread
    // PostToolUse(AskUserQuestion) → on-activity writes ask-resolved →
    // askMs <= askResolvedMs clears it on the next tick. Sibling tools cannot.
    const ask = readAsking(dir);
    const askMs = ask.asking_ts !== undefined ? Date.parse(ask.asking_ts) : NaN;
    const asking =
      !Number.isNaN(askMs) && now - askMs < attnWindowMs() && askMs > askResolvedMs;
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

    // --- Running gate (260927-46l D-02). turn.json "running" (on-user-prompt)
    // until a main-thread Stop writes "idle". The window reference is the newer
    // of the turn ts and the heartbeat sidecar (DISC-5; NOT the start_time
    // fallback), so a long turn with ongoing tool activity keeps running while
    // an interrupted one (Esc fires no Stop) expires after runWindowMs(). A
    // dead known pid never runs. `running` is the pre-gated display flag
    // (asking > waiting > running, DISC-3); `rawRunning` feeds liveness.
    const turn = readTurn(dir);
    const turnMs = turn.turn_ts !== undefined ? Date.parse(turn.turn_ts) : NaN;
    // --- Idle-waiting gate (260927-4tv D-02). A main-thread Stop wrote
    // turn.json "idle": once that has held for at least idleWaitMs() (and still
    // under the attnWindowMs() ceiling, pid not known-dead), the session is
    // waiting on the human — well before Claude Code's ~60 s idle_prompt
    // Notification. The clear is the next prompt flipping turn.json to
    // "running". There is deliberately NO `resumed`-sidecar comparison: the
    // same main-thread Stop writes `resumed` and turn.json idle in the same
    // instant, so such a check would depend on write order.
    const rawIdleWaiting =
      turn.turn_state === "idle" &&
      !Number.isNaN(turnMs) &&
      !procDead &&
      now - turnMs >= idleWaitMs() &&
      now - turnMs < attnWindowMs();
    // D-03 / D-04: waiting = (Notification gate OR idle-waiting), asking wins.
    const attention = (rawWaiting || rawIdleWaiting) && !asking;
    const runRefMs = Math.max(turnMs, heartbeatMs ?? -Infinity);
    const rawRunning =
      turn.turn_state === "running" &&
      !Number.isNaN(turnMs) &&
      !procDead &&
      now - runRefMs < runWindowMs();
    const running = rawRunning && !asking && !attention;

    const heartbeatFresh = now - lastSeenMs < staleMs(); // TTL authoritative (D-07)
    // Needs-you keepalive (260927-1zw WR-01 / D-03): a session blocked on the
    // human emits no heartbeat, so an active marker is liveness evidence. It
    // keeps the row fresh (not stale, not readyToPrune, never pruned by App)
    // while the marker gate holds, which bounds it by attnWindowMs(). DISC-4: an
    // authoritatively dead pid gets no keepalive, so a crashed session is still
    // reaped normally. A running turn (260927-46l D-03) is liveness evidence
    // too: a session deep in a long Bash / web fetch / thinking emits no
    // heartbeat, so rawRunning (already excluding a dead pid, bounded by
    // runWindowMs()) keeps it fresh as well. Idle-waiting (260927-4tv D-05) is
    // a needs-you marker like the Notification gate, bounded by attnWindowMs().
    const needsYouKeepalive = (asking || rawWaiting || rawIdleWaiting) && !procDead;
    const fresh = heartbeatFresh || needsYouKeepalive || rawRunning;
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
    } else if (running) {
      // 260927-46l D-03 / DISC-4: a displayed running turn is the active state.
      // Needs-you rows keep their idle/recent-touch dot (no green dot beside ◉).
      dotState = "active";
    } else {
      const touchMs = lastActive ? Date.parse(lastActive) : NaN;
      const recentTouch = !Number.isNaN(touchMs) && now - touchMs < activeMs();
      dotState = recentTouch ? "active" : "idle";
    }

    rows.push({
      ...state,
      files,
      reads,
      ...readIntent(dir), // INT-01 additive read-side field (D-01 separate shard)
      ...readTargetBranch(dir), // TB-02 additive card-only field (D-01/D-BR-01 separate shard)
      ...readSkill(dir, now), // SKILL-03 additive card-only field (D-01 separate shard)
      last_active: lastActive,
      last_seen: heartbeatMs !== undefined ? new Date(heartbeatMs).toISOString() : state.last_seen,
      alive,
      readyToPrune,
      dotState,
      // ATTN-02/03 additive card-only fields — pre-gated; type/ts only survive
      // when the gate held, so the panel needs no re-check. 260927-4tv D-03:
      // the Notification's type/ts win; idle-waiting alone synthesizes
      // "idle_prompt" + the turn ts.
      attention,
      attention_type: attention ? (rawWaiting ? attn.attention_type : "idle_prompt") : undefined,
      attention_ts: attention ? (rawWaiting ? attn.attention_ts : turn.turn_ts) : undefined,
      // 260926-vfm (AQ-02) additive card-only fields — pre-gated, asking wins.
      asking,
      asking_ts: asking ? ask.asking_ts : undefined,
      // 260927-46l additive card-only flag — pre-gated (asking > waiting > running).
      running,
    });
  }

  // D-09: most-recently-active first. Fall back to start_time when a session
  // has no active touches yet.
  const key = (r: SessionRow): number => Date.parse(r.last_active ?? r.start_time) || 0;
  rows.sort((a, b) => key(b) - key(a));

  return rows;
}
