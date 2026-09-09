import { afterEach, describe, expect, it, vi } from "vitest";

// RED: src/phases.ts (scanner + pure helpers) lands in Task 2 of plan 04.2-01.
import {
  parseProgress,
  scanProgress,
  resolveGsdTools,
  buildFocusSet,
  resolvePlanningRoots,
  clampOffset,
  cycleIndex,
  phaseScanMs,
  FAZLAR_VISIBLE_ROWS,
  normalizePhaseNumber,
  phaseIsComplete,
  mergeRoadmapPhases,
  type Progress,
} from "./phases.js";
import type { SessionRow } from "./aggregate.js";

/**
 * Mutable, hoisted spawn state so `vi.mock` can drive the (mocked) child_process
 * `execFile`. No real `node gsd-tools.cjs` process is ever spawned by this suite.
 */
const spawnState = vi.hoisted(() => ({
  stdout: "",
  reject: false,
  // Per-query overrides keyed by the query name (args[2]) so a single scanProgress
  // can drive its TWO spawns (progress + roadmap.analyze) independently. Unset ⇒
  // fall back to the shared stdout/reject, preserving the single-call tests.
  byQuery: {} as Record<string, { stdout?: string; reject?: boolean }>,
  calls: [] as { cmd: string; args: string[]; opts: unknown }[],
}));

vi.mock("node:child_process", () => ({
  // promisify wraps this callback-style fn: execFile(cmd, args, opts, cb).
  execFile: (
    cmd: string,
    args: string[],
    opts: unknown,
    cb: (err: unknown, res?: { stdout: string; stderr: string }) => void,
  ) => {
    spawnState.calls.push({ cmd, args, opts });
    // args === [gsdTools, "query", <queryName>, "--cwd", root]
    const query = args[2];
    const override = spawnState.byQuery[query];
    const reject = override?.reject ?? spawnState.reject;
    const stdout = override?.stdout ?? spawnState.stdout;
    if (reject) {
      const err = new Error(`${cmd} failed`) as Error & { code: string };
      err.code = "ENOENT"; // spawn failure / timeout / non-zero surrogate
      cb(err);
      return;
    }
    cb(null, { stdout, stderr: "" });
  },
}));

/**
 * Hoisted fs state. `existsSync` consults `existsSet`; every existsSync/statSync
 * call is recorded so the buildFocusSet render-path can assert ZERO fs calls.
 */
const fsState = vi.hoisted(() => ({
  existsSet: new Set<string>(),
  existsCalls: [] as string[],
  statCalls: [] as string[],
}));

vi.mock("node:fs", () => ({
  existsSync: (p: string) => {
    fsState.existsCalls.push(String(p));
    return fsState.existsSet.has(String(p));
  },
  statSync: (p: string) => {
    fsState.statCalls.push(String(p));
    return {};
  },
}));

/** Hoisted fs/promises state: `access` resolves for paths in `accessOk`, else rejects. */
const fspState = vi.hoisted(() => ({
  accessOk: new Set<string>(),
}));

vi.mock("node:fs/promises", () => ({
  access: (p: string) =>
    fspState.accessOk.has(String(p)) ? Promise.resolve() : Promise.reject(new Error("ENOENT")),
}));

afterEach(() => {
  delete process.env.CSM_PHASE_SCAN_MS;
  delete process.env.CSM_GSD_TOOLS;
  delete process.env.RUNTIME_DIR;
  spawnState.stdout = "";
  spawnState.reject = false;
  spawnState.byQuery = {};
  spawnState.calls = [];
  fsState.existsSet = new Set();
  fsState.existsCalls = [];
  fsState.statCalls = [];
  fspState.accessOk = new Set();
});

/** Cast a minimal partial into a SessionRow — the helpers read only a few fields. */
function row(partial: Partial<SessionRow>): SessionRow {
  return {
    schema_version: 1,
    session_id: "s",
    folder: "f",
    branch: "main",
    model: "unknown",
    start_time: "2026-01-01T00:00:00Z",
    files: [],
    reads: [],
    alive: true,
    readyToPrune: false,
    dotState: "active",
    ...partial,
  } as unknown as SessionRow;
}

