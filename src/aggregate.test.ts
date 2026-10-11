import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// RED: aggregate.ts (readAll) + store.ts (writeSnapshot/appendTouch) land in wave 01-02.
import { sessionDir } from "./paths.js";
import { writeSnapshot, appendTouch } from "./store.js";
import { readAll, resolveTitle } from "./aggregate.js";
import { resetTranscriptTitleCache } from "./transcript.js";
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
  delete process.env.CSM_IDLE_WAIT_MS;
  // Phase 7 Pitfall 5: the transcript title cache is module-level and keyed by
  // session id; ids like "alpha" repeat across tests, so reset it every case.
  resetTranscriptTitleCache();
  delete process.env.CLAUDE_CONFIG_DIR;
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
  /** Phase 7 (NAME-01): `title` key of the seeded title.json shard. */
  title?: string;
  /** Phase 7: ISO `ts` of the seeded title.json (defaults to now). */
  titleTs?: string;
  /** Phase 7: `transcript_path` key of the seeded title.json. */
  transcriptPath?: string;
  /** Phase 7: raw title.json bytes written verbatim (torn/malformed cases). */
  titleRaw?: string;
}

/**
 * Write a session's title.json shard (07-01 shape `{ ts, title?, transcript_path? }`),
 * only the keys that were provided.
 */
function writeTitleShard(
  dir: string,
  o: { title?: unknown; titleTs?: string; transcriptPath?: string },
): void {
  const rec: Record<string, unknown> = { ts: o.titleTs ?? new Date().toISOString() };
  if (o.title !== undefined) rec.title = o.title;
  if (o.transcriptPath !== undefined) rec.transcript_path = o.transcriptPath;
  fs.writeFileSync(path.join(dir, "title.json"), JSON.stringify(rec), { mode: 0o600 });
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
  if (opts.titleRaw !== undefined) {
    fs.writeFileSync(path.join(dir, "title.json"), opts.titleRaw, { mode: 0o600 });
  } else if (
    opts.title !== undefined ||
    opts.titleTs !== undefined ||
    opts.transcriptPath !== undefined
  ) {
    writeTitleShard(dir, opts);
  }
  return dir;
}

/**
 * Write a Claude Code transcript under `$CLAUDE_CONFIG_DIR/projects/<slug>/<id>.jsonl`
 * (sets CLAUDE_CONFIG_DIR to `<tmp>/cfg` so the 07-03 path guard accepts it):
 * one compact custom-title line per title plus one user line, each 0x0A
 * terminated, then pins the mtime. Returns the transcript path.
 */
