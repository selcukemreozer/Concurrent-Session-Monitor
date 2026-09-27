#!/usr/bin/env node
// /csm-goto — bring a live session's Warp pane to the front from inside a chat.
//
// Self-contained (Node stdlib only, T-1-SC): NO import from src/. It re-derives
// the storeRoot / SAFE_ID / sanitize / staleMs / pidAlive / heartbeat-liveness
// semantics of scripts/csm-status.mjs inline. Invoked by commands/csm-goto.md as
//   node csm-goto.mjs "<caller_session_id>" "<query>"
// where <query> is a folder name (exact, else unique substring, case-insensitive)
// or a session id (exact, else unique prefix).
//
// WARP-ONLY: the only focus handle a session has is the `warp.focus_url` that
// on-session-start.mjs captures from $WARP_FOCUS_URL when TERM_PROGRAM is
// WarpTerminal. Sessions in any other terminal have `warp: null` and cannot be
// focused — the script says so instead of guessing (no AppleScript, no window
// titles, no other terminals).
//
// FOCUS-ONLY: opening the warp:// URL just brings that pane forward. Nothing is
// typed, sent, or submitted into the target session, and no session state is
// written — the script is strictly read-only over the store.
//
// The URL is handed to macOS `open` via execFileSync with an args ARRAY (NO
// shell), so a crafted focus_url can never inject a command; it is additionally
// validated as a well-formed warp: URL before use. The whole body is wrapped so
// it ALWAYS exits 0.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

// T-04-07: allowlist untrusted session ids before any path/compare use.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Upper bound on an accepted focus_url (a real Warp URL is well under this). */
const MAX_URL_LEN = 2048;

// Internal TEST-ONLY seam (NOT documented — analogous to CSM_LSOF_CMD in
// csm-status.mjs). Lets a spawnSync-based test point the opener at a fixture
// script instead of really focusing a Warp pane.
function openCmd() {
  return process.env.CSM_OPEN_CMD || "open";
}

/** D-01b store-location seam — identical precedence to src/paths.ts / csm-status.mjs. */
function storeRoot() {
  const override = process.env.CSM_STORE_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".claude", "csm");
}
function sessionsDir() {
  return path.join(storeRoot(), "sessions");
}

/** Numeric env tunable with NaN/negative degrade-to-default (mirrors src/env.numEnv). */
function numEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}
function staleMs() {
  return numEnv("CSM_STALE_MS", 120000);
}

/**
 * Render-boundary control-character strip (T-04-06): drops C0 (0x00-0x1F) and
 * C1 (0x80-0x9F) so a crafted folder/query cannot inject terminal escapes into
 * the caller's context. Mirrors csm-status.mjs / src/sanitize.ts.
 */