const VALID = JSON.stringify({
  milestone_version: "v1.0",
  milestone_name: "milestone",
  phases: [{ number: "04.1", name: "port", plans: 3, summaries: 3, status: "Complete" }],
  total_plans: 3,
  total_summaries: 3,
  percent: 100,
});

/**
 * `gsd-tools query progress` shape — the 8 ZERO-PADDED, directory-based phases the
 * dir scan returns (percent 100, all Complete). Phase 5 is intentionally absent
 * because it has no `.planning/phases/*` directory yet.
 */
const PROGRESS_PHASES = [
  { number: "01", name: "sharded-state", plans: 4, summaries: 4, status: "Complete" },
  { number: "02", name: "liveness", plans: 5, summaries: 5, status: "Complete" },
  { number: "03", name: "conflicts", plans: 2, summaries: 2, status: "Complete" },
  { number: "03.1", name: "read-write", plans: 3, summaries: 3, status: "Complete" },
  { number: "04", name: "agent-awareness", plans: 5, summaries: 5, status: "Complete" },
  { number: "04.1", name: "ports", plans: 3, summaries: 3, status: "Complete" },
  { number: "04.2", name: "phase-progress", plans: 3, summaries: 3, status: "Complete" },
  { number: "04.3", name: "skills", plans: 4, summaries: 4, status: "Complete" },
];
const PROGRESS_JSON = JSON.stringify({
  milestone_version: "v1.0",
  milestone_name: "milestone",
  percent: 100,
  phases: PROGRESS_PHASES,
});

/**
 * `gsd-tools query roadmap.analyze` shape — the MIXED-number roadmap phases. Every
 * number normalizes into the progress set EXCEPT "5" (Installable Plugin
 * Packaging), which has no directory and must append as a Pending row.
 */
const ROADMAP_JSON = JSON.stringify({
  phases: [
    { number: "1", name: "sharded-state", plan_count: 4, summary_count: 4, disk_status: "complete" },
    { number: "2", name: "liveness", plan_count: 5, summary_count: 5, disk_status: "complete" },
    { number: "3", name: "conflicts", plan_count: 2, summary_count: 2, disk_status: "complete" },
    { number: "03.1", name: "read-write", plan_count: 3, summary_count: 3, disk_status: "complete" },
    { number: "4", name: "agent-awareness", plan_count: 5, summary_count: 5, disk_status: "complete" },
    { number: "04.3", name: "skills", plan_count: 4, summary_count: 4, disk_status: "complete" },
    { number: "04.1", name: "ports", plan_count: 3, summary_count: 3, disk_status: "complete" },
    { number: "04.2", name: "phase-progress", plan_count: 3, summary_count: 3, disk_status: "complete" },
    {
      number: "5",
      name: "Installable Plugin Packaging",
      plan_count: 0,
      summary_count: 0,
      disk_status: "no_directory",
    },
  ],
});

/** Parse PROGRESS_JSON into a live Progress object for the pure-merge tests. */
function progressFixture(): Progress {
  return parseProgress(PROGRESS_JSON) as Progress;
}

describe("parseProgress", () => {
  it("returns a typed Progress for valid JSON with a phases array", () => {
    const p = parseProgress(VALID) as Progress;
    expect(p).not.toBeNull();
    expect(p.milestone_name).toBe("milestone");
    expect(p.milestone_version).toBe("v1.0");
    expect(p.percent).toBe(100);
    expect(Array.isArray(p.phases)).toBe(true);
    expect(p.phases[0].number).toBe("04.1");
  });

  it("returns null for a non-JSON string", () => {
    expect(parseProgress("not json {")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseProgress("")).toBeNull();
  });

  it("returns null for a JSON object with no phases array", () => {
    expect(parseProgress(JSON.stringify({ milestone_name: "x", percent: 5 }))).toBeNull();
  });
});

