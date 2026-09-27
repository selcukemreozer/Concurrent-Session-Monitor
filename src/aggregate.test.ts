import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// RED: aggregate.ts (readAll) + store.ts (writeSnapshot/appendTouch) land in wave 01-02.
import { sessionDir } from "./paths.js";
import { writeSnapshot, appendTouch } from "./store.js";
import { readAll } from "./aggregate.js";
import type { SessionState } from "./schema.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-agg-"));
  process.env.CSM_STORE_DIR = tmp;
});

afterEach(() => {
  delete process.env.CSM_STORE_DIR;
  delete process.env.CSM_WINDOW_MS;
  delete process.env.CSM_STALE_MS;
  delete process.env.CSM_ACTIVE_MS;
  delete process.env.CSM_READ_WINDOW_MS;
  delete process.env.CSM_SKILL_WINDOW_MS;
  delete process.env.CSM_ATTN_WINDOW_MS;
  delete process.env.CSM_RUN_WINDOW_MS;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Append one read event to a session's `reads.jsonl`, mirroring the writer's
 * O_APPEND shape (do NOT modify store.ts — the read shard is seeded here). Same
 * `{file_path, ts}` line shape as `appendTouch`.
 */
function appendRead(dir: string, evt: { file_path: string; ts: string; released?: boolean }): void {
  fs.appendFileSync(path.join(dir, "reads.jsonl"), JSON.stringify(evt) + "\n", { mode: 0o600 });
}

/**
 * Append one skill event to a session's `skill.jsonl`, mirroring the writer's
 * O_APPEND shape (scripts/on-skill.mjs). Line shape `{ skill, ts, subagent? }`
 * (SKILL-01/02) — the read shard is seeded here, not via store.ts.
 */
function appendSkill(dir: string, evt: { skill: string; ts: string; subagent?: string }): void {
  fs.appendFileSync(path.join(dir, "skill.jsonl"), JSON.stringify(evt) + "\n", { mode: 0o600 });
}

interface SeedOpts {
  pid?: number;
  pid_started?: string;
  /** ISO-8601 string written into the `heartbeat` sidecar (last_seen source). */
  heartbeat?: string;
}

function seedSession(id: string, startTime: string, opts: SeedOpts = {}): string {
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const state: SessionState = {
    schema_version: 1,
    session_id: id,
    folder: id,
    branch: "main",
    model: "unknown",
    start_time: startTime,
    ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
    ...(opts.pid_started !== undefined ? { pid_started: opts.pid_started } : {}),
  } as SessionState;
  writeSnapshot(dir, "session.json", state);
  if (opts.heartbeat !== undefined) {
    fs.writeFileSync(path.join(dir, "heartbeat"), opts.heartbeat, { mode: 0o600 });
  }
  return dir;
}

describe("readAll", () => {
  it("aggregate: merges multiple session dirs into one array (STATE-02)", () => {
    seedSession("alpha", new Date().toISOString());
    seedSession("beta", new Date().toISOString());

    const rows = readAll();
    const ids = rows.map((r) => r.session_id).sort();
    expect(ids).toEqual(["alpha", "beta"]);
  });

  it("window: drops touches older than CSM_WINDOW_MS and keeps recent (D-02)", () => {
    process.env.CSM_WINDOW_MS = "300000"; // 5 minutes
    const now = Date.now();
    const dir = seedSession("gamma", new Date(now).toISOString());

    // One stale touch (10 min ago) and one fresh touch (just now).
    appendTouch(dir, { file_path: "/repo/stale.ts", ts: new Date(now - 600_000).toISOString() });
    appendTouch(dir, { file_path: "/repo/fresh.ts", ts: new Date(now).toISOString() });

    const rows = readAll(now);
    const gamma = rows.find((r) => r.session_id === "gamma");
    const files = (gamma?.files ?? []).map((f) => f.file_path);
    expect(files).toContain("/repo/fresh.ts");
    expect(files).not.toContain("/repo/stale.ts");
  });

  it("sort: rows ordered most-recently-active first (D-09)", () => {
    const now = Date.now();
    const older = seedSession("older", new Date(now - 60_000).toISOString());
    const newer = seedSession("newer", new Date(now - 60_000).toISOString());

    appendTouch(older, { file_path: "/repo/a.ts", ts: new Date(now - 30_000).toISOString() });
    appendTouch(newer, { file_path: "/repo/b.ts", ts: new Date(now - 1_000).toISOString() });

    const rows = readAll(now);
    expect(rows[0].session_id).toBe("newer");
    expect(rows[1].session_id).toBe("older");
  });
});

// RED: readAll liveness fields (alive/readyToPrune/dotState) + injectable probe seam land in wave 02-01 Task 3.
const deadProbe = (): "alive" | "dead" => "dead";
const aliveProbe = (): "alive" | "dead" => "alive";

describe("readAll liveness (SC-3 / SC-4 / dot state)", () => {
  it("SC-4: dead-but-fresh row is alive (TTL authoritative) and not readyToPrune", () => {
    const now = Date.now();
    // Heartbeat is fresh (now), but the pid probe says the process is gone.
    seedSession("s4", new Date(now).toISOString(), {
      pid: 1234,
      heartbeat: new Date(now).toISOString(),
    });

    const row = readAll(now, deadProbe).find((r) => r.session_id === "s4")!;
    expect(row.alive).toBe(true);
    expect(row.readyToPrune).toBe(false);
  });

  it("SC-4 phantom-dot: dead probe + recent touch + fresh heartbeat => dotState 'stale', never 'active'", () => {
    process.env.CSM_ACTIVE_MS = "30000";
    const now = Date.now();
    const dir = seedSession("phantom", new Date(now).toISOString(), {
      pid: 1234,
      heartbeat: new Date(now).toISOString(), // fresh
    });
    // A touch well within the active window — would look "active" if the dot keyed off recency alone.
    appendTouch(dir, { file_path: "/repo/x.ts", ts: new Date(now - 5_000).toISOString() });

    const row = readAll(now, deadProbe).find((r) => r.session_id === "phantom")!;
    expect(row.alive).toBe(true); // TTL keeps it alive for prune timing
    expect(row.dotState).toBe("stale"); // but a kill -0 fail forces grey (SC-4 compute-layer guard)
  });

  it("SC-3: stale heartbeat AND dead probe => not alive and readyToPrune", () => {
    process.env.CSM_STALE_MS = "120000";
    const now = Date.now();
    seedSession("s3", new Date(now - 600_000).toISOString(), {
      pid: 1234,
      heartbeat: new Date(now - 200_000).toISOString(), // older than staleMs
    });

    const row = readAll(now, deadProbe).find((r) => r.session_id === "s3")!;
    expect(row.alive).toBe(false);
    expect(row.readyToPrune).toBe(true);
  });

  it("dotState 'active': live process with a touch within CSM_ACTIVE_MS", () => {
    process.env.CSM_ACTIVE_MS = "30000";
    const now = Date.now();
    const dir = seedSession("act", new Date(now).toISOString(), {
      pid: 1234,
      heartbeat: new Date(now).toISOString(),
    });
    appendTouch(dir, { file_path: "/repo/a.ts", ts: new Date(now - 5_000).toISOString() });

    const row = readAll(now, aliveProbe).find((r) => r.session_id === "act")!;
    expect(row.dotState).toBe("active");
    expect(row.readyToPrune).toBe(false);
  });

  it("dotState 'idle': live process but last touch older than CSM_ACTIVE_MS", () => {
    process.env.CSM_ACTIVE_MS = "30000";
    const now = Date.now();
    const dir = seedSession("idle", new Date(now).toISOString(), {
      pid: 1234,
      heartbeat: new Date(now).toISOString(),
    });
    // Beyond activeMs but within the default 5-min window (still an active file).
    appendTouch(dir, { file_path: "/repo/b.ts", ts: new Date(now - 60_000).toISOString() });

    const row = readAll(now, aliveProbe).find((r) => r.session_id === "idle")!;
    expect(row.dotState).toBe("idle");
  });
});

// RED (02-01 fix, CR-01/WR-03): the reader must consult the captured
// `pid_started` identity token so a numeric pid reused by an unrelated live
// process cannot masquerade as the original session. `aliveProbe` models the
// reused pid still answering kill -0; the injected started-probe returns a
// DIFFERENT start-time than what SessionStart recorded.
const reusedStartedProbe = (): string => "Wed Aug 27 09:00:00 2026";
const matchingStartedProbe =
  (token: string) =>
  (): string =>
    token;

describe("readAll PID-reuse guard (CR-01 / WR-03)", () => {
  const ORIG = "Mon Jan  1 00:00:00 2020"; // start-time captured at SessionStart

  it("WR-03: reused pid + stale heartbeat => not alive, readyToPrune, dot not active", () => {
    process.env.CSM_STALE_MS = "120000";
    process.env.CSM_ACTIVE_MS = "30000";
    const now = Date.now();
    // Stale heartbeat (older than staleMs); the pid still answers alive but its
    // start-time no longer matches -> a recycled pid, i.e. a zombie shard.
    const dir = seedSession("zombie", new Date(now - 600_000).toISOString(), {
      pid: 1234,
      pid_started: ORIG,
      heartbeat: new Date(now - 200_000).toISOString(),
    });
    appendTouch(dir, { file_path: "/repo/z.ts", ts: new Date(now - 5_000).toISOString() });

    const row = readAll(now, aliveProbe, reusedStartedProbe).find(
      (r) => r.session_id === "zombie",
    )!;
    expect(row.alive).toBe(false);
    expect(row.readyToPrune).toBe(true);
    expect(row.dotState).not.toBe("active");
  });

  it("CR-01: reused pid + fresh heartbeat + recent touch => dot 'stale', never 'active'", () => {
    process.env.CSM_ACTIVE_MS = "30000";
    const now = Date.now();
    const dir = seedSession("phantom-reuse", new Date(now).toISOString(), {
      pid: 1234,
      pid_started: ORIG,
      heartbeat: new Date(now).toISOString(), // fresh
    });
    // A touch well within the active window — would read "active" if the reused
    // pid were trusted.
    appendTouch(dir, { file_path: "/repo/x.ts", ts: new Date(now - 5_000).toISOString() });

    const row = readAll(now, aliveProbe, reusedStartedProbe).find(
      (r) => r.session_id === "phantom-reuse",
    )!;
    expect(row.dotState).toBe("stale"); // reused pid cannot render green
    expect(row.dotState).not.toBe("active");
  });

  it("identity match: same start-time keeps a live session active (no false positive)", () => {
    process.env.CSM_ACTIVE_MS = "30000";
    const now = Date.now();
    const dir = seedSession("genuine", new Date(now).toISOString(), {
      pid: 1234,
      pid_started: ORIG,
      heartbeat: new Date(now).toISOString(),
    });
    appendTouch(dir, { file_path: "/repo/a.ts", ts: new Date(now - 5_000).toISOString() });

    const row = readAll(now, aliveProbe, matchingStartedProbe(ORIG)).find(
      (r) => r.session_id === "genuine",
    )!;
    expect(row.dotState).toBe("active");
    expect(row.readyToPrune).toBe(false);
  });

  it("soft miss: an empty re-derived token never blocks the roster (TTL decides)", () => {
    process.env.CSM_ACTIVE_MS = "30000";
    const now = Date.now();
    const dir = seedSession("soft", new Date(now).toISOString(), {
      pid: 1234,
      pid_started: ORIG,
      heartbeat: new Date(now).toISOString(),
    });
    appendTouch(dir, { file_path: "/repo/a.ts", ts: new Date(now - 5_000).toISOString() });

    const row = readAll(now, aliveProbe, () => "").find((r) => r.session_id === "soft")!;
    expect(row.dotState).toBe("active");
  });
});

// RED (02-02 fix, WR-01): when SessionStart could not capture a trustworthy pid
// it writes no `pid` (the sentinel). The reader must then defer to the
// TTL/heartbeat for the dot rather than forcing "stale" on the missing probe —
// otherwise a genuinely-active session shows grey.
describe("readAll no-pid sentinel defers to TTL (WR-01)", () => {
  // deadProbe would be consulted only if a pid existed; here there is none, so
  // isProcessAlive short-circuits to "unknown" and never calls it.
  it("no pid + fresh heartbeat + recent touch => dot 'active', not 'stale'", () => {
    process.env.CSM_ACTIVE_MS = "30000";
    const now = Date.now();
    const dir = seedSession("nopid-live", new Date(now).toISOString(), {
      heartbeat: new Date(now).toISOString(), // fresh, no pid seeded
    });
    appendTouch(dir, { file_path: "/repo/a.ts", ts: new Date(now - 5_000).toISOString() });

    const row = readAll(now, deadProbe).find((r) => r.session_id === "nopid-live")!;
    expect(row.dotState).toBe("active");
    expect(row.alive).toBe(true);
  });

  it("no pid + stale heartbeat => not alive, readyToPrune, dot 'stale'", () => {
    process.env.CSM_STALE_MS = "120000";
    const now = Date.now();
    seedSession("nopid-dead", new Date(now - 600_000).toISOString(), {
      heartbeat: new Date(now - 200_000).toISOString(), // older than staleMs
    });

    const row = readAll(now, deadProbe).find((r) => r.session_id === "nopid-dead")!;
    expect(row.alive).toBe(false);
    expect(row.readyToPrune).toBe(true);
    expect(row.dotState).toBe("stale");
  });
});

// RED (03.1-02): the read-side aggregate. Every SessionRow must carry a
// `reads[]` populated from `reads.jsonl` on a SHORT, SEPARATE 30s window
// (CSM_READ_WINDOW_MS, D-04/D-05), with the D-07 write-suppresses-read de-dup.
// The write path (files[]/last_active/sort/liveness) stays byte-for-byte
// unchanged (D-02) — none of these cases touch it.
describe("activeReads (read window, D-04/D-06/D-07)", () => {
  it("default window: a read within 30s is IN reads[], one older than 30s is OUT", () => {
    // CSM_READ_WINDOW_MS unset -> default 30_000ms boundary.
    const now = Date.now();
    const dir = seedSession("rd-default", new Date(now).toISOString());
    appendRead(dir, { file_path: "/repo/fresh-read.ts", ts: new Date(now - 10_000).toISOString() });
    appendRead(dir, { file_path: "/repo/stale-read.ts", ts: new Date(now - 45_000).toISOString() });

    const row = readAll(now).find((r) => r.session_id === "rd-default")!;
    const reads = row.reads.map((r) => r.file_path);
    expect(reads).toContain("/repo/fresh-read.ts");
    expect(reads).not.toContain("/repo/stale-read.ts");
  });

  it("override: CSM_READ_WINDOW_MS keeps a now-10s read and drops a now-40s read", () => {
    process.env.CSM_READ_WINDOW_MS = "30000";
    const now = Date.now();
    const dir = seedSession("rd-override", new Date(now).toISOString());
    appendRead(dir, { file_path: "/repo/keep.ts", ts: new Date(now - 10_000).toISOString() });
    appendRead(dir, { file_path: "/repo/drop.ts", ts: new Date(now - 40_000).toISOString() });

    const row = readAll(now).find((r) => r.session_id === "rd-override")!;
    const reads = row.reads.map((r) => r.file_path);
    expect(reads).toContain("/repo/keep.ts");
    expect(reads).not.toContain("/repo/drop.ts");
  });

  it("reads populated + separate axis: a read-only session has the path in reads[], files[] empty", () => {
    const now = Date.now();
    const dir = seedSession("rd-only", new Date(now).toISOString());
    appendRead(dir, { file_path: "/repo/onlyread.ts", ts: new Date(now - 5_000).toISOString() });

    const row = readAll(now).find((r) => r.session_id === "rd-only")!;
    expect(row.reads.map((r) => r.file_path)).toContain("/repo/onlyread.ts");
    expect(row.files).toHaveLength(0);
  });

  it("D-07 write suppresses read: a path both written and read is in files[] but NOT reads[]", () => {
    const now = Date.now();
    const dir = seedSession("rd-dedup", new Date(now).toISOString());
    // Same path present in BOTH shards within both windows.
    appendTouch(dir, { file_path: "/repo/shared.ts", ts: new Date(now - 5_000).toISOString() });
    appendRead(dir, { file_path: "/repo/shared.ts", ts: new Date(now - 5_000).toISOString() });

    const row = readAll(now).find((r) => r.session_id === "rd-dedup")!;
    expect(row.files.map((f) => f.file_path)).toContain("/repo/shared.ts");
    expect(row.reads.map((r) => r.file_path)).not.toContain("/repo/shared.ts");
  });
});

// RED (04-01): readAll must surface a per-session intent.txt shard as
// SessionRow.intent / intent_ts (INT-01). intent.txt is a SEPARATE writer from
// session.json (D-01), format `{ intent: string, ts: string }`. An absent or
// torn intent.txt must leave `intent` undefined and NEVER drop the session
// (D-11 self-heal), mirroring the activeFiles/activeReads try/catch shape.
describe("readIntent surface (INT-01, D-01/D-11)", () => {
  function writeIntent(dir: string, snap: { intent?: unknown; ts?: unknown }): void {
    fs.writeFileSync(path.join(dir, "intent.txt"), JSON.stringify(snap), { mode: 0o600 });
  }

  it("valid intent.txt: readAll's row carries intent and intent_ts", () => {
    const now = Date.now();
    const dir = seedSession("int-ok", new Date(now).toISOString());
    const ts = new Date(now).toISOString();
    writeIntent(dir, { intent: "refactor Card", ts });

    const row = readAll(now).find((r) => r.session_id === "int-ok")!;
    expect(row.intent).toBe("refactor Card");
    expect(row.intent_ts).toBe(ts);
  });

  it("torn intent.txt (non-JSON): row still appears with intent undefined (never dropped)", () => {
    const now = Date.now();
    const dir = seedSession("int-torn", new Date(now).toISOString());
    fs.writeFileSync(path.join(dir, "intent.txt"), "{not json", { mode: 0o600 });

    const row = readAll(now).find((r) => r.session_id === "int-torn");
    expect(row).toBeDefined();
    expect(row!.intent).toBeUndefined();
    expect(row!.intent_ts).toBeUndefined();
  });

  it("absent intent.txt: intent is undefined and the session still appears", () => {
    const now = Date.now();
    seedSession("int-absent", new Date(now).toISOString());

    const row = readAll(now).find((r) => r.session_id === "int-absent");
    expect(row).toBeDefined();
    expect(row!.intent).toBeUndefined();
  });

  it("empty-string intent is treated as absent (undefined, not empty)", () => {
    const now = Date.now();
    const dir = seedSession("int-empty", new Date(now).toISOString());
    writeIntent(dir, { intent: "", ts: new Date(now).toISOString() });

    const row = readAll(now).find((r) => r.session_id === "int-empty")!;
    expect(row.intent).toBeUndefined();
  });
});

// RED (04.3-03): readAll must reduce a per-session skill.jsonl shard into the
// NEWEST in-window skill as additive card-only SessionRow.skill / skill_ts /
// skill_subagent (SKILL-03/D-02, SKILL-02 subagent passthrough). skill.jsonl is
// a SEPARATE writer (scripts/on-skill.mjs, D-01), line shape { skill, ts,
// subagent? }. Decay is on a NEW CSM_SKILL_WINDOW_MS axis (5-min default). A
// torn/absent shard leaves skill undefined and NEVER drops the session (D-11
// self-heal). skill NEVER feeds sort/liveness/conflicts — card-only, like
// reads/intent.
describe("readSkill (skill window, SKILL-03/D-02)", () => {
  it("newest-wins in window: two skill events -> the newer skill/ts wins", () => {
    const now = Date.now();
    const dir = seedSession("sk-newest", new Date(now).toISOString());
    const olderTs = new Date(now - 60_000).toISOString();
    const newerTs = new Date(now - 5_000).toISOString();
    appendSkill(dir, { skill: "gsd-fast", ts: olderTs });
    appendSkill(dir, { skill: "gsd-quick", ts: newerTs });

    const row = readAll(now).find((r) => r.session_id === "sk-newest")!;
    expect(row.skill).toBe("gsd-quick");
    expect(row.skill_ts).toBe(newerTs);
  });

  it("default window: a skill at now-4min is IN, a lone skill at now-6min is OUT (300000ms default)", () => {
    // CSM_SKILL_WINDOW_MS unset -> default 300_000ms (5-min) boundary.
    const now = Date.now();

    const inDir = seedSession("sk-def-in", new Date(now).toISOString());
    appendSkill(inDir, { skill: "gsd-plan-phase", ts: new Date(now - 4 * 60_000).toISOString() });
    const inRow = readAll(now).find((r) => r.session_id === "sk-def-in")!;
    expect(inRow.skill).toBe("gsd-plan-phase");

    const outDir = seedSession("sk-def-out", new Date(now).toISOString());
    appendSkill(outDir, { skill: "gsd-plan-phase", ts: new Date(now - 6 * 60_000).toISOString() });
    const outRow = readAll(now).find((r) => r.session_id === "sk-def-out")!;
    expect(outRow.skill).toBeUndefined();
  });

  it("override decay: CSM_SKILL_WINDOW_MS=30000 keeps a now-10s skill, drops a now-40s skill", () => {
    process.env.CSM_SKILL_WINDOW_MS = "30000";
    const now = Date.now();

    const keepDir = seedSession("sk-keep", new Date(now).toISOString());
    appendSkill(keepDir, { skill: "gsd-quick", ts: new Date(now - 10_000).toISOString() });
    const keepRow = readAll(now).find((r) => r.session_id === "sk-keep")!;
    expect(keepRow.skill).toBe("gsd-quick");

    const dropDir = seedSession("sk-drop", new Date(now).toISOString());
    appendSkill(dropDir, { skill: "gsd-quick", ts: new Date(now - 40_000).toISOString() });
    const dropRow = readAll(now).find((r) => r.session_id === "sk-drop")!;
    expect(dropRow.skill).toBeUndefined();
  });

  it("SKILL-02 subagent passthrough: subagent present -> skill_subagent set; absent/empty -> undefined", () => {
    const now = Date.now();

    const subDir = seedSession("sk-sub", new Date(now).toISOString());
    appendSkill(subDir, {
      skill: "claude-api",
      ts: new Date(now - 5_000).toISOString(),
      subagent: "gsd-executor",
    });
    const subRow = readAll(now).find((r) => r.session_id === "sk-sub")!;
    expect(subRow.skill).toBe("claude-api");
    expect(subRow.skill_subagent).toBe("gsd-executor");

    const mainDir = seedSession("sk-main", new Date(now).toISOString());
    appendSkill(mainDir, { skill: "claude-api", ts: new Date(now - 5_000).toISOString() });
    const mainRow = readAll(now).find((r) => r.session_id === "sk-main")!;
    expect(mainRow.skill).toBe("claude-api");
    expect(mainRow.skill_subagent).toBeUndefined();

    const emptyDir = seedSession("sk-empty-sub", new Date(now).toISOString());
    appendSkill(emptyDir, {
      skill: "claude-api",
      ts: new Date(now - 5_000).toISOString(),
      subagent: "",
    });
    const emptyRow = readAll(now).find((r) => r.session_id === "sk-empty-sub")!;
    expect(emptyRow.skill_subagent).toBeUndefined();
  });

  it("torn-line self-heal: a trailing non-JSON fragment is skipped, the valid skill wins, session retained", () => {
    const now = Date.now();
    const dir = seedSession("sk-torn", new Date(now).toISOString());
    appendSkill(dir, { skill: "gsd-quick", ts: new Date(now - 5_000).toISOString() });
    // Append a raw half-written trailing line (no newline-completed JSON).
    fs.appendFileSync(path.join(dir, "skill.jsonl"), '{"skill":"gsd-bro', { mode: 0o600 });

    const row = readAll(now).find((r) => r.session_id === "sk-torn");
    expect(row).toBeDefined();
    expect(row!.skill).toBe("gsd-quick");
  });

  it("absent shard: a session with no skill.jsonl still appears with skill undefined", () => {
    const now = Date.now();
    seedSession("sk-absent", new Date(now).toISOString());

    const row = readAll(now).find((r) => r.session_id === "sk-absent");
    expect(row).toBeDefined();
    expect(row!.skill).toBeUndefined();
    expect(row!.skill_ts).toBeUndefined();
    expect(row!.skill_subagent).toBeUndefined();
  });

  it("card-only: a skill-only session is NOT hoisted by its skill ts and gets no last_active (D-02)", () => {
    const now = Date.now();
    // "older" session with a genuine recent write touch (drives sort/last_active).
    const older = seedSession("sk-older", new Date(now - 60_000).toISOString());
    appendTouch(older, { file_path: "/repo/a.ts", ts: new Date(now - 30_000).toISOString() });
    // "newer" session that ONLY has a very fresh skill event (no files/reads).
    const newer = seedSession("sk-newer", new Date(now - 60_000).toISOString());
    appendSkill(newer, { skill: "gsd-quick", ts: new Date(now - 1_000).toISOString() });

    const rows = readAll(now);
    // The skill-only session must NOT be hoisted above the write-active one by
    // its (newer) skill ts — sort keys off last_active/start_time only (D-09).
    expect(rows[0].session_id).toBe("sk-older");
    // And a skill NEVER sets last_active.
    const newerRow = rows.find((r) => r.session_id === "sk-newer")!;
    expect(newerRow.last_active).toBeUndefined();
    expect(newerRow.skill).toBe("gsd-quick");
  });
});

// RED (260914-507 Task 2): readAll must surface a per-session target-branch.txt
// shard as SessionRow.target_branch / target_branch_ts (TB-02). target-branch.txt
// is a SEPARATE writer from session.json (D-01/D-BR-01), format
// `{ target_branch: string, ts: string }`. An absent or torn shard must leave
// target_branch undefined and NEVER drop the session (D-11 self-heal), mirroring
// the readIntent try/catch shape exactly. An empty-string target_branch is
// treated as absent.
describe("readTargetBranch surface (TB-02, D-01/D-BR-01/D-11)", () => {
  function writeTargetBranch(dir: string, snap: { target_branch?: unknown; ts?: unknown }): void {
    fs.writeFileSync(path.join(dir, "target-branch.txt"), JSON.stringify(snap), { mode: 0o600 });
  }

  it("valid target-branch.txt: readAll's row carries target_branch and target_branch_ts", () => {
    const now = Date.now();
    const dir = seedSession("tb-ok", new Date(now).toISOString());
    const ts = new Date(now).toISOString();
    writeTargetBranch(dir, { target_branch: "feature-x", ts });

    const row = readAll(now).find((r) => r.session_id === "tb-ok")!;
    expect(row.target_branch).toBe("feature-x");
    expect(row.target_branch_ts).toBe(ts);
  });

  it("torn target-branch.txt (non-JSON): row still appears with target_branch undefined (never dropped)", () => {
    const now = Date.now();
    const dir = seedSession("tb-torn", new Date(now).toISOString());
    fs.writeFileSync(path.join(dir, "target-branch.txt"), "{not json", { mode: 0o600 });

    const row = readAll(now).find((r) => r.session_id === "tb-torn");
    expect(row).toBeDefined();
    expect(row!.target_branch).toBeUndefined();
    expect(row!.target_branch_ts).toBeUndefined();
  });

  it("absent target-branch.txt: target_branch is undefined and the session still appears", () => {
    const now = Date.now();
    seedSession("tb-absent", new Date(now).toISOString());

    const row = readAll(now).find((r) => r.session_id === "tb-absent");
    expect(row).toBeDefined();
    expect(row!.target_branch).toBeUndefined();
  });

  it("empty-string target_branch is treated as absent (undefined, not empty)", () => {
    const now = Date.now();
    const dir = seedSession("tb-empty", new Date(now).toISOString());
    writeTargetBranch(dir, { target_branch: "", ts: new Date(now).toISOString() });

    const row = readAll(now).find((r) => r.session_id === "tb-empty")!;
    expect(row.target_branch).toBeUndefined();
  });
});

// RED (06-03): readAll must surface a per-session attention.json snapshot shard
// as a PRE-GATED boolean SessionRow.attention (+ passthrough attention_type /
// attention_ts) (ATTN-02/03). attention.json is a SEPARATE writer from
// session.json (D-01), format `{ type: string, ts: string }`. The gate is the
// single genuinely-new rule in the phase (Pattern 2): the flag shows only while
// the attention ts is BOTH within CSM_ATTN_WINDOW_MS (default 1_800_000 ms — a
// 30-minute safety net, 260926-r7n) AND strictly NEWER than the session's last
// activity (heartbeat / newest tool touch). Activity is the primary clear. All
// timestamps are explicit ISO strings and `now` is injected, so the four gate
// cases are deterministic with no timers. attention NEVER drives sort/liveness/
// conflicts — presentation-only, like reads/skill/intent/branch.
describe("readAttention gate (ATTN-02/03, D-04 window + newer-than-activity)", () => {
  function writeAttention(dir: string, snap: { type?: unknown; ts?: unknown }): void {
    fs.writeFileSync(path.join(dir, "attention.json"), JSON.stringify(snap), { mode: 0o600 });
  }

  it("case 1 — in-window AND newer than heartbeat: attention true with attention_type passthrough", () => {
    const now = Date.now();
    // Heartbeat 30s ago; attention 5s ago (newer than heartbeat, well within 90s).
    const dir = seedSession("at-show", new Date(now - 120_000).toISOString(), {
      heartbeat: new Date(now - 30_000).toISOString(),
    });
    const attnTs = new Date(now - 5_000).toISOString();
    writeAttention(dir, { type: "permission_prompt", ts: attnTs });

    const row = readAll(now).find((r) => r.session_id === "at-show")!;
    expect(row.attention).toBe(true);
    expect(row.attention_type).toBe("permission_prompt");
    expect(row.attention_ts).toBe(attnTs);
  });

  it("case 2 — attention OLDER than the heartbeat (session resumed): attention false", () => {
    const now = Date.now();
    // Attention 40s ago, but the heartbeat is fresher (5s ago) => the session
    // resumed activity after the prompt, so the flag must clear.
    const dir = seedSession("at-resumed", new Date(now - 120_000).toISOString(), {
      heartbeat: new Date(now - 5_000).toISOString(),
    });
    writeAttention(dir, { type: "idle_prompt", ts: new Date(now - 40_000).toISOString() });

    const row = readAll(now).find((r) => r.session_id === "at-resumed")!;
    expect(row.attention).toBe(false);
  });

  it("case 3 — attention older than now minus CSM_ATTN_WINDOW_MS (expired): attention false", () => {
    process.env.CSM_ATTN_WINDOW_MS = "90000";
    const now = Date.now();
    // Attention 120s ago (beyond the 90s window) though still newer than a very
    // old heartbeat — the window backstop must expire it.
    const dir = seedSession("at-expired", new Date(now - 600_000).toISOString(), {
      heartbeat: new Date(now - 300_000).toISOString(),
    });
    writeAttention(dir, { type: "idle_prompt", ts: new Date(now - 120_000).toISOString() });

    const row = readAll(now).find((r) => r.session_id === "at-expired")!;
    expect(row.attention).toBe(false);
  });

  it("case 4 — no attention.json at all: attention false and the session still appears", () => {
    const now = Date.now();
    seedSession("at-absent", new Date(now).toISOString(), {
      heartbeat: new Date(now - 5_000).toISOString(),
    });

    const row = readAll(now).find((r) => r.session_id === "at-absent");
    expect(row).toBeDefined();
    expect(row!.attention).toBe(false);
  });

  // --- 260926-r7n (AP-02): the default window is a 30-minute SAFETY NET, not
  // the primary clear (activity is). A user who answers late must still see ◉.
  it("D1 — default window keeps a long wait visible: attention 10 min ago, no activity since → attention true", () => {
    const now = Date.now();
    const dir = seedSession("at-long-wait", new Date(now - 3_600_000).toISOString(), {
      heartbeat: new Date(now - 1_200_000).toISOString(),
    });
    writeAttention(dir, { type: "permission_prompt", ts: new Date(now - 600_000).toISOString() });

    const row = readAll(now).find((r) => r.session_id === "at-long-wait")!;
    expect(row.attention).toBe(true);
  });

  it("D2 — default safety net still expires: attention 31 min ago → attention false", () => {
    const now = Date.now();
    const dir = seedSession("at-safety-net", new Date(now - 7_200_000).toISOString(), {
      heartbeat: new Date(now - 3_600_000).toISOString(),
    });
    writeAttention(dir, { type: "permission_prompt", ts: new Date(now - 1_860_000).toISOString() });

    const row = readAll(now).find((r) => r.session_id === "at-safety-net")!;
    expect(row.attention).toBe(false);
  });

  it("D3 — an invalid override (NaN) degrades to the 30-min default: attention 10 min ago → attention true", () => {
    process.env.CSM_ATTN_WINDOW_MS = "abc";
    const now = Date.now();
    const dir = seedSession("at-bad-override", new Date(now - 3_600_000).toISOString(), {
      heartbeat: new Date(now - 1_200_000).toISOString(),
    });
    writeAttention(dir, { type: "idle_prompt", ts: new Date(now - 600_000).toISOString() });

    const row = readAll(now).find((r) => r.session_id === "at-bad-override")!;
    expect(row.attention).toBe(true);
  });
});

// --- Quick task 260926-vfm (AQ-02): readAll surfaces a SEPARATE asking.json
// {ts} shard (written by scripts/on-ask.mjs on PreToolUse AskUserQuestion) as a
// PRE-GATED SessionRow.asking boolean, using the SAME gate as attention (within
// attnWindowMs AND strictly newer than lastSeenMs). Asking WINS: when asking is
// true, attention is forced false (attention_type/ts undefined), so a row is
// counted once. Timestamps are explicit ISO strings and `now` is injected.
describe("readAsking gate + precedence (AQ-02)", () => {
  type AskFields = { asking?: boolean; asking_ts?: string; attention?: boolean; attention_type?: string; attention_ts?: string };
  const askRow = (id: string, now: number): AskFields | undefined =>
    readAll(now).find((r) => r.session_id === id) as unknown as AskFields | undefined;

  function writeAsking(dir: string, snap: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, "asking.json"), JSON.stringify(snap), { mode: 0o600 });
  }
  function writeAttention(dir: string, snap: { type?: unknown; ts?: unknown }): void {
    fs.writeFileSync(path.join(dir, "attention.json"), JSON.stringify(snap), { mode: 0o600 });
  }

  it("A1 open question: asking 5s ago, heartbeat 30s ago → asking true with asking_ts, attention false", () => {
    const now = Date.now();
    const dir = seedSession("ask-open", new Date(now - 120_000).toISOString(), {
      heartbeat: new Date(now - 30_000).toISOString(),
    });
    const askTs = new Date(now - 5_000).toISOString();
    writeAsking(dir, { ts: askTs });

    const row = askRow("ask-open", now)!;
    expect(row.asking).toBe(true);
    expect(row.asking_ts).toBe(askTs);
    expect(row.attention).toBe(false);
  });

  it("A2 answered: heartbeat 5s ago is newer than asking 40s ago → asking false, asking_ts undefined", () => {
    const now = Date.now();
    const dir = seedSession("ask-answered", new Date(now - 120_000).toISOString(), {
      heartbeat: new Date(now - 5_000).toISOString(),
    });
    writeAsking(dir, { ts: new Date(now - 40_000).toISOString() });

    const row = askRow("ask-answered", now)!;
    expect(row.asking).toBe(false);
    expect(row.asking_ts).toBeUndefined();
  });

  it("A3 explicit window expiry: CSM_ATTN_WINDOW_MS=90000, asking 120s ago → asking false", () => {
    process.env.CSM_ATTN_WINDOW_MS = "90000";
    const now = Date.now();
    const dir = seedSession("ask-expired", new Date(now - 600_000).toISOString(), {
      heartbeat: new Date(now - 300_000).toISOString(),
    });
    writeAsking(dir, { ts: new Date(now - 120_000).toISOString() });

    expect(askRow("ask-expired", now)!.asking).toBe(false);
  });

  it("A4 default 30-min window: asking 10 min ago → true; asking 31 min ago → false", () => {
    const now = Date.now();
    const d1 = seedSession("ask-long", new Date(now - 3_600_000).toISOString(), {
      heartbeat: new Date(now - 1_200_000).toISOString(),
    });
    writeAsking(d1, { ts: new Date(now - 600_000).toISOString() });
    const d2 = seedSession("ask-net", new Date(now - 7_200_000).toISOString(), {
      heartbeat: new Date(now - 3_600_000).toISOString(),
    });
    writeAsking(d2, { ts: new Date(now - 1_860_000).toISOString() });

    expect(askRow("ask-long", now)!.asking).toBe(true);
    expect(askRow("ask-net", now)!.asking).toBe(false);
  });

  it("A5 precedence: a permission_prompt Notification newer than the open question → asking true, attention false (type/ts undefined)", () => {
    const now = Date.now();
    const dir = seedSession("ask-wins", new Date(now - 120_000).toISOString(), {
      heartbeat: new Date(now - 30_000).toISOString(),
    });
    writeAsking(dir, { ts: new Date(now - 10_000).toISOString() });
    writeAttention(dir, { type: "permission_prompt", ts: new Date(now - 3_000).toISOString() });

    const row = askRow("ask-wins", now)!;
    expect(row.asking).toBe(true);
    expect(row.attention).toBe(false);
    expect(row.attention_type).toBeUndefined();
    expect(row.attention_ts).toBeUndefined();
  });

  it("A6 waiting unchanged after an answered question: asking false, attention true with type passthrough", () => {
    const now = Date.now();
    const dir = seedSession("ask-then-wait", new Date(now - 120_000).toISOString(), {
      heartbeat: new Date(now - 30_000).toISOString(),
    });
    writeAsking(dir, { ts: new Date(now - 60_000).toISOString() });
    writeAttention(dir, { type: "permission_prompt", ts: new Date(now - 5_000).toISOString() });

    const row = askRow("ask-then-wait", now)!;
    expect(row.asking).toBe(false);
    expect(row.attention).toBe(true);
    expect(row.attention_type).toBe("permission_prompt");
  });

  it("A7 self-heal: absent, torn, or non-string-ts asking.json → asking false and the row is present", () => {
    const now = Date.now();
    seedSession("ask-absent", new Date(now - 120_000).toISOString(), {
      heartbeat: new Date(now - 30_000).toISOString(),
    });
    const torn = seedSession("ask-torn", new Date(now - 120_000).toISOString(), {
      heartbeat: new Date(now - 30_000).toISOString(),
    });
    fs.writeFileSync(path.join(torn, "asking.json"), "{not json", { mode: 0o600 });
    const bad = seedSession("ask-badts", new Date(now - 120_000).toISOString(), {
      heartbeat: new Date(now - 30_000).toISOString(),
    });
    writeAsking(bad, { ts: 123 });

    for (const id of ["ask-absent", "ask-torn", "ask-badts"]) {
      const row = askRow(id, now);
      expect(row).toBeDefined();
      expect(row!.asking).toBe(false);
    }
  });
});

