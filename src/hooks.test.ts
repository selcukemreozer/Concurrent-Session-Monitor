import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readAll } from "./aggregate.js";

// RED: the hook scripts do not exist yet. They land in wave 01-03:
//   scripts/on-tool.mjs         (PostToolUse file-touch capture, CAP-01)
//   scripts/on-session-start.mjs (SessionStart identity capture, CAP-02)
// Tests spawn each script with fixture stdin and assert exit code / output.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const onTool = path.join(repoRoot, "scripts", "on-tool.mjs");
const onSessionStart = path.join(repoRoot, "scripts", "on-session-start.mjs");
const onUserPrompt = path.join(repoRoot, "scripts", "on-user-prompt.mjs");
const onSkill = path.join(repoRoot, "scripts", "on-skill.mjs");
// RED (06-02): the Notification capture hook does not exist yet. It writes a
// per-session attention.json snapshot shard { type, ts } and — CRITICALLY —
// must NOT refresh the heartbeat (Pitfall 1), so the reader-side newer-than
// gate can surface the ◉ waiting flag.
const onNotification = path.join(repoRoot, "scripts", "on-notification.mjs");
// 260926-r7n (AP-01): heartbeat-only activity hook wired to PostToolUse("*")
// and Stop, so answering/approving a prompt (the tool then completes) or a turn
// end refreshes the heartbeat and the reader's strict attnMs > lastSeenMs gate
// clears the ◉ waiting marker.
const onActivity = path.join(repoRoot, "scripts", "on-activity.mjs");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-hooks-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runHook(script: string, stdin: string, storeDir: string) {
  return spawnSync(process.execPath, [script], {
    input: stdin,
    env: { ...process.env, CSM_STORE_DIR: storeDir },
    encoding: "utf8",
  });
}

