import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
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
  /** Declared target branch written to target-branch.txt; omitted => no shard (TB-03). */
  target_branch?: string;
  /** Attention shard { type, ts } written to attention.json; omitted => no shard (ATTN-04). */
  attention?: { type: string; ts: string };
  /** Asking shard written VERBATIM to asking.json; omitted => no shard (AQ-03, 260926-vfm). */
  asking?: Record<string, unknown>;
  /**
   * Numeric pid written into the session.json `state` object. Used ONLY for
   * port-ancestry attribution (liveness comes from the fresh heartbeat, not pid).
   * Omitted => no `pid` key is written (the 8 pre-existing tests are unaffected).
   */
  pid?: number;
  /** ISO-8601 written into the plain `resumed` sidecar (260927-1zw); omitted => absent. */
  resumed?: string;
  /** ISO-8601 written into the plain `ask-resolved` sidecar (260927-1zw); omitted => absent. */
  askResolved?: string;
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
    ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
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
  if (opts.target_branch !== undefined) {
    fs.writeFileSync(
      path.join(dir, "target-branch.txt"),
      JSON.stringify({ target_branch: opts.target_branch, ts: nowIso }),
      { mode: 0o600 },
    );
  }
  if (opts.attention !== undefined) {
    fs.writeFileSync(path.join(dir, "attention.json"), JSON.stringify(opts.attention), { mode: 0o600 });
  }
  if (opts.asking !== undefined) {
    fs.writeFileSync(path.join(dir, "asking.json"), JSON.stringify(opts.asking), { mode: 0o600 });
  }
  if (opts.resumed !== undefined) {
    fs.writeFileSync(path.join(dir, "resumed"), opts.resumed, { mode: 0o600 });
  }
  if (opts.askResolved !== undefined) {
    fs.writeFileSync(path.join(dir, "ask-resolved"), opts.askResolved, { mode: 0o600 });
  }
}

/** The stdout line that mentions a session's first-8 shortId. */
function lineFor(stdout: string, id: string): string | undefined {
  return stdout.split("\n").find((l) => l.includes(id.slice(0, 8)));
}

/**
 * Write an executable POSIX shell fixture (`/bin/sh`) that ignores its args and
 * emits `body` verbatim as stdout (or `exit 1` to surrogate an lsof/ps failure).
 * The reader is pointed at it via CSM_LSOF_CMD / CSM_PS_CMD. Returns its abs path.
 */
function writeFixture(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  return p;
}

