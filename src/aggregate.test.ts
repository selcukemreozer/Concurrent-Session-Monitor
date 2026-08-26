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
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedSession(id: string, startTime: string): string {
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const state: SessionState = {
    schema_version: 1,
    session_id: id,
    folder: id,
    branch: "main",
    model: "unknown",
    start_time: startTime,
  } as SessionState;
  writeSnapshot(dir, "session.json", state);
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
