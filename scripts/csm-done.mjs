#!/usr/bin/env node
// /csm-done done-gesture writer (INT-01, D-03).
//
// Completes the intent lifecycle: one gesture clears this session's declared
// intent AND releases the write files it is currently holding, so the panel
// task line falls back to the D-11 recent-file/idle indicator and the released
// files drop off the conflict surface. It does NOT end the session.
//
// Self-contained ESM using only Node stdlib (T-1-SC): the store-root
// resolution, the SAFE_ID allowlist, the file mode, and the active-window read
// are inlined here rather than imported from src/, so this stays a build-free
// script the plugin command invokes directly. Invoked from commands/csm-done.md:
//   node csm-done.mjs "<session_id>"
// argv[2] = session id (UNTRUSTED). No $ARGUMENTS — done takes no arguments.
//
// Passivity contract (mirrors the capture hooks): every path is swallowed and
// the process ALWAYS exits 0, so a bad id / unwritable store never leaks stderr
// into the agent's context.
//
// Single-writer invariant (D-01/D-03): this process touches ONLY its own
// session's intent.txt (remove) and files.jsonl (append). It never reads,
// writes, renames, or removes session.json, the heartbeat, or the session dir —
// the session keeps running.
import { readFileSync, appendFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FILE_MODE = 0o600;

// Defense-in-depth (T-04-12): re-apply the same allowlist to the substituted
// session id before building any path — a non-matching id does no work.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

// D-01b store-location seam — identical precedence to src/paths.ts so this
// writer and the panel reader agree on where shards live: 1) CSM_STORE_DIR
// override, else 2) ~/.claude/csm.
function storeRoot() {
  const override = process.env.CSM_STORE_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".claude", "csm");
}

// The rolling active write window (D-02), config-adjustable via CSM_WINDOW_MS,
// mirroring src/aggregate.ts windowMs(). Only files active within this window
// are considered "held" and worth releasing.
function windowMs() {
  const raw = process.env.CSM_WINDOW_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5 * 60 * 1000;
}

/**
 * Reduce a session's files.jsonl to its currently-active write paths — mirrors
 * aggregate.ts activeFiles(): newest-per-path within the window, already-released
 * paths excluded, torn/partial lines skipped. Returns the set of paths to release.
 */
function activeWritePaths(filesPath, now) {
  let raw;
  try {
    raw = readFileSync(filesPath, "utf8");
  } catch {
    return []; // no files.jsonl yet -> nothing held
  }

  const threshold = now - windowMs();
  const released = new Set();
  const newest = new Map(); // file_path -> newest ts (ms)

  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue; // skip a torn/partial line
    }
    if (typeof evt?.file_path !== "string" || typeof evt?.ts !== "string") continue;

    if (evt.released) {
      released.add(evt.file_path);
      continue;
    }

    const tsMs = Date.parse(evt.ts);
    if (Number.isNaN(tsMs) || tsMs < threshold) continue; // outside the active window

    const prev = newest.get(evt.file_path);
    if (prev === undefined || tsMs > prev) newest.set(evt.file_path, tsMs);
  }

  const paths = [];
  for (const file_path of newest.keys()) {
    if (released.has(file_path)) continue; // already released, don't double-release
    paths.push(file_path);
  }
  return paths;
}

try {
  const id = process.argv[2];

  // Gate the id before any path.join (T-04-12); a non-matching id does no work.
  if (typeof id === "string" && SAFE_ID.test(id) && id !== "." && id !== "..") {
    const dir = path.join(storeRoot(), "sessions", id);

    // (a) Clear intent — remove intent.txt if present (absent = no intent, the
    // D-11 fallback handles display). force:true makes an absent file a no-op.
    // We deliberately do NOT create an empty intent.txt.
    rmSync(path.join(dir, "intent.txt"), { force: true });

    // (b) Release active files — reduce files.jsonl to its currently-active
    // write paths and append one released:true TouchEvent per path (O_APPEND,
    // same line shape as on-tool.mjs). Confined to files.jsonl; no new shard.
    const filesPath = path.join(dir, "files.jsonl");
    const paths = activeWritePaths(filesPath, Date.now());
    let released = 0;
    for (const file_path of paths) {
      const evt = { file_path, ts: new Date().toISOString(), released: true };
      appendFileSync(filesPath, JSON.stringify(evt) + "\n", { mode: FILE_MODE });
      released += 1;
    }

    // Short confirmation inlined into context by the command's `!` injection.
    process.stdout.write(`csm: done — intent cleared, ${released} file(s) released\n`);
  }
} catch {
  // Swallow everything: the done gesture is passive, never blocks the agent.
}

process.exit(0);