// --- Quick task 260927-1zw (CR-01 / WR-02): the waiting gate compares against
// the main-thread `resumed` sidecar and the asking gate against the
// answer-specific `ask-resolved` sidecar. The heartbeat stays the liveness
// signal (it counts subagent activity) and is only the FALLBACK clear when a
// sidecar is absent (DISC-1: sessions whose hooks predate the fix).
describe("resume-signal gates (260927-1zw CR-01/WR-02)", () => {
  function writeSidecar(dir: string, name: string, iso: string): void {
    fs.writeFileSync(path.join(dir, name), iso, { mode: 0o600 });
  }
  function writeAttention(dir: string, snap: { type?: unknown; ts?: unknown }): void {
    fs.writeFileSync(path.join(dir, "attention.json"), JSON.stringify(snap), { mode: 0o600 });
  }
  function writeAsking(dir: string, snap: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, "asking.json"), JSON.stringify(snap), { mode: 0o600 });
  }
  const ago = (now: number, ms: number) => new Date(now - ms).toISOString();
  const row = (id: string, now: number) => readAll(now).find((r) => r.session_id === id)!;

  it("G1 CR-01: waiting survives subagent activity (heartbeat newer, resumed older than the prompt)", () => {
    const now = Date.now();
    const dir = seedSession("g1", ago(now, 120_000), { heartbeat: ago(now, 1_000) });
    writeSidecar(dir, "resumed", ago(now, 30_000));
    writeAttention(dir, { type: "permission_prompt", ts: ago(now, 5_000) });
    expect(row("g1", now).attention).toBe(true);
  });

  it("G2 a main-thread resume newer than the prompt clears waiting", () => {
    const now = Date.now();
    const dir = seedSession("g2", ago(now, 120_000), { heartbeat: ago(now, 1_000) });
    writeSidecar(dir, "resumed", ago(now, 1_000));
    writeAttention(dir, { type: "permission_prompt", ts: ago(now, 5_000) });
    expect(row("g2", now).attention).toBe(false);
  });

  it("G3 strictly newer: resumed ts equal to the attention ts clears waiting", () => {
    const now = Date.now();
    const ts = ago(now, 5_000);
    const dir = seedSession("g3", ago(now, 120_000), { heartbeat: ago(now, 30_000) });
    writeSidecar(dir, "resumed", ts);
    writeAttention(dir, { type: "permission_prompt", ts });
    expect(row("g3", now).attention).toBe(false);
  });

  it("G4 WR-02: an open question survives a sibling main-thread tool (resumed newer, ask-resolved older)", () => {
    const now = Date.now();
    const dir = seedSession("g4", ago(now, 120_000), { heartbeat: ago(now, 1_000) });
    writeSidecar(dir, "resumed", ago(now, 1_000));
    writeSidecar(dir, "ask-resolved", ago(now, 60_000));
    writeAsking(dir, { ts: ago(now, 5_000) });
    const r = row("g4", now);
    expect(r.asking).toBe(true);
    expect(r.attention).toBe(false);
  });

  it("G5 the answer clears asking: ask-resolved newer than the question", () => {
    const now = Date.now();
    const dir = seedSession("g5", ago(now, 120_000), { heartbeat: ago(now, 1_000) });
    writeSidecar(dir, "ask-resolved", ago(now, 1_000));
    writeAsking(dir, { ts: ago(now, 5_000) });
    const r = row("g5", now);
    expect(r.asking).toBe(false);
    expect(r.asking_ts).toBeUndefined();
  });

  it("G6 legacy fallback (DISC-1): with no sidecars the heartbeat still gates both markers", () => {
    const now = Date.now();
    const a = seedSession("g6a", ago(now, 120_000), { heartbeat: ago(now, 1_000) });
    writeAttention(a, { type: "permission_prompt", ts: ago(now, 5_000) });
    writeAsking(a, { ts: ago(now, 5_000) });
    const b = seedSession("g6b", ago(now, 120_000), { heartbeat: ago(now, 30_000) });
    writeAttention(b, { type: "permission_prompt", ts: ago(now, 5_000) });

    const ra = row("g6a", now);
    expect(ra.attention).toBe(false);
    expect(ra.asking).toBe(false);
    expect(row("g6b", now).attention).toBe(true);
  });
});