function sanitize(s) {
  let out = "";
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || (cp >= 0x80 && cp <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/** Heartbeat sidecar last-seen ms (mirrors csm-status.resolveSidecarMs): ISO text, else mtime. */
function resolveLastSeen(dir) {
  const file = path.join(dir, "heartbeat");
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const parsed = Date.parse(content.trim());
  if (!Number.isNaN(parsed)) return parsed;
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Cheap pid liveness (mirrors csm-status.pidAlive) — kill -0; no lstart guard. */
function pidAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM"; // exists but not ours
  }
}

/**
 * Accept only a well-formed warp: URL (no control bytes, no whitespace, bounded
 * length). Returns the URL string or undefined. `open` would otherwise happily
 * launch file:// paths or http(s) pages — this keeps the command focus-only.
 */
function validFocusUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LEN) return undefined;
  if (sanitize(raw) !== raw || /\s/.test(raw)) return undefined;
  try {
    return new URL(raw).protocol === "warp:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Live sessions (heartbeat-fresh OR pid alive), newest start first. */
function liveSessions(now) {
  let ids;
  try {
    ids = fs.readdirSync(sessionsDir());
  } catch {
    return []; // store not created yet
  }
  const out = [];
  for (const id of ids) {
    if (!SAFE_ID.test(id) || id === "." || id === "..") continue;
    const dir = path.join(sessionsDir(), id);
    let state;
    try {
      state = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
    } catch {
      continue; // torn/missing snapshot self-heals next tick
    }
    const startMs = Date.parse(state?.start_time);
    const lastSeenMs = resolveLastSeen(dir) ?? startMs;
    const heartbeatFresh = !Number.isNaN(lastSeenMs) && now - lastSeenMs < staleMs();
    if (!heartbeatFresh && !pidAlive(state?.pid)) continue;
    const cwd = typeof state?.cwd === "string" ? state.cwd : "";
    const folder =
      typeof state?.folder === "string" && state.folder.length > 0 ? state.folder : path.basename(cwd);
    out.push({
      id,
      folder,
      focusUrl: state?.warp?.focus_url,
      startMs: Number.isNaN(startMs) ? 0 : startMs,
    });
  }
  out.sort((a, b) => b.startMs - a.startMs);
  return out;
}

/**
 * Resolve the query to candidates, most specific tier first: exact id, id
 * prefix, exact folder, folder substring (folder tiers case-insensitive). The
 * first tier with any hit wins. In the folder tiers the caller's own session is
 * dropped when another session also matches — "go to <this folder>" from one of
 * two sessions in the same folder means the other one.
 */
function resolveQuery(sessions, query, callerId) {
  const q = query.toLowerCase();
  const tiers = [
    [(s) => s.id === query, false],
    [(s) => s.id.startsWith(query), false],
    [(s) => s.folder.toLowerCase() === q, true],
    [(s) => s.folder.toLowerCase().includes(q), true],
  ];
  for (const [pred, dropSelf] of tiers) {
    let hits = sessions.filter(pred);
    if (hits.length === 0) continue;
    if (dropSelf && hits.length > 1 && callerId) {
      const others = hits.filter((s) => s.id !== callerId);
      if (others.length > 0) hits = others;
    }
    return hits;
  }
  return [];
}

function label(s, callerId) {
  const you = s.id === callerId ? " (you)" : "";
  const warp = validFocusUrl(s.focusUrl) ? "" : "  [no Warp focus]";
  return `${sanitize(s.folder) || "?"} (${sanitize(s.id.slice(0, 8))})${you}${warp}`;
}

function listLines(sessions, callerId) {
  return sessions.map((s) => `  - ${label(s, callerId)}`).join("\n");
}

function main() {
  const now = Date.now();
  const rawCaller = process.argv[2];
  const callerId =
    typeof rawCaller === "string" && SAFE_ID.test(rawCaller) && rawCaller !== "." && rawCaller !== ".."
      ? rawCaller
      : undefined;
  const query = sanitize(process.argv[3] ?? "").trim().slice(0, 200);

  const sessions = liveSessions(now);
  if (sessions.length === 0) {
    process.stdout.write("No live sessions.\n");
    return;
  }

  if (query.length === 0) {
    process.stdout.write(
      `Usage: /csm-goto <folder | session-id>\nLive sessions:\n${listLines(sessions, callerId)}\n`,
    );
    return;
  }

  const hits = resolveQuery(sessions, query, callerId);
  if (hits.length === 0) {
    process.stdout.write(
      `No live session matches "${query}".\nLive sessions:\n${listLines(sessions, callerId)}\n`,
    );
    return;
  }
  if (hits.length > 1) {
    process.stdout.write(
      `"${query}" matches ${hits.length} live sessions — use a session id to pick one:\n${listLines(hits, callerId)}\n`,
    );
    return;
  }

  const target = hits[0];
  const name = `${sanitize(target.folder) || "?"} (${sanitize(target.id.slice(0, 8))})`;
  const url = validFocusUrl(target.focusUrl);
  if (!url) {
    // Warp-only: no (valid) focus_url means the session is not in Warp, or Warp
    // did not export WARP_FOCUS_URL — there is no other handle to focus it by.
    process.stdout.write(
      `${name} has no Warp focus URL — /csm-goto can only focus sessions running in Warp.\n`,
    );
    return;
  }
  if (process.platform !== "darwin" && !process.env.CSM_OPEN_CMD) {
    process.stdout.write(`/csm-goto needs macOS \`open\` to focus ${name}.\n`);
    return;
  }

  try {
    // Args array, no shell: the URL is a single argv entry, never interpreted.
    execFileSync(openCmd(), [url], { timeout: 3000, stdio: ["ignore", "ignore", "ignore"] });
    process.stdout.write(`Focused ${name} in Warp.\n`);
  } catch {
    process.stdout.write(`Could not focus ${name} (open failed).\n`);
  }
}

try {
  main();
} catch {
  // Never surface a stack into the caller's context — passive, always exit 0.
}
process.exit(0);
