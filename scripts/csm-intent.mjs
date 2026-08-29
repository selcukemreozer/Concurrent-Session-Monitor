#!/usr/bin/env node
// /csm-intent declare-intent writer (INT-01, D-01, D-02).
//
// Self-contained ESM using only Node stdlib (T-1-SC): the store-root
// resolution and the safeId allowlist are inlined here rather than imported
// from src/, so this stays a build-free script the plugin command invokes
// directly. Invoked from commands/csm-intent.md as:
//   node csm-intent.mjs "<session_id>" "<intent text>"
// argv[2] = session id, argv[3] = the intent text (both UNTRUSTED).
//
// Passivity contract (mirrors the capture hooks): every path is swallowed and
// the process ALWAYS exits 0, so a bad id / unwritable store never leaks stderr
// into the agent's context.
//
// Single-writer invariant (D-01): this process owns ONLY intent.txt via
// temp+rename. It never reads, writes, or renames session.json — that shard
// belongs to the SessionStart/heartbeat hooks alone.
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Defense-in-depth (T-04-01): re-apply the same allowlist to the substituted
// session id before building any path — a non-matching id writes nothing.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

// Untrusted-text cap (T-04-02): the intent line is bounded to keep the panel
// task line single-line and finite.
const MAX_INTENT = 200;

// D-01b store-location seam — identical precedence to src/paths.ts so the writer
// and the panel reader agree on where shards live: 1) CSM_STORE_DIR override,
// else 2) ~/.claude/csm.
function storeRoot() {
  const override = process.env.CSM_STORE_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".claude", "csm");
}

// Treat argv[3] as UNTRUSTED (T-04-02): strip C0 (0x00-0x1F) and C1 (0x80-0x9F)
// control code points (removing newlines/ESC so it stays single-line), collapse
// whitespace runs to a single space, trim, then cap at MAX_INTENT chars. The
// control classes are filtered by code point (Array.from) rather than a regex
// so no literal control byte lives in this source file.
function sanitizeIntent(raw) {
  if (typeof raw !== "string") return "";
  const stripped = Array.from(raw, (ch) => {
    const c = ch.charCodeAt(0);
    return c <= 0x1f || (c >= 0x80 && c <= 0x9f) ? " " : ch;
  }).join("");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, MAX_INTENT);
}

try {
  const id = process.argv[2];
  const intent = sanitizeIntent(process.argv[3]);

  // Gate the id before any path.join (T-04-01); an empty intent writes nothing.
  if (
    typeof id === "string" &&
    SAFE_ID.test(id) &&
    id !== "." &&
    id !== ".." &&
    intent.length > 0
  ) {
    const dir = path.join(storeRoot(), "sessions", id);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });

    const record = { intent, ts: new Date().toISOString() };
    // Atomic snapshot: unique temp in the SAME dir + renameSync over target
    // (rename(2) atomicity — the panel never reads a torn intent.txt).
    const tmp = path.join(
      dir,
      `.intent.txt.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    writeFileSync(tmp, JSON.stringify(record), { mode: FILE_MODE });
    renameSync(tmp, path.join(dir, "intent.txt"));

    // Print a short confirmation so the command's `!` injection inlines it into
    // context (the agent sees what it recorded).
    process.stdout.write(`csm: intent set — ${intent}\n`);
  }
} catch {
  // Swallow everything: declaring intent is passive, never blocks the agent.
}

process.exit(0);
