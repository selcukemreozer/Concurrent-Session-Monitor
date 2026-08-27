import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// RED until wave 02-03 Task 2 lands src/prune.ts (pruneSession).
import { pruneSession } from "./prune.js";
import { sessionDir, sessionsDir } from "./paths.js";
import { writeSnapshot } from "./store.js";
import { readAll } from "./aggregate.js";
import type { SessionState } from "./schema.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-prune-"));
  process.env.CSM_STORE_DIR = tmp;
});

afterEach(() => {
  delete process.env.CSM_STORE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Seed a minimal shard dir with a session.json snapshot, mirroring aggregate.test.ts. */
function seedShard(id: string): string {
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const state: SessionState = {
    schema_version: 1,
    session_id: id,
    folder: id,
    branch: "main",
    model: "unknown",
    start_time: new Date().toISOString(),
  } as SessionState;
  writeSnapshot(dir, "session.json", state);
  return dir;
}

describe("pruneSession (LIFE-02 reader-side prune)", () => {
  it("idempotency: removes a dead shard and a second prune on the missing shard never throws", () => {
    const dir = seedShard("gone");
    expect(fs.existsSync(dir)).toBe(true);

    pruneSession("gone");
    expect(fs.existsSync(dir)).toBe(false);

    // Second call on an already-gone shard is a no-op, not a throw (force:true + self-heal catch).
    expect(() => pruneSession("gone")).not.toThrow();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("traversal-safety: a crafted parent-hop id cannot rm an external sentinel (T-02-20, WR-01)", () => {
    // Sentinel lives OUTSIDE the store, in a sibling temp dir the prune must never reach.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "csm-sentinel-"));
    const sentinelDir = path.join(outside, "victim");
    const sentinel = path.join(sentinelDir, "keep.txt");
    fs.mkdirSync(sentinelDir, { recursive: true });
    fs.writeFileSync(sentinel, "do-not-delete");

    try {
      // A string of parent-dir hops aimed at the sentinel's location. safeId (via
      // sessionDir) collapses the traversal tokens to a single in-root segment, so
      // rmSync targets a sanitized dir inside sessionsDir(), never the sentinel.
      const craftedId = "../".repeat(6) + "victim";

      expect(() => pruneSession(craftedId)).not.toThrow();

      // The external sentinel survives — the crafted id never escaped the sessions root.
      expect(fs.existsSync(sentinel)).toBe(true);
      // And the resolved target stayed inside the sessions root.
      expect(sessionDir(craftedId).startsWith(sessionsDir())).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("self-heal: a shard re-created after prune is picked up by readAll on the next tick", () => {
    seedShard("reborn");
    pruneSession("reborn");
    expect(fs.existsSync(sessionDir("reborn"))).toBe(false);

    // A live session's next write re-creates its shard (hooks mkdirSync before every write).
    seedShard("reborn");

    const ids = readAll().map((r) => r.session_id);
    expect(ids).toContain("reborn");
  });
});
