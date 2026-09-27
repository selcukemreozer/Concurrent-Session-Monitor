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
// nor asserted here. CSM_CONFLICT_MS is RESERVED (not read anywhere — see the
// detectConflicts JSDoc in src/conflicts.ts), so it lives in the README's
// "Reserved (not yet wired)" note instead of the active config table (05 IN-01).

/** Read a file resolved relative to THIS test file. */
function readRel(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const README = readRel("../README.md");

/** The 14 live, user-facing CSM_* env knobs (source-verified). */
const ENV_KNOBS = [
  "CSM_STORE_DIR",
  "CSM_STALE_MS",
  "CSM_GRACE_MS",
  "CSM_ACTIVE_MS",
  "CSM_WINDOW_MS",
  "CSM_READ_WINDOW_MS",
  "CSM_SKILL_WINDOW_MS",
  "CSM_ATTN_WINDOW_MS",
  "CSM_RUN_WINDOW_MS",
  "CSM_IDLE_WAIT_MS",
  "CSM_PORT_SCAN_MS",
  "CSM_PHASE_SCAN_MS",
  "CSM_BRANCH_SCAN_MS",
  "CSM_GSD_TOOLS",
] as const;

/** Reserved knobs: documented as inert, never as a row of the active table. */
const RESERVED_KNOBS = ["CSM_CONFLICT_MS"] as const;

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

  it("documents each of the four slash commands", () => {
    expect(README).toContain("/csm-intent");
    expect(README).toContain("/csm-branch");
    expect(README).toContain("/csm-done");
    expect(README).toContain("/csm-status");
  });

  it("documents the no-argument /csm-goto that focuses the CSM panel's terminal (260927-59z)", () => {
    const lines = README.split("\n");
    const idx = lines.findIndex((l) => l.startsWith("- `/csm-goto`:"));
    expect(idx).toBeGreaterThanOrEqual(0);
    const parts = [lines[idx]];
    for (let i = idx + 1; i < lines.length && lines[i].startsWith("  "); i++) {
      parts.push(lines[i]);
    }
    const block = parts.join(" ").replace(/\s+/g, " ");
    expect(block).toMatch(/no arguments/);
    expect(block).toMatch(/CSM panel/);
    expect(block).toMatch(/\*\*In Warp\*\*/);
    expect(block).toMatch(/exact pane/);
    expect(block).toMatch(/only bring that app to the front/);
    expect(block).toMatch(/most recently started/);
    expect(block).toMatch(/nothing is typed or sent/);
    expect(README).not.toContain("`/csm-goto <");
    expect(README).not.toContain("in-chat version of the panel's go-to-pane link");
    expect(README).toMatch(/go-to-pane link/);
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

// 05 IN-01: an inert knob must not sit in the active config table (users would
// tune it expecting an effect), but it must stay documented as reserved so the
// default-equals-CSM_WINDOW_MS contract is not silently lost.
describe("README reserved env knobs (05 IN-01)", () => {
  const lines = README.split("\n");
  const start = lines.findIndex((l) => l.startsWith("### Reserved (not yet wired)"));
  let end = lines.length;
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    if (lines[i].startsWith("#")) {
      end = i;
      break;
    }
  }
  const reserved = start >= 0 ? lines.slice(start, end).join("\n") : "";

  it("has a Reserved (not yet wired) subsection", () => {
    expect(start).toBeGreaterThanOrEqual(0);
  });

  it.each(RESERVED_KNOBS)("%s is NOT a row of the active config table", (knob) => {
    expect(lines.some((l) => l.startsWith(`| \`${knob}\``))).toBe(false);
  });

  it.each(RESERVED_KNOBS)("%s is documented in the reserved subsection", (knob) => {
    expect(reserved).toContain(knob);
  });

  it("the reserved note says the effective window equals CSM_WINDOW_MS", () => {
    expect(reserved).toContain("CSM_WINDOW_MS");
    expect(reserved).toMatch(/no effect/);
  });
});

// Quick task 260927-1zw (WR-03 / WR-04): the README must describe the real
// needs-you clear semantics. Approving a permission, rejecting a question and
// Esc fire no hook, "waiting" clears when the approved tool finishes, and
// subagent activity never clears a marker.
describe("README needs-you clear semantics (260927-1zw WR-03/WR-04)", () => {
  it("does not claim approving clears the marker", () => {
    expect(README).not.toContain("you answer, you approve");
  });

  it("does not claim any tool completion clears the marker", () => {
    expect(README).not.toContain("any tool completes");
  });

  it("documents the Esc limitation", () => {
    expect(README).toContain("Esc");
  });

  it("documents that subagent activity does not clear a marker", () => {
    expect(README).toMatch(/subagent/i);
  });

  it("documents that waiting clears when the approved tool finishes", () => {
    expect(README).toMatch(/approved tool/i);
  });

  it("keeps the 30-minute safety-net default", () => {
    expect(README).toContain("1800000");
  });
});

// Quick task 260927-46l (D-07): the README documents the running state, its
// CSM_RUN_WINDOW_MS ceiling and the Esc limitation (no Stop hook on interrupt).
describe("README running state (260927-46l)", () => {
  const lines = README.split("\n");

  it("one line documents ▶ running together with Esc, Stop and CSM_RUN_WINDOW_MS", () => {
    const line = lines.find((l) => l.includes("▶ running"));
    expect(line).toBeDefined();
    expect(line).toContain("Esc");
    expect(line).toContain("Stop");
    expect(line).toContain("CSM_RUN_WINDOW_MS");
  });

  it("the env table documents CSM_RUN_WINDOW_MS with its 1800000 default", () => {
    const row = lines.find((l) => l.startsWith("| `CSM_RUN_WINDOW_MS`"));
    expect(row).toBeDefined();
    expect(row).toContain("1800000");
  });
});

// Quick task 260927-73b (D-06): the README documents the turquoise subagent
// state, its Stop/background_tasks source and its CSM_RUN_WINDOW_MS bound.
describe("README subagent state (260927-73b)", () => {
  const lines = README.split("\n");

  it("one line documents ↻ subagent with #40E0D0, Stop, background_tasks and CSM_RUN_WINDOW_MS", () => {
    const line = lines.find((l) => l.includes("↻ subagent") && l.includes("#40E0D0"));
    expect(line).toBeDefined();
    expect(line).toContain("Stop");
    expect(line).toContain("background_tasks");
    expect(line).toContain("CSM_RUN_WINDOW_MS");
  });

  it("the CSM_RUN_WINDOW_MS env-table row mentions the subagent state", () => {
    const row = lines.find((l) => l.startsWith("| `CSM_RUN_WINDOW_MS`"));
    expect(row).toBeDefined();
    expect(row).toContain("subagent");
  });
});

// Quick 260927-4tv: the 10 s idle-waiting knob is documented in the env table.
describe("README documents CSM_IDLE_WAIT_MS (260927-4tv)", () => {
  const lines = readRel("../README.md").split("\n");
  it("the env table documents CSM_IDLE_WAIT_MS with its 10000 default", () => {
    const row = lines.find((l) => l.startsWith("| `CSM_IDLE_WAIT_MS`"));
    expect(row).toBeDefined();
    expect(row).toContain("`10000`");
  });
});
