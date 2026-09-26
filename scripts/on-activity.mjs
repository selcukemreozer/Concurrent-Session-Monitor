#!/usr/bin/env node
// Activity heartbeat hook (260926-r7n, AP-01) — the attention-clear signal.
//
// Purpose: the Notification hook fires ONCE when a question or permission
// prompt opens and writes attention.json. Answering an AskUserQuestion or
// approving a permission produces no Read/Edit/Write/Skill/UserPromptSubmit
// event, so nothing used to refresh the heartbeat and the ◉ waiting marker
// could only expire on a timer. PostToolUse("*") fires when the answered or
// approved tool completes, and Stop fires at turn end. This hook refreshes the
// heartbeat on those events so the reader's strict `attnMs > lastSeenMs` gate
// clears the marker on the next tick.
//
// Stop-safety contract: this hook MUST always exit 0 with EMPTY stdout (and no
// stderr). A Stop hook that exits 2 or prints a blocking decision would stop
// Claude from ending its turn. The whole body is wrapped so every error is
// swallowed, and it is wired "async" (timeout 5) so no tool call waits on it.
//
// Heartbeat-only and detail-free: it reads ONLY the session id from the
// payload and persists ONLY an ISO-8601 timestamp. PostToolUse("*") payloads
// carry Bash commands and file contents — none of that is read or written.
// D-01 one-writer-per-file: it NEVER writes, renames or deletes attention.json
// (on-notification owns that shard; clearing is purely reader-side).
//
// Kept deliberately tiny and self-contained (Node stdlib only), an exact
// structural mirror of on-user-prompt.mjs.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// T-r7n-01: allowlist the untrusted session_id before it becomes a path segment.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

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
    // Heartbeat sidecar contract (FROZEN, shared with liveness resolveLastSeen):
    // file `heartbeat`, content = ISO-8601, plain writeFileSync (a one-line
    // mtime/content file has no torn-read window — no temp+rename needed).
    writeFileSync(path.join(dir, "heartbeat"), new Date().toISOString(), { mode: FILE_MODE });
  }
} catch {
  // Swallow every error (T-r7n-02): NEVER exit non-zero, NEVER write stdout.
}

process.exit(0);
