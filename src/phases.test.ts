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
    if (spawnState.reject) {
      const err = new Error(`${cmd} failed`) as Error & { code: string };
      err.code = "ENOENT"; // spawn failure / timeout / non-zero surrogate
      cb(err);
      return;
    }
    cb(null, { stdout: spawnState.stdout, stderr: "" });
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

  it("invokes execFile with cmd node and an args ARRAY (no shell) + bounded opts", async () => {
    spawnState.stdout = VALID;
    await scanProgress("/root", "/tools/gsd-tools.cjs");
    expect(spawnState.calls).toHaveLength(1);
    const call = spawnState.calls[0];
    expect(call.cmd).toBe("node");
    expect(call.args).toEqual(["/tools/gsd-tools.cjs", "query", "progress", "--cwd", "/root"]);
    const opts = call.opts as { timeout?: number; maxBuffer?: number };
    expect(Number.isFinite(opts.timeout)).toBe(true);
    expect(Number.isFinite(opts.maxBuffer)).toBe(true);
  });

  it("resolves null (never throws) when execFile rejects", async () => {
    spawnState.reject = true;
    const p = await scanProgress("/root", "/tools/gsd-tools.cjs");
    expect(p).toBeNull();
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
