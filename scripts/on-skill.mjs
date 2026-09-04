#!/usr/bin/env node
// PostToolUse skill-capture hook (SKILL-01) — the passive Skill tap.
//
// Kept deliberately tiny and self-contained (Node stdlib only): buffer stdin,
// extract tool_input.skill + session_id (+ optional agent_type), append ONE
// skill.jsonl line, refresh the heartbeat sidecar, exit 0.
//
// D-01 one-writer-per-file: skill.jsonl is its OWN shard — this hook NEVER
// writes files.jsonl or reads.jsonl (those belong to on-tool.mjs).
//
// D-01b passivity contract: this runs on EVERY Skill tool_use. It is wired
// "async" so the agent's tool call never waits on it, and the whole body is
// wrapped so it ALWAYS exits 0. A non-zero PostToolUse exit (2) would inject
// stderr straight into Claude's context — forbidden.
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// T-04.3-01: allowlist the untrusted session_id before it becomes a path segment.
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

  const id = payload && payload.session_id; // parent id, even in a subagent call
  const skill = payload && payload.tool_input && payload.tool_input.skill;
  // SKILL-02 / D-03: agent_type is a friendly subagent name present ONLY inside a
  // subagent Skill call; the main loop has none. Treat "" (and non-string) as
  // absent so the line never carries the literal string "undefined" (Pitfall 2).
  const subagent =
    payload && typeof payload.agent_type === "string" && payload.agent_type
      ? payload.agent_type
      : undefined;

  if (
    typeof id === "string" &&
    SAFE_ID.test(id) &&
    id !== "." &&
    id !== ".." &&
    typeof skill === "string" &&
    skill
  ) {
    const dir = path.join(storeRoot(), "sessions", id);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const evt = {
      skill,
      // ISO-8601 to match the reader (Date.parse); NOT epoch ms.
      ts: new Date().toISOString(),
    };
    if (subagent) evt.subagent = subagent;
    // O_APPEND single-writer-per-file: skill.jsonl is its own shard (D-01).
    appendFileSync(path.join(dir, "skill.jsonl"), JSON.stringify(evt) + "\n", { mode: FILE_MODE });
    // D-02 heartbeat: refresh last_seen alongside the skill touch so the reader
    // sees a current liveness signal. Same FROZEN sidecar contract as
    // on-tool.mjs: file `heartbeat`, content = ISO-8601, plain writeFileSync.
    writeFileSync(path.join(dir, "heartbeat"), new Date().toISOString(), { mode: FILE_MODE });
  }
} catch {
  // Swallow every error (D-01b): NEVER exit non-zero, NEVER asyncRewake.
}

process.exit(0);
