import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink";
import { Writable, PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionRow } from "../aggregate.js";
import chalk from "chalk";

// 260926-vfm (AQ-04): raw-SGR helpers for the asking-counter color assertion.
const ESC = String.fromCharCode(27); // 0x1B
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");
}

// RED (wave 01-04): App.tsx is the ~750ms poll + full re-read panel (PANEL-05).
// readAll (01-02) is the store reader the poll calls; mock it so the test asserts
// the poll WIRING, not the store.
vi.mock("../aggregate.js", () => ({ readAll: vi.fn(() => []) }));
// RED (wave 02-05): the App owns the grace-then-prune lifecycle (D-05/D-06/D-08)
// and calls prune.ts pruneSession exactly once after the grace. Mock it so the
// test asserts the WIRING, not the filesystem rm.
vi.mock("../prune.js", () => ({ pruneSession: vi.fn() }));
// RED (wave 04.1-03): App owns the SECOND, slower port-scan timer (PORT-06, D-05).
// Mock ONLY scanPorts + portScanMs so the test asserts the scan cadence/cache/
// overlap/unmount WIRING, not a real lsof/ps spawn. Everything else in ports.js
// (livePidMap/attribute, consumed by Card.tsx's PortsPane) is preserved via the
// actual module so the LEFT pane still renders the cached ports for real.
vi.mock("../ports.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ports.js")>();
  return {
    ...actual,
    scanPorts: vi.fn(async () => []),
    portScanMs: vi.fn(() => 2500),
  };
});
// RED (wave 04.2-03): App owns the SECOND, slower phase-scan effect (PANEL-08)
// AND the sole TTY-guarded `useInput` keyboard handler (PANEL-09). Mock
// ../phases.js so these tests drive the scan cadence / focus-set / keyboard
// WIRING without spawning gsd-tools or touching the filesystem — but PRESERVE
// the pure helpers (buildFocusSet/clampOffset/cycleIndex/parseProgress +
// FAZLAR_VISIBLE_ROWS) via importOriginal so the render-path focus-set
// derivation is the real, fs-free one. resolvePlanningRoots returns a fixed
// Set of roots-with-.planning so buildFocusSet yields a deterministic focus set
// with ZERO fs probe on the render tick.
const { PROGRESS_FIXTURE, ROOTS } = vi.hoisted(() => {
  const phases = Array.from({ length: 20 }, (_, i) => ({
    number: String(i).padStart(2, "0"),
    name: `phase-${i}`,
    plans: 1,
    summaries: i < 3 ? 1 : 0,
    status: i < 3 ? "Complete" : "Pending",
  }));
  return {
    PROGRESS_FIXTURE: {
      milestone_name: "MILE",
      milestone_version: "v1",
      percent: 30,
      phases,
    },
    ROOTS: ["/projA", "/projB"] as string[],
  };
});
vi.mock("../phases.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../phases.js")>();
  return {
    ...actual,
    scanProgress: vi.fn(async () => PROGRESS_FIXTURE),
    resolvePlanningRoots: vi.fn(async () => new Set(ROOTS)),
    phaseScanMs: vi.fn(() => 3000),
    resolveGsdTools: vi.fn(() => "/dummy/gsd-tools.cjs"),
  };
});
// RED (wave 260914-ovb-01): App owns a THIRD, slower branch-scan effect (LB-02,
// D-LB-04) that derives each live session's current git branch off the render
// tick and merges it into the row it hands SessionCard/CompactRow. Mock ONLY
// scanBranches + branchScanMs so these tests drive the scan cadence/overlap/merge
// WIRING without spawning real `git` — but PRESERVE the pure `liveBranch`
// fallback via importOriginal so App's merge uses the real live-vs-snapshot rule.
vi.mock("../branch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../branch.js")>();
  return {
    ...actual,
    scanBranches: vi.fn(async () => new Map<string, string>()),
    branchScanMs: vi.fn(() => 1700),
  };
});
// RED (wave 08-06): App owns the OTURUMLAR resume pane (RESUME-04, D-14..D-19):
// a visibility-gated slow discoverSessions scan plus Enter / `o` routed through
// launch.ts. Mock ONLY the scan + its cadence, keeping every pure helper and
// constant real (reconcileSelection / followOffset / RESUME_* / fmtAge, which
// Card.tsx's SessionsPane also consumes), so these tests drive the WIRING and
// never read the real ~/.claude tree.
vi.mock("../sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions.js")>();
  return {
    ...actual,
    discoverSessions: vi.fn(async () => []),
    resumeScanMs: vi.fn(() => 4000),
    // 08-07 (D-16): `o` re-checks liveness from the CC registry right before
    // launching. registryDirs stays real (importOriginal spread).
    readLiveRegistry: vi.fn(async () => new Set<string>()),
  };
});
// Mock the launcher's two side-effecting entry points so no test ever runs
// pbcopy / osascript / open or touches the real clipboard or ~/.warp.
vi.mock("./launch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./launch.js")>();
  return {
    ...actual,
    copyResume: vi.fn(async () => ({ ok: true, copied: true, message: "copied ✓" })),
    openResume: vi.fn(async () => ({
      ok: true,
      copied: true,
      message: "opened a new Terminal window · command copied",
    })),
  };
});
import { readAll } from "../aggregate.js";
import { pruneSession } from "../prune.js";
import {
  discoverSessions,
  resumeScanMs,
  readLiveRegistry,
  registryDirs,
  RESUME_LIST_N,
  type ResumeRow,
} from "../sessions.js";
import { copyResume, openResume } from "./launch.js";
import { scanPorts, portScanMs } from "../ports.js";
import type { ScannedPort } from "../ports.js";
import {
  scanProgress,
  resolvePlanningRoots,
  phaseScanMs,
  resolveGsdTools,
} from "../phases.js";
import { scanBranches, branchScanMs } from "../branch.js";
import { App } from "./App.js";

/** The mocked scan cadence (ms) — App arms its 2nd interval at portScanMs(). */
const PORT_CADENCE = 2500;

/** The mocked phase-scan cadence (ms) — App arms its 3rd interval at phaseScanMs(). */
const PHASE_CADENCE = 3000;

/** The mocked branch-scan cadence (ms) — App arms its 4th interval at branchScanMs(). */
const BRANCH_CADENCE = 1700;

/** The mocked OTURUMLAR scan cadence (ms) — armed ONLY while the pane is visible (D-19). */
const RESUME_CADENCE = 4000;

/**
 * A minimal fake TTY stdin (Pitfall 1 / Wave 0 Gaps): an in-memory duplex with
 * `isTTY:true` + a noop `setRawMode` (plus `ref`/`unref`) so Ink's `useInput`
 * engages raw mode and attaches its `readable` listener WITHOUT a real terminal.
 * Emitting a keypress is `stdin.write(<escape sequence>)`.
 */
function fakeTtyStdin(): NodeJS.ReadStream {
  const s = new PassThrough() as unknown as NodeJS.ReadStream;
  (s as unknown as { isTTY: boolean }).isTTY = true;
  (s as unknown as { setRawMode: (m: boolean) => void }).setRawMode = () => {};
  (s as unknown as { ref: () => unknown }).ref = () => s;
  (s as unknown as { unref: () => unknown }).unref = () => s;
  return s;
}

/** Terminal escape sequences Ink's parseKeypress resolves to key.{tab,shift,...}. */
const KEYS = {
  tab: "\t",
  shiftTab: "[Z",
  up: "[A",
  down: "[B",
  pageUp: "[5~",
  pageDown: "[6~",
  enter: "\r",
  r: "r",
  o: "o",
  ctrlR: "\x12",
  metaO: "\x1bo",
  ctrlC: "\x03",
} as const;

