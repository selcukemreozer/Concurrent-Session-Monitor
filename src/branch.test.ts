import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// RED: src/branch.ts (the reader-side live-branch derivation module) lands in the
// GREEN step of Task 1. scanBranches runs REAL git against a real temp repo (per
// the plan constraint — NOT a mocked execFile), so the derivation is exercised
// end-to-end; liveBranch + branchScanMs are pure and unit-tested directly.
import { scanBranches, liveBranch, branchScanMs } from "./branch.js";
import type { SessionRow } from "./aggregate.js";

/** Cast a minimal partial into a SessionRow — the branch module reads only cwd + branch. */
function row(partial: Partial<SessionRow>): SessionRow {
  return partial as unknown as SessionRow;
}

/** True when a usable `git` is on PATH (the macOS target ships one). */
function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

const HAVE_GIT = gitAvailable();

let repoDir: string; // a real git repo checked out on feature-x
let plainDir: string; // a plain temp dir with no .git

beforeAll(() => {
  if (!HAVE_GIT) return;
  repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "csm-branch-repo-")));
  const run = (args: string[]) =>
    execFileSync("git", ["-C", repoDir, ...args], { stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: ["ignore", "ignore", "ignore"] });
  run(["config", "user.email", "csm@example.com"]);
  run(["config", "user.name", "CSM Test"]);
  run(["commit", "--allow-empty", "-m", "init"]);
  run(["checkout", "-b", "feature-x"]);

  plainDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "csm-branch-plain-")));
});

afterAll(() => {
  if (!HAVE_GIT) return;
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(plainDir, { recursive: true, force: true });
});

describe.runIf(HAVE_GIT)("scanBranches (real temp git repo, dedupe, non-fatal)", () => {
  it("derives the current branch of a real repo cwd (feature-x)", async () => {
    const m = await scanBranches([row({ cwd: repoDir, branch: "main" })]);
    expect(m.get(repoDir)).toBe("feature-x");
  });

  it("dedupe: two rows sharing the SAME cwd yield a single map entry", async () => {
    const m = await scanBranches([
      row({ cwd: repoDir, branch: "main" }),
      row({ cwd: repoDir, branch: "main" }),
    ]);
    expect(m.size).toBe(1);
    expect(m.get(repoDir)).toBe("feature-x");
  });

  it("non-repo: a plain temp dir cwd is OMITTED from the map (never throws)", async () => {
    const m = await scanBranches([row({ cwd: plainDir, branch: "main" })]);
    expect(m.has(plainDir)).toBe(false);
  });

  it("no cwd: a row with no string cwd contributes no entry and does not throw", async () => {
    const m = await scanBranches([row({ branch: "main" })]);
    expect(m.size).toBe(0);
  });
});

describe("liveBranch (pure fallback rule, D-LB-02)", () => {
  it("returns the live map value when it is a non-empty string (live wins)", () => {
    const branches = new Map([["/repo", "feature-x"]]);
    expect(liveBranch(row({ cwd: "/repo", branch: "main" }), branches)).toBe("feature-x");
  });

  it("falls back to the snapshot when the map has no entry for the cwd", () => {
    const branches = new Map<string, string>();
    expect(liveBranch(row({ cwd: "/repo", branch: "main" }), branches)).toBe("main");
  });

  it("falls back to the snapshot when the map value is an empty string", () => {
    const branches = new Map([["/repo", ""]]);
    expect(liveBranch(row({ cwd: "/repo", branch: "main" }), branches)).toBe("main");
  });

  it("falls back to the snapshot when the row has no cwd", () => {
    const branches = new Map([["/repo", "feature-x"]]);
    expect(liveBranch(row({ branch: "main" }), branches)).toBe("main");
  });
});

describe("branchScanMs cadence accessor (D-LB-01)", () => {
  afterEach(() => {
    delete process.env.CSM_BRANCH_SCAN_MS;
  });

  it("defaults to 1500", () => {
    expect(branchScanMs()).toBe(1500);
  });

  it("honors CSM_BRANCH_SCAN_MS", () => {
    process.env.CSM_BRANCH_SCAN_MS = "800";
    expect(branchScanMs()).toBe(800);
  });
});