// --- Quick task 260927-1zw (WR-01): an active needs-you marker is liveness
// evidence. A session blocked on the human with an old heartbeat and no
// trustworthy pid must not go stale / readyToPrune (App would delete its shard).
// Bounded by CSM_ATTN_WINDOW_MS through the marker gate; an authoritatively
// dead pid is still reaped (DISC-4).
describe("needs-you keepalive (260927-1zw WR-01)", () => {
  function writeSidecar(dir: string, name: string, iso: string): void {
    fs.writeFileSync(path.join(dir, name), iso, { mode: 0o600 });
  }
  function writeAttention(dir: string, snap: { type?: unknown; ts?: unknown }): void {
    fs.writeFileSync(path.join(dir, "attention.json"), JSON.stringify(snap), { mode: 0o600 });
  }
  function writeAsking(dir: string, snap: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, "asking.json"), JSON.stringify(snap), { mode: 0o600 });
  }
  const ago = (now: number, ms: number) => new Date(now - ms).toISOString();

  beforeEach(() => {
    process.env.CSM_STALE_MS = "120000";
  });

  it("W1 reviewer repro: no pid, heartbeat 180s, asking 170s → asking, alive, not readyToPrune, idle dot, not pruned by App", () => {
    const now = Date.now();
    const dir = seedSession("w1", ago(now, 600_000), { heartbeat: ago(now, 180_000) });
    writeAsking(dir, { ts: ago(now, 170_000) });
    const r = readAll(now, deadProbe).find((x) => x.session_id === "w1")!;
    expect(r.asking).toBe(true);
    expect(r.alive).toBe(true);
    expect(r.readyToPrune).toBe(false);
    expect(r.dotState).toBe("idle");
    expect(!r.alive || r.readyToPrune).toBe(false);
  });

  it("W2 waiting variant: no pid, heartbeat 180s, idle_prompt 60s → attention, alive, not readyToPrune", () => {
    const now = Date.now();
    const dir = seedSession("w2", ago(now, 600_000), { heartbeat: ago(now, 180_000) });
    writeAttention(dir, { type: "idle_prompt", ts: ago(now, 60_000) });
    const r = readAll(now, deadProbe).find((x) => x.session_id === "w2")!;
    expect(r.attention).toBe(true);
    expect(r.alive).toBe(true);
    expect(r.readyToPrune).toBe(false);
  });

  it("W3 bounded by the window: no pid, heartbeat 40 min, asking 31 min → no keepalive", () => {
    const now = Date.now();
    const dir = seedSession("w3", ago(now, 7_200_000), { heartbeat: ago(now, 2_400_000) });
    writeAsking(dir, { ts: ago(now, 1_860_000) });
    const r = readAll(now, deadProbe).find((x) => x.session_id === "w3")!;
    expect(r.asking).toBe(false);
    expect(r.alive).toBe(false);
    expect(r.readyToPrune).toBe(true);
  });

  it("W4 a cleared marker gives no keepalive: resumed newer than the attention ts", () => {
    const now = Date.now();
    const dir = seedSession("w4", ago(now, 600_000), { heartbeat: ago(now, 150_000) });
    writeSidecar(dir, "resumed", ago(now, 150_000));
    writeAttention(dir, { type: "permission_prompt", ts: ago(now, 170_000) });
    const r = readAll(now, deadProbe).find((x) => x.session_id === "w4")!;
    expect(r.attention).toBe(false);
    expect(r.alive).toBe(false);
    expect(r.readyToPrune).toBe(true);
  });

  it("W5 DISC-4: a known pid that probes dead is still reaped despite an active marker", () => {
    const now = Date.now();
    const dir = seedSession("w5", ago(now, 600_000), { pid: 4242, heartbeat: ago(now, 180_000) });
    writeAsking(dir, { ts: ago(now, 60_000) });
    const r = readAll(now, deadProbe).find((x) => x.session_id === "w5")!;
    expect(r.asking).toBe(true);
    expect(r.alive).toBe(false);
    expect(r.readyToPrune).toBe(true);
    expect(r.dotState).toBe("stale");
  });

  it("W6 known-alive pid: an active marker keeps the dot idle instead of stale", () => {
    const now = Date.now();
    const dir = seedSession("w6", ago(now, 600_000), { pid: 4242, heartbeat: ago(now, 180_000) });
    writeAttention(dir, { type: "permission_prompt", ts: ago(now, 60_000) });
    const r = readAll(now, aliveProbe).find((x) => x.session_id === "w6")!;
    expect(r.alive).toBe(true);
    expect(r.readyToPrune).toBe(false);
    expect(r.dotState).toBe("idle");
  });
});