/** Emit a keypress into a fake TTY stdin. */
function press(stdin: NodeJS.ReadStream, seq: string): void {
  (stdin as unknown as { write: (s: string) => void }).write(seq);
}

/** A live SessionRow carrying a cwd so buildFocusSet + the .planning/ probe pair it. */
function makeFocusRow(id: string, folder: string, cwd: string): SessionRow {
  return makeRow({ session_id: id, folder, alive: true, dotState: "active", cwd } as Partial<SessionRow>);
}

/** A non-TTY sink so Ink renders without touching the real terminal. */
function fakeStdout(rows = 24, columns = 80): NodeJS.WriteStream {
  const out = new Writable({ write(_c, _e, cb) { cb(); } }) as unknown as NodeJS.WriteStream;
  (out as unknown as { columns: number }).columns = columns;
  (out as unknown as { rows: number }).rows = rows;
  return out;
}

/**
 * Render the App into a captured buffer. `debug:true` makes Ink unthrottled and
 * writes the full frame synchronously to the injected stdout (verified against
 * ink 7.1.1 `onRender` debug branch), so the returned `frame()` is the rendered
 * text — no async flush needed. `useWindowSize` reads the injected stdout's
 * rows/columns, so passing a small `rows` drives the height-overflow switch.
 */
function renderCapture(rows = 24, columns = 80, stdin?: NodeJS.ReadStream) {
  let buf = "";
  const out = new Writable({ write(c, _e, cb) { buf += c.toString(); cb(); } }) as unknown as NodeJS.WriteStream;
  (out as unknown as { columns: number }).columns = columns;
  (out as unknown as { rows: number }).rows = rows;
  const opts: Parameters<typeof render>[1] = {
    stdout: out,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  };
  // Inject a fake-TTY stdin so the App's guarded useInput engages raw mode for
  // keyboard tests; omit it to exercise the non-TTY (isRawModeSupported false)
  // static-degrade path.
  if (stdin) (opts as { stdin?: NodeJS.ReadStream }).stdin = stdin;
  const inst = render(React.createElement(App), opts);
  return { inst, frame: () => buf, clear: () => { buf = ""; } };
}

/** A minimal-but-complete SessionRow for render/lifecycle assertions. */
function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    schema_version: 1,
    session_id: "sess-0001",
    folder: "proj",
    branch: "main",
    model: "claude",
    start_time: new Date().toISOString(),
    files: [],
    alive: true,
    readyToPrune: false,
    dotState: "active",
    ...overrides,
  } as SessionRow;
}

// After GREEN, App imports ../phases.js, so its phase-scan effect runs in EVERY
// test. Re-arm the phases mocks before each test (a prior describe's
// restoreAllMocks strips vi.fn implementations) so App never calls an
// undefined-returning scanProgress()/resolvePlanningRoots() and crashes. Tests
// that need to assert on these override/clear them in their own beforeEach.
beforeEach(() => {
  vi.mocked(scanProgress).mockResolvedValue(PROGRESS_FIXTURE);
  vi.mocked(resolvePlanningRoots).mockResolvedValue(new Set(ROOTS));
  vi.mocked(phaseScanMs).mockReturnValue(PHASE_CADENCE);
  vi.mocked(resolveGsdTools).mockReturnValue("/dummy/gsd-tools.cjs");
  // After GREEN, App imports ../branch.js, so its branch-scan effect runs in EVERY
  // test. Re-arm the branch mocks (a prior describe's restoreAllMocks strips vi.fn
  // implementations) so App never calls an undefined-returning scanBranches() and
  // crashes. Tests that assert on these override them in their own beforeEach.
  vi.mocked(scanBranches).mockResolvedValue(new Map<string, string>());
  vi.mocked(branchScanMs).mockReturnValue(BRANCH_CADENCE);
  // After GREEN (08-06), App imports ../sessions.js and ./launch.js. Re-arm the
  // resume-scan and launcher mocks (restoreAllMocks may strip implementations)
  // so App never awaits an undefined-returning discoverSessions()/copyResume().
  vi.mocked(discoverSessions).mockResolvedValue([]);
  vi.mocked(resumeScanMs).mockReturnValue(RESUME_CADENCE);
  vi.mocked(readLiveRegistry).mockResolvedValue(new Set<string>());
  vi.mocked(copyResume).mockResolvedValue({ ok: true, copied: true, message: "copied ✓" });
  vi.mocked(openResume).mockResolvedValue({
    ok: true,
    copied: true,
    message: "opened a new Terminal window · command copied",
  });
});

describe("App poll loop (PANEL-05 live refresh, Pitfall 4 full re-read)", () => {
  beforeEach(() => {
    (readAll as unknown as { mockClear: () => void }).mockClear();
    (readAll as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads on mount, arms a ~750ms interval that full-re-reads, and clears it on unmount", () => {
    const setSpy = vi.spyOn(global, "setInterval");
    const clearSpy = vi.spyOn(global, "clearInterval");

    const { unmount } = render(React.createElement(App), {
      stdout: fakeStdout(),
      patchConsole: false,
      exitOnCtrlC: false,
    });

    // Seeded from readAll() on mount (useState initializer).
    expect(readAll).toHaveBeenCalled();

    // The effect armed a poll near 750ms whose callback does a full re-read.
    const poll = setSpy.mock.calls.find((c) => c[1] === 750 && typeof c[0] === "function");
    expect(poll, "expected a setInterval(fn, 750) poll").toBeTruthy();

    (readAll as unknown as { mockClear: () => void }).mockClear();
    (poll![0] as () => void)();
    expect(readAll).toHaveBeenCalledTimes(1); // full re-read on each tick

    unmount();
    expect(clearSpy).toHaveBeenCalled(); // cleanup clears the interval
  });

  it("exports App as a renderable component", () => {
    expect(typeof App).toBe("function");
  });
});

describe("App grace-then-prune lifecycle (D-05/D-06/D-08, SC-3/SC-4)", () => {
  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (pruneSession as unknown as { mockReset: () => void }).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("prunes a vanished session exactly once after the grace, and not before", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const id = "vanish-1";
    // Present on mount, then it vanishes (clean SessionEnd) on every later tick.
    vi.mocked(readAll).mockReturnValueOnce([makeRow({ session_id: id })]).mockReturnValue([]);

    const { unmount } = render(React.createElement(App), {
      stdout: fakeStdout(),
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });

    // Mount: the row is present + alive, so no grace, no prune.
    expect(pruneSession).not.toHaveBeenCalled();

    // One tick later the row has vanished — grace starts, but has not elapsed.
    vi.advanceTimersByTime(750);
    expect(pruneSession).not.toHaveBeenCalled();

    // Advance well past the grace: prune fires exactly once for the id.
    vi.advanceTimersByTime(5000);
    expect(pruneSession).toHaveBeenCalledTimes(1);
    expect(pruneSession).toHaveBeenCalledWith(id);

    unmount();
  });

  it("never prunes a session that stays alive", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown })
      .mockReturnValue([makeRow({ session_id: "live-1", alive: true, readyToPrune: false, dotState: "active" })]);

    const { unmount } = render(React.createElement(App), {
      stdout: fakeStdout(),
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });

    vi.advanceTimersByTime(10000);
    expect(pruneSession).not.toHaveBeenCalled();
    unmount();
  });

  it("renders a dead/readyToPrune row as a dim-grey 'ended' state during the grace", () => {
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown })
      .mockReturnValue([makeRow({ session_id: "dead-1", folder: "dyingproj", alive: false, readyToPrune: true, dotState: "stale" })]);

    const { inst, frame } = renderCapture();
    expect(frame()).toContain("ended");
    inst.unmount();
  });

  it("A1: the ended ghost row leads with the native name (Ghost name), no (unnamed)", () => {
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue([
      makeRow({
        session_id: "dead-1",
        folder: "dyingproj",
        title: "Ghost name",
        alive: false,
        readyToPrune: true,
        dotState: "stale",
      } as Partial<SessionRow>),
    ]);

    const { inst, frame } = renderCapture();
    expect(frame()).toContain("● Ghost name · dead-1 · ended");
    expect(frame()).not.toContain("(unnamed)");
    inst.unmount();
  });

  it("A2: an unnamed ended ghost row keeps the folder lead", () => {
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue([
      makeRow({ session_id: "dead-1", folder: "dyingproj", alive: false, readyToPrune: true, dotState: "stale" }),
    ]);

    const { inst, frame } = renderCapture();
    expect(frame()).toContain("● dyingproj · dead-1 · ended");
    inst.unmount();
  });
});

