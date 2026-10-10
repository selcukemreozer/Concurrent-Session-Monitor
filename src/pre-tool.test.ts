import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { detectConflicts } from "./conflicts.js";
import type { SessionRow } from "./aggregate.js";

/**
 * CONF-02 pre-edit advisory hook tests (Plan 04-04, RED first).
 *
 * The hook `scripts/on-pre-tool.mjs` runs synchronously on `PreToolUse` for
 * Edit/Write/MultiEdit. When the acting session is about to touch a file a
 * DIFFERENT live session already holds in its active write window, it prints a
 * single `hookSpecificOutput.additionalContext` line and lets the edit proceed.
 * It NEVER denies, NEVER exits 2, NEVER writes a file (D-06/D-07/D-08/D-09).
 *
 * The harness mirrors src/hooks.test.ts (spawnSync + CSM_STORE_DIR mkdtemp) and
 * uses the realpath-anchored temp root convention from src/conflicts.test.ts so
 * fixture realpaths string-compare through the macOS /var -> /private/var fold.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const onPreTool = path.join(repoRoot, "scripts", "on-pre-tool.mjs");

// Default numeric knobs pinned so the fresh/stale + window math is deterministic.
const STALE_MS = 120_000; // CSM_STALE_MS default
const WINDOW_MS = 300_000; // CSM_WINDOW_MS default

let store: string; // realpath-anchored store + fixture root

beforeEach(() => {
  store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "csm-pre-")));
});

afterEach(() => {
  fs.rmSync(store, { recursive: true, force: true });
});

/** Spawn the advisory hook with hook stdin JSON against the mkdtemp store. */
function runPreTool(stdin: string) {
  return spawnSync(process.execPath, [onPreTool], {
    input: stdin,
    env: {
      ...process.env,
      CSM_STORE_DIR: store,
      CSM_STALE_MS: String(STALE_MS),
      CSM_WINDOW_MS: String(WINDOW_MS),
    },
    encoding: "utf8",
  });
}

/** Build a PreToolUse hook payload for the acting session about to touch `file`. */
function payload(session_id: string, file: string, tool_name = "Edit") {
  return JSON.stringify({
    session_id,
    cwd: store,
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input: { file_path: file },
  });
}

interface SeedOpts {
  folder?: string;
  branch?: string;
  /** Active-write file paths seeded into this session's files.jsonl. */
  files?: string[];
  /** ms since epoch written into the heartbeat sidecar; omit for no heartbeat. */
  heartbeatMs?: number;
  pid?: number;
  /** Native session name written as title.json { title, ts } (NAME-02); omitted => absent. */
  title?: string;
  /** Raw (possibly torn) title.json content (NAME-02); wins over `title`. */
  titleRaw?: string;
}

/** Seed one session shard (session.json + optional files.jsonl + heartbeat). */
function seedSession(id: string, opts: SeedOpts = {}): string {
  const dir = path.join(store, "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  const state = {
    schema_version: 1,
    session_id: id,
    folder: opts.folder ?? id,
    branch: opts.branch ?? "main",
    model: "unknown",
    start_time: new Date().toISOString(),
    ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
  };
  fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify(state));
  if (opts.files && opts.files.length > 0) {
    const now = Date.now();
    const lines =
      opts.files
        .map((fp) => JSON.stringify({ file_path: fp, ts: new Date(now).toISOString(), tool: "Edit" }))
        .join("\n") + "\n";
    fs.writeFileSync(path.join(dir, "files.jsonl"), lines);
  }
  if (opts.heartbeatMs !== undefined) {
    fs.writeFileSync(path.join(dir, "heartbeat"), new Date(opts.heartbeatMs).toISOString());
  }
  if (opts.titleRaw !== undefined) {
    fs.writeFileSync(path.join(dir, "title.json"), opts.titleRaw);
  } else if (opts.title !== undefined) {
    fs.writeFileSync(path.join(dir, "title.json"), JSON.stringify({ title: opts.title, ts: new Date().toISOString() }));
  }
  return dir;
}

/** Create a real file under the store so realpathSync resolves it. */
function makeFile(name: string): string {
  const fp = path.join(store, name);
  fs.writeFileSync(fp, "");
  return fp;
}

/** A minimal SessionRow builder for the detectConflicts parity fixtures. */
function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    schema_version: 1,
    session_id: "sess",
    folder: "proj",
    branch: "main",
    model: "unknown",
    start_time: new Date().toISOString(),
    files: [],
    alive: true,
    readyToPrune: false,
    dotState: "active",
    ...overrides,
  } as SessionRow;
}

