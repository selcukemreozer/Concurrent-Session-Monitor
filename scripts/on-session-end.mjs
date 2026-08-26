#!/usr/bin/env node
// SessionEnd cleanup hook (D-03).
//
// When a session ends, remove its shard directory so its files no longer show
// as "active" in the panel. Self-contained ESM, Node stdlib only (T-1-SC).
//
// Passivity contract (T-1-05): malformed stdin, a bad id, or an rm failure are
// all swallowed and the process ALWAYS exits 0 — cleanup is best-effort and the
// panel independently treats a stale-mtime shard as inactive.
import { readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// T-1-01: allowlist the untrusted session_id before it becomes a path segment.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

// D-01b store-location seam — identical precedence to src/paths.ts.
function storeRoot() {
  const override = process.env.CSM_STORE_DIR;
  if (override) return override;
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) return path.join(pluginData, "csm");
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
  // Strict allowlist gate before building the path to remove (T-1-01).
  if (typeof id === "string" && SAFE_ID.test(id) && id !== "." && id !== "..") {
    const dir = path.join(storeRoot(), "sessions", id);
    rmSync(dir, { recursive: true, force: true }); // D-03: clear this session's state
  }
} catch {
  // Swallow everything (T-1-05).
}

process.exit(0);