/** A `/bin/sh` script that prints `stdout` verbatim (canned lsof/ps output). */
function cannedOut(dir: string, name: string, stdout: string): string {
  return writeFixture(dir, name, `cat <<'CSM_FIXTURE_EOF'\n${stdout}\nCSM_FIXTURE_EOF`);
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

describe("csm-status reader — target branch (TB-03)", () => {
  const BRANCH_GLYPH = "⎇"; // U+2387
  const NEQ_GLYPH = "≠"; // U+2260

  it("mismatch: a target differing from the current branch shows the target AND the ≠ flag", () => {
    seed(tmp, "alpha111-aaaa", {
      folder: "projAlpha",
      branch: "main",
      target_branch: "feature-x",
      writes: ["/repo/a.ts"],
    });

    const res = runStatus("alpha111-aaaa", tmp);
    expect(res.status).toBe(0);
    const line = lineFor(res.stdout, "alpha111-aaaa");
    expect(line).toBeDefined();
    expect(line).toContain(BRANCH_GLYPH);
    expect(line).toContain("feature-x");
    expect(line).toContain(NEQ_GLYPH);
  });

  it("match: a target equal to the current branch shows the target but no ≠ flag", () => {
    seed(tmp, "beta2222-bbbb", {
      folder: "projBeta",
      branch: "main",
      target_branch: "main",
      writes: ["/repo/b.ts"],
    });

    const res = runStatus("beta2222-bbbb", tmp);
    expect(res.status).toBe(0);
    const line = lineFor(res.stdout, "beta2222-bbbb");
    expect(line).toBeDefined();
    expect(line).toContain(BRANCH_GLYPH);
    expect(line).not.toContain(NEQ_GLYPH);
  });

  it("absent: a session without a declared target shows no branch glyph token", () => {
    seed(tmp, "gamma333-cccc", { folder: "projGamma", branch: "main", writes: ["/repo/c.ts"] });

    const res = runStatus("gamma333-cccc", tmp);
    expect(res.status).toBe(0);
    const line = lineFor(res.stdout, "gamma333-cccc");
    expect(line).toBeDefined();
    expect(line).not.toContain(BRANCH_GLYPH);
    expect(line).not.toContain(NEQ_GLYPH);
  });
});

describe("csm-status reader — Ports: block (INT-02, PORT-05)", () => {
  it("attribution: a LISTEN port whose pid ancestry reaches a live session groups under it with port, command, pid", () => {
    // Live session with pid 4242; the listening socket is owned by pid 4242.
    seed(tmp, "alpha111-aaaa", { folder: "projAlpha", branch: "feature-x", pid: 4242, writes: ["/repo/a.ts"] });
    const lsof = cannedOut(tmp, "lsof.sh", ["p4242", "cnode", "Luser", "f5", "n*:3000"].join("\n"));
    const ps = cannedOut(tmp, "ps.sh", ["  PID  PPID USER     COMMAND", " 4242     1 user     node server.js"].join("\n"));

    const res = runStatus("alpha111-aaaa", tmp, { CSM_LSOF_CMD: lsof, CSM_PS_CMD: ps });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Ports:");
    // Grouped under the session's folder · branch · shortid heading.
    expect(res.stdout).toContain("projAlpha · feature-x · alpha111");
    // Row carries the port, command, and pid.
    expect(res.stdout).toContain("3000");
    expect(res.stdout).toContain("node");
    expect(res.stdout).toContain("pid 4242");
  });

  it("exposed vs local: a 0.0.0.0 bind renders the exposed marker; a 127.0.0.1 bind renders local", () => {
    seed(tmp, "alpha111-aaaa", { folder: "projAlpha", pid: 4242, writes: ["/repo/a.ts"] });
    const lsof = cannedOut(
      tmp,
      "lsof.sh",
      ["p4242", "cnode", "Luser", "f5", "n0.0.0.0:3000", "f6", "n127.0.0.1:4000"].join("\n"),
    );
    const ps = cannedOut(tmp, "ps.sh", ["  PID  PPID USER     COMMAND", " 4242     1 user     node"].join("\n"));

    const res = runStatus("alpha111-aaaa", tmp, { CSM_LSOF_CMD: lsof, CSM_PS_CMD: ps });
    expect(res.status).toBe(0);
    // The exposed 0.0.0.0:3000 row carries the ⇅ exposed badge.
    const line3000 = res.stdout.split("\n").find((l) => l.includes("3000"));
    const line4000 = res.stdout.split("\n").find((l) => l.includes("4000"));
    expect(line3000).toBeDefined();
    expect(line4000).toBeDefined();
    expect(line3000).toContain("⇅ exposed");
    expect(line4000).toContain("local");
    expect(line4000).not.toContain("⇅ exposed");
  });

  it("user bucket: a port whose ancestry matches no live session falls under 'Sen (kullanici)' rendered LAST", () => {
    // Live session owns pid 4242 (port 3000); port 5000 is owned by orphan pid 7777.
    seed(tmp, "alpha111-aaaa", { folder: "projAlpha", pid: 4242, writes: ["/repo/a.ts"] });
    const lsof = cannedOut(
      tmp,
      "lsof.sh",
      ["p4242", "cnode", "Luser", "f5", "n*:3000", "p7777", "cstray", "Luser", "f6", "n*:5000"].join("\n"),
    );
    const ps = cannedOut(
      tmp,
      "ps.sh",
      ["  PID  PPID USER     COMMAND", " 4242     1 user     node", " 7777     1 user     stray"].join("\n"),
    );

    const res = runStatus("alpha111-aaaa", tmp, { CSM_LSOF_CMD: lsof, CSM_PS_CMD: ps });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Sen (kullanici)");
    // The user bucket appears AFTER the per-session group in the Ports: block.
    const idxSession = res.stdout.indexOf("projAlpha · main · alpha111");
    const idxBucket = res.stdout.indexOf("Sen (kullanici)");
    expect(idxSession).toBeGreaterThanOrEqual(0);
    expect(idxBucket).toBeGreaterThan(idxSession);
    // The orphan port renders in the user bucket.
    expect(res.stdout).toContain("5000");
  });

  it("passivity: lsof failure/timeout yields 'no listening ports', exits 0, and never throws", () => {
    seed(tmp, "alpha111-aaaa", { folder: "projAlpha", pid: 4242, writes: ["/repo/a.ts"] });
    const lsofFail = writeFixture(tmp, "lsof-fail.sh", "exit 1");
    const ps = cannedOut(tmp, "ps.sh", ["  PID  PPID USER     COMMAND", " 4242     1 user     node"].join("\n"));

    const res = runStatus("alpha111-aaaa", tmp, { CSM_LSOF_CMD: lsofFail, CSM_PS_CMD: ps });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("no listening ports");
    expect(res.stderr).not.toMatch(/Error|throw|ENOENT/);
  });

  it("denylist: an Apple background-agent command is excluded while a genuine dev-server port renders", () => {
    seed(tmp, "alpha111-aaaa", { folder: "projAlpha", pid: 4242, writes: ["/repo/a.ts"] });
    const lsof = cannedOut(
      tmp,
      "lsof.sh",
      ["p4242", "cnode", "Luser", "f5", "n*:3000", "p5555", "crapportd", "Luser", "f6", "n*:7000"].join("\n"),
    );
    const ps = cannedOut(
      tmp,
      "ps.sh",
      ["  PID  PPID USER     COMMAND", " 4242     1 user     node", " 5555     1 user     rapportd"].join("\n"),
    );

    const res = runStatus("alpha111-aaaa", tmp, { CSM_LSOF_CMD: lsof, CSM_PS_CMD: ps });
    expect(res.status).toBe(0);
    // Genuine dev server renders.
    expect(res.stdout).toContain("3000");
    expect(res.stdout).toContain("node");
    // Denylisted Apple agent (rapportd / port 7000) is excluded.
    expect(res.stdout).not.toContain("rapportd");
    expect(res.stdout).not.toContain("7000");
  });
});

// RED (06-06): the self-contained csm-status reader (imports no src/) mirrors the
// aggregate.readAll gate inline — readAttention + the window/newer-than-activity
// rule — and appends a detail-free "◉ waiting" marker to a waiting live session's
// roster line (ATTN-04). A non-waiting live session omits it. lastSeenMs is
// heartbeat-based (verified: csm-status.mjs line 472), so an attention ts newer
// than the heartbeat and within CSM_ATTN_WINDOW_MS (default 1800000 — a 30-minute
// safety net, 260926-r7n; activity is the primary clear) surfaces the marker
// regardless of write timestamps. RED until csm-status.mjs adds the inline
// read + marker.
describe("csm-status reader — attention marker (ATTN-04)", () => {
  const ATTENTION_GLYPH = "◉"; // U+25C9 fisheye

  it("waiting: a live session whose attention.json is newer than its heartbeat and within window carries the detail-free ◉ waiting marker", () => {
    const now = Date.now();
    seed(tmp, "alpha111-aaaa", {
      folder: "projAlpha",
      heartbeat: new Date(now - 30_000).toISOString(), // fresh (live) but 30s ago
      writes: ["/repo/a.ts"],
      intent: "awaiting approval",
      // Attention 5s ago: newer than the heartbeat, well within the 30-min window.
      attention: { type: "permission_prompt", ts: new Date(now - 5_000).toISOString() },
    });

    const res = runStatus("alpha111-aaaa", tmp);
    expect(res.status).toBe(0);
    const line = lineFor(res.stdout, "alpha111-aaaa");
    expect(line).toBeDefined();
    expect(line).toContain(ATTENTION_GLYPH);
    expect(line).toContain("waiting");
  });

  it("not waiting: a live session with NO attention.json omits the marker", () => {
    seed(tmp, "beta2222-bbbb", { folder: "projBeta", writes: ["/repo/b.ts"], intent: "coding" });

    const res = runStatus("beta2222-bbbb", tmp);
    expect(res.status).toBe(0);
    const line = lineFor(res.stdout, "beta2222-bbbb");
    expect(line).toBeDefined();
    expect(line).not.toContain(ATTENTION_GLYPH);
  });

  // --- 260926-r7n (AP-02): the inline mirror shares the 30-minute safety-net
  // default. CSM_ATTN_WINDOW_MS is removed from the spawned env so the DEFAULT
  // is exercised; pid = the test runner keeps the session live despite a stale
  // heartbeat.
  function withoutAttnEnv<T>(fn: () => T): T {
    const prior = process.env.CSM_ATTN_WINDOW_MS;
    delete process.env.CSM_ATTN_WINDOW_MS;
    try {
      return fn();
    } finally {
      if (prior !== undefined) process.env.CSM_ATTN_WINDOW_MS = prior;
    }
  }

  it("S1 — default window keeps a long wait visible: attention 10 min ago, heartbeat 15 min ago → ◉ waiting", () => {
    const now = Date.now();
    seed(tmp, "gamma333-cccc", {
      folder: "projGamma",
      pid: process.pid,
      heartbeat: new Date(now - 900_000).toISOString(),
      attention: { type: "permission_prompt", ts: new Date(now - 600_000).toISOString() },
    });

    const res = withoutAttnEnv(() => runStatus("gamma333-cccc", tmp));
    expect(res.status).toBe(0);
    const line = lineFor(res.stdout, "gamma333-cccc");
    expect(line).toBeDefined();
    expect(line).toContain(ATTENTION_GLYPH);
    expect(line).toContain("waiting");
  });

  it("S2 — default safety net still expires: attention 31 min ago, heartbeat 40 min ago → no ◉", () => {
    const now = Date.now();
    seed(tmp, "delta444-dddd", {
      folder: "projDelta",
      pid: process.pid,
      heartbeat: new Date(now - 2_400_000).toISOString(),
      attention: { type: "permission_prompt", ts: new Date(now - 1_860_000).toISOString() },
    });

    const res = withoutAttnEnv(() => runStatus("delta444-dddd", tmp));
    expect(res.status).toBe(0);
    const line = lineFor(res.stdout, "delta444-dddd");
    expect(line).toBeDefined();
    expect(line).not.toContain(ATTENTION_GLYPH);
  });
});

// --- Quick task 260926-vfm (AQ-03): the inline mirror computes `asking` from
// asking.json with the same gate as attention, applies asking-wins precedence,
// and prints a distinct detail-free " ◉ asking" marker (vs " ◉ waiting").
describe("csm-status reader — asking marker (AQ-03)", () => {
  const GLYPH = "◉";

  it("C1: a live session with an open question (asking 5s ago, heartbeat 30s ago) shows ◉ asking, not waiting", () => {
    const now = Date.now();
    seed(tmp, "aq111111-aaaa", {
      folder: "projOne",
      heartbeat: new Date(now - 30_000).toISOString(),
      asking: { ts: new Date(now - 5_000).toISOString() },
    });
    const res = runStatus("aq111111-aaaa", tmp);
    expect(res.status).toBe(0);
    const line = lineFor(res.stdout, "aq111111-aaaa");
    expect(line).toBeDefined();
    expect(line).toContain(GLYPH + " asking");
    expect(line).not.toContain("waiting");
  });

  it("C2 precedence: asking 10s ago + permission_prompt 3s ago → ◉ asking, not waiting", () => {
    const now = Date.now();
    seed(tmp, "aq222222-bbbb", {
      folder: "projTwo",
      heartbeat: new Date(now - 30_000).toISOString(),
      asking: { ts: new Date(now - 10_000).toISOString() },
      attention: { type: "permission_prompt", ts: new Date(now - 3_000).toISOString() },
    });
    const res = runStatus("aq222222-bbbb", tmp);
    const line = lineFor(res.stdout, "aq222222-bbbb");
    expect(line).toBeDefined();
    expect(line).toContain(GLYPH + " asking");
    expect(line).not.toContain("waiting");
  });

  it("C3 waiting unchanged: attention only → ◉ waiting, not asking", () => {
    const now = Date.now();
    seed(tmp, "aq333333-cccc", {
      folder: "projThree",
      heartbeat: new Date(now - 30_000).toISOString(),
      attention: { type: "permission_prompt", ts: new Date(now - 5_000).toISOString() },
    });
    const res = runStatus("aq333333-cccc", tmp);
    const line = lineFor(res.stdout, "aq333333-cccc");
    expect(line).toBeDefined();
    expect(line).toContain(GLYPH + " waiting");
    expect(line).not.toContain("asking");
  });

  it("C4 answered: heartbeat 30s ago is newer than asking 60s ago → no ◉", () => {
    const now = Date.now();
    seed(tmp, "aq444444-dddd", {
      folder: "projFour",
      heartbeat: new Date(now - 30_000).toISOString(),
      asking: { ts: new Date(now - 60_000).toISOString() },
    });
    const res = runStatus("aq444444-dddd", tmp);
    const line = lineFor(res.stdout, "aq444444-dddd");
    expect(line).toBeDefined();
    expect(line).not.toContain(GLYPH);
  });

  it("C5 detail-free: an extra question key in asking.json never reaches stdout", () => {
    const now = Date.now();
    seed(tmp, "aq555555-eeee", {
      folder: "projFive",
      heartbeat: new Date(now - 30_000).toISOString(),
      asking: { ts: new Date(now - 5_000).toISOString(), question: "SENTINEL_Q_vfm" },
    });
    const res = runStatus("aq555555-eeee", tmp);
    const line = lineFor(res.stdout, "aq555555-eeee");
    expect(line).toBeDefined();
    expect(line).toContain(GLYPH + " asking");
    expect(res.stdout).not.toContain("SENTINEL_Q_vfm");
  });
});

/** True when a usable `git` is on PATH (the macOS target ships one). */
function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

const HAVE_GIT = gitAvailable();

/**
 * Create a real temp git repo checked out on `feature-x` (over an initial `main`)
 * so the reader's synchronous `git rev-parse --abbrev-ref HEAD` derivation resolves
 * a LIVE branch distinct from any seeded snapshot. Returns the realpath'd repo dir;
 * caller registers cleanup.
 */
function makeGitRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "csm-status-repo-")));
  const run = (args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("git", ["init", "-b", "main", dir], { stdio: ["ignore", "ignore", "ignore"] });
  run(["config", "user.email", "csm@example.com"]);
  run(["config", "user.name", "CSM Test"]);
  run(["commit", "--allow-empty", "-m", "init"]);
  run(["checkout", "-b", "feature-x"]);
  return dir;
}