describe("on-pre-tool advisory (CONF-02, D-06/D-07)", () => {
  const fresh = () => Date.now(); // within STALE_MS

  it("WARN: a live peer holding the about-to-edit realpath yields an additionalContext line (exit 0)", () => {
    const F = makeFile("shared.ts");
    seedSession("actor", { heartbeatMs: fresh() });
    seedSession("peer", {
      folder: "peerproj",
      branch: "feat",
      files: [F],
      heartbeatMs: fresh(),
    });

    const res = runPreTool(payload("actor", F));
    expect(res.status).toBe(0);

    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    const ctx: string = out.hookSpecificOutput.additionalContext;
    expect(typeof ctx).toBe("string");
    expect(ctx.length).toBeGreaterThan(0);
    // Names the file's basename and the peer's folder·branch·shortid label.
    expect(ctx).toContain(path.basename(F));
    expect(ctx).toContain("peerproj");
    expect(ctx).toContain("feat");
    expect(ctx).toContain("peer".slice(0, 8));
  });

  it("NEVER BLOCKS: the warn output carries no permissionDecision and exits 0", () => {
    const F = makeFile("shared.ts");
    seedSession("actor", { heartbeatMs: fresh() });
    seedSession("peer", { files: [F], heartbeatMs: fresh() });

    const res = runPreTool(payload("actor", F));
    expect(res.status).toBe(0);
    // Behavior assertion (not a source grep): the emitted JSON has no
    // permissionDecision field anywhere in the object.
    const out = JSON.parse(res.stdout);
    expect(JSON.stringify(out)).not.toContain("permissionDecision");
  });

  it("SELF-EXCLUDE: no advisory about a file only the acting session itself holds", () => {
    const F = makeFile("mine.ts");
    const G = makeFile("other.ts");
    // Actor holds F; a second live peer holds an unrelated file G (>=2 live).
    seedSession("actor", { files: [F], heartbeatMs: fresh() });
    seedSession("peer", { files: [G], heartbeatMs: fresh() });

    const res = runPreTool(payload("actor", F));
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("FEWER THAN 2 LIVE: only the acting session exists -> silent early exit", () => {
    const F = makeFile("shared.ts");
    seedSession("actor", { files: [F], heartbeatMs: fresh() });

    const res = runPreTool(payload("actor", F));
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("DEAD PEER: a stale + pid-dead holder of the file never warns (live-only)", () => {
    const F = makeFile("shared.ts");
    const G = makeFile("other.ts");
    seedSession("actor", { heartbeatMs: fresh() });
    // A live peer on an unrelated file keeps >=2 live (isolates live-only from
    // the <2-live early exit).
    seedSession("livepeer", { files: [G], heartbeatMs: fresh() });
    // The holder of F is dead: heartbeat older than STALE_MS AND a dead pid.
    seedSession("deadpeer", {
      files: [F],
      heartbeatMs: Date.now() - STALE_MS - 60_000,
      pid: 999_999,
    });

    const res = runPreTool(payload("actor", F));
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("READ IS NOT A TRIGGER: a Read payload on a held file is silent", () => {
    const F = makeFile("shared.ts");
    seedSession("actor", { heartbeatMs: fresh() });
    seedSession("peer", { files: [F], heartbeatMs: fresh() });

    const res = runPreTool(payload("actor", F, "Read"));
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("MALFORMED STDIN: non-JSON stdin exits 0 and never blocks", () => {
    const res = runPreTool("this is not json{");
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("PARITY: the hook warns iff detectConflicts reports a group with the edit realpath + actor", () => {
    const F = makeFile("shared.ts");
    const G = makeFile("other.ts");
    const now = Date.now();
    const ts = new Date(now).toISOString();

    // --- Conflict scenario: peer holds F. The equivalent detectConflicts fixture
    // includes the acting session ALSO holding F (as if its edit landed).
    seedSession("actor", { heartbeatMs: fresh() });
    seedSession("peer", { files: [F], heartbeatMs: fresh() });
    const warnRes = runPreTool(payload("actor", F));
    const warns = warnRes.status === 0 && warnRes.stdout.trim() !== "";

    const conflictRows = [
      makeRow({ session_id: "actor", cwd: store, files: [{ file_path: F, ts }] }),
      makeRow({ session_id: "peer", cwd: store, files: [{ file_path: F, ts }] }),
    ];
    const conflicts = detectConflicts(conflictRows, now);
    const realF = fs.realpathSync(F);
    const groupHasEdit = conflicts.some(
      (c) => c.realpath === realF && c.sessions.some((s) => s.session_id === "actor"),
    );
    expect(warns).toBe(true);
    expect(groupHasEdit).toBe(true);
    expect(warns).toBe(groupHasEdit);

    // reset the store for the no-conflict scenario
    fs.rmSync(path.join(store, "sessions"), { recursive: true, force: true });

    // --- No-conflict scenario: the live peer holds a DIFFERENT file G.
    seedSession("actor", { heartbeatMs: fresh() });
    seedSession("peer", { files: [G], heartbeatMs: fresh() });
    const quietRes = runPreTool(payload("actor", F));
    const quietWarns = quietRes.status === 0 && quietRes.stdout.trim() !== "";

    const noConflictRows = [
      makeRow({ session_id: "actor", cwd: store, files: [{ file_path: F, ts }] }),
      makeRow({ session_id: "peer", cwd: store, files: [{ file_path: G, ts }] }),
    ];
    const noConflicts = detectConflicts(noConflictRows, now);
    const groupHasEdit2 = noConflicts.some(
      (c) => c.realpath === realF && c.sessions.some((s) => s.session_id === "actor"),
    );
    expect(quietWarns).toBe(false);
    expect(groupHasEdit2).toBe(false);
    expect(quietWarns).toBe(groupHasEdit2);
  });
});

describe("on-pre-tool advisory \u2014 peer session name (NAME-02, D-08/D-09)", () => {
  const fresh = () => Date.now();
  const ELL = String.fromCodePoint(0x2026);
  const ESC = String.fromCharCode(0x1b);
  const RLO = String.fromCodePoint(0x202e);
  const ctxOf = (stdout: string): string => JSON.parse(stdout).hookSpecificOutput.additionalContext;

  it("P1: names a titled peer by its capped native name, then branch and shortid", () => {
    const F = makeFile("shared.ts");
    seedSession("actor", { heartbeatMs: fresh() });
    seedSession("peer", { files: [F], heartbeatMs: fresh(), title: "Logitech MK295 Mac tutukluluk sorunu" });
    const res = runPreTool(payload("actor", F));
    expect(res.status).toBe(0);
    expect(ctxOf(res.stdout).endsWith("is also held by Logitech MK295 Mac tutuk" + ELL + " \u00b7 main \u00b7 peer")).toBe(true);
  });

  it("P2: an unnamed peer keeps today's folder label and never prints (unnamed)", () => {
    const F = makeFile("shared.ts");
    seedSession("actor", { heartbeatMs: fresh() });
    seedSession("peer", { folder: "peerproj", branch: "feat", files: [F], heartbeatMs: fresh() });
    const res = runPreTool(payload("actor", F));
    expect(res.status).toBe(0);
    const ctx = ctxOf(res.stdout);
    expect(ctx.endsWith("is also held by peerproj \u00b7 feat \u00b7 peer")).toBe(true);
    expect(ctx).not.toContain("(unnamed)");
  });

  it("P3: control and bidi code points never reach the acting agent's context", () => {
    const F = makeFile("shared.ts");
    seedSession("actor", { heartbeatMs: fresh() });
    seedSession("peer", { files: [F], heartbeatMs: fresh(), title: "ev" + ESC + "[2Jil" + RLO });
    const res = runPreTool(payload("actor", F));
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain(ESC);
    expect(res.stdout).not.toContain(RLO);
    const ctx = ctxOf(res.stdout);
    expect(ctx).not.toContain(ESC);
    expect(ctx).toContain("ev[2Jil");
  });

  it("P4: a torn title.json falls back to the folder lead", () => {
    const F = makeFile("shared.ts");
    seedSession("actor", { heartbeatMs: fresh() });
    seedSession("peer", { folder: "peerproj", files: [F], heartbeatMs: fresh(), titleRaw: "{bad" });
    const res = runPreTool(payload("actor", F));
    expect(res.status).toBe(0);
    expect(ctxOf(res.stdout)).toContain("is also held by peerproj \u00b7 main \u00b7 peer");
  });

  it("P5: a titled or torn-title peer never blocks: exit 0, empty stderr, no permissionDecision", () => {
    for (const opts of [{ title: "Logitech MK295 Mac tutukluluk sorunu" }, { titleRaw: "{bad" }]) {
      fs.rmSync(path.join(store, "sessions"), { recursive: true, force: true });
      const F = makeFile("shared.ts");
      seedSession("actor", { heartbeatMs: fresh() });
      seedSession("peer", { files: [F], heartbeatMs: fresh(), ...opts });
      const res = runPreTool(payload("actor", F));
      expect(res.status).toBe(0);
      expect(res.stderr).toBe("");
      expect(JSON.stringify(JSON.parse(res.stdout))).not.toContain("permissionDecision");
    }
  });

  it("P6: titled sessions with no shared file produce no output", () => {
    const F = makeFile("mine.ts");
    const G = makeFile("theirs.ts");
    seedSession("actor", { files: [F], heartbeatMs: fresh(), title: "Actor name" });
    seedSession("peer", { files: [G], heartbeatMs: fresh(), title: "Peer name" });
    const res = runPreTool(payload("actor", F));
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
  });
});