describe("scanProgress", () => {
  it("resolves the parsed Progress when execFile succeeds", async () => {
    spawnState.stdout = VALID;
    const p = await scanProgress("/root", "/tools/gsd-tools.cjs");
    expect(p).not.toBeNull();
    expect(p?.milestone_name).toBe("milestone");
  });

  it("invokes execFile TWICE (progress then roadmap.analyze) with args ARRAYs (no shell) + bounded opts", async () => {
    spawnState.stdout = VALID;
    await scanProgress("/root", "/tools/gsd-tools.cjs");
    expect(spawnState.calls).toHaveLength(2);

    const first = spawnState.calls[0];
    expect(first.cmd).toBe("node");
    expect(first.args).toEqual(["/tools/gsd-tools.cjs", "query", "progress", "--cwd", "/root"]);
    const firstOpts = first.opts as { timeout?: number; maxBuffer?: number };
    expect(Number.isFinite(firstOpts.timeout)).toBe(true);
    expect(Number.isFinite(firstOpts.maxBuffer)).toBe(true);

    const second = spawnState.calls[1];
    expect(second.cmd).toBe("node");
    expect(second.args).toEqual([
      "/tools/gsd-tools.cjs",
      "query",
      "roadmap.analyze",
      "--cwd",
      "/root",
    ]);
    const secondOpts = second.opts as { timeout?: number; maxBuffer?: number };
    expect(Number.isFinite(secondOpts.timeout)).toBe(true);
    expect(Number.isFinite(secondOpts.maxBuffer)).toBe(true);
  });

  it("resolves null (never throws) when execFile rejects", async () => {
    spawnState.reject = true;
    const p = await scanProgress("/root", "/tools/gsd-tools.cjs");
    expect(p).toBeNull();
  });

  it("merges roadmap.analyze Pending phases when both spawns succeed", async () => {
    spawnState.byQuery = {
      progress: { stdout: PROGRESS_JSON },
      "roadmap.analyze": { stdout: ROADMAP_JSON },
    };
    const p = await scanProgress("/root", "/tools/gsd-tools.cjs");
    expect(p).not.toBeNull();
    expect(p?.phases).toHaveLength(9);
    const last = p?.phases[8];
    expect(last?.number).toBe("5");
    expect(last?.status).toBe("Pending");
    expect(p?.percent).toBe(89);
  });

  it("returns the dir-based progress UNCHANGED (never throws) when roadmap.analyze rejects", async () => {
    spawnState.byQuery = {
      progress: { stdout: PROGRESS_JSON },
      "roadmap.analyze": { reject: true },
    };
    const p = await scanProgress("/root", "/tools/gsd-tools.cjs");
    expect(p).not.toBeNull();
    expect(p?.phases).toHaveLength(8); // dir-based table preserved
    expect(p?.percent).toBe(100); // original percent, not recomputed
  });

  it("resolves null when the progress stdout is non-JSON (unchanged early-return)", async () => {
    spawnState.byQuery = {
      progress: { stdout: "not json {" },
      "roadmap.analyze": { stdout: ROADMAP_JSON },
    };
    const p = await scanProgress("/root", "/tools/gsd-tools.cjs");
    expect(p).toBeNull();
  });
});

describe("normalizePhaseNumber", () => {
  it("strips leading zeros per dot-segment", () => {
    expect(normalizePhaseNumber("01")).toBe("1");
    expect(normalizePhaseNumber("04.1")).toBe("4.1");
    expect(normalizePhaseNumber("03.1")).toBe("3.1");
    expect(normalizePhaseNumber("04.2")).toBe("4.2");
    expect(normalizePhaseNumber("5")).toBe("5");
  });

  it("is idempotent on already-normalized numbers", () => {
    expect(normalizePhaseNumber("1")).toBe("1");
    expect(normalizePhaseNumber("4.1")).toBe("4.1");
  });
});