describe.runIf(HAVE_GIT)("csm-status reader — LIVE branch derivation (LB-03)", () => {
  const BRANCH_GLYPH = "⎇"; // U+2387
  const NEQ_GLYPH = "≠"; // U+2260

  let repo: string;
  beforeEach(() => {
    repo = makeGitRepo();
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("derives the LIVE branch from cwd: target equals the live checkout -> shows it, NO ≠ flag", () => {
    // Snapshot says "main" but the repo is actually on "feature-x"; the declared
    // target is "feature-x". If the reader used the SNAPSHOT the flag would fire
    // (feature-x != main); its ABSENCE proves the flag rebased onto the LIVE branch.
    seed(tmp, "alpha111-aaaa", {
      folder: "projAlpha",
      branch: "main",
      cwd: repo,
      target_branch: "feature-x",
      writes: ["/repo/a.ts"],
    });

    const res = runStatus("alpha111-aaaa", tmp);
    expect(res.status).toBe(0);
    const line = lineFor(res.stdout, "alpha111-aaaa");
    expect(line).toBeDefined();
    expect(line).toContain("feature-x"); // the LIVE checkout, not the "main" snapshot
    expect(line).toContain(BRANCH_GLYPH);
    expect(line).not.toContain(NEQ_GLYPH); // target == live branch -> no mismatch
  });

  it("derives the LIVE branch from cwd: target differs from the live checkout -> shows it WITH the ≠ flag", () => {
    // Snapshot "main", live "feature-x", target "main". Against the live branch the
    // target differs -> the flag fires. If the reader used the snapshot ("main"),
    // target "main" would MATCH and no flag would show; the flag proves live wins.
    seed(tmp, "beta2222-bbbb", {
      folder: "projBeta",
      branch: "main",
      cwd: repo,
      target_branch: "main",
      writes: ["/repo/b.ts"],
    });

    const res = runStatus("beta2222-bbbb", tmp);
    expect(res.status).toBe(0);
    const line = lineFor(res.stdout, "beta2222-bbbb");
    expect(line).toBeDefined();
    expect(line).toContain("feature-x"); // live checkout shown
    expect(line).toContain(NEQ_GLYPH); // live feature-x drifts from declared target main
  });

  it("falls back to the snapshot branch when cwd is absent/non-repo, never crashing (exit 0)", () => {
    // No cwd at all -> no derivation possible -> snapshot "main" stands in.
    seed(tmp, "gamma333-cccc", { folder: "projGamma", branch: "main", writes: ["/repo/c.ts"] });

    const res = runStatus("gamma333-cccc", tmp);
    expect(res.status).toBe(0);
    const line = lineFor(res.stdout, "gamma333-cccc");
    expect(line).toBeDefined();
    expect(line).toContain("main"); // snapshot fallback
  });
});

// --- Quick task 260927-1zw: the inline csm-status mirror applies the same
// resume-signal gates (CR-01 resumed / WR-02 ask-resolved, heartbeat fallback)
// and the WR-01 needs-you keepalive as aggregate.readAll. Env pinned for
// determinism.
describe("csm-status reader — resume signals + keepalive (260927-1zw)", () => {
  const env = { CSM_STALE_MS: "120000", CSM_ATTN_WINDOW_MS: "1800000" };
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("K1 CR-01: resumed older than the prompt keeps ◉ waiting despite a fresh heartbeat", () => {
    const id = "kone1111-aaaa";
    seed(tmp, id, { heartbeat: ago(1_000), resumed: ago(30_000), attention: { type: "permission_prompt", ts: ago(5_000) } });
    const res = runStatus(id, tmp, env);
    expect(res.status).toBe(0);
    expect(lineFor(res.stdout, id)).toContain("◉ waiting");
  });

  it("K2 a main-thread resume newer than the prompt clears the marker", () => {
    const id = "ktwo2222-aaaa";
    seed(tmp, id, { heartbeat: ago(1_000), resumed: ago(1_000), attention: { type: "permission_prompt", ts: ago(5_000) } });
    const res = runStatus(id, tmp, env);
    const line = lineFor(res.stdout, id);
    expect(line).toBeDefined();
    expect(line).not.toContain("◉");
  });

  it("K3 WR-02: a sibling main-thread tool (resumed newer) keeps ◉ asking while ask-resolved is older", () => {
    const id = "kthree33-aaaa";
    seed(tmp, id, {
      heartbeat: ago(1_000),
      resumed: ago(1_000),
      askResolved: ago(60_000),
      asking: { ts: ago(5_000) },
    });
    const res = runStatus(id, tmp, env);
    expect(lineFor(res.stdout, id)).toContain("◉ asking");
  });

  it("K4 the answer (ask-resolved newer) clears asking", () => {
    const id = "kfour444-aaaa";
    seed(tmp, id, { askResolved: ago(1_000), asking: { ts: ago(5_000) } });
    const res = runStatus(id, tmp, env);
    const line = lineFor(res.stdout, id);
    expect(line).toBeDefined();
    expect(line).not.toContain("asking");
  });

  it("K5 WR-01: no pid, heartbeat 180s, asking 170s → still listed with ◉ asking", () => {
    const id = "kfive555-aaaa";
    seed(tmp, id, { heartbeat: ago(180_000), asking: { ts: ago(170_000) } });
    const res = runStatus(id, tmp, env);
    const line = lineFor(res.stdout, id);
    expect(line).toBeDefined();
    expect(line).toContain("◉ asking");
  });

  it("K6 WR-01 waiting: no pid, heartbeat 180s, idle_prompt 60s → still listed with ◉ waiting", () => {
    const id = "ksix6666-aaaa";
    seed(tmp, id, { heartbeat: ago(180_000), attention: { type: "idle_prompt", ts: ago(60_000) } });
    const res = runStatus(id, tmp, env);
    const line = lineFor(res.stdout, id);
    expect(line).toBeDefined();
    expect(line).toContain("◉ waiting");
  });

  it("K7 bounded by the window: no pid, heartbeat 40 min, attention 31 min → not listed", () => {
    const id = "kseven77-aaaa";
    seed(tmp, id, { heartbeat: ago(2_400_000), attention: { type: "idle_prompt", ts: ago(1_860_000) } });
    const res = runStatus(id, tmp, env);
    expect(res.status).toBe(0);
    expect(lineFor(res.stdout, id)).toBeUndefined();
  });

  it("K8 DISC-4: a known pid that has exited is not kept alive by an active marker", () => {
    const id = "keight88-aaaa";
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid as number;
    seed(tmp, id, { pid: deadPid, heartbeat: ago(180_000), asking: { ts: ago(60_000) } });
    const res = runStatus(id, tmp, env);
    expect(res.status).toBe(0);
    expect(lineFor(res.stdout, id)).toBeUndefined();
  });
});
