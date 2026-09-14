import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// RED (260914-507 Task 1): the writer script does not exist yet. It lands in
// GREEN as scripts/csm-branch.mjs (TB-01 declare-target-branch writer, atomic
// temp+rename to a dedicated target-branch.txt sidecar shard, D-BR-01). The
// command runs it as `node csm-branch.mjs "<session_id>" "<branch name>"` (argv,
// not stdin) — mirror src/csm-intent.test.ts's spawnSync harness exactly.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const csmBranch = path.join(repoRoot, "scripts", "csm-branch.mjs");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-branch-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runBranch(sessionId: string, text: string, storeDir: string) {
  return spawnSync(process.execPath, [csmBranch, sessionId, text], {
    env: { ...process.env, CSM_STORE_DIR: storeDir },
    encoding: "utf8",
  });
}

function targetBranchPath(storeDir: string, id: string): string {
  return path.join(storeDir, "sessions", id, "target-branch.txt");
}

describe("csm-branch writer (TB-01, D-BR-01/D-01)", () => {
  it("write: writes sessions/<id>/target-branch.txt whose JSON has target_branch and a parseable ts", () => {
    const res = runBranch("branch-sess", "feature-x", tmp);
    expect(res.status).toBe(0);

    const snap = JSON.parse(fs.readFileSync(targetBranchPath(tmp, "branch-sess"), "utf8"));
    expect(typeof snap.target_branch).toBe("string");
    expect(snap.target_branch.length).toBeGreaterThan(0);
    expect(snap.target_branch).toBe("feature-x");
    expect(typeof snap.ts).toBe("string");
    expect(Number.isFinite(Date.parse(snap.ts))).toBe(true);
  });

  it("single-writer invariant: the writer NEVER creates or touches session.json (D-01)", () => {
    const res = runBranch("branch-sess", "feature-x", tmp);
    expect(res.status).toBe(0);

    expect(fs.existsSync(targetBranchPath(tmp, "branch-sess"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "sessions", "branch-sess", "session.json"))).toBe(false);
  });

  it("length cap: an over-cap name (~500 chars) is stored truncated to <= 120 chars (D-BR-03)", () => {
    const big = "a".repeat(500);
    const res = runBranch("branch-sess", big, tmp);
    expect(res.status).toBe(0);

    const snap = JSON.parse(fs.readFileSync(targetBranchPath(tmp, "branch-sess"), "utf8"));
    expect(snap.target_branch.length).toBeLessThanOrEqual(120);
  });

  it("untrusted text: embedded ESC/newline/tab/control bytes are stripped and single-lined", () => {
    // ESC (0x1B), newline, tab embedded in the branch text — built by char code so
    // no literal control byte lives in this source file.
    const ESC = String.fromCharCode(0x1b);
    const dirty = "feat\n" + ESC + "[31mure\tx-end";
    const res = runBranch("branch-sess", dirty, tmp);
    expect(res.status).toBe(0);

    const snap = JSON.parse(fs.readFileSync(targetBranchPath(tmp, "branch-sess"), "utf8"));
    const hasControl = [...snap.target_branch].some((ch) => {
      const c = (ch as string).charCodeAt(0);
      return c <= 0x1f || (c >= 0x80 && c <= 0x9f);
    });
    expect(hasControl).toBe(false);
    expect(snap.target_branch.includes("\n")).toBe(false);
    expect(snap.target_branch).toContain("feat");
    expect(snap.target_branch).toContain("ure");
    expect(snap.target_branch).toContain("end");
  });

  it("bad id: an out-of-allowlist session id writes NO file and still exits 0", () => {
    for (const badId of ["../evil", ""]) {
      const res = runBranch(badId, "feature-x", tmp);
      expect(res.status).toBe(0);
    }
    const sessions = path.join(tmp, "sessions");
    const leaked = fs.existsSync(sessions) ? fs.readdirSync(sessions) : [];
    expect(leaked).toHaveLength(0);
    expect(fs.existsSync(path.join(tmp, "evil"))).toBe(false);
  });
});
