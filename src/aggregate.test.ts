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
