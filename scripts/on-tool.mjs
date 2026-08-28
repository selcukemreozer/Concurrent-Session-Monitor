#!/usr/bin/env node
// PostToolUse file-touch capture hook (CAP-01) — the make-or-break passive tap.
//
// Kept deliberately tiny and self-contained (Node stdlib only, T-1-SC): buffer
// stdin, extract file_path + session_id, append ONE files.jsonl line, exit 0.
//
// Passivity contract (T-1-05 / Pitfall 1): this runs on EVERY Edit/Write/
// MultiEdit. It is wired "async" so the agent's tool call never waits on it,
// and the whole body is wrapped so it ALWAYS exits 0. A non-zero PostToolUse
// exit (2) would inject stderr straight into Claude's context — forbidden.
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// T-1-01: allowlist the untrusted session_id before it becomes a path segment.
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
  // A1 defensive extraction: Edit/Write/MultiEdit all carry file_path at
  // tool_input.file_path; fall back to the first edit's file_path so an
  // unexpected MultiEdit nesting does not silently miss touches. The real
  // MultiEdit shape is confirmed empirically in the 01-04 end-to-end smoke.
  const toolInput = payload && payload.tool_input;
  const file_path =
    (toolInput && toolInput.file_path) ??
    (toolInput && toolInput.edits && toolInput.edits[0] && toolInput.edits[0].file_path);

  if (
    typeof id === "string" &&
    SAFE_ID.test(id) &&
    id !== "." &&
    id !== ".." &&
    typeof file_path === "string" &&
    file_path
  ) {
    const dir = path.join(storeRoot(), "sessions", id);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const evt = {
      file_path,
      // ISO-8601 to match the reader (aggregate.ts requires typeof ts ===
      // "string" and parses it with Date.parse); NOT epoch ms.
      ts: new Date().toISOString(),
      tool: payload.tool_name,
    };
    // CAP-03 (D-01/D-02): route by tool_name. A `Read` lands in the separate
    // append-only `reads.jsonl` shard; every write tool (Edit/Write/MultiEdit)
    // stays in the write-only `files.jsonl`, so Phase-3 detectConflicts — which
    // consumes only write-derived files[] — is untouched and reads can never
    // mint a conflict. Same TouchEvent line shape for both shards.
    const shard = payload.tool_name === "Read" ? "reads.jsonl" : "files.jsonl";
    // O_APPEND single-writer-per-file: no cross-writer contention (sharding).
    appendFileSync(path.join(dir, shard), JSON.stringify(evt) + "\n", { mode: FILE_MODE });
    // D-02 heartbeat: refresh last_seen alongside the touch so the 02-01 reader
    // (resolveLastSeen) sees a current liveness signal. Same FROZEN sidecar
    // contract as on-user-prompt.mjs: file `heartbeat`, content = ISO-8601,
    // plain writeFileSync (one-line file, no torn-read window), into the dir we
    // already mkdir'd above.
    writeFileSync(path.join(dir, "heartbeat"), new Date().toISOString(), { mode: FILE_MODE });
  }
} catch {
  // Swallow every error (T-1-05): NEVER exit non-zero, NEVER asyncRewake.
}

process.exit(0);
