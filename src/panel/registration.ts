// Panel self-registration (260927-59z, D-01).
//
// When the CSM panel (`csm`) starts it records WHICH terminal it runs in at
// <storeRoot>/panel.json (the store root, NOT under sessions/), so the no-arg
// `/csm-goto` command can bring that terminal back to the front from any chat.
//
// Record: { schema_version: 1, pid, started (ISO), term_program, warp_focus_url,
// tty }. warp_focus_url is kept only for Warp and only when it matches the
// strict Warp session rule from src/warp-url.ts (261017-sbh), which
// scripts/csm-goto.mjs re-checks on read — panel.json is a same-user-writable
// file.
//
// Lifecycle / guarantees:
//   - Writes are atomic (writeSnapshot: 0600 temp file in a 0700 dir + rename),
//     so a reader never sees a torn file.
//   - Multiple panels: last writer wins. An exiting panel removes panel.json
//     ONLY when the file still holds its own pid, so an older panel never
//     deletes a newer panel's registration. The read-compare-unlink window is a
//     tolerated race (same user, benign outcome).
//   - Everything here is best-effort: no function throws, and nothing may crash
//     or delay the panel (entry.ts calls registerPanel after run()).
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { storeRoot } from "../paths.js";
import { writeSnapshot } from "../store.js";
import { sanitize } from "../sanitize.js";
import { isWarpSessionUrl } from "../warp-url.js";

export const PANEL_FILE = "panel.json";

export interface PanelRecord {
  schema_version: 1;
  pid: number;
  started: string;
  term_program: string | null;
  warp_focus_url: string | null;
  tty: string | null;
}

const MAX_TERM_LEN = 64;
const TTY_PATTERN = /^[A-Za-z0-9._/-]{1,64}$/;

/**
 * Keep the URL only when it matches the strict Warp session rule from
 * src/warp-url.ts (`warp://session/<32 lowercase hex>` or the Preview / OSS
 * form). Anything else, including `warp://launch/…`, gives null (261017-sbh).
 */
export function validWarpFocusUrl(raw: unknown): string | null {
  return isWarpSessionUrl(raw) ? raw : null;
}

/** Pure: shape the panel.json record from explicit inputs. */
export function buildPanelRecord(opts: {
  pid: number;
  env: NodeJS.ProcessEnv;
  now: Date;
  tty: string | null;
}): PanelRecord {
  const { pid, env, now, tty } = opts;
  const rawTerm = env.TERM_PROGRAM;
  const term =
    typeof rawTerm === "string" ? sanitize(rawTerm).slice(0, MAX_TERM_LEN) : "";
  return {
    schema_version: 1,
    pid,
    started: now.toISOString(),
    term_program: term === "" ? null : term,
    warp_focus_url:
      env.TERM_PROGRAM === "WarpTerminal"
        ? validWarpFocusUrl(env.WARP_FOCUS_URL)
        : null,
    tty,
  };
}

/**
 * Best-effort controlling-tty name for `pid` (e.g. "ttys003"). Only probes when
 * stdout is a TTY; one `ps` call with a 500 ms timeout. Never throws.
 */
export function detectTty(pid: number = process.pid): string | null {
  try {
    if (process.stdout.isTTY !== true) return null;
    const out = execFileSync("ps", ["-o", "tty=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out === "??" || out === "-") return null;
    return TTY_PATTERN.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** Write panel.json for this panel. true on write, false on any failure. */
export function registerPanel(
  overrides: {
    pid?: number;
    env?: NodeJS.ProcessEnv;
    now?: Date;
    tty?: string | null;
  } = {},
): boolean {
  try {
    const pid = overrides.pid ?? process.pid;
    const record = buildPanelRecord({
      pid,
      env: overrides.env ?? process.env,
      now: overrides.now ?? new Date(),
      tty: overrides.tty !== undefined ? overrides.tty : detectTty(pid),
    });
    writeSnapshot(storeRoot(), PANEL_FILE, record);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove panel.json only when it still holds `pid` (default: this process).
 * true only when the file was removed. Never throws.
 */
export function unregisterPanel(pid: number = process.pid): boolean {
  try {
    const file = path.join(storeRoot(), PANEL_FILE);
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as { pid?: unknown }).pid === pid
    ) {
      fs.unlinkSync(file);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