describe("App summary header (D-15)", () => {
  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (pruneSession as unknown as { mockReset: () => void }).mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("reports live + idle counts with a 0 conflicts placeholder", () => {
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue([
      makeRow({ session_id: "a", alive: true, dotState: "active" }),
      makeRow({ session_id: "b", alive: true, dotState: "idle" }),
    ]);

    const { inst, frame } = renderCapture();
    const out = frame();
    expect(out).toContain("2 live");
    expect(out).toContain("1 idle");
    expect(out).toContain("0 conflicts");
    inst.unmount();
  });
});

// RED (06-05): the header gains a "N waiting" counter beside "N conflicts"
// (D-01), counting ONLY non-ended display rows (Pitfall 5) — an ended/grey row in
// the grace state must never inflate the count nor resurrect a pruned session. The
// counter is always rendered (colored only when >0) for layout stability. RED
// until App.tsx adds the nWaiting counter.
describe("App waiting counter (ATTN-03, D-01 header counter, Pitfall 5)", () => {
  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (pruneSession as unknown as { mockReset: () => void }).mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("counts only non-ended waiting rows: '1 waiting' for one live waiting row while an ended waiting row is excluded", () => {
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue([
      makeRow({ session_id: "live-wait", alive: true, readyToPrune: false, dotState: "active", attention: true } as Partial<SessionRow>),
      // An ended/grey row (readyToPrune) that is ALSO waiting — must NOT be counted.
      makeRow({ session_id: "ended-wait", alive: false, readyToPrune: true, dotState: "stale", attention: true } as Partial<SessionRow>),
    ]);
    const { inst, frame } = renderCapture();
    expect(frame()).toContain("1 waiting");
    inst.unmount();
  });

  it("renders '0 waiting' when no live session is waiting (counter always shown)", () => {
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue([
      makeRow({ session_id: "a", alive: true, dotState: "active", attention: false } as Partial<SessionRow>),
    ]);
    const { inst, frame } = renderCapture();
    expect(frame()).toContain("0 waiting");
    inst.unmount();
  });
});

// --- Quick task 260926-vfm (AQ-04): the header gains an "N asking" counter
// (magenta+bold when > 0) beside "N waiting", with the same visibility rules —
// always rendered, non-ended rows only — and each row counted exactly once
// (asking wins over waiting).
describe("App asking counter (AQ-04)", () => {
  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (pruneSession as unknown as { mockReset: () => void }).mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  const setRows = (rows: SessionRow[]) =>
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue(rows);

  it("P7: counts only non-ended asking rows — '1 asking' and '1 waiting'", () => {
    setRows([
      makeRow({ session_id: "live-ask", alive: true, dotState: "active", asking: true } as Partial<SessionRow>),
      makeRow({ session_id: "live-wait", alive: true, dotState: "active", attention: true } as Partial<SessionRow>),
      makeRow({ session_id: "ended-ask", alive: false, readyToPrune: true, dotState: "stale", asking: true } as Partial<SessionRow>),
    ]);
    const { inst, frame } = renderCapture();
    expect(frame()).toContain("1 asking");
    expect(frame()).toContain("1 waiting");
    inst.unmount();
  });

  it("P8: renders '0 asking' and '0 waiting' when nobody needs you (counter always shown)", () => {
    setRows([makeRow({ session_id: "a", alive: true, dotState: "active" } as Partial<SessionRow>)]);
    const { inst, frame } = renderCapture();
    expect(frame()).toContain("0 asking");
    expect(frame()).toContain("0 waiting");
    inst.unmount();
  });

  it("P9: a row with asking AND attention is counted once, under asking", () => {
    setRows([
      makeRow({ session_id: "both", alive: true, dotState: "active", asking: true, attention: true } as Partial<SessionRow>),
    ]);
    const { inst, frame } = renderCapture();
    expect(frame()).toContain("1 asking");
    expect(frame()).toContain("0 waiting");
    inst.unmount();
  });

  it("P10: the header line is magenta only when nAsking > 0", () => {
    const headerAt1 = (rows: SessionRow[]): string => {
      setRows(rows);
      const prev = chalk.level;
      chalk.level = 1;
      try {
        const { inst, frame } = renderCapture();
        const raw = frame();
        inst.unmount();
        return raw.split("\n").find((l) => stripAnsi(l).includes("conflicts")) ?? "";
      } finally {
        chalk.level = prev;
      }
    };
    const withAsk = headerAt1([
      makeRow({ session_id: "ask", alive: true, dotState: "active", asking: true } as Partial<SessionRow>),
    ]);
    expect(withAsk).not.toBe("");
    expect(withAsk).toContain(ESC + "[35m");

    const noAsk = headerAt1([makeRow({ session_id: "calm", alive: true, dotState: "active" } as Partial<SessionRow>)]);
    expect(noAsk).not.toBe("");
    expect(noAsk).not.toContain(ESC + "[35m");
  });
});

// --- Quick task 260927-73b (D-05): the header gains an "N subagent" counter
// (turquoise #40E0D0 + bold when > 0) beside "N asking", counting non-ended
// rows with the pre-gated row.subagent (rows, not agents).
describe("App subagent counter (260927-73b)", () => {
  const TURQ = ESC + "[38;2;64;224;208m";

  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (pruneSession as unknown as { mockReset: () => void }).mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  const setRows = (rows: SessionRow[]) =>
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue(rows);

  it("P11: counts non-ended subagent rows (not agents) — '2 subagent', '0 waiting', '0 asking'", () => {
    setRows([
      makeRow({ session_id: "sub-a", alive: true, dotState: "active", subagent: true, subagent_count: 2 } as Partial<SessionRow>),
      makeRow({ session_id: "sub-b", alive: true, dotState: "active", subagent: true, subagent_count: 1 } as Partial<SessionRow>),
      makeRow({
        session_id: "sub-ended",
        alive: false,
        readyToPrune: true,
        dotState: "stale",
        subagent: true,
        subagent_count: 4,
      } as Partial<SessionRow>),
    ]);
    const { inst, frame } = renderCapture();
    expect(frame()).toContain("2 subagent");
    expect(frame()).toContain("0 waiting");
    expect(frame()).toContain("0 asking");
    inst.unmount();
  });

  it("P12: renders '0 subagent' on the single header line at 80 columns", () => {
    setRows([makeRow({ session_id: "calm", alive: true, dotState: "active" } as Partial<SessionRow>)]);
    const { inst, frame } = renderCapture();
    const out = frame();
    expect(out).toContain("0 subagent");
    const header = stripAnsi(out)
      .split("\n")
      .find((l) => l.includes("conflicts"));
    expect(header).toBeDefined();
    expect(header).toContain("0 subagent");
    inst.unmount();
  });

  it("P13: the header line is turquoise only when nSubagent > 0", () => {
    const headerAt3 = (rows: SessionRow[]): string => {
      setRows(rows);
      const prev = chalk.level;
      chalk.level = 3;
      try {
        const { inst, frame } = renderCapture();
        const raw = frame();
        inst.unmount();
        return raw.split("\n").find((l) => stripAnsi(l).includes("conflicts")) ?? "";
      } finally {
        chalk.level = prev;
      }
    };
    const withSub = headerAt3([
      makeRow({ session_id: "sub", alive: true, dotState: "active", subagent: true, subagent_count: 1 } as Partial<SessionRow>),
    ]);
    expect(withSub).not.toBe("");
    expect(withSub).toContain(TURQ);

    const noSub = headerAt3([makeRow({ session_id: "calm", alive: true, dotState: "active" } as Partial<SessionRow>)]);
    expect(noSub).not.toBe("");
    expect(noSub).not.toContain(TURQ);
  });
});