// --- Quick task 260927-46l (D-02..D-04): the running state. A session working a
// turn (turn.json "running") with no file activity must stay alive with a green
// dot even past CSM_STALE_MS, bounded by CSM_RUN_WINDOW_MS; a dead known pid
// still wins; asking and waiting take precedence over running.
describe("running state (260927-46l)", () => {
  function writeTurn(dir: string, snap: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, "turn.json"), JSON.stringify(snap), { mode: 0o600 });
  }
  const ago = (now: number, ms: number) => new Date(now - ms).toISOString();
  const rowOf = (id: string, now: number, probe = deadProbe) =>
    readAll(now, probe).find((x) => x.session_id === id)!;

  beforeEach(() => {
    process.env.CSM_STALE_MS = "120000";
  });

  it("N1 keepalive repro: no pid, heartbeat 300s, turn running 360s → running, alive, active dot, not pruned", () => {
    const now = Date.now();
    const dir = seedSession("n1", ago(now, 600_000), { heartbeat: ago(now, 300_000) });
    writeTurn(dir, { state: "running", ts: ago(now, 360_000) });
    const r = rowOf("n1", now);
    expect(r.running).toBe(true);
    expect(r.alive).toBe(true);
    expect(r.readyToPrune).toBe(false);
    expect(r.dotState).toBe("active");
    expect(r.last_active).toBeUndefined();
    expect(!r.alive || r.readyToPrune).toBe(false);
  });

  it("N2 idle baseline: same fixture with state idle → not running, not alive, readyToPrune, stale dot", () => {
    const now = Date.now();
    const dir = seedSession("n2", ago(now, 600_000), { heartbeat: ago(now, 300_000) });
    writeTurn(dir, { state: "idle", ts: ago(now, 360_000) });
    const r = rowOf("n2", now);
    expect(r.running).toBe(false);
    expect(r.alive).toBe(false);
    expect(r.readyToPrune).toBe(true);
    expect(r.dotState).toBe("stale");
  });

  it("N3 self-heal: missing, torn, unknown state, bad ts, numeric ts → running false, row present", () => {
    const now = Date.now();
    const cases: Array<[string, ((dir: string) => void) | null]> = [
      ["n3-missing", null],
      ["n3-torn", (d) => fs.writeFileSync(path.join(d, "turn.json"), '{"state":"runn', { mode: 0o600 })],
      ["n3-busy", (d) => writeTurn(d, { state: "busy", ts: ago(now, 10_000) })],
      ["n3-badts", (d) => writeTurn(d, { state: "running", ts: "not-a-date" })],
      ["n3-numts", (d) => writeTurn(d, { state: "running", ts: now - 10_000 })],
    ];
    for (const [id, write] of cases) {
      const dir = seedSession(id, ago(now, 600_000), { heartbeat: ago(now, 10_000) });
      if (write) write(dir);
    }
    const rows = readAll(now, deadProbe);
    for (const [id] of cases) {
      const r = rows.find((x) => x.session_id === id);
      expect(r, id).toBeDefined();
      expect(r!.running, id).toBe(false);
    }
  });

  it("N4 window: 31 min expires it; max(turn, heartbeat) rule; override; NaN degrades to 30 min", () => {
    const now = Date.now();
    // Heartbeat absent, turn 31 min ago.
    const a = seedSession("n4-a", ago(now, 7_200_000));
    writeTurn(a, { state: "running", ts: ago(now, 1_860_000) });
    // Heartbeat and turn both 31 min ago.
    const b = seedSession("n4-b", ago(now, 7_200_000), { heartbeat: ago(now, 1_860_000) });
    writeTurn(b, { state: "running", ts: ago(now, 1_860_000) });
    // Turn 40 min ago, heartbeat 10 min ago → the newer reference wins (DISC-5).
    const c = seedSession("n4-c", ago(now, 7_200_000), { heartbeat: ago(now, 600_000) });
    writeTurn(c, { state: "running", ts: ago(now, 2_400_000) });

    let ra = rowOf("n4-a", now);
    expect(ra.running).toBe(false);
    expect(ra.alive).toBe(false);
    const rb = rowOf("n4-b", now);
    expect(rb.running).toBe(false);
    expect(rb.alive).toBe(false);
    expect(rowOf("n4-c", now).running).toBe(true);

    // Override: 60s window.
    process.env.CSM_RUN_WINDOW_MS = "60000";
    const d = seedSession("n4-d", ago(now, 600_000), { heartbeat: ago(now, 90_000) });
    writeTurn(d, { state: "running", ts: ago(now, 90_000) });
    const e = seedSession("n4-e", ago(now, 600_000), { heartbeat: ago(now, 90_000) });
    writeTurn(e, { state: "running", ts: ago(now, 30_000) });
    const rd = rowOf("n4-d", now);
    expect(rd.running).toBe(false);
    expect(rd.alive).toBe(true); // still within the 2-min TTL
    expect(rowOf("n4-e", now).running).toBe(true);

    // NaN override degrades to the 30-min default.
    process.env.CSM_RUN_WINDOW_MS = "abc";
    const f = seedSession("n4-f", ago(now, 7_200_000), { heartbeat: ago(now, 600_000) });
    writeTurn(f, { state: "running", ts: ago(now, 600_000) });
    expect(rowOf("n4-f", now).running).toBe(true);
    ra = rowOf("n4-a", now);
    expect(ra.running).toBe(false);
  });

  it("N5 dead known pid wins: no running, stale dot; old heartbeat → reaped", () => {
    const now = Date.now();
    const a = seedSession("n5-a", ago(now, 600_000), { pid: 4242, heartbeat: ago(now, 10_000) });
    writeTurn(a, { state: "running", ts: ago(now, 10_000) });
    const ra = rowOf("n5-a", now, deadProbe);
    expect(ra.running).toBe(false);
    expect(ra.dotState).toBe("stale");
    expect(ra.alive).toBe(true); // fresh-heartbeat TTL (SC-4)

    const b = seedSession("n5-b", ago(now, 600_000), { pid: 4242, heartbeat: ago(now, 300_000) });
    writeTurn(b, { state: "running", ts: ago(now, 300_000) });
    const rb = rowOf("n5-b", now, deadProbe);
    expect(rb.running).toBe(false);
    expect(rb.alive).toBe(false);
    expect(rb.readyToPrune).toBe(true);
  });

  it("N6 known-alive pid: heartbeat 300s, turn running 300s → running, active dot", () => {
    const now = Date.now();
    const dir = seedSession("n6", ago(now, 600_000), { pid: 4242, heartbeat: ago(now, 300_000) });
    writeTurn(dir, { state: "running", ts: ago(now, 300_000) });
    const r = rowOf("n6", now, aliveProbe);
    expect(r.running).toBe(true);
    expect(r.dotState).toBe("active");
  });

  it("N7 precedence: asking and waiting both force running false (DISC-3/DISC-4)", () => {
    const now = Date.now();
    const a = seedSession("n7-ask", ago(now, 600_000), { heartbeat: ago(now, 30_000) });
    writeTurn(a, { state: "running", ts: ago(now, 60_000) });
    fs.writeFileSync(path.join(a, "asking.json"), JSON.stringify({ ts: ago(now, 5_000) }), { mode: 0o600 });
    const ra = rowOf("n7-ask", now);
    expect(ra.asking).toBe(true);
    expect(ra.running).toBe(false);
    expect(ra.attention).toBe(false);
    expect(ra.alive).toBe(true);
    expect(ra.dotState).toBe("idle");

    const w = seedSession("n7-wait", ago(now, 600_000), { heartbeat: ago(now, 30_000) });
    writeTurn(w, { state: "running", ts: ago(now, 60_000) });
    fs.writeFileSync(
      path.join(w, "attention.json"),
      JSON.stringify({ type: "permission_prompt", ts: ago(now, 5_000) }),
      { mode: 0o600 },
    );
    const rw = rowOf("n7-wait", now);
    expect(rw.attention).toBe(true);
    expect(rw.running).toBe(false);
  });
});
