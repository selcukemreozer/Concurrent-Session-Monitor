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
// 260926-vfm (AQ-01): PreToolUse(AskUserQuestion) hook writing the asking.json {ts} shard.
const onAsk = path.join(repoRoot, "scripts", "on-ask.mjs");

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

  it("T4 heartbeat + resumed only, detail-free: a main-thread Bash PostToolUse leaves ONLY heartbeat + resumed and never persists tool_input (260927-1zw)", () => {
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
    expect(fs.readdirSync(sessDir("act-sess")).sort()).toEqual(["heartbeat", "resumed"]);
    expect(fs.readFileSync(heartbeatPath("act-sess"), "utf8")).not.toContain(sentinel);
    expect(fs.readFileSync(path.join(sessDir("act-sess"), "resumed"), "utf8")).not.toContain(sentinel);
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

// --- Quick task 260927-1zw: resume signals written by the hooks.
// The heartbeat stays the liveness signal for every agent. Two new sidecars
// split out the clear signals: `resumed` (main-thread only, clears waiting,
// CR-01) and `ask-resolved` (answer-specific, clears asking, WR-02). All
// needs-you snapshots and sidecars are written via temp + rename (WR-05).
describe("resume signals: hook writers (260927-1zw CR-01/WR-02/WR-05)", () => {
  const sessDir = (id: string) => path.join(tmp, "sessions", id);
  const ls = (id: string) => fs.readdirSync(sessDir(id)).sort();
  const parses = (id: string, name: string) =>
    Number.isFinite(Date.parse(fs.readFileSync(path.join(sessDir(id), name), "utf8").trim()));
  const modeOf = (id: string, name: string) => fs.statSync(path.join(sessDir(id), name)).mode & 0o777;

  it("R1 subagent PostToolUse (agent_id) writes ONLY the heartbeat", () => {
    const res = runHook(
      onActivity,
      JSON.stringify({
        session_id: "rs-sess",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        agent_id: "agent-abc",
        agent_type: "general-purpose",
        tool_input: { command: "echo SENTINEL_1zw" },
      }),
      tmp,
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
    expect(ls("rs-sess")).toEqual(["heartbeat"]);
    expect(parses("rs-sess", "heartbeat")).toBe(true);
  });

  it("R2 main-thread sibling PostToolUse (Read) writes heartbeat + resumed (0o600)", () => {
    const res = runHook(
      onActivity,
      JSON.stringify({ session_id: "rs-sess", hook_event_name: "PostToolUse", tool_name: "Read" }),
      tmp,
    );
    expect(res.status).toBe(0);
    expect(ls("rs-sess")).toEqual(["heartbeat", "resumed"]);
    expect(parses("rs-sess", "resumed")).toBe(true);
    expect(modeOf("rs-sess", "resumed")).toBe(0o600);
  });

  it("R3 main-thread AskUserQuestion PostToolUse writes ask-resolved + heartbeat + resumed", () => {
    const res = runHook(
      onActivity,
      JSON.stringify({ session_id: "rs-sess", hook_event_name: "PostToolUse", tool_name: "AskUserQuestion" }),
      tmp,
    );
    expect(res.status).toBe(0);
    expect(ls("rs-sess")).toEqual(["ask-resolved", "heartbeat", "resumed"]);
    for (const f of ["ask-resolved", "heartbeat", "resumed"]) expect(parses("rs-sess", f)).toBe(true);
  });

  it("R4 main-thread Stop writes all three sidecars, exit 0, empty stdout/stderr (Stop-safety)", () => {
    const res = runHook(
      onActivity,
      JSON.stringify({ session_id: "rs-sess", hook_event_name: "Stop", stop_hook_active: false }),
      tmp,
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
    expect(ls("rs-sess")).toEqual(["ask-resolved", "heartbeat", "resumed"]);
  });

  it("R5 subagent AskUserQuestion PostToolUse writes ONLY the heartbeat (D-02 main-thread wording)", () => {
    const res = runHook(
      onActivity,
      JSON.stringify({
        session_id: "rs-sess",
        hook_event_name: "PostToolUse",
        tool_name: "AskUserQuestion",
        agent_id: "agent-abc",
      }),
      tmp,
    );
    expect(res.status).toBe(0);
    expect(ls("rs-sess")).toEqual(["heartbeat"]);
  });

  it("R6 discriminator (DISC-2): agent_type alone or an empty agent_id still counts as main-thread", () => {
    const a = runHook(
      onActivity,
      JSON.stringify({ session_id: "rs-type", hook_event_name: "PostToolUse", tool_name: "Bash", agent_type: "reviewer" }),
      tmp,
    );
    expect(a.status).toBe(0);
    expect(ls("rs-type")).toContain("resumed");

    const b = runHook(
      onActivity,
      JSON.stringify({ session_id: "rs-empty", hook_event_name: "PostToolUse", tool_name: "Bash", agent_id: "" }),
      tmp,
    );
    expect(b.status).toBe(0);
    expect(ls("rs-empty")).toContain("resumed");
  });

  it("R7 agent-spawn exclusion (DISC-3): main-thread Task / Agent completions write ONLY the heartbeat", () => {
    for (const tool of ["Task", "Agent"]) {
      const id = `rs-${tool.toLowerCase()}`;
      const res = runHook(
        onActivity,
        JSON.stringify({ session_id: id, hook_event_name: "PostToolUse", tool_name: tool }),
        tmp,
      );
      expect(res.status).toBe(0);
      expect(ls(id)).toEqual(["heartbeat"]);
    }
  });

  it("R8 on-user-prompt writes heartbeat + resumed + ask-resolved (all parse, all 0o600)", () => {
    const res = runHook(
      onUserPrompt,
      JSON.stringify({ session_id: "rs-sess", hook_event_name: "UserPromptSubmit" }),
      tmp,
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(ls("rs-sess")).toEqual(["ask-resolved", "heartbeat", "resumed"]);
    for (const f of ["ask-resolved", "heartbeat", "resumed"]) {
      expect(parses("rs-sess", f)).toBe(true);
      expect(modeOf("rs-sess", f)).toBe(0o600);
    }
  });

  it("R9 one-writer rule: attention.json and asking.json are byte-identical after the resume writers run", () => {
    fs.mkdirSync(sessDir("rs-sess"), { recursive: true });
    const attn = path.join(sessDir("rs-sess"), "attention.json");
    const ask = path.join(sessDir("rs-sess"), "asking.json");
    const attnBody = JSON.stringify({ type: "permission_prompt", ts: new Date(Date.now() - 1000).toISOString() });
    const askBody = JSON.stringify({ ts: new Date(Date.now() - 1000).toISOString() });
    fs.writeFileSync(attn, attnBody, { mode: 0o600 });
    fs.writeFileSync(ask, askBody, { mode: 0o600 });

    expect(runHook(onActivity, JSON.stringify({ session_id: "rs-sess", hook_event_name: "Stop" }), tmp).status).toBe(0);
    expect(
      runHook(onUserPrompt, JSON.stringify({ session_id: "rs-sess", hook_event_name: "UserPromptSubmit" }), tmp).status,
    ).toBe(0);
    expect(
      runHook(
        onActivity,
        JSON.stringify({ session_id: "rs-sess", hook_event_name: "PostToolUse", tool_name: "Bash", agent_id: "a1" }),
        tmp,
      ).status,
    ).toBe(0);

    expect(fs.readFileSync(attn, "utf8")).toBe(attnBody);
    expect(fs.readFileSync(ask, "utf8")).toBe(askBody);
  });

  it("R10 atomic writes (WR-05): no temp leftovers, snapshots parse, every writer uses renameSync", () => {
    const id = "rs-atomic";
    for (let i = 0; i < 3; i++) {
      const r = runHook(
        onNotification,
        JSON.stringify({ session_id: id, hook_event_name: "Notification", notification_type: "permission_prompt" }),
        tmp,
      );
      expect(r.status).toBe(0);
    }
    expect(
      runHook(
        onAsk,
        JSON.stringify({ session_id: id, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: {} }),
        tmp,
      ).status,
    ).toBe(0);
    expect(
      runHook(
        onActivity,
        JSON.stringify({ session_id: id, hook_event_name: "PostToolUse", tool_name: "AskUserQuestion" }),
        tmp,
      ).status,
    ).toBe(0);
    expect(
      runHook(onUserPrompt, JSON.stringify({ session_id: id, hook_event_name: "UserPromptSubmit" }), tmp).status,
    ).toBe(0);

    for (const entry of ls(id)) {
      expect(entry.startsWith(".")).toBe(false);
      expect(entry.endsWith(".tmp")).toBe(false);
    }
    expect(() => JSON.parse(fs.readFileSync(path.join(sessDir(id), "attention.json"), "utf8"))).not.toThrow();
    expect(() => JSON.parse(fs.readFileSync(path.join(sessDir(id), "asking.json"), "utf8"))).not.toThrow();
    expect(modeOf(id, "attention.json")).toBe(0o600);

    for (const script of [onNotification, onAsk, onActivity, onUserPrompt]) {
      const code = fs
        .readFileSync(script, "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      expect(code, path.basename(script)).toContain("renameSync(");
    }
  });
});

// --- Quick task 260926-vfm: on-ask PreToolUse(AskUserQuestion) hook (AQ-01).
// Notification cannot distinguish AskUserQuestion, so a PreToolUse tap records
// that a question was opened as a SEPARATE asking.json {ts} shard. It must be
// detail-free, never write the heartbeat (Pitfall 1 mirrored) or attention.json
// (one-writer-per-file), and always exit 0 with empty output (PreToolUse-safe).
describe("asking capture — AskUserQuestion (AQ-01)", () => {
  const sessDir = (id: string) => path.join(tmp, "sessions", id);
  const askingPath = (id: string) => path.join(sessDir(id), "asking.json");
  const askPayload = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: "ask-sess",
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{ question: "SENTINEL_QUESTION_vfm", options: [{ label: "SENTINEL_OPTION_vfm" }] }],
      },
      transcript_path: "/x/t.jsonl",
      ...extra,
    });

  it("H1 wiring: hooks.json wires on-ask under PreToolUse 'AskUserQuestion' (async, timeout 5); on-pre-tool stays synchronous", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, "hooks", "hooks.json"), "utf8"));
    const h = cfg.hooks;

    const ask = h.PreToolUse.find((e: { matcher?: string }) => e.matcher === "AskUserQuestion");
    expect(ask).toBeDefined();
    expect(ask.hooks).toHaveLength(1);
    expect(ask.hooks[0].type).toBe("command");
    expect(ask.hooks[0].command).toContain("scripts/on-ask.mjs");
    expect(ask.hooks[0].async).toBe(true);
    expect(ask.hooks[0].timeout).toBe(5);

    const pre = h.PreToolUse.find((e: { matcher?: string }) => e.matcher === "Edit|Write|MultiEdit");
    expect(pre).toBeDefined();
    expect(pre.hooks[0].command).toContain("scripts/on-pre-tool.mjs");
    expect("async" in pre.hooks[0]).toBe(false);

    for (const k of ["Notification", "PostToolUse", "Stop"]) {
      expect(JSON.stringify(h[k])).not.toContain("on-ask");
    }
    expect(fs.existsSync(onAsk)).toBe(true);
  });

  it("H2 write + detail-free: writes asking.json with exactly {ts}, mode 0o600, no question/option text, silent exit 0", () => {
    const res = runHook(onAsk, askPayload(), tmp);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");

    const raw = fs.readFileSync(askingPath("ask-sess"), "utf8");
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed)).toEqual(["ts"]);
    expect(Number.isFinite(Date.parse(parsed.ts))).toBe(true);
    expect(raw).not.toContain("SENTINEL_QUESTION_vfm");
    expect(raw).not.toContain("SENTINEL_OPTION_vfm");
    expect(fs.statSync(askingPath("ask-sess")).mode & 0o777).toBe(0o600);
  });

  it("H3 no heartbeat / no foreign shards: the session dir holds ONLY asking.json", () => {
    const res = runHook(onAsk, askPayload(), tmp);
    expect(res.status).toBe(0);
    expect(fs.readdirSync(sessDir("ask-sess"))).toEqual(["asking.json"]);
  });

  it("H4 one-writer rule: pre-existing heartbeat and attention.json are byte-identical after on-ask runs", () => {
    fs.mkdirSync(sessDir("ask-sess"), { recursive: true });
    const hb = path.join(sessDir("ask-sess"), "heartbeat");
    const attn = path.join(sessDir("ask-sess"), "attention.json");
    const hbOriginal = new Date(Date.now() - 5000).toISOString();
    const attnOriginal = JSON.stringify({ type: "permission_prompt", ts: new Date(Date.now() - 1000).toISOString() });
    fs.writeFileSync(hb, hbOriginal, { mode: 0o600 });
    fs.writeFileSync(attn, attnOriginal, { mode: 0o600 });

    const res = runHook(onAsk, askPayload(), tmp);
    expect(res.status).toBe(0);
    expect(fs.readFileSync(hb, "utf8")).toBe(hbOriginal);
    expect(fs.readFileSync(attn, "utf8")).toBe(attnOriginal);
    expect(fs.existsSync(askingPath("ask-sess"))).toBe(true);
  });

  it("H5 tool_name guard: a non-AskUserQuestion tool_name writes nothing", () => {
    const res = runHook(onAsk, askPayload({ tool_name: "Bash" }), tmp);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(fs.existsSync(askingPath("ask-sess"))).toBe(false);
  });

  it("H6 unsafe ids: traversal/empty/oversized/non-string/missing ids exit 0, empty stdout, and create nothing", () => {
    const payloads: string[] = [
      ...["../evil", "..", ".", "a/b", "", "x".repeat(129), 42].map((id) => askPayload({ session_id: id })),
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }),
    ];
    for (const p of payloads) {
      const res = runHook(onAsk, p, tmp);
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("");
    }
    expect(fs.existsSync(path.join(tmp, "sessions"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "evil"))).toBe(false);
    const walk = (d: string): string[] =>
      fs.existsSync(d)
        ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
            const full = path.join(d, e.name);
            return e.isDirectory() ? [full, ...walk(full)] : [full];
          })
        : [];
    expect(walk(tmp).some((p) => p.includes("evil"))).toBe(false);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("H7 passivity: malformed stdin AND an unwritable 0o500 store dir both exit 0 with empty stdout", () => {
    const malformed = runHook(onAsk, "not json{", tmp);
    expect(malformed.status).toBe(0);
    expect(malformed.stdout).toBe("");
    expect(fs.existsSync(askingPath("ask-sess"))).toBe(false);

    const readOnly = path.join(tmp, "readonly");
    fs.mkdirSync(readOnly, { recursive: true });
    fs.chmodSync(readOnly, 0o500);
    const unwritable = runHook(onAsk, askPayload(), readOnly);
    expect(unwritable.status).toBe(0);
    expect(unwritable.stdout).toBe("");
    fs.chmodSync(readOnly, 0o700);
  });

  it("E1 end-to-end: on-ask → asking; a Notification while open → still asking (asking wins); answer via on-activity → cleared", () => {
    const prior = process.env.CSM_STORE_DIR;
    process.env.CSM_STORE_DIR = tmp;
    type AskFields = { asking?: boolean; attention?: boolean };
    const rowOf = (id: string) =>
      readAll(Date.now()).find((r) => r.session_id === id) as unknown as AskFields;
    try {
      const id = "ask-e2e";
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

      const ask = runHook(onAsk, askPayload({ session_id: id }), tmp);
      expect(ask.status).toBe(0);
      expect(rowOf(id).asking).toBe(true);
      expect(rowOf(id).attention).toBe(false);

      const notif = runHook(
        onNotification,
        JSON.stringify({ session_id: id, hook_event_name: "Notification", notification_type: "permission_prompt" }),
        tmp,
      );
      expect(notif.status).toBe(0);
      expect(rowOf(id).asking).toBe(true);
      expect(rowOf(id).attention).toBe(false);

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
      expect(rowOf(id).asking).toBe(false);
      expect(rowOf(id).attention).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.CSM_STORE_DIR;
      else process.env.CSM_STORE_DIR = prior;
    }
  });
});
