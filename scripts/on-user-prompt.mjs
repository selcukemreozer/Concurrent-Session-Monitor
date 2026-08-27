#!/usr/bin/env node
// UserPromptSubmit heartbeat hook (D-03) — the liveness proof for a session
// that is only reading/thinking between edits.
//
// Kept deliberately tiny and self-contained (Node stdlib only, T-1-SC): buffer
// stdin, extract session_id, write ONE `heartbeat` sidecar, exit 0. Unlike
// on-tool.mjs it does NOT append files.jsonl — a bare prompt touches no file.
//
// Passivity contract (T-1-05 / T-02-11): UserPromptSubmit stdout is
// model-visible, so this hook writes NOTHING to stdout, wraps its whole body so
// it ALWAYS exits 0, and is wired "async" so the prompt never waits on it.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// T-02-10: allowlist the untrusted session_id before it becomes a path segment.
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
  // Strict allowlist gate before any path is built (T-02-10).
  if (typeof id === "string" && SAFE_ID.test(id) && id !== "." && id !== "..") {
    const dir = path.join(storeRoot(), "sessions", id);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    // Heartbeat sidecar contract (FROZEN, shared with 02-01 resolveLastSeen):
    // file `heartbeat`, content = ISO-8601, plain writeFileSync (a one-line
    // mtime/content file has no torn-read window — no temp+rename needed).
    writeFileSync(path.join(dir, "heartbeat"), new Date().toISOString(), { mode: FILE_MODE });
  }
} catch {
  // Swallow every error (T-1-05): NEVER exit non-zero, NEVER write stdout.
}

process.exit(0);
