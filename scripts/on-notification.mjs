#!/usr/bin/env node
// Notification attention-capture hook (ATTN-01) — the passive Notification tap.
//
// Only the Notification event sees "this session is waiting on the human"
// (a permission_prompt or an idle_prompt). Kept deliberately tiny and
// self-contained (Node stdlib only): buffer stdin, extract session_id +
// notification_type, write ONE attention.json snapshot { type, ts }, exit 0.
//
// D-01 one-writer-per-file: attention.json is its OWN shard — this hook NEVER
// writes files.jsonl, reads.jsonl, skill.jsonl, or the heartbeat sidecar.
//
// !!! PHASE-UNIQUE RULE (Pitfall 1): this hook DELIBERATELY DOES NOT refresh
// the heartbeat. Every other shard-writer ends with a `heartbeat` write; this
// one MUST NOT. A waiting session is not doing work, and the reader gate in
// 06-03 only surfaces the ◉ flag when the attention ts stays NEWER than the
// last activity (attnMs > lastSeenMs). Writing a heartbeat here would refresh
// last activity and permanently suppress the indicator.
//
// D-01b passivity contract: this runs on EVERY Notification event. It is wired
// "async" so the agent never waits on it, and the whole body is wrapped so it
// ALWAYS exits 0. A non-zero exit would inject stderr straight into Claude's
// context — forbidden. It also writes NOTHING to stdout.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// T-06-01: allowlist the untrusted session_id before it becomes a path segment.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

// T-06-02: narrow the untrusted notification_type to a known enum at write time.
// Anything else (crafted, absent, non-string) collapses to the literal "waiting"
// (defence-in-depth; A4 / ASVS V5) so no attacker-controlled value is persisted.
const KNOWN_TYPES = new Set(["permission_prompt", "idle_prompt"]);

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
  const rawType = payload && payload.notification_type;
  // T-06-02 enum narrowing: only the known values pass through; everything else
  // becomes "waiting" so a crafted notification_type is never persisted verbatim.
  const type =
    typeof rawType === "string" && KNOWN_TYPES.has(rawType) ? rawType : "waiting";

  // Strict allowlist gate before any path is built (T-06-01).
  if (typeof id === "string" && SAFE_ID.test(id) && id !== "." && id !== "..") {
    const dir = path.join(storeRoot(), "sessions", id);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    // T-06-03 detail-free: persist ONLY { type, ts } — NEVER payload.message,
    // transcript_path, or prompt_id. ts is ISO-8601 to match the reader gate
    // (Date.parse), NOT epoch ms.
    const evt = { type, ts: new Date().toISOString() };
    writeFileSync(path.join(dir, "attention.json"), JSON.stringify(evt), { mode: FILE_MODE });
    // DELIBERATELY NO heartbeat write here (Pitfall 1) — a waiting session emits
    // no activity signal, so the reader's newer-than-activity gate can fire.
  }
} catch {
  // Swallow every error (D-01b): NEVER exit non-zero, NEVER write stdout.
}

process.exit(0);