describe("phaseIsComplete", () => {
  it("is true when status is exactly Complete", () => {
    expect(phaseIsComplete({ status: "Complete", plans: 0, summaries: 0 })).toBe(true);
  });
  it("is true when plans > 0 and summaries >= plans regardless of status text", () => {
    expect(phaseIsComplete({ status: "anything", plans: 3, summaries: 3 })).toBe(true);
  });
  it("is false for an empty Pending phase", () => {
    expect(phaseIsComplete({ status: "Pending", plans: 0, summaries: 0 })).toBe(false);
  });
  it("is false when summaries lag plans", () => {
    expect(phaseIsComplete({ status: "Needs Review", plans: 2, summaries: 1 })).toBe(false);
  });
});

describe("mergeRoadmapPhases (PURE — Progress + roadmap STRING, no spawn)", () => {
  it("appends exactly one Pending phase for the absent roadmap number, at the END", () => {
    const merged = mergeRoadmapPhases(progressFixture(), ROADMAP_JSON);
    expect(merged.phases).toHaveLength(9);
    expect(merged.phases[8]).toEqual({
      number: "5",
      name: "Installable Plugin Packaging",
      plans: 0,
      summaries: 0,
      status: "Pending",
    });
  });

  it("keeps the original 8 phases byte-for-byte in the SAME order, no duplicates", () => {
    const original = progressFixture();
    const merged = mergeRoadmapPhases(progressFixture(), ROADMAP_JSON);
    expect(merged.phases.slice(0, 8)).toEqual(original.phases);
    const numbers = merged.phases.map((p) => p.number);
    expect(new Set(numbers).size).toBe(numbers.length); // no dup despite zero-pad vs mixed
  });

  it("recomputes percent to 89 (round(8/9*100)) when a pending phase is appended", () => {
    const merged = mergeRoadmapPhases(progressFixture(), ROADMAP_JSON);
    expect(merged.percent).toBe(89);
  });

  it("returns the progress UNCHANGED when the roadmap string is non-JSON garbage", () => {
    const original = progressFixture();
    const merged = mergeRoadmapPhases(progressFixture(), "not json {");
    expect(merged.phases).toEqual(original.phases);
    expect(merged.percent).toBe(original.percent);
  });

  it("returns UNCHANGED when the parsed roadmap object has no phases array", () => {
    const original = progressFixture();
    const merged = mergeRoadmapPhases(progressFixture(), JSON.stringify({ note: "no phases" }));
    expect(merged.phases).toEqual(original.phases);
    expect(merged.percent).toBe(original.percent);
  });

  it("returns UNCHANGED with ORIGINAL percent when every roadmap number is already present", () => {
    const original = progressFixture();
    const roadmapAllPresent = JSON.stringify({
      phases: [
        { number: "1", name: "sharded-state", plan_count: 4, summary_count: 4 },
        { number: "04.1", name: "ports", plan_count: 3, summary_count: 3 },
      ],
    });
    const merged = mergeRoadmapPhases(progressFixture(), roadmapAllPresent);
    expect(merged.phases).toEqual(original.phases);
    expect(merged.percent).toBe(original.percent); // NOT recomputed
  });
});

describe("resolveGsdTools", () => {
  it("returns CSM_GSD_TOOLS when it points at an existing file", () => {
    process.env.CSM_GSD_TOOLS = "/custom/tools.cjs";
    fsState.existsSet.add("/custom/tools.cjs");
    expect(resolveGsdTools("/proj")).toBe("/custom/tools.cjs");
  });

  it("prefers the RUNTIME_DIR candidate over cwd and home", () => {
    process.env.RUNTIME_DIR = "/rt";
    const rt = "/rt/gsd-core/bin/gsd-tools.cjs";
    const cwd = "/proj/.claude/gsd-core/bin/gsd-tools.cjs";
    fsState.existsSet.add(rt);
    fsState.existsSet.add(cwd);
    expect(resolveGsdTools("/proj")).toBe(rt);
  });

  it("falls back to the cwd/.claude candidate when RUNTIME_DIR is unset", () => {
    const cwd = "/proj/.claude/gsd-core/bin/gsd-tools.cjs";
    fsState.existsSet.add(cwd);
    expect(resolveGsdTools("/proj")).toBe(cwd);
  });

  it("returns null when no candidate exists and no PATH hit", () => {
    expect(resolveGsdTools("/proj")).toBeNull();
  });
});

