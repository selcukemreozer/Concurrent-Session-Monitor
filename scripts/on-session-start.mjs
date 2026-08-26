#!/usr/bin/env node
// SessionStart capture hook (CAP-02, D-05, D-06).
//
// Self-contained ESM using only Node stdlib (T-1-SC): the store-root
// resolution and the safeId allowlist are inlined here rather than imported
// from src/, so this stays a build-free hot-path script (Open Q3).
//
// Non-negotiable passivity contract (T-1-05): every path — malformed stdin,
// non-repo cwd, an unwritable store dir — is swallowed and the process ALWAYS
// exits 0. A non-zero SessionStart/hook exit could leak stderr into Claude's
// context; that must never happen.
import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

const SCHEMA_VERSION = 1;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// T-1-01: an untrusted session_id becomes a directory name. Accept only a
// conservative allowlist BEFORE building any path; anything else is ignored
// (no fs touch) and the hook still exits 0.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

// D-01b store-location seam — identical precedence to src/paths.ts so every
// process agrees on where the shards live.
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
  // Strict allowlist gate before any path is built (T-1-01).
  if (typeof id === "string" && SAFE_ID.test(id) && id !== "." && id !== "..") {
    const cwd = (payload && payload.cwd) || process.cwd();

    // Best-effort branch: "" when cwd is not a git repo or git is slow/absent.
    let branch = "";
    try {
      branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }).trim();
    } catch {
      branch = "";
    }

    // D-06 Warp enrichment: an object only inside Warp, else null. No window/tab
    // name is ever read (D-07). Absent env vars degrade to "" — no failure path.
    const warp =
      process.env.TERM_PROGRAM === "WarpTerminal"
        ? {
            focus_url: process.env.WARP_FOCUS_URL || "",
            session_uuid: process.env.WARP_TERMINAL_SESSION_UUID || "",
          }
        : null;

    const record = {
      schema_version: SCHEMA_VERSION,
      session_id: id,
      cwd,
      folder: path.basename(cwd), // D-05 human-friendly label
      branch,
      // Best-effort model — the SessionStart payload MAY carry it ("not
      // guaranteed"); there is no $CLAUDE_MODEL. null when unknown.
      model: (payload && payload.model) ?? null,
      source: payload && payload.source,
      // ISO-8601 to match the cross-process reader contract (aggregate.ts sorts
      // via Date.parse(start_time)); NOT epoch ms.
      start_time: new Date().toISOString(),
      pid: process.ppid, // captured for Phase 2 liveness (kill -0); unused now
      warp,
    };

    // Atomic snapshot: unique temp in the same dir + renameSync over target
    // (rename(2) atomicity — no torn reads).
    const dir = path.join(storeRoot(), "sessions", id);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const tmp = path.join(
      dir,
      `.session.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    writeFileSync(tmp, JSON.stringify(record), { mode: FILE_MODE });
    renameSync(tmp, path.join(dir, "session.json"));
  }
} catch {
  // Swallow everything (T-1-05): monitoring is passive, never blocks the agent.
}

process.exit(0);