describe("capture hooks", () => {
  it("exit 0: malformed stdin AND an unwritable store dir both still exit 0 (CAP-01, T-1-05)", () => {
    // Malformed JSON on stdin must not crash the hook.
    const malformed = runHook(onTool, "this is not json{", tmp);
    expect(malformed.status).toBe(0);

    // An unwritable store dir must also be swallowed (always exit 0, no stderr leak).
    const readOnly = path.join(tmp, "readonly");
    fs.mkdirSync(readOnly, { recursive: true });
    fs.chmodSync(readOnly, 0o500);
    const validPayload = JSON.stringify({
      session_id: "hook-sess",
      cwd: "/repo",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
    });
    const unwritable = runHook(onTool, validPayload, readOnly);
    expect(unwritable.status).toBe(0);
    fs.chmodSync(readOnly, 0o700);
  });

  it("append: a valid PostToolUse payload appends one files.jsonl line carrying file_path (CAP-01)", () => {
    const payload = JSON.stringify({
      session_id: "hook-sess",
      cwd: "/repo",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
    });
    const res = runHook(onTool, payload, tmp);
    expect(res.status).toBe(0);

    const jsonl = path.join(tmp, "sessions", "hook-sess", "files.jsonl");
    const lines = fs.readFileSync(jsonl, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const evt = JSON.parse(lines[0]);
    expect(evt.file_path).toBe("/repo/x.ts");
  });

  it("identity: SessionStart writes session.json with folder, branch, model, start_time (CAP-02)", () => {
    const payload = JSON.stringify({
      session_id: "hook-sess",
      cwd: repoRoot,
      hook_event_name: "SessionStart",
      model: "claude-opus",
    });
    const res = runHook(onSessionStart, payload, tmp);
    expect(res.status).toBe(0);

    const sessionJson = path.join(tmp, "sessions", "hook-sess", "session.json");
    const state = JSON.parse(fs.readFileSync(sessionJson, "utf8"));
    expect(state.folder).toBeDefined();
    expect(state.branch).toBeDefined();
    expect(state.model).toBe("claude-opus");
    expect(state.start_time).toBeDefined();
  });

  // --- Plan 02-02: heartbeat writes + durable pid + passivity (LIFE-01 write half) ---

  it("heartbeat: on-user-prompt writes a heartbeat sidecar whose content parses as an ISO date (D-03)", () => {
    const payload = JSON.stringify({
      session_id: "hook-sess",
      cwd: "/repo",
      hook_event_name: "UserPromptSubmit",
    });
    const res = runHook(onUserPrompt, payload, tmp);
    expect(res.status).toBe(0);

    const hb = path.join(tmp, "sessions", "hook-sess", "heartbeat");
    const content = fs.readFileSync(hb, "utf8");
    expect(Number.isFinite(Date.parse(content.trim()))).toBe(true);

    // on-user-prompt is a heartbeat-only hook: it must NOT append a files.jsonl line.
    expect(fs.existsSync(path.join(tmp, "sessions", "hook-sess", "files.jsonl"))).toBe(false);
  });

  it("passivity: on-user-prompt exits 0 with empty stdout on malformed stdin AND an unwritable dir (T-02-11)", () => {
    const malformed = runHook(onUserPrompt, "not json{", tmp);
    expect(malformed.status).toBe(0);
    expect(malformed.stdout).toBe("");

    const readOnly = path.join(tmp, "readonly");
    fs.mkdirSync(readOnly, { recursive: true });
    fs.chmodSync(readOnly, 0o500);
    const payload = JSON.stringify({ session_id: "hook-sess", hook_event_name: "UserPromptSubmit" });
    const unwritable = runHook(onUserPrompt, payload, readOnly);
    expect(unwritable.status).toBe(0);
    expect(unwritable.stdout).toBe("");
    fs.chmodSync(readOnly, 0o700);
  });

  it("heartbeat: a valid PostToolUse payload writes BOTH files.jsonl (1 line) and a heartbeat sidecar (D-02, WR-03)", () => {
    const payload = JSON.stringify({
      session_id: "hook-sess",
      cwd: "/repo",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
    });
    const res = runHook(onTool, payload, tmp);
    expect(res.status).toBe(0);

    const jsonl = path.join(tmp, "sessions", "hook-sess", "files.jsonl");
    const lines = fs.readFileSync(jsonl, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    const hb = path.join(tmp, "sessions", "hook-sess", "heartbeat");
    const content = fs.readFileSync(hb, "utf8");
    expect(Number.isFinite(Date.parse(content.trim()))).toBe(true);
  });

  it("pid: SessionStart writes an integer pid > 0 and a string pid_started (D-04)", () => {
    const payload = JSON.stringify({
      session_id: "hook-sess",
      cwd: repoRoot,
      hook_event_name: "SessionStart",
      model: "claude-opus",
    });
    const res = runHook(onSessionStart, payload, tmp);
    expect(res.status).toBe(0);

    const sessionJson = path.join(tmp, "sessions", "hook-sess", "session.json");
    const state = JSON.parse(fs.readFileSync(sessionJson, "utf8"));
    expect(Number.isInteger(state.pid)).toBe(true);
    expect(state.pid).toBeGreaterThan(0);
    expect(typeof state.pid_started).toBe("string");
  });

  it("model sentinel: a model-less SessionStart payload yields session.json.model === 'unknown' (WR-02, D-09)", () => {
    const payload = JSON.stringify({
      session_id: "hook-sess",
      cwd: repoRoot,
      hook_event_name: "SessionStart",
    });
    const res = runHook(onSessionStart, payload, tmp);
    expect(res.status).toBe(0);

    const sessionJson = path.join(tmp, "sessions", "hook-sess", "session.json");
    const state = JSON.parse(fs.readFileSync(sessionJson, "utf8"));
    expect(state.model).toBe("unknown");
  });
});

// --- Plan 03.1-01: read capture routes to reads.jsonl, never files.jsonl (CAP-03) ---

describe("read capture routing (CAP-03)", () => {
  it("read routing: a Read payload appends ONE reads.jsonl line and NO files.jsonl (D-01/D-02)", () => {
    const payload = JSON.stringify({
      session_id: "hook-sess",
      cwd: "/repo",
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/repo/r.ts" },
    });
    const res = runHook(onTool, payload, tmp);
    expect(res.status).toBe(0);

    const readsJsonl = path.join(tmp, "sessions", "hook-sess", "reads.jsonl");
    const lines = fs.readFileSync(readsJsonl, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const evt = JSON.parse(lines[0]);
    expect(evt.file_path).toBe("/repo/r.ts");

    // Write-only invariant: a pure Read must NEVER mint a files.jsonl line.
    expect(fs.existsSync(path.join(tmp, "sessions", "hook-sess", "files.jsonl"))).toBe(false);
  });

  it("write still write-only: an Edit payload appends to files.jsonl and leaves reads.jsonl absent (D-02 BACKBONE)", () => {
    const payload = JSON.stringify({
      session_id: "hook-sess",
      cwd: "/repo",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts" },
    });
    const res = runHook(onTool, payload, tmp);
    expect(res.status).toBe(0);

    const filesJsonl = path.join(tmp, "sessions", "hook-sess", "files.jsonl");
    const lines = fs.readFileSync(filesJsonl, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    // The write shard must never bleed into the read shard.
    expect(fs.existsSync(path.join(tmp, "sessions", "hook-sess", "reads.jsonl"))).toBe(false);
  });

  it("read heartbeat: a Read payload refreshes the heartbeat sidecar (a read is liveness too, D-02)", () => {
    const payload = JSON.stringify({
      session_id: "hook-sess",
      cwd: "/repo",
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/repo/r.ts" },
    });
    const res = runHook(onTool, payload, tmp);
    expect(res.status).toBe(0);

    const hb = path.join(tmp, "sessions", "hook-sess", "heartbeat");
    const content = fs.readFileSync(hb, "utf8");
    expect(Number.isFinite(Date.parse(content.trim()))).toBe(true);
  });

  it("read passivity: a Read payload with malformed stdin AND against an unwritable dir both exit 0 (D-12)", () => {
    const malformed = runHook(onTool, "not json{", tmp);
    expect(malformed.status).toBe(0);
    expect(malformed.stdout).toBe("");

    const readOnly = path.join(tmp, "readonly");
    fs.mkdirSync(readOnly, { recursive: true });
    fs.chmodSync(readOnly, 0o500);
    const payload = JSON.stringify({
      session_id: "hook-sess",
      cwd: "/repo",
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/repo/r.ts" },
    });
    const unwritable = runHook(onTool, payload, readOnly);
    expect(unwritable.status).toBe(0);
    expect(unwritable.stdout).toBe("");
    fs.chmodSync(readOnly, 0o700);
  });
});

// --- Plan 04.3-02: Skill capture routes to its OWN skill.jsonl shard (SKILL-01/02) ---
// Payload shape confirmed live by Plan 01's spike:
//   { session_id, hook_event_name:"PostToolUse", tool_name:"Skill", tool_input:{ skill } }
//   plus agent_type:<friendly name> ONLY when the Skill call originates in a subagent
//   (main-loop invocations omit agent_type). session_id is the parent id in BOTH cases.

describe("skill capture (SKILL-01/02)", () => {
  const skillPayload = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: "hook-sess",
      cwd: "/repo",
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "gsd-help" },
      ...extra,
    });

  it("(a) SKILL-01 append: a valid Skill payload exits 0 and appends ONE skill.jsonl line with matching skill + parseable ts", () => {
    const res = runHook(onSkill, skillPayload(), tmp);
    expect(res.status).toBe(0);

    const jsonl = path.join(tmp, "sessions", "hook-sess", "skill.jsonl");
    const lines = fs.readFileSync(jsonl, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const evt = JSON.parse(lines[0]);
    expect(evt.skill).toBe("gsd-help");
    expect(typeof evt.ts).toBe("string");
    expect(Number.isFinite(Date.parse(evt.ts))).toBe(true);
  });

  it("(b) D-01 shard isolation: a Skill payload creates NEITHER files.jsonl NOR reads.jsonl", () => {
    const res = runHook(onSkill, skillPayload(), tmp);
    expect(res.status).toBe(0);

    const dir = path.join(tmp, "sessions", "hook-sess");
    expect(fs.existsSync(path.join(dir, "files.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "reads.jsonl"))).toBe(false);
  });

  it("(c) heartbeat: a Skill payload writes a heartbeat sidecar whose content parses as an ISO date", () => {
    const res = runHook(onSkill, skillPayload(), tmp);
    expect(res.status).toBe(0);

    const hb = path.join(tmp, "sessions", "hook-sess", "heartbeat");
    const content = fs.readFileSync(hb, "utf8");
    expect(Number.isFinite(Date.parse(content.trim()))).toBe(true);
  });

  it("(d) SKILL-02 subagent present: agent_type on the payload yields line.subagent === agent_type", () => {
    const res = runHook(onSkill, skillPayload({ agent_type: "gsd-executor" }), tmp);
    expect(res.status).toBe(0);

    const jsonl = path.join(tmp, "sessions", "hook-sess", "skill.jsonl");
    const lines = fs.readFileSync(jsonl, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const evt = JSON.parse(lines[0]);
    expect(evt.subagent).toBe("gsd-executor");
  });

  it("(e) SKILL-02 subagent absent: a main-loop payload (no agent_type, and agent_type:'') yields NO subagent key — never the string 'undefined' (Pitfall 2)", () => {
    // Main loop: no agent_type key at all.
    const res1 = runHook(onSkill, skillPayload(), tmp);
    expect(res1.status).toBe(0);
    const jsonl = path.join(tmp, "sessions", "hook-sess", "skill.jsonl");
    let lines = fs.readFileSync(jsonl, "utf8").trim().split("\n").filter(Boolean);
    let evt = JSON.parse(lines[lines.length - 1]);
    expect("subagent" in evt).toBe(false);

    // Empty-string agent_type must be treated as absent, not persisted verbatim.
    const res2 = runHook(onSkill, skillPayload({ agent_type: "" }), tmp);
    expect(res2.status).toBe(0);
    lines = fs.readFileSync(jsonl, "utf8").trim().split("\n").filter(Boolean);
    evt = JSON.parse(lines[lines.length - 1]);
    expect("subagent" in evt).toBe(false);
  });

  it("(f) D-01b passivity: malformed stdin AND an unwritable store dir both exit 0 with empty stdout", () => {
    const malformed = runHook(onSkill, "not json{", tmp);
    expect(malformed.status).toBe(0);
    expect(malformed.stdout).toBe("");

    const readOnly = path.join(tmp, "readonly");
    fs.mkdirSync(readOnly, { recursive: true });
    fs.chmodSync(readOnly, 0o500);
    const unwritable = runHook(onSkill, skillPayload(), readOnly);
    expect(unwritable.status).toBe(0);
    expect(unwritable.stdout).toBe("");
    fs.chmodSync(readOnly, 0o700);
  });

  it("(g) T-04.3-01 traversal: a '../evil' session_id writes NOTHING under the store", () => {
    const res = runHook(onSkill, skillPayload({ session_id: "../evil" }), tmp);
    expect(res.status).toBe(0);

    // No escape above the sessions dir, and no shard for the crafted id.
    expect(fs.existsSync(path.join(tmp, "evil"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "sessions", "..", "evil"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "sessions", "..", "evil", "skill.jsonl"))).toBe(false);
  });
});

// --- Plan 06-02: Notification capture writes its OWN attention.json snapshot
// shard, NEVER a heartbeat (ATTN-01). Payload shape verified by the Phase-6
// spike:
//   { session_id, hook_event_name:"Notification", notification_type, message,
//     transcript_path, prompt_id, cwd, ... }
// The writer must persist ONLY { type, ts } (detail-free — no message/transcript/
// prompt id leaks), narrow notification_type to the known enum
// {permission_prompt, idle_prompt} else "waiting", and — the single phase-unique
// rule — write NO heartbeat sidecar (Pitfall 1), or the reader's newer-than gate
// would never surface the ◉ flag. These cases are RED until scripts/
// on-notification.mjs lands in 06-02.

describe("notification capture (ATTN-01)", () => {
  const notifPayload = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: "s",
      cwd: "/repo",
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      message: "Claude is waiting for your input",
      transcript_path: "/some/transcript.jsonl",
      prompt_id: "p-123",
      ...extra,
    });

  const attentionPath = (id: string) => path.join(tmp, "sessions", id, "attention.json");
  const heartbeatPath = (id: string) => path.join(tmp, "sessions", id, "heartbeat");

  it("(a) ATTN-01 write: a valid idle_prompt Notification exits 0 and writes attention.json {type:'idle_prompt', ts:<ISO>}", () => {
    const res = runHook(onNotification, notifPayload(), tmp);
    expect(res.status).toBe(0);

    const evt = JSON.parse(fs.readFileSync(attentionPath("s"), "utf8"));
    expect(evt.type).toBe("idle_prompt");
    expect(typeof evt.ts).toBe("string");
    expect(Number.isFinite(Date.parse(evt.ts))).toBe(true);
  });

  it("(b) Pitfall-1 no-heartbeat: after the write attention.json EXISTS but the heartbeat sidecar does NOT (a waiting session emits no activity signal)", () => {
    const res = runHook(onNotification, notifPayload(), tmp);
    expect(res.status).toBe(0);

    expect(fs.existsSync(attentionPath("s"))).toBe(true);
    // The single phase-unique invariant: this hook must NEVER refresh heartbeat.
    expect(fs.existsSync(heartbeatPath("s"))).toBe(false);
  });

  it("(c) permission_prompt: the type is persisted verbatim as 'permission_prompt'", () => {
    const res = runHook(onNotification, notifPayload({ notification_type: "permission_prompt" }), tmp);
    expect(res.status).toBe(0);

    const evt = JSON.parse(fs.readFileSync(attentionPath("s"), "utf8"));
    expect(evt.type).toBe("permission_prompt");
  });

  it("(d) enum narrowing: an unknown/crafted notification_type collapses to 'waiting' (A4/ASVS V5)", () => {
    const res = runHook(onNotification, notifPayload({ notification_type: "weird" }), tmp);
    expect(res.status).toBe(0);

    const evt = JSON.parse(fs.readFileSync(attentionPath("s"), "utf8"));
    expect(evt.type).toBe("waiting");
  });

  it("(e) detail-free: the written object exposes EXACTLY the keys ts and type — no message/transcript/prompt id leaks in", () => {
    const res = runHook(onNotification, notifPayload(), tmp);
    expect(res.status).toBe(0);

    const evt = JSON.parse(fs.readFileSync(attentionPath("s"), "utf8"));
    expect(Object.keys(evt).sort()).toEqual(["ts", "type"]);
  });

  it("(f) passivity: malformed stdin exits 0 with empty stdout and writes NO attention.json", () => {
    const malformed = runHook(onNotification, "not json{", tmp);
    expect(malformed.status).toBe(0);
    expect(malformed.stdout).toBe("");
    expect(fs.existsSync(attentionPath("s"))).toBe(false);
  });

  it("(g) passivity: an unwritable 0o500 store dir still exits 0 with empty stdout (mirror on-skill)", () => {
    const readOnly = path.join(tmp, "readonly");
    fs.mkdirSync(readOnly, { recursive: true });
    fs.chmodSync(readOnly, 0o500);
    const unwritable = runHook(onNotification, notifPayload(), readOnly);
    expect(unwritable.status).toBe(0);
    expect(unwritable.stdout).toBe("");
    fs.chmodSync(readOnly, 0o700);
  });

  it("(h) W3 security (T-06-01): a crafted/traversal session_id is rejected by SAFE_ID — exits 0, writes no attention.json, and creates no file outside the session subtree", () => {
    for (const crafted of ["../evil", "a/../../b"]) {
      const res = runHook(onNotification, notifPayload({ session_id: crafted }), tmp);
      expect(res.status).toBe(0);
    }
    // No escape above the sessions dir, and no attention shard for any crafted id.
    expect(fs.existsSync(path.join(tmp, "evil"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "sessions", "..", "evil"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "sessions", "..", "evil", "attention.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "b"))).toBe(false);
    // Belt-and-braces: nothing anywhere under the store root carries the crafted segment.
    const walk = (d: string): string[] =>
      fs.existsSync(d)
        ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
            const full = path.join(d, e.name);
            return e.isDirectory() ? [full, ...walk(full)] : [full];
          })
        : [];
    const all = walk(tmp);
    expect(all.some((p) => p.includes("evil"))).toBe(false);
  });
});

// --- Quick task 260926-r7n: on-activity heartbeat hook (AP-01/AP-03). The
// Notification hook fires ONCE when a prompt opens; answering AskUserQuestion or
// approving a permission bumped no heartbeat, so only the old short TTL cleared
// the marker. on-activity refreshes the heartbeat on PostToolUse("*") and Stop.
// It must be heartbeat-only, detail-free, Stop-safe (exit 0, empty stdout) and
// must NEVER touch attention.json (D-01 one-writer-per-file).
describe("activity heartbeat — attention clear (AP-01/AP-03)", () => {
  const sessDir = (id: string) => path.join(tmp, "sessions", id);
  const heartbeatPath = (id: string) => path.join(sessDir(id), "heartbeat");

  it("T1 wiring: hooks.json wires on-activity to PostToolUse '*' and Stop (async, timeout 5) and leaves existing entries intact", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, "hooks", "hooks.json"), "utf8"));
    const h = cfg.hooks;

    const star = h.PostToolUse.find((e: { matcher?: string }) => e.matcher === "*");
    expect(star).toBeDefined();
    expect(star.hooks).toHaveLength(1);
    expect(star.hooks[0].type).toBe("command");
    expect(star.hooks[0].command).toContain("scripts/on-activity.mjs");
    expect(star.hooks[0].async).toBe(true);
    expect(star.hooks[0].timeout).toBe(5);

    expect(Array.isArray(h.Stop)).toBe(true);
    const stop = h.Stop[0];
    expect(stop.matcher).toBeUndefined();
    expect(stop.hooks).toHaveLength(1);
    expect(stop.hooks[0].type).toBe("command");
    expect(stop.hooks[0].command).toContain("scripts/on-activity.mjs");
    expect(stop.hooks[0].async).toBe(true);
    expect(stop.hooks[0].timeout).toBe(5);

    const tool = h.PostToolUse.find((e: { matcher?: string }) => e.matcher === "Read|Edit|Write|MultiEdit");
    expect(tool.hooks[0].command).toContain("scripts/on-tool.mjs");
    const skill = h.PostToolUse.find((e: { matcher?: string }) => e.matcher === "Skill");
    expect(skill.hooks[0].command).toContain("scripts/on-skill.mjs");

    // Pitfall 1: the Notification hook must never bump the heartbeat.
    expect(JSON.stringify(h.Notification)).not.toContain("on-activity");
    expect(fs.existsSync(onActivity)).toBe(true);
  });

  it("T2 PostToolUse: an AskUserQuestion completion writes a parseable heartbeat, exit 0, empty stdout", () => {
    const payload = JSON.stringify({
      session_id: "act-sess",
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      tool_input: {},
      tool_response: {},
    });
    const res = runHook(onActivity, payload, tmp);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    const content = fs.readFileSync(heartbeatPath("act-sess"), "utf8");
    expect(Number.isFinite(Date.parse(content.trim()))).toBe(true);
  });

  it("T3 Stop: a Stop payload writes a parseable heartbeat, exit 0, stdout exactly empty (Stop-safety)", () => {
    const payload = JSON.stringify({ session_id: "act-sess", hook_event_name: "Stop", stop_hook_active: false });
    const res = runHook(onActivity, payload, tmp);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    const content = fs.readFileSync(heartbeatPath("act-sess"), "utf8");
    expect(Number.isFinite(Date.parse(content.trim()))).toBe(true);
  });

  it("T4 heartbeat-only + detail-free: a Bash PostToolUse leaves ONLY a heartbeat and never persists tool_input", () => {
    const sentinel = "SENTINEL_SECRET_r7n";
    const payload = JSON.stringify({
      session_id: "act-sess",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: `echo ${sentinel}` },
      tool_response: { stdout: sentinel },
    });
    const res = runHook(onActivity, payload, tmp);
    expect(res.status).toBe(0);
    expect(fs.readdirSync(sessDir("act-sess"))).toEqual(["heartbeat"]);
    expect(fs.readFileSync(heartbeatPath("act-sess"), "utf8")).not.toContain(sentinel);
  });

  it("T5 one-writer rule: a pre-existing attention.json is byte-identical after on-activity runs", () => {
    fs.mkdirSync(sessDir("act-sess"), { recursive: true });
    const attn = path.join(sessDir("act-sess"), "attention.json");
    const original = JSON.stringify({ type: "permission_prompt", ts: new Date(Date.now() - 1000).toISOString() });
    fs.writeFileSync(attn, original, { mode: 0o600 });

    const res = runHook(
      onActivity,
      JSON.stringify({ session_id: "act-sess", hook_event_name: "PostToolUse", tool_name: "Bash" }),
      tmp,
    );
    expect(res.status).toBe(0);
    expect(fs.readFileSync(attn, "utf8")).toBe(original);
  });

  it("T6 unsafe ids: traversal/empty/oversized/non-string/missing ids exit 0, empty stdout, and create nothing", () => {
    const payloads: string[] = [
      ...["../evil", "..", ".", "a/b", "", "x".repeat(129), 42].map((id) =>
        JSON.stringify({ session_id: id, hook_event_name: "PostToolUse", tool_name: "Bash" }),
      ),
      JSON.stringify({ hook_event_name: "Stop" }),
    ];
    for (const p of payloads) {
      const res = runHook(onActivity, p, tmp);
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("");
    }
    expect(fs.existsSync(path.join(tmp, "sessions"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "evil"))).toBe(false);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("T7 passivity: malformed stdin AND an unwritable 0o500 store dir both exit 0 with empty stdout", () => {
    const malformed = runHook(onActivity, "not json{", tmp);
    expect(malformed.status).toBe(0);
    expect(malformed.stdout).toBe("");

    const readOnly = path.join(tmp, "readonly");
    fs.mkdirSync(readOnly, { recursive: true });
    fs.chmodSync(readOnly, 0o500);
    const payload = JSON.stringify({ session_id: "act-sess", hook_event_name: "Stop" });
    const unwritable = runHook(onActivity, payload, readOnly);
    expect(unwritable.status).toBe(0);
    expect(unwritable.stdout).toBe("");
    fs.chmodSync(readOnly, 0o700);
  });

  it("T8 end-to-end: a permission_prompt Notification sets attention, then an on-activity PostToolUse clears it", () => {
    const prior = process.env.CSM_STORE_DIR;
    process.env.CSM_STORE_DIR = tmp;
    try {
      const id = "e2e-sess";
      fs.mkdirSync(sessDir(id), { recursive: true });
      fs.writeFileSync(
        path.join(sessDir(id), "session.json"),
        JSON.stringify({
          schema_version: 1,
          session_id: id,
          folder: id,
          branch: "main",
          model: "unknown",
          start_time: new Date(Date.now() - 10_000).toISOString(),
        }),
        { mode: 0o600 },
      );

      const notif = runHook(
        onNotification,
        JSON.stringify({ session_id: id, hook_event_name: "Notification", notification_type: "permission_prompt" }),
        tmp,
      );
      expect(notif.status).toBe(0);
      expect(readAll(Date.now()).find((r) => r.session_id === id)!.attention).toBe(true);

      const act = runHook(
        onActivity,
        JSON.stringify({
          session_id: id,
          hook_event_name: "PostToolUse",
          tool_name: "AskUserQuestion",
          tool_input: {},
          tool_response: {},
        }),
        tmp,
      );
      expect(act.status).toBe(0);
      expect(readAll(Date.now()).find((r) => r.session_id === id)!.attention).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.CSM_STORE_DIR;
      else process.env.CSM_STORE_DIR = prior;
    }
  });
});
