import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// RED: the writer script does not exist yet. It lands in Task 2 (GREEN):
//   scripts/csm-intent.mjs  (INT-01 declare-intent writer, atomic temp+rename)
// The command runs it as `node csm-intent.mjs "<session_id>" "<text>"` (argv,
// not stdin) — mirror src/hooks.test.ts's spawnSync harness, but pass args.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const csmIntent = path.join(repoRoot, "scripts", "csm-intent.mjs");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-intent-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runIntent(sessionId: string, text: string, storeDir: string) {
  return spawnSync(process.execPath, [csmIntent, sessionId, text], {
    env: { ...process.env, CSM_STORE_DIR: storeDir },
    encoding: "utf8",
  });
}

function intentPath(storeDir: string, id: string): string {
  return path.join(storeDir, "sessions", id, "intent.txt");
}

describe("csm-intent writer (INT-01, D-01/D-02)", () => {
  it("write: writes sessions/<id>/intent.txt whose JSON has the text and a parseable ts", () => {
    const res = runIntent("intent-sess", "refactor Card", tmp);
    expect(res.status).toBe(0);

    const snap = JSON.parse(fs.readFileSync(intentPath(tmp, "intent-sess"), "utf8"));
    expect(typeof snap.intent).toBe("string");
    expect(snap.intent.length).toBeGreaterThan(0);
    expect(snap.intent).toBe("refactor Card");
    expect(typeof snap.ts).toBe("string");
    expect(Number.isFinite(Date.parse(snap.ts))).toBe(true);
  });

  it("single-writer invariant: the writer NEVER creates or touches session.json (D-01)", () => {
    const res = runIntent("intent-sess", "some intent", tmp);
    expect(res.status).toBe(0);

    // intent.txt exists, but session.json must not have been minted by this writer.
    expect(fs.existsSync(intentPath(tmp, "intent-sess"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "sessions", "intent-sess", "session.json"))).toBe(false);
  });

  it("length cap: an over-cap intent (~500 chars) is stored truncated to <= 200 chars", () => {
    const big = "a".repeat(500);
    const res = runIntent("intent-sess", big, tmp);
    expect(res.status).toBe(0);

    const snap = JSON.parse(fs.readFileSync(intentPath(tmp, "intent-sess"), "utf8"));
    expect(snap.intent.length).toBeLessThanOrEqual(200);
  });

  it("untrusted text: embedded ESC/newline/control bytes are stripped and single-lined", () => {
    // ESC (0x1B), newline, tab embedded in the intent text — built by char code so
    // no literal control byte lives in this source file.
    const ESC = String.fromCharCode(0x1b);
    const dirty = "line1\n" + ESC + "[31mline2\tline3end";
    const res = runIntent("intent-sess", dirty, tmp);
    expect(res.status).toBe(0);

    const snap = JSON.parse(fs.readFileSync(intentPath(tmp, "intent-sess"), "utf8"));
    // No C0 (0x00-0x1F) or C1 (0x80-0x9F) control code points survive.
    const hasControl = [...snap.intent].some((ch) => {
      const c = ch.charCodeAt(0);
      return c <= 0x1f || (c >= 0x80 && c <= 0x9f);
    });
    expect(hasControl).toBe(false);
    expect(snap.intent.includes("\n")).toBe(false);
    // The visible words are preserved (whitespace collapsed to single spaces).
    expect(snap.intent).toContain("line1");
    expect(snap.intent).toContain("line2");
    expect(snap.intent).toContain("end");
  });

  it("bad id: an out-of-allowlist session id writes NO file and still exits 0", () => {
    for (const badId of ["../evil", ""]) {
      const res = runIntent(badId, "attempt", tmp);
      expect(res.status).toBe(0);
    }
    // No escape write anywhere: the sessions tree stays empty (or absent).
    const sessions = path.join(tmp, "sessions");
    const leaked = fs.existsSync(sessions) ? fs.readdirSync(sessions) : [];
    expect(leaked).toHaveLength(0);
    // And no traversal outside the store.
    expect(fs.existsSync(path.join(tmp, "evil"))).toBe(false);
  });
});
