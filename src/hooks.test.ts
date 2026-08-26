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
});
