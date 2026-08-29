import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// RED: the reader script does not exist yet. It lands in Task 2 (GREEN):
//   scripts/csm-status.mjs  (INT-02 cross-session roster reader, plain text)
// The command runs it as `node csm-status.mjs "<caller_session_id>"` (the caller
// session id is process.argv[2]) — mirror src/csm-intent.test.ts's spawnSync
// harness, but the sole arg is the caller session id (no $ARGUMENTS).
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const csmStatus = path.join(repoRoot, "scripts", "csm-status.mjs");

let tmp: string;

beforeEach(() => {
  // Realpath-anchor the store root so the macOS `/var` -> `/private/var` fold is
  // applied before any fixture path is built (RESEARCH Pitfall 1) — otherwise a
  // session's active-write realpath would never string-equal the raw mkdtemp path
  // in the conflicts case.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "csm-status-")));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Invoke the reader with the caller session id as its sole CLI argument. */
function runStatus(callerId: string, storeDir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [csmStatus, callerId], {
    env: { ...process.env, CSM_STORE_DIR: storeDir, ...extraEnv },
    encoding: "utf8",
  });
}

interface SeedOpts {
  folder?: string;
  branch?: string;
  cwd?: string;
  /** ISO-8601 written into the heartbeat sidecar (fresh => live). */
  heartbeat?: string;
  /** ISO-8601 start_time (drives uptime). */
  start_time?: string;
  /** Absolute (or store-relative) write paths appended to files.jsonl (active writes). */
  writes?: string[];
  /** Absolute read paths appended to reads.jsonl (must NEVER surface). */
  reads?: string[];
  /** Declared intent written to intent.txt; omitted => no intent shard. */
  intent?: string;
}

/** Seed one session shard directly on disk (no src/ import — self-contained). */
function seed(storeDir: string, id: string, opts: SeedOpts = {}): void {
  const dir = path.join(storeDir, "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  const nowIso = new Date().toISOString();
  const state = {
    schema_version: 1,
    session_id: id,
    folder: opts.folder ?? id,
    branch: opts.branch ?? "main",
    model: "unknown",
    start_time: opts.start_time ?? nowIso,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  };
  fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify(state), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "heartbeat"), opts.heartbeat ?? nowIso, { mode: 0o600 });
  for (const w of opts.writes ?? []) {
    fs.appendFileSync(path.join(dir, "files.jsonl"), JSON.stringify({ file_path: w, ts: nowIso }) + "\n", {
      mode: 0o600,
    });
  }
  for (const r of opts.reads ?? []) {
    fs.appendFileSync(path.join(dir, "reads.jsonl"), JSON.stringify({ file_path: r, ts: nowIso }) + "\n", {
      mode: 0o600,
    });
  }
  if (opts.intent !== undefined) {
    fs.writeFileSync(path.join(dir, "intent.txt"), JSON.stringify({ intent: opts.intent, ts: nowIso }), {
      mode: 0o600,
    });
  }
}

/** The stdout line that mentions a session's first-8 shortId. */
function lineFor(stdout: string, id: string): string | undefined {
  return stdout.split("\n").find((l) => l.includes(id.slice(0, 8)));
}

