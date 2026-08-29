import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// RED: the done writer does not exist yet. It lands in Task 2 (GREEN):
//   scripts/csm-done.mjs  (INT-01 done gesture — clears intent.txt AND appends
//   released:true events to files.jsonl, without ever touching session.json).
// The command runs it as `node csm-done.mjs "<session_id>"` (argv[2] = id only,
// no $ARGUMENTS) — mirror src/csm-intent.test.ts's spawnSync harness.
//
// readAll is imported directly and reads CSM_STORE_DIR from process.env (set in
// beforeEach), so it aggregates the same temp store the spawned writer mutates.
import { readAll } from "./aggregate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const csmDone = path.join(repoRoot, "scripts", "csm-done.mjs");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-done-"));
  process.env.CSM_STORE_DIR = tmp;
  // Pin the active write window so seeded now-based touches are in-window for
  // both the in-process readAll and the spawned writer (which reduces to the
  // currently-active write paths to release them).
  process.env.CSM_WINDOW_MS = "300000"; // 5 min
});

afterEach(() => {
  delete process.env.CSM_STORE_DIR;
  delete process.env.CSM_WINDOW_MS;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runDone(sessionId: string, storeDir: string) {
  return spawnSync(process.execPath, [csmDone, sessionId], {
    env: { ...process.env, CSM_STORE_DIR: storeDir },
    encoding: "utf8",
  });
}

function sessDir(id: string): string {
  return path.join(tmp, "sessions", id);
}

interface SeedOpts {
  intent?: string;
  writes?: { file_path: string; ts: string }[];
}

/** Seed a live session shard (session.json + optional intent.txt + writes). */
function seed(id: string, opts: SeedOpts = {}): string {
  const dir = sessDir(id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const state = {
    schema_version: 1,
    session_id: id,
    folder: id,
    branch: "main",
    model: "unknown",
    start_time: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify(state), { mode: 0o600 });
  if (opts.intent !== undefined) {
    fs.writeFileSync(
      path.join(dir, "intent.txt"),
      JSON.stringify({ intent: opts.intent, ts: new Date().toISOString() }),
      { mode: 0o600 },
    );
  }
  for (const w of opts.writes ?? []) {
    fs.appendFileSync(path.join(dir, "files.jsonl"), JSON.stringify(w) + "\n", { mode: 0o600 });
  }
  return dir;
}

function rowFor(id: string) {
  return readAll().find((r) => r.session_id === id);
}

describe("csm-done writer (INT-01, D-03)", () => {
  it("clears intent, releases active write files, and leaves session.json unchanged", () => {
    const id = "done-sess";
    const now = Date.now();
    const dir = seed(id, {
      intent: "refactor Card",
      writes: [{ file_path: "/repo/a.ts", ts: new Date(now).toISOString() }],
    });

    // Precondition: intent surfaced and the write file is active before done.
    const before = rowFor(id)!;
    expect(before.intent).toBe("refactor Card");
    expect(before.files.map((f) => f.file_path)).toContain("/repo/a.ts");

    // Capture session.json bytes to prove the writer never touches it (D-01/D-03).
    const sessionJsonPath = path.join(dir, "session.json");
    const sessionBytesBefore = fs.readFileSync(sessionJsonPath);

    const res = runDone(id, tmp);
    expect(res.status).toBe(0);

    const after = rowFor(id)!;
    // (1) intent cleared -> undefined (D-03).
    expect(after.intent).toBeUndefined();
    // (2) the previously-active write file is released -> gone from files[] (D-03).
    expect(after.files.map((f) => f.file_path)).not.toContain("/repo/a.ts");
    // (3) session.json byte-for-byte unchanged -> the session was NOT ended (D-01/D-03).
    expect(fs.readFileSync(sessionJsonPath).equals(sessionBytesBefore)).toBe(true);
    expect(fs.existsSync(sessionJsonPath)).toBe(true);
  });

  it("release marks only files active at done-time: a NEW write after done is still active", () => {
    const id = "done-later";
    const now = Date.now();
    const dir = seed(id, {
      intent: "wip",
      writes: [{ file_path: "/repo/held.ts", ts: new Date(now).toISOString() }],
    });

    const res = runDone(id, tmp);
    expect(res.status).toBe(0);

    // A brand-new touch to a DIFFERENT path AFTER done registers normally —
    // done is a point-in-time release, not a permanent block on future writes.
    fs.appendFileSync(
      path.join(dir, "files.jsonl"),
      JSON.stringify({ file_path: "/repo/after.ts", ts: new Date(Date.now()).toISOString() }) + "\n",
      { mode: 0o600 },
    );

    const after = rowFor(id)!;
    const files = after.files.map((f) => f.file_path);
    expect(files).toContain("/repo/after.ts");
    expect(files).not.toContain("/repo/held.ts"); // still released
  });

  it("bad session id writes nothing and still exits 0", () => {
    for (const badId of ["../evil", ""]) {
      const res = runDone(badId, tmp);
      expect(res.status).toBe(0);
    }
    // No escape write anywhere: the sessions tree stays empty (or absent), and
    // no traversal target was created outside the store.
    const sessions = path.join(tmp, "sessions");
    const leaked = fs.existsSync(sessions) ? fs.readdirSync(sessions) : [];
    expect(leaked).toHaveLength(0);
    expect(fs.existsSync(path.join(tmp, "evil"))).toBe(false);
  });

  it("a session with no active files and no intent still exits 0 and never mints session.json", () => {
    const id = "empty-sess";
    // An empty shard dir: no session.json, no intent.txt, no files.jsonl.
    fs.mkdirSync(sessDir(id), { recursive: true, mode: 0o700 });

    const res = runDone(id, tmp);
    expect(res.status).toBe(0);

    // done must not create session.json (it only ever removes intent.txt and
    // appends release events to an existing files.jsonl).
    expect(fs.existsSync(path.join(sessDir(id), "session.json"))).toBe(false);
    expect(fs.existsSync(path.join(sessDir(id), "intent.txt"))).toBe(false);
  });
});