describe("App conflict surface (PANEL-04 SC-1/SC-3, D-06/D-07)", () => {
  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (pruneSession as unknown as { mockReset: () => void }).mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  /** Two live sessions whose windows both hold the same absolute (non-existent)
   * path — resolveRealpath degrades a missing file to its lexical absolute, so
   * both fold to the same realpath and raise one conflict. */
  function overlappingRows(): SessionRow[] {
    const ts = new Date().toISOString();
    return [
      makeRow({ session_id: "a", folder: "projA", branch: "main", files: [{ file_path: "/abs/shared.ts", ts }] }),
      makeRow({ session_id: "b", folder: "projB", branch: "dev", files: [{ file_path: "/abs/shared.ts", ts }] }),
    ];
  }

  it("renders a real `1 conflicts` counter + the ⚠ band naming the file and both sessions", () => {
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue(overlappingRows());
    const { inst, frame } = renderCapture();
    const out = frame();
    expect(out).toContain("1 conflicts");
    expect(out).toContain("⚠");
    expect(out).toContain("shared.ts");
    expect(out).toContain("projA");
    expect(out).toContain("projB");
    inst.unmount();
  });

  it("omits the ⚠ band and shows `0 conflicts` when no path overlaps (D-07)", () => {
    const ts = new Date().toISOString();
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue([
      makeRow({ session_id: "a", folder: "projA", files: [{ file_path: "/abs/a.ts", ts }] }),
      makeRow({ session_id: "b", folder: "projB", files: [{ file_path: "/abs/b.ts", ts }] }),
    ]);
    const { inst, frame } = renderCapture();
    const out = frame();
    expect(out).toContain("0 conflicts");
    expect(out).not.toContain("⚠");
    inst.unmount();
  });

  it("renders the ⚠ band in BOTH compact and card modes (D-07 mode-independence)", () => {
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue(overlappingRows());
    const compact = renderCapture(6, 120);
    expect(compact.frame()).toContain("⚠");
    compact.inst.unmount();

    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue(overlappingRows());
    const card = renderCapture(80, 120);
    expect(card.frame()).toContain("⚠");
    card.inst.unmount();
  });

  it("does NOT raise a conflict from a dead/ghost row sharing the path (SC-3)", () => {
    const ts = new Date().toISOString();
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue([
      makeRow({ session_id: "live", folder: "projA", files: [{ file_path: "/abs/shared.ts", ts }] }),
      makeRow({ session_id: "ghost", folder: "projB", alive: false, readyToPrune: true, dotState: "stale", files: [{ file_path: "/abs/shared.ts", ts }] }),
    ]);
    const { inst, frame } = renderCapture();
    const out = frame();
    expect(out).toContain("0 conflicts");
    expect(out).not.toContain("⚠");
    inst.unmount();
  });
});

describe("App de-framed header (borderless, HEADER_LINES=3)", () => {
  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (pruneSession as unknown as { mockReset: () => void }).mockReset();
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps the title + summary but drops the round-border corner glyph", () => {
    const { inst, frame } = renderCapture();
    const out = frame();
    expect(out).toContain("◆ Concurrent Session Monitor");
    expect(out).toContain("0 live");
    expect(out).toContain("0 conflicts");
    // The round-border top-left corner glyph ╭ (U+256D) proves the frame is gone.
    expect(out).not.toContain("╭");
    inst.unmount();
  });
});

describe("App height-driven compact overflow (D-13)", () => {
  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (pruneSession as unknown as { mockReset: () => void }).mockReset();
    const many = Array.from({ length: 10 }, (_, i) =>
      makeRow({ session_id: `s-${i}`, folder: `proj-${i}` }),
    );
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue(many);
  });
  afterEach(() => vi.restoreAllMocks());

  it("collapses to one-line CompactRow rows when the rows do not fit", () => {
    const { inst, frame } = renderCapture(6, 120); // tiny height, wide enough not to wrap
    const out = frame();
    // CompactRow ends each line with the active-file count token ("0f"); only the
    // full SessionCard draws a round border (its "╭" corner) — CompactRow has none.
    expect(out).toContain("0f");
    expect(out).not.toContain("╭");
    inst.unmount();
  });

  it("renders full SessionCards when there is ample height", () => {
    const { inst, frame } = renderCapture(80, 120); // tall terminal
    const out = frame();
    expect(out).toContain("╭"); // SessionCard round-border corner
    expect(out).not.toContain("0f");
    inst.unmount();
  });
});

describe("bin/csm.mjs clean shutdown (D-14, Pitfall 3)", () => {
  it("exits 0 on SIGTERM (unmounts the alt-screen shell instead of stranding)", async () => {
    const binPath = fileURLToPath(new URL("../../bin/csm.mjs", import.meta.url));
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "csm-shutdown-"));

    const code: number = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [binPath], {
        env: { ...process.env, CSM_STORE_DIR: store },
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", reject);
      child.on("exit", (c) => resolve(c ?? -1));
      // Give tsImport time to transpile the App -> Card -> aggregate graph and boot.
      setTimeout(() => child.kill("SIGTERM"), 600);
    });

    fs.rmSync(store, { recursive: true, force: true });
    expect(code).toBe(0);
  }, 15000);
});

