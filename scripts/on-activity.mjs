#!/usr/bin/env node
// Activity hook (260926-r7n AP-01, reworked 260927-1zw CR-01/WR-02) — wired to
// PostToolUse("*") and Stop. It writes up to four separate per-session
// sidecars, because liveness and the two needs-you clear signals are different
// facts and must not be conflated:
//
// 1. `heartbeat` (every event, including subagent / parallel-agent activity):
//    the liveness signal. Any agent finishing a tool proves the session is
//    alive, so this counts every agent.
// 2. `resumed` (main-thread events only, CR-01): "the main session moved on".
//    The reader clears the ◉ waiting marker when attnMs is no longer newer
//    than this. A payload with a truthy agent_id comes from a subagent and never
//    writes it, so parallel agents finishing tools can no longer hide a
//    permission prompt the human still has to answer. Completions of the
//    agent-spawning tool ("Task" / "Agent") do not write it either: a sibling
//    agent returning is not a user response. agent_type alone is NOT a subagent
//    signal (it also appears on main-thread payloads of --agent sessions).
// 3. `ask-resolved` (main-thread AskUserQuestion completion or main-thread
//    Stop only, WR-02): "the open question was resolved". The reader clears the
//    ◉ asking marker when askMs is no longer newer than this. Sibling tool
//    completions in the same message never write it, so they cannot clear an
//    open question.
// 4. `turn.json` (main-thread Stop only, 260927-46l): the turn ended; state
//    'idle'. on-user-prompt writes state 'running'. The reader shows ▶ running
//    from these. A Stop-shaped payload with a truthy agent_id and every
//    PostToolUse leave it untouched. Since 260927-73b it also carries `agents`:
//    the count of running/pending background subagents/workflows taken from
//    the main-thread Stop payload's `background_tasks` (the reader shows
//    ↻ subagent instead of ◉ waiting while it is > 0). The key is omitted when
//    the count is zero, and older Claude Code versions omit the field, so
//    turn.json then stays exactly {state, ts}.
//
// Write discipline: the heartbeat keeps its FROZEN plain writeFileSync (the
// liveness contract shared with resolveLastSeen). `resumed`, `ask-resolved`
// and `turn.json` are written via a same-dir temp file + renameSync (WR-05), so a reader never
// sees a torn file and no temp file is left behind.
//
// Stop-safety contract: this hook MUST always exit 0 with EMPTY stdout (and no
// stderr). A Stop hook that exits 2 or prints a blocking decision would stop
// Claude from ending its turn. The whole body is wrapped so every error is
// swallowed, and it is wired "async" (timeout 5) so no tool call waits on it.
//
// Detail-free: it reads the session id plus agent_id, tool_name and
// hook_event_name (used ONLY as guards, never persisted) and persists ONLY
// ISO-8601 timestamps and, in turn.json, the constant state literal "idle".
// PostToolUse("*") and Stop payloads carry Bash commands, file contents and the
// last assistant message — none of that is read or written.
// background_tasks[].type and .status are read ONLY as guards (260927-73b) and
// only the integer count is persisted — never ids, descriptions, agent types,
// commands or prompts.
// D-01 one-writer-per-file: it NEVER writes, renames or deletes attention.json
// or asking.json (on-notification / on-ask own those shards; clearing is
// purely reader-side).
//
// Kept deliberately tiny and self-contained (Node stdlib only), a structural
// mirror of on-user-prompt.mjs.
import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// T-r7n-01: allowlist the untrusted session_id before it becomes a path segment.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

// DISC-3: completions of the subagent-spawning tool are not a user response.
const AGENT_SPAWN_TOOLS = new Set(["Task", "Agent"]);

