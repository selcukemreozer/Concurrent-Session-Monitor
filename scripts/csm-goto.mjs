#!/usr/bin/env node
// /csm-goto — bring the terminal running the CSM panel (`csm`) to the front, so
// you can jump back to the panel from any chat (260927-59z). Takes NO arguments;
// any argv is ignored.
//
// Source: <storeRoot>/panel.json, written by the panel itself when it starts
// (src/panel/registration.ts) and removed on a clean exit. With several panels
// open the most recently started one wins (last writer).
//
// Focus strategy:
//   - Warp: the panel recorded its $WARP_FOCUS_URL → `open <warp: URL>` brings
//     the panel's exact pane forward.
//   - Terminal / iTerm2 / Warp (no URL) / Ghostty / VS Code: `open -a <App>` —
//     only the app can be activated, not the exact window or tab.
//   - Any other terminal: nothing is opened; the panel's pid / tty / terminal
//     are printed instead.
//   - No panel.json, torn/malformed file, or a dead pid: says no panel is
//     running.
//
// FOCUS-ONLY and READ-ONLY: nothing is typed or sent anywhere and the store is
// never written. panel.json is a same-user-writable file, so EVERY field is
// re-validated here: pid must be an integer > 1 that is alive; the focus URL
// must be a well-formed warp: URL; the app name comes only from a fixed Map
// keyed by exact TERM_PROGRAM values (never from the file); echoed text is
// control-byte stripped and length-capped. The opener is run via execFileSync
// with an args ARRAY and no shell, so no field can inject a command.
//
// Self-contained (Node stdlib only, T-1-SC): NO import from src/. The whole body
// is wrapped so it ALWAYS exits 0.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/** Upper bound on an accepted focus URL (a real Warp URL is well under this). */
const MAX_URL_LEN = 2048;
/** Cap on echoed term_program / tty text. */
const MAX_ECHO = 64;

const NO_PANEL = "No CSM panel is running — start it with `csm`.";
const WARP_OK = "Focused the CSM panel (Warp).";
const OPEN_FAIL = "Could not focus the CSM panel (open failed).";
const NOT_MAC = "/csm-goto needs macOS `open` to focus the CSM panel.";

/**
 * Exact TERM_PROGRAM → macOS app name. A Map (not an object lookup) so
 * prototype names like __proto__ / constructor / toString never resolve.
 */
const APP_BY_TERM = new Map([
  ["Apple_Terminal", "Terminal"],
  ["iTerm.app", "iTerm"],
  ["WarpTerminal", "Warp"],
  ["ghostty", "Ghostty"],
  ["vscode", "Visual Studio Code"],
]);

// Internal TEST-ONLY seam (NOT documented — analogous to CSM_LSOF_CMD in
// csm-status.mjs). Lets a spawnSync-based test point the opener at a fixture
// script instead of really focusing anything.
function openCmd() {
  return process.env.CSM_OPEN_CMD || "open";
}

/** D-01b store-location seam — identical precedence to src/paths.ts / csm-status.mjs. */
function storeRoot() {
  const override = process.env.CSM_STORE_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".claude", "csm");
}

/**
 * Render-boundary control-character strip (T-04-06): drops C0 (0x00-0x1F) and
 * C1 (0x80-0x9F) so a crafted panel.json cannot inject terminal escapes into
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

/** Sanitized, length-capped echo of an untrusted string field ("" otherwise). */
function safeText(v, max) {
  return typeof v === "string" ? sanitize(v).slice(0, max) : "";
}

/** Cheap pid liveness (mirrors csm-status.pidAlive) — kill -0; EPERM = alive. */
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

/**
 * The live panel's registration, or undefined when panel.json is missing,
 * torn, malformed, or names a pid that is not an integer > 1 or is dead.
 * (pid 1 is launchd: kill -0 on it is EPERM = "alive" and would lie.)
 */
function readPanel() {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(storeRoot(), "panel.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return undefined;
  const pid = rec.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return undefined;
  if (!pidAlive(pid)) return undefined;
  return rec;
}

function say(line) {
  process.stdout.write(`${line}\n`);
}

function main() {
  const rec = readPanel();
  if (!rec) {
    say(NO_PANEL);
    return;
  }

  const url = validFocusUrl(rec.warp_focus_url);
  const app = typeof rec.term_program === "string" ? APP_BY_TERM.get(rec.term_program) : undefined;

  if (!url && !app) {
    const tty = safeText(rec.tty, MAX_ECHO) || "unknown";
    const term = safeText(rec.term_program, MAX_ECHO) || "unknown";
    say(
      `The CSM panel is running (pid ${rec.pid}, tty ${tty}, terminal ${term}) but its terminal can't be focused automatically.`,
    );
    return;
  }

  if (process.platform !== "darwin" && !process.env.CSM_OPEN_CMD) {
    say(NOT_MAC);
    return;
  }

  try {
    // Args array with no shell — the URL / app name is a single argv entry, never
    // interpreted. The app name comes from APP_BY_TERM, never from the file.
    execFileSync(openCmd(), url ? [url] : ["-a", app], {
      timeout: 3000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    say(
      url
        ? WARP_OK
        : `Brought ${app} to the front — the CSM panel runs there, but only the app could be focused, not its exact window or tab.`,
    );
  } catch {
    say(OPEN_FAIL);
  }
}

try {
  main();
} catch {
  // Never surface a stack into the caller's context — passive, always exit 0.
}
process.exit(0);