describe("buildFocusSet (PURE — no fs)", () => {
  it("dedups by root, keeps live-only roots present in planningRoots, drops no-cwd", () => {
    const rows = [
      row({ cwd: "/a", folder: "a", alive: true }),
      row({ cwd: "/a", folder: "a", alive: true }), // duplicate
      row({ folder: "nocwd", alive: true }), // no cwd → dropped
      row({ cwd: "/b", folder: "b", alive: false }), // dead → dropped
    ];
    const out = buildFocusSet(rows, new Set(["/a"]));
    expect(out).toEqual([{ root: "/a", name: "a" }]);
  });

  it("preserves readAll order (most-recently-active first)", () => {
    const rows = [
      row({ cwd: "/x", folder: "x", alive: true }),
      row({ cwd: "/y", folder: "y", alive: true }),
    ];
    const out = buildFocusSet(rows, new Set(["/x", "/y"]));
    expect(out).toEqual([
      { root: "/x", name: "x" },
      { root: "/y", name: "y" },
    ]);
  });

  it("performs NO synchronous fs call on the render path", () => {
    fsState.existsCalls = [];
    fsState.statCalls = [];
    const rows = [row({ cwd: "/a", folder: "a", alive: true })];
    buildFocusSet(rows, new Set(["/a"]));
    expect(fsState.existsCalls).toHaveLength(0);
    expect(fsState.statCalls).toHaveLength(0);
  });
});

describe("resolvePlanningRoots (async .planning/ probe)", () => {
  it("resolves the deduped live-with-cwd roots that contain .planning/, non-fatal", async () => {
    fspState.accessOk.add("/a/.planning");
    const rows = [
      row({ cwd: "/a", folder: "a", alive: true }),
      row({ cwd: "/a", folder: "a", alive: true }), // duplicate
      row({ folder: "nocwd", alive: true }), // no cwd
      row({ cwd: "/b", folder: "b", alive: false }), // dead
    ];
    const set = await resolvePlanningRoots(rows);
    expect([...set]).toEqual(["/a"]);
  });

  it("omits a root whose access rejects and never throws", async () => {
    // accessOk empty → every access rejects
    const rows = [row({ cwd: "/a", folder: "a", alive: true })];
    const set = await resolvePlanningRoots(rows);
    expect(set.size).toBe(0);
  });
});

describe("clampOffset", () => {
  it("clamps below zero to 0", () => {
    expect(clampOffset(-1, 10, 5)).toBe(0);
  });
  it("clamps above (total - visible)", () => {
    expect(clampOffset(99, 10, 5)).toBe(5);
  });
  it("passes an in-range value through", () => {
    expect(clampOffset(3, 10, 5)).toBe(3);
  });
  it("returns 0 when total < visible", () => {
    expect(clampOffset(0, 3, 5)).toBe(0);
  });
});

describe("cycleIndex", () => {
  it("advances forward", () => {
    expect(cycleIndex(0, 3, 1)).toBe(1);
  });
  it("wraps forward past the end", () => {
    expect(cycleIndex(2, 3, 1)).toBe(0);
  });
  it("wraps backward past the start", () => {
    expect(cycleIndex(0, 3, -1)).toBe(2);
  });
  it("returns 0 for an empty set", () => {
    expect(cycleIndex(0, 0, 1)).toBe(0);
  });
});

describe("phaseScanMs", () => {
  it("defaults to 4000 when unset", () => {
    expect(phaseScanMs()).toBe(4000);
  });
  it("reads a valid CSM_PHASE_SCAN_MS", () => {
    process.env.CSM_PHASE_SCAN_MS = "1500";
    expect(phaseScanMs()).toBe(1500);
  });
  it("falls back to 4000 for a non-numeric value", () => {
    process.env.CSM_PHASE_SCAN_MS = "bad";
    expect(phaseScanMs()).toBe(4000);
  });
});

describe("FAZLAR_VISIBLE_ROWS", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(FAZLAR_VISIBLE_ROWS)).toBe(true);
    expect(FAZLAR_VISIBLE_ROWS).toBeGreaterThan(0);
  });
});