function writeTranscript(id: string, titles: string[], mtimeSec: number, slug = "p"): string {
  const cfg = path.join(tmp, "cfg");
  process.env.CLAUDE_CONFIG_DIR = cfg;
  const dir = path.join(cfg, "projects", slug);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${id}.jsonl`);
  const lines = titles.map((t) =>
    JSON.stringify({ type: "custom-title", customTitle: t, sessionId: id }),
  );
  lines.push(JSON.stringify({ type: "user", sessionId: id, message: { role: "user", content: "hi" } }));
  fs.writeFileSync(p, lines.map((l) => l + "\n").join(""), { mode: 0o600 });
  fs.utimesSync(p, mtimeSec, mtimeSec);
  return p;
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

// 261011-qgi: the CSM_ATTN_WINDOW_MS default is 3_600_000 ms (60 min; was 3 h
// under 261011-or2); these sit one minute either side of it.
const JUST_UNDER_60M = 3_540_000; // 59 min
const JUST_OVER_60M = 3_660_000; // 61 min

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
// the attention ts is BOTH within CSM_ATTN_WINDOW_MS (default 3_600_000 ms — a
// 60-minute safety net, 261011-qgi; was 3 h under 261011-or2 and 30 min under
// 260926-r7n) AND strictly
// NEWER than the session's last
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

  // --- 260926-r7n (AP-02) / 261011-or2 / 261011-qgi: the default window is a 60-minute SAFETY
  // NET, not the primary clear (activity is). A user who answers late must
  // still see ◉.
  it("D1 — default window keeps a long wait visible: attention 10 min ago, no activity since → attention true", () => {
    const now = Date.now();
    const dir = seedSession("at-long-wait", new Date(now - 3_600_000).toISOString(), {
      heartbeat: new Date(now - 1_200_000).toISOString(),
    });
    writeAttention(dir, { type: "permission_prompt", ts: new Date(now - 600_000).toISOString() });

    const row = readAll(now).find((r) => r.session_id === "at-long-wait")!;
    expect(row.attention).toBe(true);
  });

  it("D2 — default 60-min ceiling expires: attention 61 min ago → attention false", () => {
    const now = Date.now();
    const dir = seedSession("at-safety-net", new Date(now - 14_400_000).toISOString(), {
      heartbeat: new Date(now - 4_200_000).toISOString(),
    });
    writeAttention(dir, { type: "permission_prompt", ts: new Date(now - JUST_OVER_60M).toISOString() });

    const row = readAll(now).find((r) => r.session_id === "at-safety-net")!;
    expect(row.attention).toBe(false);
  });

  it("D2b — default 60-min ceiling still holds: attention 59 min ago → attention true", () => {
    const now = Date.now();
    const dir = seedSession("at-under-ceiling", new Date(now - 14_400_000).toISOString(), {
      heartbeat: new Date(now - 4_200_000).toISOString(),
    });
    writeAttention(dir, { type: "permission_prompt", ts: new Date(now - JUST_UNDER_60M).toISOString() });

    const row = readAll(now).find((r) => r.session_id === "at-under-ceiling")!;
    expect(row.attention).toBe(true);
  });

  it("D2c — a known-alive pid does NOT lift the waiting ceiling: attention 61 min ago → attention false", () => {
    const now = Date.now();
    const dir = seedSession("at-alive-ceiling", new Date(now - 14_400_000).toISOString(), {
      pid: 4242,
      heartbeat: new Date(now - 4_200_000).toISOString(),
    });
    writeAttention(dir, { type: "permission_prompt", ts: new Date(now - JUST_OVER_60M).toISOString() });

    const row = readAll(now, aliveProbe).find((r) => r.session_id === "at-alive-ceiling")!;
    expect(row.attention).toBe(false);
    expect(row.alive).toBe(true); // shown via the alive pid, just without ◉
  });

  it("D3 — an invalid override (NaN) degrades to the 60-min default: attention 10 min ago → attention true", () => {
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

  it("A4 default 60-min ceiling for a pid CSM cannot confirm: no pid, asking 10 min / 59 min ago → true; 61 min ago → false", () => {
    const now = Date.now();
    const d1 = seedSession("ask-long", new Date(now - 3_600_000).toISOString(), {
      heartbeat: new Date(now - 1_200_000).toISOString(),
    });
    writeAsking(d1, { ts: new Date(now - 600_000).toISOString() });
    const d2 = seedSession("ask-under-60m", new Date(now - 14_400_000).toISOString(), {
      heartbeat: new Date(now - 4_200_000).toISOString(),
    });
    writeAsking(d2, { ts: new Date(now - JUST_UNDER_60M).toISOString() });
    const d3 = seedSession("ask-net", new Date(now - 14_400_000).toISOString(), {
      heartbeat: new Date(now - 4_200_000).toISOString(),
    });
    writeAsking(d3, { ts: new Date(now - JUST_OVER_60M).toISOString() });

    expect(askRow("ask-long", now)!.asking).toBe(true);
    expect(askRow("ask-under-60m", now)!.asking).toBe(true);
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

  // --- 261011-or2 (D-2): while the pid verdict is "alive" an open question has
  // NO time ceiling; only the ask-resolved sidecar (answer / main-thread Stop /
  // new prompt) or the lastSeenMs fallback clears it.
  it("A8 alive pid: asking 4 h ago stays asking (no ceiling), the row is kept and not prunable", () => {
    const now = Date.now();
    const askTs = new Date(now - 14_400_000).toISOString();
    const dir = seedSession("ask-alive-4h", new Date(now - 18_000_000).toISOString(), {
      pid: 4242,
      heartbeat: new Date(now - 14_400_000).toISOString(),
    });
    writeAsking(dir, { ts: askTs });
    // ask-resolved older than the question (a prior, already-answered one).
    fs.writeFileSync(path.join(dir, "ask-resolved"), new Date(now - 15_000_000).toISOString(), { mode: 0o600 });

    const row = readAll(now, aliveProbe).find((r) => r.session_id === "ask-alive-4h")!;
    expect(row.asking).toBe(true);
    expect(row.asking_ts).toBe(askTs);
    expect(row.alive).toBe(true);
    expect(row.readyToPrune).toBe(false);
    expect(row.dotState).toBe("idle"); // keepalive keeps it fresh
  });

  it("A8b alive pid ignores even an explicit ceiling: CSM_ATTN_WINDOW_MS=60000, asking 120s ago → asking true", () => {
    process.env.CSM_ATTN_WINDOW_MS = "60000";
    const now = Date.now();
    const dir = seedSession("ask-alive-override", new Date(now - 600_000).toISOString(), {
      pid: 4242,
      heartbeat: new Date(now - 300_000).toISOString(),
    });
    writeAsking(dir, { ts: new Date(now - 120_000).toISOString() });

    const row = readAll(now, aliveProbe).find((r) => r.session_id === "ask-alive-override")!;
    expect(row.asking).toBe(true);
  });

  it("A8c alive pid: an ask-resolved sidecar newer than the 4 h-old question still clears it", () => {
    const now = Date.now();
    const dir = seedSession("ask-alive-answered", new Date(now - 18_000_000).toISOString(), {
      pid: 4242,
      heartbeat: new Date(now - 14_400_000).toISOString(),
    });
    writeAsking(dir, { ts: new Date(now - 14_400_000).toISOString() });
    fs.writeFileSync(path.join(dir, "ask-resolved"), new Date(now - 14_000_000).toISOString(), { mode: 0o600 });

    const row = readAll(now, aliveProbe).find((r) => r.session_id === "ask-alive-answered")!;
    expect(row.asking).toBe(false);
    expect(row.asking_ts).toBeUndefined();
  });

  it("A9 dead pid: asking 4 h ago is past the 60-min ceiling → asking false", () => {
    const now = Date.now();
    const dir = seedSession("ask-dead-4h", new Date(now - 18_000_000).toISOString(), {
      pid: 4242,
      heartbeat: new Date(now - 14_400_000).toISOString(),
    });
    writeAsking(dir, { ts: new Date(now - 14_400_000).toISOString() });
    const noPid = seedSession("ask-nopid-4h", new Date(now - 18_000_000).toISOString(), {
      heartbeat: new Date(now - 14_400_000).toISOString(),
    });
    writeAsking(noPid, { ts: new Date(now - 14_400_000).toISOString() });

    const rows = readAll(now, deadProbe);
    expect(rows.find((r) => r.session_id === "ask-dead-4h")!.asking).toBe(false);
    // No pid (verdict unknown) is bounded by the ceiling too.
    expect(rows.find((r) => r.session_id === "ask-nopid-4h")!.asking).toBe(false);
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
// Bounded by CSM_ATTN_WINDOW_MS through the marker gate (waiting always; asking
// only when the pid is not alive — 261011-or2, an alive pid already keeps the
// row listed); an authoritatively dead pid is still reaped (DISC-4).
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

  it("W3 bounded by the window: no pid, heartbeat 70 min, asking 61 min → no keepalive", () => {
    const now = Date.now();
    const dir = seedSession("w3", ago(now, 14_400_000), { heartbeat: ago(now, 4_200_000) });
    writeAsking(dir, { ts: ago(now, JUST_OVER_60M) });
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

  it("N2 idle turn (260927-4tv): not running; idle-waiting keeps it alive as waiting", () => {
    const now = Date.now();
    const dir = seedSession("n2", ago(now, 600_000), { heartbeat: ago(now, 300_000) });
    writeTurn(dir, { state: "idle", ts: ago(now, 360_000) });
    const r = rowOf("n2", now);
    expect(r.running).toBe(false);
    expect(r.attention).toBe(true);
    expect(r.attention_type).toBe("idle_prompt");
    expect(r.alive).toBe(true);
    expect(r.readyToPrune).toBe(false);
    expect(r.dotState).toBe("idle");
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

// --- Quick task 260927-4tv (D-02..D-05): idle-waiting. Once a main-thread Stop
// has left turn.json "idle" for at least CSM_IDLE_WAIT_MS (default 1s since
// 261011-or2; was 10s), the session shows ◉ waiting without waiting for Claude
// Code's ~60s idle_prompt Notification. Bounded by the CSM_ATTN_WINDOW_MS 60-min
// ceiling (even for an alive pid); a dead known pid never
// idle-waits; asking still wins; a Notification's own type/ts win when both hold.
describe("idle-waiting (260927-4tv)", () => {
  function writeTurn(dir: string, snap: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, "turn.json"), JSON.stringify(snap), { mode: 0o600 });
  }
  const ago = (now: number, ms: number) => new Date(now - ms).toISOString();
  const rowOf = (id: string, now: number, probe = deadProbe) =>
    readAll(now, probe).find((x) => x.session_id === id)!;

  beforeEach(() => {
    process.env.CSM_STALE_MS = "120000";
  });

  it("I1 threshold: idle 500ms → not waiting; idle 1.5s → waiting idle_prompt with the turn ts; future ts → not waiting", () => {
    const now = Date.now();
    const a = seedSession("i1-500ms", ago(now, 600_000), { heartbeat: ago(now, 500) });
    writeTurn(a, { state: "idle", ts: ago(now, 500) });
    const ra = rowOf("i1-500ms", now);
    expect(ra.attention).toBe(false);
    expect(ra.running).toBe(false);

    const b = seedSession("i1-1500ms", ago(now, 600_000), { heartbeat: ago(now, 1_500) });
    const turnTs = ago(now, 1_500);
    writeTurn(b, { state: "idle", ts: turnTs });
    const rb = rowOf("i1-1500ms", now);
    expect(rb.attention).toBe(true);
    expect(rb.attention_type).toBe("idle_prompt");
    expect(rb.attention_ts).toBe(turnTs);
    expect(rb.running).toBe(false);
    expect(rb.asking).toBe(false);

    const c = seedSession("i1-future", ago(now, 600_000), { heartbeat: ago(now, 5_000) });
    writeTurn(c, { state: "idle", ts: new Date(now + 5_000).toISOString() });
    expect(rowOf("i1-future", now).attention).toBe(false);
  });

  it("I2 keepalive with a known-alive pid: heartbeat 300s, idle 300s → waiting, alive, not readyToPrune, idle dot", () => {
    const now = Date.now();
    const dir = seedSession("i2", ago(now, 600_000), { pid: 4242, heartbeat: ago(now, 300_000) });
    writeTurn(dir, { state: "idle", ts: ago(now, 300_000) });
    const r = rowOf("i2", now, aliveProbe);
    expect(r.attention).toBe(true);
    expect(r.alive).toBe(true);
    expect(r.readyToPrune).toBe(false);
    expect(r.dotState).toBe("idle");
  });

  it("I3 ceiling: idle 59 min → waiting + alive; 61 min → no waiting, reaped; alive pid at 61 min → no waiting; CSM_ATTN_WINDOW_MS=60000 caps it", () => {
    const now = Date.now();
    const u = seedSession("i3-under", ago(now, 14_400_000), { heartbeat: ago(now, JUST_UNDER_60M) });
    writeTurn(u, { state: "idle", ts: ago(now, JUST_UNDER_60M) });
    const ru = rowOf("i3-under", now);
    expect(ru.attention).toBe(true);
    expect(ru.alive).toBe(true); // needs-you keepalive
    expect(ru.readyToPrune).toBe(false);

    const a = seedSession("i3-a", ago(now, 14_400_000), { heartbeat: ago(now, JUST_OVER_60M) });
    writeTurn(a, { state: "idle", ts: ago(now, JUST_OVER_60M) });
    const ra = rowOf("i3-a", now);
    expect(ra.attention).toBe(false);
    expect(ra.alive).toBe(false);
    expect(ra.readyToPrune).toBe(true);

    const p = seedSession("i3-alive", ago(now, 14_400_000), { pid: 4242, heartbeat: ago(now, JUST_OVER_60M) });
    writeTurn(p, { state: "idle", ts: ago(now, JUST_OVER_60M) });
    const rp = rowOf("i3-alive", now, aliveProbe);
    expect(rp.attention).toBe(false); // an alive pid does not lift the waiting ceiling
    expect(rp.alive).toBe(true);

    process.env.CSM_ATTN_WINDOW_MS = "60000";
    const b = seedSession("i3-b", ago(now, 600_000), { heartbeat: ago(now, 90_000) });
    writeTurn(b, { state: "idle", ts: ago(now, 90_000) });
    const rb = rowOf("i3-b", now);
    expect(rb.attention).toBe(false);
    expect(rb.alive).toBe(true); // still within the 2-min TTL
  });

  it("I4 CSM_IDLE_WAIT_MS override; NaN/negative degrade to 1s; 0 accepted", () => {
    const now = Date.now();
    const mk = (id: string, idleMs: number) => {
      const dir = seedSession(id, ago(now, 600_000), { heartbeat: ago(now, 5_000) });
      writeTurn(dir, { state: "idle", ts: ago(now, idleMs) });
    };
    process.env.CSM_IDLE_WAIT_MS = "60000";
    mk("i4-30s", 30_000);
    mk("i4-90s", 90_000);
    expect(rowOf("i4-30s", now).attention).toBe(false);
    expect(rowOf("i4-90s", now).attention).toBe(true);

    mk("i4-1500ms", 1_500);
    mk("i4-500ms", 500);
    for (const bad of ["abc", "-5"]) {
      process.env.CSM_IDLE_WAIT_MS = bad;
      expect(rowOf("i4-1500ms", now).attention, bad).toBe(true);
      expect(rowOf("i4-500ms", now).attention, bad).toBe(false);
    }

    process.env.CSM_IDLE_WAIT_MS = "0";
    mk("i4-200ms", 200);
    expect(rowOf("i4-200ms", now).attention).toBe(true);
  });

  it("I5 dead known pid never idle-waits: fresh heartbeat → stale dot but alive; old heartbeat → reaped", () => {
    const now = Date.now();
    const a = seedSession("i5-a", ago(now, 600_000), { pid: 4242, heartbeat: ago(now, 5_000) });
    writeTurn(a, { state: "idle", ts: ago(now, 20_000) });
    const ra = rowOf("i5-a", now, deadProbe);
    expect(ra.attention).toBe(false);
    expect(ra.dotState).toBe("stale");
    expect(ra.alive).toBe(true); // fresh-heartbeat TTL (SC-4)

    const b = seedSession("i5-b", ago(now, 600_000), { pid: 4242, heartbeat: ago(now, 300_000) });
    writeTurn(b, { state: "idle", ts: ago(now, 300_000) });
    const rb = rowOf("i5-b", now, deadProbe);
    expect(rb.attention).toBe(false);
    expect(rb.alive).toBe(false);
    expect(rb.readyToPrune).toBe(true);
  });

  it("I6 self-heal: missing, torn, unknown state, bad ts, numeric ts, running → no idle-waiting, row present", () => {
    const now = Date.now();
    const cases: Array<[string, ((dir: string) => void) | null]> = [
      ["i6-missing", null],
      ["i6-torn", (d) => fs.writeFileSync(path.join(d, "turn.json"), '{"state":"idl', { mode: 0o600 })],
      ["i6-done", (d) => writeTurn(d, { state: "done", ts: ago(now, 20_000) })],
      ["i6-badts", (d) => writeTurn(d, { state: "idle", ts: "not-a-date" })],
      ["i6-numts", (d) => writeTurn(d, { state: "idle", ts: now - 20_000 })],
      ["i6-running", (d) => writeTurn(d, { state: "running", ts: ago(now, 20_000) })],
    ];
    for (const [id, write] of cases) {
      const dir = seedSession(id, ago(now, 600_000), { heartbeat: ago(now, 5_000) });
      if (write) write(dir);
    }
    const rows = readAll(now, deadProbe);
    for (const [id] of cases) {
      const r = rows.find((x) => x.session_id === id);
      expect(r, id).toBeDefined();
      expect(r!.attention, id).toBe(false);
    }
    expect(rows.find((x) => x.session_id === "i6-running")!.running).toBe(true);
  });

  it("I7 precedence: an open question beats idle-waiting", () => {
    const now = Date.now();
    const dir = seedSession("i7", ago(now, 600_000), { heartbeat: ago(now, 30_000) });
    writeTurn(dir, { state: "idle", ts: ago(now, 20_000) });
    fs.writeFileSync(path.join(dir, "asking.json"), JSON.stringify({ ts: ago(now, 5_000) }), { mode: 0o600 });
    const r = rowOf("i7", now);
    expect(r.asking).toBe(true);
    expect(r.attention).toBe(false);
    expect(r.attention_type).toBeUndefined();
    expect(r.attention_ts).toBeUndefined();
    expect(r.running).toBe(false);
  });

  it("I8 Notification wins type/ts when it and idle-waiting both hold", () => {
    const now = Date.now();
    const dir = seedSession("i8", ago(now, 600_000), { heartbeat: ago(now, 60_000) });
    writeTurn(dir, { state: "idle", ts: ago(now, 60_000) });
    fs.writeFileSync(path.join(dir, "resumed"), ago(now, 60_000), { mode: 0o600 });
    const notifTs = ago(now, 30_000);
    fs.writeFileSync(
      path.join(dir, "attention.json"),
      JSON.stringify({ type: "permission_prompt", ts: notifTs }),
      { mode: 0o600 },
    );
    const r = rowOf("i8", now);
    expect(r.attention).toBe(true);
    expect(r.attention_type).toBe("permission_prompt");
    expect(r.attention_ts).toBe(notifTs);
  });
});

// --- Quick task 260927-73b (D-03): subagent state. A main-thread Stop that
// recorded still-running background subagents/workflows (turn.json idle with
// agents > 0) shows ↻ subagent instead of idle-waiting / an idle_prompt
// Notification, bounded by CSM_RUN_WINDOW_MS from max(turn ts, heartbeat). A
// permission prompt and asking still win; a dead known pid never shows it.
describe("subagent state (260927-73b)", () => {
  function writeTurn(dir: string, snap: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, "turn.json"), JSON.stringify(snap), { mode: 0o600 });
  }
  const ago = (now: number, ms: number) => new Date(now - ms).toISOString();
  const rowOf = (id: string, now: number, probe = deadProbe) =>
    readAll(now, probe).find((x) => x.session_id === id)!;

  beforeEach(() => {
    process.env.CSM_STALE_MS = "120000";
  });

  it("A1 gate on: idle turn 20s with agents 2 → subagent ×2, no idle-waiting, active dot", () => {
    const now = Date.now();
    const dir = seedSession("a1", ago(now, 600_000), { heartbeat: ago(now, 5_000) });
    writeTurn(dir, { state: "idle", ts: ago(now, 20_000), agents: 2 });
    const r = rowOf("a1", now);
    expect(r.subagent).toBe(true);
    expect(r.subagent_count).toBe(2);
    expect(r.attention).toBe(false);
    expect(r.attention_type).toBeUndefined();
    expect(r.attention_ts).toBeUndefined();
    expect(r.running).toBe(false);
    expect(r.asking).toBe(false);
    expect(r.dotState).toBe("active");
    expect(r.alive).toBe(true);
  });

  it("A2 gate off: missing/0/string/negative/fraction/null agents, a running turn, or no turn.json", () => {
    const now = Date.now();
    const variants: Array<[string, unknown]> = [
      ["a2-missing", undefined],
      ["a2-zero", 0],
      ["a2-str", "2"],
      ["a2-neg", -1],
      ["a2-frac", 1.5],
      ["a2-null", null],
    ];
    for (const [id, agents] of variants) {
      const dir = seedSession(id, ago(now, 600_000), { heartbeat: ago(now, 5_000) });
      const snap: Record<string, unknown> = { state: "idle", ts: ago(now, 20_000) };
      if (agents !== undefined) snap.agents = agents;
      writeTurn(dir, snap);
      const r = rowOf(id, now);
      expect(r.subagent, id).toBe(false);
      expect(r.subagent_count, id).toBeUndefined();
      expect(r.attention, id).toBe(true);
    }

    const run = seedSession("a2-running", ago(now, 600_000), { heartbeat: ago(now, 5_000) });
    writeTurn(run, { state: "running", ts: ago(now, 20_000), agents: 2 });
    const rr = rowOf("a2-running", now);
    expect(rr.running).toBe(true);
    expect(rr.subagent).toBe(false);

    seedSession("a2-noturn", ago(now, 600_000), { heartbeat: ago(now, 5_000) });
    expect(rowOf("a2-noturn", now).subagent).toBe(false);
  });

  it("A3 an idle_prompt Notification is suppressed while the subagent gate holds", () => {
    const now = Date.now();
    const dir = seedSession("a3", ago(now, 600_000), { heartbeat: ago(now, 5_000) });
    writeTurn(dir, { state: "idle", ts: ago(now, 90_000), agents: 1 });
    fs.writeFileSync(path.join(dir, "resumed"), ago(now, 90_000), { mode: 0o600 });
    fs.writeFileSync(
      path.join(dir, "attention.json"),
      JSON.stringify({ type: "idle_prompt", ts: ago(now, 30_000) }),
      { mode: 0o600 },
    );
    const r = rowOf("a3", now);
    expect(r.subagent).toBe(true);
    expect(r.attention).toBe(false);
  });

  it("A4 a permission_prompt (or generic waiting) Notification still wins over subagent", () => {
    const now = Date.now();
    for (const type of ["permission_prompt", "waiting"]) {
      const id = `a4-${type}`;
      const dir = seedSession(id, ago(now, 600_000), { heartbeat: ago(now, 5_000) });
      writeTurn(dir, { state: "idle", ts: ago(now, 90_000), agents: 1 });
      fs.writeFileSync(path.join(dir, "resumed"), ago(now, 90_000), { mode: 0o600 });
      const notifTs = ago(now, 30_000);
      fs.writeFileSync(path.join(dir, "attention.json"), JSON.stringify({ type, ts: notifTs }), { mode: 0o600 });
      const r = rowOf(id, now);
      expect(r.attention, type).toBe(true);
      expect(r.attention_type, type).toBe(type);
      expect(r.attention_ts, type).toBe(notifTs);
      expect(r.subagent, type).toBe(false);
      expect(r.subagent_count, type).toBeUndefined();
    }
  });

  it("A5 an open question beats subagent", () => {
    const now = Date.now();
    const dir = seedSession("a5", ago(now, 600_000), { heartbeat: ago(now, 30_000) });
    writeTurn(dir, { state: "idle", ts: ago(now, 20_000), agents: 1 });
    fs.writeFileSync(path.join(dir, "asking.json"), JSON.stringify({ ts: ago(now, 5_000) }), { mode: 0o600 });
    const r = rowOf("a5", now);
    expect(r.asking).toBe(true);
    expect(r.subagent).toBe(false);
    expect(r.attention).toBe(false);
  });

  it("A6 expiry measured from max(turn ts, heartbeat); falls back to idle-waiting / TTL", () => {
    const now = Date.now();
    process.env.CSM_RUN_WINDOW_MS = "60000";
    const a = seedSession("a6-a", ago(now, 600_000), { heartbeat: ago(now, 90_000) });
    writeTurn(a, { state: "idle", ts: ago(now, 90_000), agents: 1 });
    const ra = rowOf("a6-a", now);
    expect(ra.subagent).toBe(false);
    expect(ra.attention).toBe(true);
    expect(ra.alive).toBe(true); // 2-min TTL

    const b = seedSession("a6-b", ago(now, 600_000), { heartbeat: ago(now, 30_000) });
    writeTurn(b, { state: "idle", ts: ago(now, 90_000), agents: 1 });
    expect(rowOf("a6-b", now).subagent).toBe(true);

    delete process.env.CSM_RUN_WINDOW_MS;
    // 261011-or2 / 261011-qgi: past both the 30-min run window AND the 60-min idle-waiting
    // ceiling, so neither subagent nor the idle-waiting fallback holds.
    const c = seedSession("a6-c", ago(now, 14_400_000), { heartbeat: ago(now, JUST_OVER_60M) });
    writeTurn(c, { state: "idle", ts: ago(now, JUST_OVER_60M), agents: 1 });
    const rc = rowOf("a6-c", now);
    expect(rc.subagent).toBe(false);
    expect(rc.alive).toBe(false);
    expect(rc.readyToPrune).toBe(true);
  });

  it("A7 keepalive isolated from idle-waiting (attn window 60s): subagent keeps the row alive + active", () => {
    const now = Date.now();
    process.env.CSM_ATTN_WINDOW_MS = "60000";
    const a = seedSession("a7-a", ago(now, 600_000), { heartbeat: ago(now, 300_000) });
    writeTurn(a, { state: "idle", ts: ago(now, 300_000), agents: 1 });
    const b = seedSession("a7-b", ago(now, 600_000), { pid: 4242, heartbeat: ago(now, 300_000) });
    writeTurn(b, { state: "idle", ts: ago(now, 300_000), agents: 1 });
    for (const [id, probe] of [
      ["a7-a", deadProbe],
      ["a7-b", aliveProbe],
    ] as const) {
      const r = rowOf(id, now, probe);
      expect(r.subagent, id).toBe(true);
      expect(r.alive, id).toBe(true);
      expect(r.readyToPrune, id).toBe(false);
      expect(r.dotState, id).toBe("active");
    }
  });

  it("A8 a dead known pid never shows subagent", () => {
    const now = Date.now();
    const a = seedSession("a8-a", ago(now, 600_000), { pid: 4242, heartbeat: ago(now, 5_000) });
    writeTurn(a, { state: "idle", ts: ago(now, 20_000), agents: 2 });
    const ra = rowOf("a8-a", now, deadProbe);
    expect(ra.subagent).toBe(false);
    expect(ra.subagent_count).toBeUndefined();
    expect(ra.dotState).toBe("stale");
    expect(ra.alive).toBe(true); // fresh-heartbeat TTL

    const b = seedSession("a8-b", ago(now, 600_000), { pid: 4242, heartbeat: ago(now, 300_000) });
    writeTurn(b, { state: "idle", ts: ago(now, 300_000), agents: 2 });
    const rb = rowOf("a8-b", now, deadProbe);
    expect(rb.alive).toBe(false);
    expect(rb.readyToPrune).toBe(true);
  });
});

describe("session title (NAME-01, D-02/D-03/D-04/D-10)", () => {
  const rowById = (id: string) => {
    const r = readAll().find((x) => x.session_id === id);
    expect(r).toBeDefined();
    return r!;
  };

  it("A1: title.json title only -> row.title", () => {
    seedSession("alpha", new Date().toISOString(), { title: "Alpha" });
    expect(rowById("alpha").title).toBe("Alpha");
  });

  it("A2: no title.json -> title undefined, row still returned", () => {
    seedSession("alpha", new Date().toISOString());
    expect(rowById("alpha").title).toBeUndefined();
  });

  it("A3: torn/malformed title.json -> title undefined, row present (T-07-10)", () => {
    seedSession("alpha", new Date().toISOString(), { titleRaw: "{not json" });
    expect(rowById("alpha").title).toBeUndefined();
  });

  it("A4: empty or non-string title -> title undefined", () => {
    const now = new Date().toISOString();
    const a = seedSession("alpha", now);
    writeTitleShard(a, { title: "" });
    const b = seedSession("beta", now);
    writeTitleShard(b, { title: 42 });
    expect(rowById("alpha").title).toBeUndefined();
    expect(rowById("beta").title).toBeUndefined();
  });

  it("A5 (D-04): a live transcript /rename seen after the baseline scan wins over an older title.json title", () => {
    const p = writeTranscript("alpha", ["Old"], 1700000030);
    seedSession("alpha", new Date().toISOString(), {
      title: "Old",
      titleTs: new Date(1700000000000).toISOString(),
      transcriptPath: p,
    });
    expect(rowById("alpha").title).toBe("Old"); // baseline scan
    writeTranscript("alpha", ["Old", "New"], 1700000060); // live /rename appends
    expect(rowById("alpha").title).toBe("New");
  });

  it("A5b (WR-01): on a cold cache a transcript mtime LATER than title.json.ts does not beat h.title", () => {
    // The transcript is appended after every assistant message, so its mtime is
    // almost always newer than the last prompt's title.json ts; that mtime says
    // nothing about when the custom-title line was written.
    const p = writeTranscript("alpha", ["A"], 1700000300);
    seedSession("alpha", new Date().toISOString(), {
      title: "C",
      titleTs: new Date(1700000000000).toISOString(),
      transcriptPath: p,
    });
    expect(rowById("alpha").title).toBe("C");
    // A panel restart (cache reset) keeps showing the documented record.
    resetTranscriptTitleCache();
    expect(rowById("alpha").title).toBe("C");
  });

  it("A5c (WR-01): a baseline tail value still wins when title.json has no parseable ts", () => {
    const p = writeTranscript("alpha", ["Tail"], 1700000300);
    seedSession("alpha", new Date().toISOString(), {
      titleRaw: JSON.stringify({ title: "Hook", transcript_path: p }),
    });
    expect(rowById("alpha").title).toBe("Tail");
  });

  it("A6 (D-02/D-03): a newer title.json without a title overrides an older tail value", () => {
    const p = writeTranscript("alpha", ["Z"], 1700000060);
    seedSession("alpha", new Date().toISOString(), {
      titleTs: new Date(1700000120000).toISOString(),
      transcriptPath: p,
    });
    expect(rowById("alpha").title).toBeUndefined();
  });

  it("A7: a newer title.json title wins over a stale transcript value", () => {
    const p = writeTranscript("alpha", ["Stale"], 1700000060);
    seedSession("alpha", new Date().toISOString(), {
      title: "Fresh",
      titleTs: new Date(1700000120000).toISOString(),
      transcriptPath: p,
    });
    expect(rowById("alpha").title).toBe("Fresh");
  });

  it("A8 (D-10): a /clear session in the same project dir never inherits the old name", () => {
    const oldP = writeTranscript("old-s", [], 1700000030, "proj");
    const newP = writeTranscript("new-s", [], 1700000090, "proj");
    const ts = new Date(1700000000000).toISOString();
    seedSession("old-s", new Date().toISOString(), { titleTs: ts, transcriptPath: oldP });
    seedSession("new-s", new Date().toISOString(), { titleTs: ts, transcriptPath: newP });
    readAll(); // baseline scan of both transcripts
    writeTranscript("old-s", ["Kept"], 1700000060, "proj"); // live /rename in the old session
    const rows = readAll();
    expect(rows.find((r) => r.session_id === "new-s")?.title).toBeUndefined();
    expect(rows.find((r) => r.session_id === "old-s")?.title).toBe("Kept");
  });

  it("A9 (T-07-03): a transcript_path outside the projects roots is ignored", () => {
    writeTranscript("other", [], 1700000000); // sets CLAUDE_CONFIG_DIR to a real root
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "csm-agg-out-"));
    try {
      const p = path.join(outside, "alpha.jsonl");
      fs.writeFileSync(
        p,
        JSON.stringify({ type: "custom-title", customTitle: "Evil", sessionId: "alpha" }) + "\n",
        { mode: 0o600 },
      );
      fs.utimesSync(p, 1700000060, 1700000060);
      seedSession("alpha", new Date().toISOString(), {
        title: "Safe",
        titleTs: new Date(1700000000000).toISOString(),
        transcriptPath: p,
      });
      expect(rowById("alpha").title).toBe("Safe");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("A10: title never changes sort order, alive, readyToPrune or dotState", () => {
    const now = Date.now();
    const a = seedSession("aaa-sess", new Date(now - 60_000).toISOString());
    const b = seedSession("bbb-sess", new Date(now - 30_000).toISOString());
    const snap = () =>
      readAll(now).map((r) => ({
        id: r.session_id,
        alive: r.alive,
        readyToPrune: r.readyToPrune,
        dotState: r.dotState,
      }));
    const before = snap();
    writeTitleShard(a, { title: "Zzz" });
    writeTitleShard(b, { title: "Aaa" });
    const after = snap();
    expect(after).toEqual(before);
    const titled = readAll(now);
    expect(titled.map((r) => r.title)).toEqual(
      before.map((r) => (r.id === "aaa-sess" ? "Zzz" : "Aaa")),
    );
  });

  it("A11: resolveTitle freshness table (Pattern 3)", () => {
    const t = (title: string, changedAtMs: number) => ({ title, changedAtMs });
    expect(resolveTitle({ title: "X", tsMs: 10 }, t("Y", 20))).toBe("Y");
    expect(resolveTitle({ title: "X", tsMs: 30 }, t("Y", 20))).toBe("X");
    expect(resolveTitle({ tsMs: 30 }, t("Y", 20))).toBeUndefined();
    expect(resolveTitle({}, t("Y", 20))).toBe("Y");
    expect(resolveTitle({ title: "X", tsMs: 10 }, undefined)).toBe("X");
    expect(resolveTitle({}, undefined)).toBeUndefined();
    expect(resolveTitle({ title: "X" }, t("Y", 20))).toBe("Y");
    expect(resolveTitle({ title: "X", tsMs: 20 }, t("Y", 20))).toBe("X");
  });
});