describe("csm-status reader (INT-02, D-04/D-05)", () => {
  it("terse live roster: both live sessions appear one line each with folder, branch, shortid, uptime", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    seed(tmp, "alpha111-aaaa", {
      folder: "projAlpha",
      branch: "feature-x",
      start_time: fiveMinAgo,
      writes: ["/repo/alpha/edit-a.ts"],
      intent: "refactor Card",
    });
    seed(tmp, "beta2222-bbbb", {
      folder: "projBeta",
      branch: "main",
      start_time: fiveMinAgo,
      writes: ["/repo/beta/edit-b.ts"],
    });

    const res = runStatus("alpha111-aaaa", tmp);
    expect(res.status).toBe(0);
    const out = res.stdout;

    const lineA = lineFor(out, "alpha111-aaaa");
    const lineB = lineFor(out, "beta2222-bbbb");
    expect(lineA).toBeDefined();
    expect(lineB).toBeDefined();

    // Folder, branch, first-8 shortId all present on each roster line.
    expect(lineA).toContain("projAlpha");
    expect(lineA).toContain("feature-x");
    expect(lineA).toContain("alpha111");
    expect(lineB).toContain("projBeta");
    expect(lineB).toContain("main");
    expect(lineB).toContain("beta2222");

    // An uptime token (e.g. "5m" / "45s" / "1h 2m") on each line.
    expect(lineA).toMatch(/\d+\s*[smh]/);
    expect(lineB).toMatch(/\d+\s*[smh]/);
  });

  it("(you) marking: the caller (argv[2]) session is marked, others are not", () => {
    seed(tmp, "alpha111-aaaa", { folder: "projAlpha", writes: ["/repo/a.ts"] });
    seed(tmp, "beta2222-bbbb", { folder: "projBeta", writes: ["/repo/b.ts"] });

    const res = runStatus("alpha111-aaaa", tmp);
    expect(res.status).toBe(0);

    expect(lineFor(res.stdout, "alpha111-aaaa")).toContain("(you)");
    expect(lineFor(res.stdout, "beta2222-bbbb")).not.toContain("(you)");
  });

  it("intent column: a session with intent.txt shows its intent text", () => {
    seed(tmp, "alpha111-aaaa", { folder: "projAlpha", writes: ["/repo/a.ts"], intent: "wire the panel" });

    const res = runStatus("alpha111-aaaa", tmp);
    expect(res.status).toBe(0);
    expect(lineFor(res.stdout, "alpha111-aaaa")).toContain("wire the panel");
  });

  it("D-11 fallback: a session WITHOUT intent shows its newest write basename, never blank", () => {
    seed(tmp, "beta2222-bbbb", {
      folder: "projBeta",
      writes: ["/repo/beta/newest-write.ts"],
      // no intent
    });

    const res = runStatus("someone-else", tmp);
    expect(res.status).toBe(0);
    const line = lineFor(res.stdout, "beta2222-bbbb");
    expect(line).toBeDefined();
    // Recent-file fallback: the newest write basename stands in for the intent.
    expect(line).toContain("newest-write.ts");
  });

  it("reads excluded (D-05): a reads.jsonl-only path never appears in the output", () => {
    seed(tmp, "alpha111-aaaa", {
      folder: "projAlpha",
      writes: ["/repo/written.ts"],
      reads: ["/repo/only-read-secret.ts"],
      intent: "editing",
    });

    const res = runStatus("alpha111-aaaa", tmp);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("written.ts");
    expect(res.stdout).not.toContain("only-read-secret.ts");
  });

  it("live-only: a stale/dead session (heartbeat older than CSM_STALE_MS, no pid) does not appear", () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    seed(tmp, "dead0000-dddd", {
      folder: "projDead",
      heartbeat: longAgo, // stale — beyond default 120000ms TTL, and no live pid
      writes: ["/repo/dead.ts"],
      intent: "should not show",
    });
    seed(tmp, "live1111-llll", { folder: "projLive", writes: ["/repo/live.ts"], intent: "alive" });

    const res = runStatus("live1111-llll", tmp);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("projLive");
    expect(res.stdout).not.toContain("projDead");
    expect(res.stdout).not.toContain("should not show");
  });

  it("conflicts relevant to you: names the shared file + the OTHER session, self-excluded", () => {
    // A real shared file under the realpath-anchored store root.
    const shared = path.join(tmp, "shared-conflict.ts");
    fs.writeFileSync(shared, "");

    seed(tmp, "alpha111-aaaa", { folder: "projAlpha", cwd: tmp, writes: [shared] });
    seed(tmp, "beta2222-bbbb", { folder: "projBeta", cwd: tmp, writes: [shared] });

    const res = runStatus("alpha111-aaaa", tmp);
    expect(res.status).toBe(0);
    const out = res.stdout.toLowerCase();

    // A conflicts section exists, naming the shared file basename and the OTHER session.
    expect(out).toContain("conflict");
    expect(res.stdout).toContain("shared-conflict.ts");
    expect(res.stdout).toContain("projBeta");
    // Self-exclusion: the caller's conflict partner is projBeta, not projAlpha
    // against itself — only conflicts naming the caller are emitted (D-04).
  });

  it("passivity: an empty/nonexistent store exits 0 and never throws", () => {
    const empty = path.join(tmp, "does-not-exist");
    const res = runStatus("whoever", empty);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/Error|throw|ENOENT/);
  });
});