describe("port scan cadence (PORT-06, D-05)", () => {
  /** A mocked scanned port that lands in the user bucket (no live pid match), so
   * PortsPane renders `<port> · <command> · local` regardless of the roster. */
  function makePort(o: Partial<ScannedPort> = {}): ScannedPort {
    return { port: 5173, pid: 999999, command: "vite", exposed: false, ancestryPids: [999999], origin: "other", ...o };
  }

  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (readAll as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue([]);
    vi.mocked(scanPorts).mockReset();
    vi.mocked(scanPorts).mockResolvedValue([]);
    vi.mocked(portScanMs).mockReturnValue(PORT_CADENCE);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // restoreAllMocks strips the scanPorts/portScanMs implementations; re-arm the
    // module mocks so the next describe/test still sees callable stubs.
    vi.mocked(scanPorts).mockResolvedValue([]);
    vi.mocked(portScanMs).mockReturnValue(PORT_CADENCE);
  });

  it("port scan: runs once on mount and arms the 750ms poll independently of the scan timer", () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(global, "setInterval");

    const { unmount } = render(React.createElement(App), {
      stdout: fakeStdout(),
      patchConsole: false,
      exitOnCtrlC: false,
    });

    // Mount fires exactly one initial scan.
    expect(scanPorts).toHaveBeenCalledTimes(1);
    // Two independent timers armed: the 750ms poll AND the portScanMs scan.
    expect(setSpy.mock.calls.some((c) => c[1] === 750), "expected a 750ms poll interval").toBe(true);
    expect(
      setSpy.mock.calls.some((c) => c[1] === PORT_CADENCE),
      "expected a portScanMs() scan interval distinct from the poll",
    ).toBe(true);

    unmount();
  });

  it("port scan: the cadence tick re-scans but the 750ms poll tick does NOT scan (D-05)", async () => {
    vi.useFakeTimers();
    const { unmount } = render(React.createElement(App), {
      stdout: fakeStdout(),
      patchConsole: false,
      exitOnCtrlC: false,
    });

    expect(scanPorts).toHaveBeenCalledTimes(1); // mount scan

    // A poll tick (750ms) must NOT trigger a scan — the scan is on its own timer.
    await vi.advanceTimersByTimeAsync(750);
    expect(scanPorts).toHaveBeenCalledTimes(1);

    // Reaching the cadence boundary triggers the next scan.
    await vi.advanceTimersByTimeAsync(PORT_CADENCE - 750);
    expect(scanPorts).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("port scan: an in-flight scan blocks the next cadence tick (overlap guard)", async () => {
    vi.useFakeTimers();
    let release!: (v: ScannedPort[]) => void;
    // Mount scan stays pending until we release it.
    vi.mocked(scanPorts).mockReturnValueOnce(new Promise<ScannedPort[]>((r) => { release = r; }));

    const { unmount } = render(React.createElement(App), {
      stdout: fakeStdout(),
      patchConsole: false,
      exitOnCtrlC: false,
    });

    expect(scanPorts).toHaveBeenCalledTimes(1); // pending mount scan

    // Cadence fires while the prior scan is still in flight — must be skipped.
    await vi.advanceTimersByTimeAsync(PORT_CADENCE);
    expect(scanPorts).toHaveBeenCalledTimes(1);

    // Resolve the pending scan; the guard clears and the next cadence scans.
    release([]);
    await vi.advanceTimersByTimeAsync(PORT_CADENCE);
    expect(scanPorts).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("port scan: caches the resolved ScannedPort[] and renders it in the LEFT pane", async () => {
    vi.mocked(scanPorts).mockResolvedValue([makePort()]);

    const { inst, frame } = renderCapture();
    await vi.waitFor(() => expect(frame()).toContain("5173"));
    expect(frame()).toContain("vite");

    inst.unmount();
  });

  it("port scan: clears the scan interval on unmount (no scans after unmount)", async () => {
    vi.useFakeTimers();
    const { unmount } = render(React.createElement(App), {
      stdout: fakeStdout(),
      patchConsole: false,
      exitOnCtrlC: false,
    });

    expect(scanPorts).toHaveBeenCalledTimes(1); // mount scan
    unmount();

    // Well past several cadence boundaries — a cleared interval fires nothing.
    await vi.advanceTimersByTimeAsync(PORT_CADENCE * 3);
    expect(scanPorts).toHaveBeenCalledTimes(1);
  });
});

describe("App FAZLAR pane wiring (PANEL-08/09, D-01/D-02/D-04/D-07/D-08)", () => {
  const rows = () => [
    makeFocusRow("a", "projA", "/projA"),
    makeFocusRow("b", "projB", "/projB"),
  ];

  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (pruneSession as unknown as { mockReset: () => void }).mockReset();
    (readAll as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(rows());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("non-TTY: renders the focused project statically, no Tab hint / no i·N indicator, never throws (D-08)", async () => {
    let cap!: ReturnType<typeof renderCapture>;
    expect(() => { cap = renderCapture(24, 80); }).not.toThrow(); // no stdin => non-TTY
    // The phase-scan effect still runs off the render tick and caches Progress.
    await vi.waitFor(() => expect(cap.frame()).toContain("MILE"));
    expect(cap.frame()).not.toContain("Tab: switch"); // hint hidden when non-interactive
    expect(cap.frame()).not.toContain("Project 1/"); // i/N indicator hidden too
    cap.inst.unmount();
  });

  it("Tab cycles the focused project forward; Shift+Tab reverses (D-01/D-02)", async () => {
    const stdin = fakeTtyStdin();
    const cap = renderCapture(24, 80, stdin);
    await vi.waitFor(() => expect(cap.frame()).toContain("Project 1/2"));
    expect(cap.frame()).toContain("projA"); // D-02: most-recently-active default focus

    cap.clear();
    press(stdin, KEYS.tab);
    await vi.waitFor(() => expect(cap.frame()).toContain("Project 2/2"));
    expect(cap.frame()).toContain("projB");

    cap.clear();
    press(stdin, KEYS.shiftTab);
    await vi.waitFor(() => expect(cap.frame()).toContain("Project 1/2"));
    expect(cap.frame()).toContain("projA");
    cap.inst.unmount();
  });

  it("arrow keys scroll the FAZLAR window; up clamps at the top; Tab resets the offset (D-04)", async () => {
    const stdin = fakeTtyStdin();
    const cap = renderCapture(40, 100, stdin);
    // Fixture has 20 phases; the 15-row window shows phase-0..phase-14 at offset 0.
    await vi.waitFor(() => expect(cap.frame()).toContain("phase-0"));
    expect(cap.frame()).not.toContain("phase-15"); // below the window at offset 0

    cap.clear();
    press(stdin, KEYS.down); // offset -> 1: window is phase-1..phase-15
    await vi.waitFor(() => expect(cap.frame()).toContain("phase-15"));

    cap.clear();
    press(stdin, KEYS.up); // back to offset 0
    await vi.waitFor(() => expect(cap.frame()).toContain("phase-0"));
    cap.clear();
    press(stdin, KEYS.up); // up at the top clamps — still offset 0
    await vi.waitFor(() => expect(cap.frame()).toContain("phase-0"));
    expect(cap.frame()).not.toContain("phase-15");

    // Scroll down, then Tab to another project — the offset resets to the top.
    cap.clear();
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(cap.frame()).toContain("phase-15"));
    cap.clear();
    press(stdin, KEYS.tab);
    await vi.waitFor(() => expect(cap.frame()).toContain("phase-0"));
    expect(cap.frame()).not.toContain("phase-15"); // offset reset on focus change
    cap.inst.unmount();
  });

  it("arms a SECOND phase-scan interval at phaseScanMs cadence, distinct from the 750 poll, calling resolvePlanningRoots + scanProgress (PANEL-08)", async () => {
    const setSpy = vi.spyOn(global, "setInterval");
    const stdin = fakeTtyStdin();
    const cap = renderCapture(24, 80, stdin);

    await vi.waitFor(() => {
      expect(resolvePlanningRoots).toHaveBeenCalled(); // the sole .planning/ probe
      expect(scanProgress).toHaveBeenCalled(); // scans the focused project
    });

    // A dedicated cadence timer, separate from the 750ms poll (never inside it).
    expect(
      setSpy.mock.calls.some((c) => c[1] === PHASE_CADENCE),
      "expected a phaseScanMs() interval distinct from the 750ms poll",
    ).toBe(true);
    expect(setSpy.mock.calls.some((c) => c[1] === 750)).toBe(true);
    cap.inst.unmount();
  });

  it("clean shutdown: unmounts with raw mode engaged without throwing (D-07)", async () => {
    const stdin = fakeTtyStdin();
    const cap = renderCapture(24, 80, stdin);
    // The interactive hint proves raw mode engaged via the guarded useInput.
    await vi.waitFor(() => expect(cap.frame()).toContain("Tab: switch"));
    expect(() => cap.inst.unmount()).not.toThrow(); // no double-teardown
  });
});

describe("App live-branch scan + merge (LB-02, D-LB-04)", () => {
  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (readAll as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue([]);
    vi.mocked(scanBranches).mockReset();
    vi.mocked(scanBranches).mockResolvedValue(new Map<string, string>());
    vi.mocked(branchScanMs).mockReturnValue(BRANCH_CADENCE);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // restoreAllMocks strips the branch mock implementations; re-arm so the next
    // describe/test still sees callable stubs (mirrors the port-scan describe).
    vi.mocked(scanBranches).mockResolvedValue(new Map<string, string>());
    vi.mocked(branchScanMs).mockReturnValue(BRANCH_CADENCE);
  });

  it("merges the LIVE branch into the card, overriding the session-start snapshot", async () => {
    vi.mocked(scanBranches).mockResolvedValue(new Map([["/repo/x", "feature-live"]]));
    (readAll as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue([
      makeRow({ session_id: "s1", cwd: "/repo/x", branch: "snapshot-main" } as Partial<SessionRow>),
    ]);

    const { inst, frame } = renderCapture(80, 120);
    // The async scan resolves and setBranches re-renders the card with the live branch.
    await vi.waitFor(() => expect(frame()).toContain("feature-live"));
    inst.unmount();
  });

  it("falls back to the snapshot branch when the scan resolves WITHOUT the cwd (no regression)", async () => {
    vi.mocked(scanBranches).mockResolvedValue(new Map<string, string>()); // empty -> fallback
    (readAll as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue([
      makeRow({ session_id: "s1", cwd: "/repo/x", branch: "snapshot-main" } as Partial<SessionRow>),
    ]);

    const { inst, frame } = renderCapture(80, 120);
    await vi.waitFor(() => expect(frame()).toContain("snapshot-main"));
    inst.unmount();
  });

  it("arms a branch-scan interval at branchScanMs cadence distinct from the 750 poll; an in-flight scan is overlap-guarded", async () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(global, "setInterval");
    let release!: (v: Map<string, string>) => void;
    // Keep the mount scan pending so the next cadence tick must be skipped.
    vi.mocked(scanBranches).mockReturnValueOnce(new Promise<Map<string, string>>((r) => { release = r; }));

    const { unmount } = render(React.createElement(App), {
      stdout: fakeStdout(),
      patchConsole: false,
      exitOnCtrlC: false,
    });

    expect(scanBranches).toHaveBeenCalledTimes(1); // one scan on mount
    // A dedicated cadence timer, separate from the 750ms poll (never inside it).
    expect(
      setSpy.mock.calls.some((c) => c[1] === BRANCH_CADENCE),
      "expected a branchScanMs() interval distinct from the 750ms poll",
    ).toBe(true);
    expect(setSpy.mock.calls.some((c) => c[1] === 750)).toBe(true);

    // Cadence fires while the mount scan is still in flight — must be skipped.
    await vi.advanceTimersByTimeAsync(BRANCH_CADENCE);
    expect(scanBranches).toHaveBeenCalledTimes(1);

    // Resolve the pending scan; the guard clears and the next cadence scans again.
    release(new Map<string, string>());
    await vi.advanceTimersByTimeAsync(BRANCH_CADENCE);
    expect(scanBranches).toHaveBeenCalledTimes(2);

    unmount();
  });
});

// RED (wave 08-06): the OTURUMLAR resume pane wiring (RESUME-04, CONTEXT
// D-14..D-19). Everything is driven through a fake TTY stdin with real timers
// and a small mocked cadence; discoverSessions / copyResume / openResume are
// mocked above, so no test reads ~/.claude, touches the clipboard or opens a
// terminal window.
describe("App OTURUMLAR pane (Phase 8, D-14..D-19)", () => {
  const TITLE = "◆ Concurrent Session Monitor";
  const A_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const B_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  const C_ID = "cccccccc-3333-4333-8333-cccccccccccc";
  const NOW = Date.now();
  const A: ResumeRow = {
    id: A_ID, label: "alpha-sess", labelKind: "name", folder: "proj",
    cwd: "/w/a", mtimeMs: NOW - 60_000, live: false,
  };
  const B: ResumeRow = {
    id: B_ID, label: "beta-sess", labelKind: "name", folder: "proj",
    cwd: "/w/b", mtimeMs: NOW - 120_000, live: false,
  };
  const C: ResumeRow = {
    id: C_ID, label: "gamma-sess", labelKind: "name", folder: "proj",
    cwd: "/w/c", mtimeMs: NOW - 180_000, live: true,
  };
  // Two live focus rows so FAZLAR has content; the first is session A (D-11).
  const rows = () => [
    makeFocusRow(A_ID, "projA", "/projA"),
    makeFocusRow("b", "projB", "/projB"),
  ];

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  /** The most recent full frame (debug mode appends every frame to the buffer). */
  const latest = (buf: string) => {
    const i = buf.lastIndexOf(TITLE);
    return i >= 0 ? buf.slice(i) : buf;
  };
  /** The line of the latest frame carrying the `▸` cursor. */
  const cursorLine = (buf: string) => latest(buf).split("\n").find((l) => l.includes("▸")) ?? "";
  const calls = () => vi.mocked(discoverSessions).mock.calls.length;

  /** Render on a fake TTY (wide, so pane lines never wrap) and wait for FAZLAR. */
  async function openTty() {
    const stdin = fakeTtyStdin();
    const cap = renderCapture(40, 160, stdin);
    await vi.waitFor(() => expect(latest(cap.frame())).toContain("MILE"));
    return { stdin, cap };
  }
  /** Press `r` and wait for the OTURUMLAR heading. */
  async function openSessions(stdin: NodeJS.ReadStream, cap: ReturnType<typeof renderCapture>) {
    press(stdin, KEYS.r);
    await vi.waitFor(() => expect(latest(cap.frame())).toContain("OTURUMLAR"));
  }

  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (pruneSession as unknown as { mockReset: () => void }).mockReset();
    (readAll as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(rows());
    vi.mocked(discoverSessions).mockClear();
    vi.mocked(resumeScanMs).mockClear();
    vi.mocked(copyResume).mockClear();
    vi.mocked(openResume).mockClear();
    vi.mocked(readLiveRegistry).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("T1 non-TTY: no OTURUMLAR, no [r: hint, and the resume scan never runs (D-14, 04.2 D-08)", async () => {
    const setSpy = vi.spyOn(global, "setInterval");
    const cap = renderCapture(24, 80); // no stdin => non-TTY
    await vi.waitFor(() => expect(cap.frame()).toContain("MILE"));
    await sleep(50);
    expect(cap.frame()).not.toContain("OTURUMLAR");
    expect(cap.frame()).not.toContain("[r:");
    expect(discoverSessions).not.toHaveBeenCalled();
    expect(setSpy.mock.calls.some((c) => c[1] === RESUME_CADENCE)).toBe(false);
    cap.inst.unmount();
  });

  it("T2 TTY default: FAZLAR with the [r: oturumlar] hint on the Tab line; no scan yet (D-14, D-19)", async () => {
    const { cap } = await openTty();
    await vi.waitFor(() => expect(latest(cap.frame())).toContain("Tab: switch"));
    const hintLine = latest(cap.frame()).split("\n").find((l) => l.includes("Tab: switch")) ?? "";
    expect(hintLine).toContain("[r: oturumlar]");
    expect(cap.frame()).not.toContain("OTURUMLAR");
    await sleep(100);
    expect(discoverSessions).not.toHaveBeenCalled();
    cap.inst.unmount();
  });

  it("T3 `r` toggles FAZLAR <-> OTURUMLAR; the scan gets n=RESUME_LIST_N and the live store ids (D-14, D-11)", async () => {
    vi.mocked(discoverSessions).mockResolvedValue([A, B, C]);
    const { stdin, cap } = await openTty();
    press(stdin, KEYS.r);
    await vi.waitFor(() => {
      const f = latest(cap.frame());
      expect(f).toContain("OTURUMLAR");
      expect(f).toContain("alpha-sess");
    });
    const f = latest(cap.frame());
    expect(f).toContain("[r: fazlar]");
    expect(f).not.toContain("MILE");
    expect(discoverSessions).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(discoverSessions).mock.calls[0]![0]!;
    expect(opts.n).toBe(RESUME_LIST_N);
    expect(opts.liveIds).toBeInstanceOf(Set);
    expect(opts.liveIds!.has(A_ID)).toBe(true);

    press(stdin, KEYS.r);
    await vi.waitFor(() => expect(latest(cap.frame())).toContain("MILE"));
    expect(latest(cap.frame())).not.toContain("OTURUMLAR");
    cap.inst.unmount();
  });

  it("T4 the scan repeats at resumeScanMs() only while visible and stops when FAZLAR returns (D-19)", async () => {
    vi.mocked(resumeScanMs).mockReturnValue(30);
    const { stdin, cap } = await openTty();
    press(stdin, KEYS.r);
    await vi.waitFor(() => expect(calls()).toBeGreaterThanOrEqual(3));
    press(stdin, KEYS.r);
    await vi.waitFor(() => expect(latest(cap.frame())).toContain("MILE"));
    const n = calls();
    await sleep(200);
    expect(calls()).toBe(n);
    cap.inst.unmount();
  });

  it("T5 an in-flight scan blocks the next tick (overlap guard) and the pane shows scanning… (D-19)", async () => {
    vi.mocked(resumeScanMs).mockReturnValue(30);
    vi.mocked(discoverSessions).mockImplementation(() => new Promise<ResumeRow[]>(() => {}));
    const { stdin, cap } = await openTty();
    press(stdin, KEYS.r);
    await sleep(200);
    expect(discoverSessions).toHaveBeenCalledTimes(1);
    expect(latest(cap.frame())).toContain("scanning…");
    cap.inst.unmount();
  });

  it("T6 ↓ moves the cursor; it follows the session id across a reorder and falls back to the nearest row (D-15, D-17)", async () => {
    vi.mocked(resumeScanMs).mockReturnValue(30);
    vi.mocked(discoverSessions).mockResolvedValue([A, B, C]);
    const { stdin, cap } = await openTty();
    await openSessions(stdin, cap);
    await vi.waitFor(() => expect(cursorLine(cap.frame())).toContain("alpha-sess"));

    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(cursorLine(cap.frame())).toContain("beta-sess"));

    vi.mocked(discoverSessions).mockResolvedValue([C, B, A]);
    await vi.waitFor(() => {
      const f = latest(cap.frame());
      expect(f.indexOf("gamma-sess")).toBeGreaterThanOrEqual(0);
      expect(f.indexOf("gamma-sess")).toBeLessThan(f.indexOf("alpha-sess"));
    });
    expect(cursorLine(cap.frame())).toContain("beta-sess");

    vi.mocked(discoverSessions).mockResolvedValue([A, C]);
    await vi.waitFor(() => expect(cursorLine(cap.frame())).toContain("gamma-sess"));
    expect(latest(cap.frame())).not.toContain("beta-sess");
    cap.inst.unmount();
  });

  it("T7 Enter copies the selected row; the result shows and clears on the next cursor move (D-15)", async () => {
    vi.mocked(discoverSessions).mockResolvedValue([A, B, C]);
    const { stdin, cap } = await openTty();
    await openSessions(stdin, cap);
    await vi.waitFor(() => expect(cursorLine(cap.frame())).toContain("alpha-sess"));
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(cursorLine(cap.frame())).toContain("beta-sess"));

    press(stdin, KEYS.enter);
    await vi.waitFor(() =>
      expect(copyResume).toHaveBeenCalledWith(
        expect.objectContaining({ id: B_ID, cwd: "/w/b", live: false }),
      ),
    );
    await vi.waitFor(() => expect(latest(cap.frame())).toContain("copied ✓"));

    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(latest(cap.frame())).not.toContain("copied ✓"));
    cap.inst.unmount();
  });

  it("T8 `o` on a live row passes live:true and shows the copy-and-warn result (D-15, D-16)", async () => {
    vi.mocked(discoverSessions).mockResolvedValue([A, B, C]);
    vi.mocked(openResume).mockResolvedValueOnce({
      ok: false,
      copied: true,
      message: "session still open, no new tab opened · command copied",
    });
    const { stdin, cap } = await openTty();
    await openSessions(stdin, cap);
    await vi.waitFor(() => expect(cursorLine(cap.frame())).toContain("alpha-sess"));
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(cursorLine(cap.frame())).toContain("beta-sess"));
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(cursorLine(cap.frame())).toContain("gamma-sess"));

    press(stdin, KEYS.o);
    await vi.waitFor(() =>
      expect(openResume).toHaveBeenCalledWith(
        expect.objectContaining({ id: C_ID, cwd: "/w/c", live: true }),
      ),
    );
    await vi.waitFor(() =>
      expect(latest(cap.frame())).toContain("session still open, no new tab opened"),
    );
    cap.inst.unmount();
  });

  it("T9 Enter / `o` do nothing on FAZLAR; Tab is a no-op in OTURUMLAR", async () => {
    vi.mocked(discoverSessions).mockResolvedValue([A, B, C]);
    const { stdin, cap } = await openTty();
    await vi.waitFor(() => expect(latest(cap.frame())).toContain("Project 1/2"));
    press(stdin, KEYS.enter);
    await sleep(30);
    press(stdin, KEYS.o);
    await sleep(100);
    expect(copyResume).not.toHaveBeenCalled();
    expect(openResume).not.toHaveBeenCalled();

    await openSessions(stdin, cap);
    await vi.waitFor(() => expect(cursorLine(cap.frame())).toContain("alpha-sess"));
    press(stdin, KEYS.tab);
    await sleep(50);
    press(stdin, KEYS.r);
    await vi.waitFor(() => expect(latest(cap.frame())).toContain("MILE"));
    expect(latest(cap.frame())).toContain("Project 1/2");
    cap.inst.unmount();
  });

  it("T10 `r` / `o` with Ctrl or Meta are ignored", async () => {
    vi.mocked(discoverSessions).mockResolvedValue([A, B, C]);
    const { stdin, cap } = await openTty();
    press(stdin, KEYS.ctrlR);
    await sleep(100);
    expect(latest(cap.frame())).not.toContain("OTURUMLAR");

    await openSessions(stdin, cap);
    await vi.waitFor(() => expect(cursorLine(cap.frame())).toContain("alpha-sess"));
    press(stdin, KEYS.metaO);
    await sleep(100);
    expect(openResume).not.toHaveBeenCalled();
    cap.inst.unmount();
  });

  it("T11 unmount with OTURUMLAR visible clears the scan interval", async () => {
    vi.mocked(resumeScanMs).mockReturnValue(30);
    const { stdin, cap } = await openTty();
    await openSessions(stdin, cap);
    await vi.waitFor(() => expect(calls()).toBeGreaterThanOrEqual(1));
    expect(() => cap.inst.unmount()).not.toThrow();
    const n = calls();
    await sleep(150);
    expect(calls()).toBe(n);
  });

  it("T12 Ctrl+C still unmounts cleanly with OTURUMLAR visible (04.2 D-07, locked)", async () => {
    const stdin = fakeTtyStdin();
    let buf = "";
    const out = new Writable({ write(c, _e, cb) { buf += c.toString(); cb(); } }) as unknown as NodeJS.WriteStream;
    (out as unknown as { columns: number }).columns = 160;
    (out as unknown as { rows: number }).rows = 40;
    const inst = render(React.createElement(App), {
      stdout: out,
      stdin,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: true,
    });
    await vi.waitFor(() => expect(latest(buf)).toContain("MILE"));
    press(stdin, KEYS.r);
    await vi.waitFor(() => expect(latest(buf)).toContain("OTURUMLAR"));
    press(stdin, KEYS.ctrlC);
    const exited = await Promise.race([
      inst.waitUntilExit().then(() => true),
      sleep(2000).then(() => false),
    ]);
    expect(exited).toBe(true);
  });
  // ── 08-07 gap closure: D-16 launch hold (review CR-01) ─────────────────────
  // Every G-case targets row B (index 1). A's id is also a live store row
  // (readAll focus rows), so the fresh store re-check correctly treats A as live.
  /** openResume calls whose target carried live:false (i.e. real launches). */
  const launches = () =>
    vi.mocked(openResume).mock.calls.filter((c) => (c[0] as { live: boolean }).live === false);
  /** The live flag of the most recent openResume call. */
  const lastOpenLive = () => {
    const c = vi.mocked(openResume).mock.calls;
    return (c[c.length - 1]![0] as { live: boolean }).live;
  };
  /** Open OTURUMLAR (60 s cadence unless set before) and put the cursor on B. */
  async function selectB() {
    const { stdin, cap } = await openTty();
    await openSessions(stdin, cap);
    await vi.waitFor(() => expect(cursorLine(cap.frame())).toContain("alpha-sess"));
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(cursorLine(cap.frame())).toContain("beta-sess"));
    return { stdin, cap };
  }

  it("G1 a second `o` while the first launch is pending never launches again; the held row shows · live (D-16, D-11)", async () => {
    vi.mocked(resumeScanMs).mockReturnValue(60000);
    vi.mocked(discoverSessions).mockResolvedValue([A, B, C]);
    vi.mocked(openResume).mockImplementationOnce(() => new Promise(() => {}));
    const { stdin, cap } = await selectB();

    press(stdin, KEYS.o);
    await vi.waitFor(() => expect(openResume).toHaveBeenCalledTimes(1));
    expect(openResume).toHaveBeenCalledWith(
      expect.objectContaining({ id: B_ID, cwd: "/w/b", live: false }),
    );
    await vi.waitFor(() => expect(cursorLine(cap.frame())).toContain("· live"));
    expect(cursorLine(cap.frame())).toContain("beta-sess");

    press(stdin, KEYS.o);
    await vi.waitFor(() => expect(openResume).toHaveBeenCalledTimes(2));
    expect(lastOpenLive()).toBe(true);
    expect(launches()).toHaveLength(1);
    cap.inst.unmount();
  });

  it("G2 after a successful launch the row stays held: `o` passes live:true and Enter warns (D-16)", async () => {
    vi.mocked(resumeScanMs).mockReturnValue(60000);
    vi.mocked(discoverSessions).mockResolvedValue([A, B, C]);
    const { stdin, cap } = await selectB();

    press(stdin, KEYS.o);
    await vi.waitFor(() => expect(openResume).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(latest(cap.frame())).toContain("opened a new Terminal window"));

    press(stdin, KEYS.o);
    await vi.waitFor(() => expect(openResume).toHaveBeenCalledTimes(2));
    expect(lastOpenLive()).toBe(true);

    press(stdin, KEYS.enter);
    await vi.waitFor(() =>
      expect(copyResume).toHaveBeenCalledWith(
        expect.objectContaining({ id: B_ID, cwd: "/w/b", live: true }),
      ),
    );
    expect(launches()).toHaveLength(1);
    cap.inst.unmount();
  });

  it("G3 a failed launch releases its own claim, so `o` can retry at once (D-16)", async () => {
    vi.mocked(resumeScanMs).mockReturnValue(60000);
    vi.mocked(discoverSessions).mockResolvedValue([A, B, C]);
    vi.mocked(openResume).mockResolvedValueOnce({
      ok: false,
      copied: true,
      message: "could not open a new tab, paste the command · command copied",
    });
    const { stdin, cap } = await selectB();

    press(stdin, KEYS.o);
    await vi.waitFor(() =>
      expect(latest(cap.frame())).toContain("could not open a new tab, paste the command"),
    );

    press(stdin, KEYS.o);
    await vi.waitFor(() => expect(openResume).toHaveBeenCalledTimes(2));
    expect(lastOpenLive()).toBe(false);
    cap.inst.unmount();
  });

  it("G4 a scan that confirms the session live releases the hold; once it ends, `o` launches again (D-16)", async () => {
    vi.mocked(resumeScanMs).mockReturnValue(30);
    vi.mocked(discoverSessions).mockResolvedValue([A, B, C]);
    const { stdin, cap } = await selectB();

    press(stdin, KEYS.o);
    await vi.waitFor(() => expect(openResume).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(latest(cap.frame())).toContain("opened a new Terminal window"));

    vi.mocked(discoverSessions).mockResolvedValue([A, { ...B, live: true }, C]);
    let n = calls();
    await vi.waitFor(() => expect(calls()).toBeGreaterThanOrEqual(n + 2));

    vi.mocked(discoverSessions).mockResolvedValue([A, B, C]);
    n = calls();
    await vi.waitFor(() => expect(calls()).toBeGreaterThanOrEqual(n + 2));

    press(stdin, KEYS.o);
    await vi.waitFor(() => expect(openResume).toHaveBeenCalledTimes(2));
    expect(lastOpenLive()).toBe(false);
    cap.inst.unmount();
  });

  it("G5 `o` re-checks liveness from the registry right before launching (D-16)", async () => {
    vi.mocked(resumeScanMs).mockReturnValue(60000);
    vi.mocked(discoverSessions).mockResolvedValue([A, B, C]);
    vi.mocked(readLiveRegistry).mockResolvedValueOnce(new Set([B_ID]));
    vi.mocked(openResume).mockImplementation(async (t) =>
      t.live
        ? { ok: false, copied: true, message: "session still open, no new tab opened · command copied" }
        : { ok: true, copied: true, message: "opened a new Terminal window · command copied" },
    );
    const { stdin, cap } = await selectB();

    press(stdin, KEYS.o);
    await vi.waitFor(() => expect(openResume).toHaveBeenCalledTimes(1));
    expect(openResume).toHaveBeenCalledWith(expect.objectContaining({ id: B_ID, live: true }));
    await vi.waitFor(() =>
      expect(latest(cap.frame())).toContain("session still open, no new tab opened"),
    );
    expect(readLiveRegistry).toHaveBeenCalledWith(registryDirs());

    press(stdin, KEYS.o);
    await vi.waitFor(() => expect(openResume).toHaveBeenCalledTimes(2));
    expect(lastOpenLive()).toBe(false);
    cap.inst.unmount();
  });
});
