import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// RED: the hook scripts do not exist yet. They land in wave 01-03:
//   scripts/on-tool.mjs         (PostToolUse file-touch capture, CAP-01)
//   scripts/on-session-start.mjs (SessionStart identity capture, CAP-02)
// Tests spawn each script with fixture stdin and assert exit code / output.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const onTool = path.join(repoRoot, "scripts", "on-tool.mjs");
const onSessionStart = path.join(repoRoot, "scripts", "on-session-start.mjs");
const onUserPrompt = path.join(repoRoot, "scripts", "on-user-prompt.mjs");

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
