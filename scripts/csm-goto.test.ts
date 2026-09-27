import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// /csm-goto focus script (scripts/csm-goto.mjs). Runs as
// `node csm-goto.mjs "<caller_id>" "<query>"` — mirror src/csm-branch.test.ts's
// spawnSync harness. The CSM_OPEN_CMD test seam points the opener at a fixture
// shell script that logs its argv, so no real Warp pane is ever focused.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const csmGoto = path.join(repoRoot, "scripts", "csm-goto.mjs");

let tmp: string;
let openStub: string;
let openLog: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-goto-"));
  openLog = path.join(tmp, "open.log");
  openStub = path.join(tmp, "open-stub.sh");
  fs.writeFileSync(openStub, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${openLog}"\n`);
  fs.chmodSync(openStub, 0o755);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Seed = {
  id: string;
  folder: string;
  warp?: { focus_url?: string; session_uuid?: string } | null;
  heartbeat?: string; // ISO; defaults to "now" (live)
};

function seed({ id, folder, warp, heartbeat }: Seed) {
  const dir = path.join(tmp, "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "session.json"),
    JSON.stringify({
      schema_version: 1,
      session_id: id,
      cwd: `/work/${folder}`,
      folder,
      branch: "main",
      model: "unknown",
      start_time: new Date(Date.now() - 60_000).toISOString(),
      warp: warp === undefined ? { focus_url: `warp://session/${id}`, session_uuid: id } : warp,
    }),
  );
  fs.writeFileSync(path.join(dir, "heartbeat"), heartbeat ?? new Date().toISOString());
}

function runGoto(callerId: string, query: string) {
  return spawnSync(process.execPath, [csmGoto, callerId, query], {
    env: { ...process.env, CSM_STORE_DIR: tmp, CSM_OPEN_CMD: openStub },
    encoding: "utf8",
  });
}

function opened(): string[] {
  if (!fs.existsSync(openLog)) return [];
  return fs.readFileSync(openLog, "utf8").split("\n").filter(Boolean);
}

describe("csm-goto (Warp-only, focus-only)", () => {
  it("exact folder match: opens that session's warp focus_url and reports it", () => {
    seed({ id: "aaaa1111", folder: "alpha" });
    seed({ id: "bbbb2222", folder: "beta" });
    const res = runGoto("caller-x", "beta");
    expect(res.status).toBe(0);
    expect(opened()).toEqual(["warp://session/bbbb2222"]);
    expect(res.stdout).toContain("Focused beta (bbbb2222)");
  });

  it("folder match is case-insensitive and falls back to a unique substring", () => {
    seed({ id: "aaaa1111", folder: "Concurrent-Session-Monitor" });
    seed({ id: "bbbb2222", folder: "other" });
    const res = runGoto("caller-x", "session-mon");
    expect(res.status).toBe(0);
    expect(opened()).toEqual(["warp://session/aaaa1111"]);
  });

  it("session id prefix match selects that session", () => {
    seed({ id: "aaaa1111", folder: "same" });
    seed({ id: "bbbb2222", folder: "same" });
    const res = runGoto("caller-x", "bbbb");
    expect(res.status).toBe(0);
    expect(opened()).toEqual(["warp://session/bbbb2222"]);
  });

  it("multiple matches: opens nothing and lists the candidates", () => {
    seed({ id: "aaaa1111", folder: "proj" });
    seed({ id: "bbbb2222", folder: "proj" });
    const res = runGoto("caller-x", "proj");
    expect(res.status).toBe(0);
    expect(opened()).toEqual([]);
    expect(res.stdout).toContain("matches 2 live sessions");
    expect(res.stdout).toContain("aaaa1111");
    expect(res.stdout).toContain("bbbb2222");
  });

  it("same-folder match drops the caller's own session when another matches", () => {
    seed({ id: "aaaa1111", folder: "proj" });
    seed({ id: "bbbb2222", folder: "proj" });
    const res = runGoto("aaaa1111", "proj");
    expect(res.status).toBe(0);
    expect(opened()).toEqual(["warp://session/bbbb2222"]);
  });

  it("no focus_url (session not in Warp): opens nothing and says Warp-only", () => {
    seed({ id: "aaaa1111", folder: "plain", warp: null });
    const res = runGoto("caller-x", "plain");
    expect(res.status).toBe(0);
    expect(opened()).toEqual([]);
    expect(res.stdout).toContain("no Warp focus URL");
  });

  it("empty focus_url is treated as absent", () => {
    seed({ id: "aaaa1111", folder: "plain", warp: { focus_url: "", session_uuid: "" } });
    const res = runGoto("caller-x", "plain");
    expect(res.status).toBe(0);
    expect(opened()).toEqual([]);
    expect(res.stdout).toContain("no Warp focus URL");
  });

  it("invalid focus_url (non-warp scheme, whitespace, control bytes, junk) is never opened", () => {
    const ESC = String.fromCharCode(0x1b);
    const bad = [
      "https://evil.example/",
      "file:///etc/passwd",
      "warp://x y",
      "warp://x" + ESC + "[31m",
      "not a url",
    ];
    for (const [i, url] of bad.entries()) {
      seed({ id: `bad${i}`, folder: `f${i}`, warp: { focus_url: url } });
      const res = runGoto("caller-x", `f${i}`);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("no Warp focus URL");
    }
    expect(opened()).toEqual([]);
  });

  it("stale session (old heartbeat, no pid) is not a match target", () => {
    seed({ id: "aaaa1111", folder: "gone", heartbeat: new Date(Date.now() - 3_600_000).toISOString() });
    const res = runGoto("caller-x", "gone");
    expect(res.status).toBe(0);
    expect(opened()).toEqual([]);
    expect(res.stdout).toContain("No live sessions");
  });

  it("no match: opens nothing, lists live sessions, exits 0", () => {
    seed({ id: "aaaa1111", folder: "alpha" });
    const res = runGoto("caller-x", "zzz");
    expect(res.status).toBe(0);
    expect(opened()).toEqual([]);
    expect(res.stdout).toContain('No live session matches "zzz"');
    expect(res.stdout).toContain("alpha (aaaa1111)");
  });

  it("empty query: prints usage + roster and opens nothing", () => {
    seed({ id: "aaaa1111", folder: "alpha", warp: null });
    const res = runGoto("aaaa1111", "");
    expect(res.status).toBe(0);
    expect(opened()).toEqual([]);
    expect(res.stdout).toContain("Usage: /csm-goto");
    expect(res.stdout).toContain("alpha (aaaa1111) (you)  [no Warp focus]");
  });

  it("missing store and a failing opener both still exit 0", () => {
    const res = spawnSync(process.execPath, [csmGoto, "caller-x", "alpha"], {
      env: { ...process.env, CSM_STORE_DIR: path.join(tmp, "nope"), CSM_OPEN_CMD: openStub },
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("No live sessions");

    seed({ id: "aaaa1111", folder: "alpha" });
    const fail = spawnSync(process.execPath, [csmGoto, "caller-x", "alpha"], {
      env: { ...process.env, CSM_STORE_DIR: tmp, CSM_OPEN_CMD: "/usr/bin/false" },
      encoding: "utf8",
    });
    expect(fail.status).toBe(0);
    expect(fail.stdout).toContain("Could not focus alpha");
  });

  it("query control bytes are stripped before being echoed back", () => {
    seed({ id: "aaaa1111", folder: "alpha" });
    const ESC = String.fromCharCode(0x1b);
    const res = runGoto("caller-x", "zz" + ESC + "[31mq");
    expect(res.status).toBe(0);
    expect(res.stdout.includes(ESC)).toBe(false);
  });
});
