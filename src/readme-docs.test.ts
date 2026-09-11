import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// README doc-lint Nyquist gate for SC-4 (D-08): a new user must reach a running
// panel using README.md alone, without reading the source. This test fails the
// suite if any required install step, slash command, platform note, best-effort
// model caveat, or live CSM_* env knob is missing from README — so the docs can
// never silently drift from the shipped install surface (T-05-D2 mitigation).
//
// Source-text style mirrors launcher.test.ts: stdlib fs + url only, no deps.
//
// The env-knob list below is the SOURCE-VERIFIED live set (grep of src/ + scripts/
// for `CSM_` reads). CSM_TEST_NUM is a test-only knob and MUST NOT be documented
// nor asserted here.

/** Read a file resolved relative to THIS test file. */
function readRel(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const README = readRel("../README.md");

/** The 11 live, user-facing CSM_* env knobs (source-verified). */
const ENV_KNOBS = [
  "CSM_STORE_DIR",
  "CSM_STALE_MS",
  "CSM_GRACE_MS",
  "CSM_ACTIVE_MS",
  "CSM_CONFLICT_MS",
  "CSM_WINDOW_MS",
  "CSM_READ_WINDOW_MS",
  "CSM_SKILL_WINDOW_MS",
  "CSM_PORT_SCAN_MS",
  "CSM_PHASE_SCAN_MS",
  "CSM_GSD_TOOLS",
] as const;

describe("README end-user docs (SC-4 doc-lint gate)", () => {
  it("documents the marketplace-add install step", () => {
    expect(README).toContain("/plugin marketplace add");
  });

  it("documents the QUALIFIED install form (Pitfall 4)", () => {
    expect(README).toContain(
      "/plugin install concurrent-session-monitor@concurrent-session-monitor",
    );
  });

  it("documents the /csm-setup enable step", () => {
    expect(README).toContain("/csm-setup");
  });

  it("tells the user to launch the bare `csm` command in a separate terminal", () => {
    // bare command name present ...
    expect(README).toMatch(/\bcsm\b/);
    // ... and a "separate/another terminal" instruction
    expect(README).toMatch(/separate|another|second|different/i);
    expect(README).toMatch(/terminal/i);
  });

  it("documents each of the three slash commands", () => {
    expect(README).toContain("/csm-intent");
    expect(README).toContain("/csm-done");
    expect(README).toContain("/csm-status");
  });

  it("carries a macOS platform note", () => {
    expect(README).toMatch(/macOS/);
  });

  it("carries a best-effort model caveat", () => {
    expect(README).toMatch(/best-effort/i);
    expect(README).toMatch(/model/i);
  });

  it.each(ENV_KNOBS)("documents the %s env knob", (knob) => {
    expect(README).toContain(knob);
  });

  it("does NOT document the test-only CSM_TEST_NUM knob", () => {
    expect(README).not.toContain("CSM_TEST_NUM");
  });
});