// 260927-73b D-01: background task types that count as "agents still working"
// (Claude Code's display-mapped names in the Stop payload plus the raw internal
// names). Shells, monitors and every other task type are not counted.
const COUNTED_TASK_TYPES = new Set(["subagent", "workflow", "local_agent", "local_workflow"]);
// 260927-73b D-01: task statuses that mean "still running" (finished, failed or
// killed tasks are not counted).
const ACTIVE_TASK_STATUSES = new Set(["running", "pending"]);

// D-01b store-location seam — identical precedence to src/paths.ts: 1)
// CSM_STORE_DIR override, else 2) ~/.claude/csm. CLAUDE_PLUGIN_DATA is
// deliberately NOT a tier — it is set only for plugin-hook processes, so
// honoring it would split this writer's root from the standalone panel's reader.
function storeRoot() {
  const override = process.env.CSM_STORE_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".claude", "csm");
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// 260927-73b D-01: pure count of still-running background subagents/workflows.
// Returns 0 unless `tasks` is an array; reads ONLY `type` and `status` of each
// plain-object entry and never throws on odd shapes. Always an integer.
function countBackgroundAgents(tasks) {
  if (!Array.isArray(tasks)) return 0;
  let n = 0;
  for (const t of tasks) {
    if (
      t &&
      typeof t === "object" &&
      !Array.isArray(t) &&
      COUNTED_TASK_TYPES.has(t.type) &&
      ACTIVE_TASK_STATUSES.has(t.status)
    ) {
      n += 1;
    }
  }
  return n;
}

// WR-05 atomic write: unique temp in the same dir + renameSync over the target
// (rename(2) atomicity). Never throws: on any error the temp is removed on a
// best-effort basis, so each sidecar write is independent of the others. The
// temp name is built only from constants, the pid, the clock and a random
// suffix — never from payload strings (T-1zw-01).
function writeAtomic(dir, name, content) {
  const tmp = path.join(
    dir,
    `.${name}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    writeFileSync(tmp, content, { mode: FILE_MODE });
    renameSync(tmp, path.join(dir, name));
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // Temp was never created or is already gone.
    }
  }
}

try {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    payload = null;
  }

  const id = payload && payload.session_id;
  // Strict allowlist gate before any path is built (T-r7n-01).
  if (typeof id === "string" && SAFE_ID.test(id) && id !== "." && id !== "..") {
    const dir = path.join(storeRoot(), "sessions", id);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const iso = new Date().toISOString();
    // Heartbeat sidecar contract (FROZEN, shared with liveness resolveLastSeen):
    // file `heartbeat`, content = ISO-8601, plain writeFileSync (a one-line
    // mtime/content file has no torn-read window — no temp+rename needed).
    writeFileSync(path.join(dir, "heartbeat"), iso, { mode: FILE_MODE });

    // DISC-2: only a truthy agent_id marks a subagent payload.
    const isSubagent = Boolean(payload.agent_id);
    if (!isSubagent) {
      const toolName = payload.tool_name;
      // CR-01: main-thread resume signal (clears waiting).
      if (!AGENT_SPAWN_TOOLS.has(toolName)) {
        writeAtomic(dir, "resumed", iso);
      }
      // WR-02: answer-specific signal (clears asking).
      if (payload.hook_event_name === "Stop" || toolName === "AskUserQuestion") {
        writeAtomic(dir, "ask-resolved", iso);
      }
      // 260927-46l D-01: a main-thread Stop ends the turn. Kept inside the
      // main-thread branch so a subagent (truthy agent_id) never flips it.
      // 260927-73b D-01: also record how many background subagents/workflows
      // are still running; the key is omitted when zero (exactly {state, ts}).
      if (payload.hook_event_name === "Stop") {
        const agents = countBackgroundAgents(payload.background_tasks);
        const turn = agents > 0 ? { state: "idle", ts: iso, agents } : { state: "idle", ts: iso };
        writeAtomic(dir, "turn.json", JSON.stringify(turn));
      }
    }
  }
} catch {
  // Swallow every error (T-r7n-02): NEVER exit non-zero, NEVER write stdout.
}

process.exit(0);
