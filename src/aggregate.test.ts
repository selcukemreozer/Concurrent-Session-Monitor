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
  fs.rmSync(tmp, { recursive: true, force: true });
});

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
