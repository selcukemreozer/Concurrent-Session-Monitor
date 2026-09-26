#!/usr/bin/env node
// AskUserQuestion asking-capture hook (quick task 260926-vfm, AQ-01) — the
// passive PreToolUse tap for "Claude asked the user a question".
//
// (a) Purpose: the Notification hook CANNOT distinguish AskUserQuestion (it only
// fires permission_prompt / idle_prompt), so the only reliable "a question is
// open" signal is the tool call itself. This PreToolUse hook (matcher
// "AskUserQuestion") records that a question was opened. When the user answers,
// the tool completes, PostToolUse("*") runs on-activity.mjs, the heartbeat is
// refreshed, and the reader's strict askMs > lastSeenMs gate clears the flag.
//
// (b) PreToolUse safety contract: on exit 0 PreToolUse stdout is parsed as a
// hook decision, and exit 2 would BLOCK the AskUserQuestion call. So this hook
// is wired "async" (timeout 5), wraps its whole body so it ALWAYS exits 0, and
// prints NOTHING to stdout or stderr.
//
// (c) DELIBERATELY NO heartbeat write (Pitfall 1, mirrored from
// on-notification.mjs): a heartbeat written here would make last activity newer
// than the asking ts and suppress the indicator instantly.
//
// (d) Separate shard / one-writer-per-file (D-01): asking.json is its OWN shard.
// This hook never writes, renames or deletes the attention shard (on-notification
// owns it), files.jsonl, reads.jsonl, skill.jsonl or the heartbeat.
//
// (e) Detail-free: persists ONLY { ts }. The question text, options,
// transcript_path and every other payload field are never read or persisted.
// tool_name is used only as a guard and is never written.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// T-vfm-01: allowlist the untrusted session_id before it becomes a path segment.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

// Store-location seam — identical precedence to src/paths.ts: 1)
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

try {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    payload = null;
  }

  const id = payload && payload.session_id;
  // T-vfm-04: guard against a mis-wired or broadened matcher.
  const isAsk = Boolean(payload) && payload.tool_name === "AskUserQuestion";

  // Strict allowlist gate before any path is built (T-vfm-01).
  if (isAsk && typeof id === "string" && SAFE_ID.test(id) && id !== "." && id !== "..") {
    const dir = path.join(storeRoot(), "sessions", id);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    // ISO-8601 ts to match the reader gate (Date.parse), NOT epoch ms. A
    // snapshot, not an append log.
    const snap = { ts: new Date().toISOString() };
    writeFileSync(path.join(dir, "asking.json"), JSON.stringify(snap), { mode: FILE_MODE });
  }
} catch {
  // Swallow every error: NEVER exit non-zero, NEVER write stdout/stderr.
}

process.exit(0);
