import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cellWidth } from "./ui/text.js";
import type { SessionRow } from "../aggregate.js";
import { PanelApp } from "./PanelApp.js";
import {
  renderCapture,
  renderTty,
  fakeTtyStdin,
  nonTtyStdin,
  press,
  KEYS,
  frameLines,
} from "./ui/test-harness.js";
import { HOME_ERASE_DOWN } from "./hooks/useResizeRepaint.js";
import { stripVTControlCharacters } from "node:util";
import { drawShell } from "./ui/draw/shell.js";
import { headerFromRoster } from "./ui/headerModel.js";
import { initialUi } from "./ui/uiState.js";
import { SAMPLE } from "./ui/sample.js";
import { PALETTE } from "./ui/palette.js";
import { lineText } from "./ui/screen.js";
import { buildAgents, stableOrder } from "./ui/build/agents.js";
import type { GotoDeps } from "./actions/goto.js";
import { HEX32 } from "../warp-url.fixtures.js";

// Phase 9 plan 09-12 Task 2: the v2 root through real Ink. The store is mocked
// to two live rows (one asking, one waiting) so the LIVE header (D-20) is
// provable; every pane is the SAMPLE fixture. Keys go through the 09-02
// harness: a fake TTY for the keyboard cases, a non-TTY for keys off.

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

const ROWS = vi.hoisted(() => ({ list: [] as SessionRow[] }));
vi.mock("../aggregate.js", () => ({ readAll: vi.fn(() => ROWS.list) }));
vi.mock("../prune.js", () => ({ pruneSession: vi.fn() }));
// 10-09: PanelApp calls useBranches, which spawns git; mock only the scan and
// its cadence (as App.test.tsx does), keeping the pure liveBranch fallback.
vi.mock("../branch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../branch.js")>();
  return {
    ...actual,
    scanBranches: vi.fn(async () => new Map<string, string>()),
    branchScanMs: vi.fn(() => 10_000_000),
  };
});
// 10-11: PanelApp calls usePorts, which spawns lsof/ps; mock only the scan
// (a fixture list) and its cadence (as App.test.tsx does), keeping the pure
// livePidMap / attribute join the detail strip uses for owned ports.
const PORTS = vi.hoisted(() => ({ list: [] as import("../ports.js").ScannedPort[] }));
vi.mock("../ports.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ports.js")>();
  return {
    ...actual,
    scanPorts: vi.fn(async () => PORTS.list),
    portScanMs: vi.fn(() => 10_000_000),
    // 10-15: a stub, so no test can ever signal a real process
    killPort: vi.fn(async () => ({ ok: false, message: "test stub" })),
  };
});
const { UPDATE_STOP } = vi.hoisted(() => ({ UPDATE_STOP: vi.fn() }));
vi.mock("../update.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../update.js")>();
  return {
    ...actual,
    startUpdateCheck: vi.fn(() => UPDATE_STOP),
    installedVersion: vi.fn(() => "1.7.0"),
  };
});
// 10-14: PanelApp calls usePhases (gsd-tools, `.planning/` probes) and
// useResume (transcript scans, the launcher). Mock exactly what App.test.tsx
// mocks, keeping every pure helper real: the scans return fixtures, the
// cadences are frozen, and the clipboard / terminal launchers are stubs, so no
// test ever spawns gsd-tools, reads ~/.claude, runs pbcopy / osascript / open
// or resumes a real session.
const PH = vi.hoisted(() => ({
  roots: [] as string[],
  progress: {} as Record<string, import("../phases.js").Progress>,
}));
vi.mock("../phases.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../phases.js")>();
  return {
    ...actual,
    scanProgress: vi.fn(async (root: string) => PH.progress[root] ?? null),
    resolvePlanningRoots: vi.fn(async () => new Set(PH.roots)),
    phaseScanMs: vi.fn(() => 10_000_000),
    resolveGsdTools: vi.fn(() => "/dummy/gsd-tools.cjs"),
  };
});
const SESS = vi.hoisted(() => ({ list: [] as import("../sessions.js").ResumeRow[] }));
vi.mock("../sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions.js")>();
  return {
    ...actual,
    discoverSessions: vi.fn(async () => SESS.list),
    resumeScanMs: vi.fn(() => 10_000_000),
    readLiveRegistry: vi.fn(async () => new Set<string>()),
    resumeExtras: vi.fn(async () => ({ bypass: false })),
  };
});
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
import { scanProgress, resolvePlanningRoots, phaseScanMs, resolveGsdTools } from "../phases.js";
import { discoverSessions, resumeScanMs, readLiveRegistry, resumeExtras } from "../sessions.js";
import { copyResume, openResume } from "./launch.js";
import { killPort, portScanMs } from "../ports.js";

// Re-arm the 10-14 mocks before every test (a restore elsewhere could strip a
// vi.fn implementation) so no test ever reaches a real scan or launcher.
beforeEach(() => {
  vi.mocked(scanProgress).mockImplementation(async (root: string) => PH.progress[root] ?? null);
  vi.mocked(resolvePlanningRoots).mockImplementation(async () => new Set(PH.roots));
  vi.mocked(phaseScanMs).mockReturnValue(10_000_000);
  vi.mocked(resolveGsdTools).mockReturnValue("/dummy/gsd-tools.cjs");
  vi.mocked(discoverSessions).mockImplementation(async () => SESS.list);
  vi.mocked(resumeScanMs).mockReturnValue(10_000_000);
  vi.mocked(readLiveRegistry).mockResolvedValue(new Set<string>());
  vi.mocked(resumeExtras).mockResolvedValue({ bypass: false });
  vi.mocked(copyResume).mockResolvedValue({ ok: true, copied: true, message: "copied ✓" });
  vi.mocked(openResume).mockResolvedValue({
    ok: true,
    copied: true,
    message: "opened a new Terminal window · command copied",
  });
});

const DEFAULT_ROWS = [
  makeRow({ session_id: "sess-ask", asking: true }),
  makeRow({ session_id: "sess-wait", attention: true }),
];
ROWS.list = DEFAULT_ROWS;

const R = 55;
const C = 175;
/** A tick interval long enough that no tick fires during a test: the frame is stable. */
const FROZEN = 10_000_000;
const NOW = Date.UTC(2026, 9, 20, 10, 0, 0);

const live: Array<{ unmount: () => void }> = [];
afterEach(() => {
  while (live.length > 0) {
    try {
      live.pop()!.unmount();
    } catch {
      /* already exited */
    }
  }
});

function mount(el: React.ReactElement, stdin: NodeJS.ReadStream) {
  const r = renderCapture(el, { rows: R, columns: C, stdin });
  live.push(r.inst);
  return r;
}

/** A fake-TTY render with raw mode engaged (keys pressed earlier would be lost). */
async function mountTty(el: React.ReactElement = <PanelApp />) {
  const raw: boolean[] = [];
  const stdin = fakeTtyStdin((m) => raw.push(m));
  const r = mount(el, stdin);
  await vi.waitFor(() => expect(raw).toContain(true));
  return { ...r, stdin, raw };
}

const lines = (frame: string): string[] => frameLines(frame);
/** The left (AGENTS / FILES) column of a line: everything before the first divider. */
const leftOf = (l: string): string => l.split("│")[0] ?? l;
const footer = (frame: string): string => {
  const ls = lines(frame).filter((l) => l.trim() !== "");
  return ls[ls.length - 1] ?? "";
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("PanelApp live header (D-20)", () => {
  it("row 0 is the live header: real count and chips, never the sample chip", async () => {
    const { lastFrame } = await mountTty();
    const ls = lines(lastFrame());
    expect(ls[0]).toContain("◆ CSM");
    expect(ls[0]).toContain("2 agents");
    expect(ls[0]).toContain(" 1 asking ");
    expect(ls[0]).toContain(" 1 waiting ");
    expect(ls[0]).not.toContain("sample");
    // 10-09: AGENTS is live, so its title has no sample chip (D-23)
    const agentsTitle = ls.find((l) => l.includes("AGENTS"));
    expect(agentsTitle).toBeDefined();
    expect(leftOf(agentsTitle!)).toContain("AGENTS");
    expect(leftOf(agentsTitle!)).not.toContain("sample");
  });
});

describe("PanelApp focus model (KEYS-01, D-13)", () => {
  it("Tab cycles AGENTS -> PHASES -> PORTS -> AGENTS; Shift+Tab goes back", async () => {
    const { lastFrame, stdin } = await mountTty();
    expect(lastFrame()).toContain("▐AGENTS▌");

    press(stdin, KEYS.tab);
    await vi.waitFor(() => expect(lastFrame()).toContain("▐PHASES▌"));
    expect(lastFrame()).not.toContain("▐AGENTS▌");

    press(stdin, KEYS.tab);
    await vi.waitFor(() => expect(lastFrame()).toContain("▐PORTS▌"));
    expect(lastFrame()).not.toContain("▐PHASES▌");

    press(stdin, KEYS.tab);
    await vi.waitFor(() => expect(lastFrame()).toContain("▐AGENTS▌"));
    expect(lastFrame()).not.toContain("▐PORTS▌");

    press(stdin, KEYS.shiftTab);
    await vi.waitFor(() => expect(lastFrame()).toContain("▐PORTS▌"));
    expect(lastFrame()).not.toContain("▐AGENTS▌");
  });

  it("the footer shows the focused pane's hints", async () => {
    const { lastFrame, stdin } = await mountTty();
    expect(footer(lastFrame())).toContain("tab focus");
    expect(footer(lastFrame())).toContain("q quit");

    press(stdin, KEYS.shiftTab);
    await vi.waitFor(() => expect(footer(lastFrame())).toContain("↑↓ browse ports"));
  });

  it("Esc returns focus to AGENTS (after Ink's escape delay)", async () => {
    const { lastFrame, stdin } = await mountTty();
    press(stdin, KEYS.shiftTab);
    await vi.waitFor(() => expect(lastFrame()).toContain("▐PORTS▌"));
    press(stdin, KEYS.esc);
    await vi.waitFor(() => expect(lastFrame()).toContain("▐AGENTS▌"), { timeout: 3000 });
    expect(lastFrame()).not.toContain("▐PORTS▌");
  });
});

describe("PanelApp r and space (D-15)", () => {
  it("r with AGENTS focused makes SESSIONS the active tab", async () => {
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    // 10-14: PHASES is live; these rows have no cwd, so no project qualifies
    expect(lastFrame()).toContain("no GSD projects");
    press(stdin, KEYS.r);
    await vi.waitFor(() => expect(footer(lastFrame())).toContain("r phases"));
    // The right column now draws the live SESSIONS list, not PHASES.
    await vi.waitFor(() => expect(lastFrame()).toContain("no resumable sessions"));
    expect(lastFrame()).not.toContain("no GSD projects");

    // The tabs row in the frame is exactly the shell's row for rightTab
    // sessions, whose SESSIONS segment carries the active-tab background.
    const display = ROWS.list.map((row) => ({ id: row.session_id, row, ended: false }));
    const header = headerFromRoster({ display, live: 2, idle: 0, conflicts: [] }, null, NOW);
    // 10-09: AGENTS is live; 10-12: FILES is live (no files here); 10-14:
    // PHASES and SESSIONS are live (no projects, no sessions); PORTS is SAMPLE
    const ag = buildAgents({
      display,
      conflicts: [],
      branches: new Map(),
      order: stableOrder(new Map(), ROWS.list),
      now: NOW,
    });
    const expected = drawShell({
      rows: R,
      cols: C,
      ui: { ...initialUi, rightTab: "sessions" },
      tick: 0,
      step: 0,
      header,
      panes: {
        ...SAMPLE,
        agents: ag.agents,
        idle: ag.idle,
        conflicts: [],
        groups: [],
        projects: [],
        projectIndex: 0,
        sessions: [],
        sessionStatus: null,
        sessionCursor: null,
      },
      keysOff: false,
      flash: null,
      sample: { agents: false, files: false, phases: false, sessions: false, ports: true },
    });
    const tabsY = expected.findIndex((l) => lineText(l).includes("[r]"));
    expect(tabsY).toBeGreaterThan(0);
    const active = expected[tabsY]!.find((s) => s.text.includes("SESSIONS"));
    expect(active?.text).toBe(" SESSIONS ");
    expect(active?.bg).toBe(PALETTE.idle);
    expect(lines(lastFrame())[tabsY]).toBe(lineText(expected[tabsY]!));
  });

  // 10-12: FILES is live, so the scrolling ticker needs live files (> 6 rows)
  it("space pauses the FILES ticker and flips its hint", async () => {
    ROWS.list = [
      makeRow({
        session_id: "sess-ask",
        asking: true,
        files: Array.from({ length: 10 }, (_, k) => ({ file_path: `/nx-csm-1012/f${k}.ts`, ts: new Date().toISOString() })),
      }),
      makeRow({ session_id: "sess-wait", attention: true }),
    ];
    try {
      const { lastFrame, stdin } = await mountTty();
      await vi.waitFor(() => expect(lastFrame()).toContain("10 files"));
      expect(lastFrame()).not.toContain("paused · 10 files");
      press(stdin, KEYS.space);
      await vi.waitFor(() => expect(lastFrame()).toContain("paused · 10 files"));
      expect(footer(lastFrame())).toContain("space resume files");
    } finally {
      ROWS.list = DEFAULT_ROWS;
    }
  });
});

describe("PanelApp unbound keys (D-19)", () => {
  it("digits, j, k, ?, z, [ and ] change nothing", async () => {
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    const before = lastFrame();
    press(stdin, "1", "2", "j", "k", "?", "z", "[", "]");
    await sleep(150);
    expect(lastFrame()).toBe(before);
    expect(before).toContain("▐AGENTS▌");
    expect(footer(before)).toContain("tab focus");
  });
});

describe("PanelApp Enter with nothing selected (10-07, 10-09, 10-10)", () => {
  it("Enter with AGENTS focused and no selection leaves the frame unchanged", async () => {
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    const before = lastFrame();
    press(stdin, KEYS.enter);
    await sleep(150);
    expect(lastFrame()).toBe(before);
    expect(before).toContain("▐AGENTS▌");
    expect(footer(before)).toContain("tab focus");
  });
});

// --- Phase 10 plan 10-08: one intent dispatcher, the flash slot and the idle drop
// Time is the injected `now` (a mutable clock); a small tickMs only lets the
// UI tick fire. A spinner frame change proves a tick happened.

/** Wait until at least one UI tick has re-rendered the frame. */
async function nextTick(lastFrame: () => string): Promise<void> {
  const f0 = lastFrame();
  await vi.waitFor(() => expect(lastFrame()).not.toBe(f0), { timeout: 5000 });
}

/** A live card id from the default mocked roster (AGENTS is live from 10-09). */
const CARD_ID = "sess-ask";

describe("PanelApp footer flash slot (10-08, D-12)", () => {
  it("shows a flash for 2500 ms on the injected clock, then clears it", async () => {
    const clock = { t: 1000 };
    const { lastFrame } = await mountTty(
      <PanelApp tickMs={20} now={() => clock.t} initialUi={{ flash: { text: "focusing api", ok: false, at: 0 } }} />,
    );
    expect(footer(lastFrame())).toContain("focusing api");
    clock.t = 2499;
    await nextTick(lastFrame);
    expect(footer(lastFrame())).toContain("focusing api");
    clock.t = 2500;
    await vi.waitFor(() => expect(footer(lastFrame())).not.toContain("focusing api"), { timeout: 5000 });
  });
});

describe("PanelApp selection idle drop (10-08, D-09)", () => {
  // 10-12: FILES is live (no SAMPLE ticker scrolling any more), so a running
  // card's spinner is what makes a UI tick produce a new frame for nextTick.
  beforeEach(() => {
    ROWS.list = [...DEFAULT_ROWS, makeRow({ session_id: "sess-run", running: true })];
  });
  afterEach(() => {
    ROWS.list = DEFAULT_ROWS;
  });

  it("keeps the selection at 14 999 ms and drops it at 15 000 ms after one tick", async () => {
    const clock = { t: 14_999 };
    const { lastFrame } = await mountTty(
      <PanelApp tickMs={20} now={() => clock.t} initialUi={{ selectedAgentId: CARD_ID, lastKeyAt: 0 }} />,
    );
    expect(lastFrame()).toContain("┏");
    await nextTick(lastFrame);
    expect(lastFrame()).toContain("┏");
    clock.t = 15_000;
    await vi.waitFor(() => expect(lastFrame()).not.toContain("┏"), { timeout: 5000 });
    expect(footer(lastFrame())).toContain("select agent");
  });

  it("every key records keyAt: r at 5000 keeps the selection to 19 999, 20 000 drops it", async () => {
    const clock = { t: 5000 };
    const { lastFrame, stdin } = await mountTty(
      <PanelApp tickMs={20} now={() => clock.t} initialUi={{ selectedAgentId: CARD_ID, lastKeyAt: 0 }} />,
    );
    expect(lastFrame()).toContain("no GSD projects");
    press(stdin, KEYS.r);
    // the right column switches to SESSIONS (agentsSelected hints carry no r)
    await vi.waitFor(() => expect(lastFrame()).not.toContain("no GSD projects"));
    clock.t = 19_999;
    await nextTick(lastFrame);
    expect(lastFrame()).toContain("┏");
    clock.t = 20_000;
    await vi.waitFor(() => expect(lastFrame()).not.toContain("┏"), { timeout: 5000 });
  });
});

describe("PanelApp intent dispatcher (10-08, KEYS-01, KEYS-02)", () => {
  it("↓ with AGENTS focused reaches the dispatcher as a move intent and selects (10-09)", async () => {
    const seen: Array<{ intent: unknown; ctx: string }> = [];
    const { lastFrame, stdin } = await mountTty(
      <PanelApp tickMs={FROZEN} now={() => NOW} intentSpy={(intent, ctx) => seen.push({ intent, ctx })} />,
    );
    expect(lastFrame()).not.toContain("┏");
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ intent: { t: "move", dir: "down" }, ctx: "agents" });
    await vi.waitFor(() => expect(lastFrame()).toContain("┏"));
  });

  it("resolves keys against effectiveUi: a vanished selection routes as plain AGENTS", async () => {
    const seen: Array<{ intent: unknown; ctx: string }> = [];
    const { stdin } = await mountTty(
      <PanelApp
        tickMs={FROZEN}
        now={() => NOW}
        initialUi={{ selectedAgentId: "gone", lastKeyAt: NOW }}
        intentSpy={(intent, ctx) => seen.push({ intent, ctx })}
      />,
    );
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.ctx).toBe("agents");
  });
});

describe("PanelApp footer never lies about a vanished selection (10-08, KEYS-03)", () => {
  it("a selection that does not resolve shows the AGENTS hints, never go to pane", async () => {
    const { lastFrame } = await mountTty(
      <PanelApp tickMs={FROZEN} now={() => NOW} initialUi={{ selectedAgentId: "gone", lastKeyAt: NOW }} />,
    );
    expect(footer(lastFrame())).toContain("select agent");
    expect(lastFrame()).not.toContain("go to pane");
    expect(lastFrame()).not.toContain("┏");
  });
});

describe("PanelApp exit (KEYS-04, D-24)", () => {
  it("q exits through Ink's exit path: waitUntilExit resolves and raw mode ends off", async () => {
    const { inst, stdin, raw } = await mountTty();
    expect(raw[0]).toBe(true);
    press(stdin, KEYS.q);
    const exited = inst.waitUntilExit().then(() => "exited");
    const timeout = sleep(2000).then(() => "timeout");
    await expect(Promise.race([exited, timeout])).resolves.toBe("exited");
    expect(raw[raw.length - 1]).toBe(false);
  });

  it("Ctrl+C also exits (exitOnCtrlC)", async () => {
    const raw: boolean[] = [];
    const stdin = fakeTtyStdin((m) => raw.push(m));
    const r = renderCapture(<PanelApp />, { rows: R, columns: C, stdin, exitOnCtrlC: true });
    live.push(r.inst);
    await vi.waitFor(() => expect(raw).toContain(true));
    press(stdin, KEYS.ctrlC);
    await expect(r.inst.waitUntilExit()).resolves.toBeUndefined();
    expect(raw[raw.length - 1]).toBe(false);
  });
});

describe("PanelApp keys off on a non-TTY (KEYS-06, D-21)", () => {
  it("renders, shows the keys-off notice in the hint slot, same line count, and ignores input", async () => {
    const tty = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    const ttyCount = lines(tty.lastFrame()).length;

    const stdin = nonTtyStdin();
    const off = mount(<PanelApp tickMs={FROZEN} now={() => NOW} />, stdin);
    await vi.waitFor(() => expect(off.lastFrame()).not.toBe(""));
    const frame = off.lastFrame();
    const ls = lines(frame);
    expect(ls[0]).toContain("◆ CSM");
    expect(footer(frame)).toContain("⌨ keys off — started without a TTY");
    expect(ls.some((l) => l.includes("tab focus"))).toBe(false);
    expect(ls.length).toBe(ttyCount);

    press(stdin, KEYS.tab);
    await sleep(100);
    expect(off.lastFrame()).toBe(frame);
    expect(off.lastFrame()).toContain("▐AGENTS▌");
  });
});

describe("PanelApp frame size", () => {
  it("the last frame fits within rows x cols", async () => {
    const { lastFrame } = await mountTty();
    const ls = lines(lastFrame());
    expect(ls.length).toBeLessThanOrEqual(R);
    for (const l of ls) expect(cellWidth(l)).toBeLessThanOrEqual(C);
  });
});

describe("PanelApp resize repaint (LAYOUT-05, D-01/D-02)", () => {
  it("a resize writes the absolute clear and the repaint after it has exactly one ◆ CSM header", () => {
    const r = renderTty(<PanelApp tickMs={1000} now={() => NOW} />, { columns: C, rows: R });
    live.push(r.inst);
    const ESC = String.fromCharCode(27);
    const before = r.writes().filter((c) => c.includes(HOME_ERASE_DOWN)).length;
    r.setSize(120, 40);
    r.resize();
    const writes = r.writes();
    expect(writes.filter((c) => c.includes(HOME_ERASE_DOWN)).length - before).toBe(1);
    const all = writes.join("");
    let tail = all.slice(all.lastIndexOf(HOME_ERASE_DOWN) + HOME_ERASE_DOWN.length);
    // Up to the next erase (log-update's eraseLines starts with ESC[2K).
    const next = tail.indexOf(ESC + "[2K");
    if (next >= 0) tail = tail.slice(0, next);
    const ls = stripVTControlCharacters(tail).split("\n");
    if (ls.length > 0 && ls[ls.length - 1] === "") ls.pop();
    expect(ls.length).toBeGreaterThanOrEqual(10);
    expect(ls.filter((l) => l.includes("◆ CSM"))).toHaveLength(1);
    expect(ls.length).toBeLessThanOrEqual(40);
    for (const l of ls) expect(cellWidth(l)).toBeLessThanOrEqual(120);
  });
});

// --- Phase 10 plan 10-09: the live AGENTS pane (LAYOUT-07, KEYS-02, D-05, D-06, D-08)
// The readAll mock is driven through ROWS; a changed prompt marks the next poll.

const PG_DN = String.fromCharCode(27) + "[6~";
const T1 = "2026-10-20T07:00:00.000Z";
const T2 = "2026-10-20T08:00:00.000Z";
const T3 = "2026-10-20T09:00:00.000Z";

function liveRows(prompt = "fix the login bug"): SessionRow[] {
  return [
    makeRow({
      session_id: "s-alpha",
      title: "alpha task",
      start_time: T1,
      running: true,
      transcript_model: "claude-opus-4-7",
      last_prompt: prompt,
    }),
    makeRow({ session_id: "s-beta", title: "beta task", start_time: T2, asking: true, model: "claude-sonnet-4-5" }),
    makeRow({ session_id: "s-gamma", title: "gamma idle", start_time: T3 }),
  ];
}

/** The line holding both card names (2 card columns at 175x55). */
const nameRow = (frame: string): string =>
  lines(frame).find((l) => l.includes("alpha task") && l.includes("beta task")) ?? "";

describe("PanelApp live AGENTS (10-09)", () => {
  beforeEach(() => {
    ROWS.list = liveRows();
  });
  afterEach(() => {
    ROWS.list = DEFAULT_ROWS;
  });

  it("shows 2 cards and 1 strip in start order with live names, model and prompt; no AGENTS sample chip", async () => {
    const { lastFrame } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    const f = lastFrame();
    const row = nameRow(f);
    expect(row.indexOf("alpha task")).toBeGreaterThanOrEqual(0);
    expect(row.indexOf("alpha task")).toBeLessThan(row.indexOf("beta task"));
    expect(f).toContain("gamma idle");
    expect(f).toContain("opus 4.7");
    expect(f).toContain("sonnet 4.5");
    expect(f).toContain("fix the login bug");
    const title = lines(f).find((l) => l.includes("AGENTS"))!;
    expect(leftOf(title)).toContain("2 active · 1 idle");
    expect(leftOf(title)).not.toContain("sample");
  });

  it("no pane keeps its sample chip: FILES (10-12), PHASES and SESSIONS (10-14), PORTS (10-15) are live (D-23)", async () => {
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    const ls = lines(lastFrame());
    expect(leftOf(ls.find((l) => leftOf(l).startsWith(" FILES "))!)).not.toContain("sample");
    expect(ls.find((l) => l.includes("PORTS"))).not.toContain("sample");
    expect(ls.find((l) => l.includes("[r]"))).not.toContain("sample");
    press(stdin, KEYS.r);
    await vi.waitFor(() => expect(footer(lastFrame())).toContain("r phases"));
    expect(lines(lastFrame()).find((l) => l.includes("[r]"))).not.toContain("sample");
  });

  it("a reversed readAll and a compact (start_time rewritten) never move a card", async () => {
    const { lastFrame } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    const before = nameRow(lastFrame());
    expect(before).not.toBe("");

    ROWS.list = liveRows("second prompt").reverse();
    await vi.waitFor(() => expect(lastFrame()).toContain("second prompt"), { timeout: 5000 });
    expect(nameRow(lastFrame())).toBe(before);

    const compacted = liveRows("third prompt");
    compacted[0] = { ...compacted[0]!, start_time: new Date(NOW).toISOString() };
    ROWS.list = compacted;
    await vi.waitFor(() => expect(lastFrame()).toContain("third prompt"), { timeout: 5000 });
    expect(nameRow(lastFrame())).toBe(before);
  });

  it("↓ selects the first card, → walks to the next card and then onto the idle strip", async () => {
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(lastFrame()).toContain("┏"));
    const heavy = (f: string): number => lines(f).find((l) => l.includes("┏"))!.indexOf("┏");
    expect(heavy(lastFrame())).toBe(0);
    expect(footer(lastFrame())).toContain("go to pane");

    press(stdin, KEYS.right);
    await vi.waitFor(() => expect(heavy(lastFrame())).toBeGreaterThan(0));
    // the heavy frame sits on the beta card's column
    expect(heavy(lastFrame())).toBe(nameRow(lastFrame()).indexOf("beta task") - 4);

    press(stdin, KEYS.right);
    // the strip is selected: no heavy frame, but the selection still resolves
    await vi.waitFor(() => expect(lastFrame()).not.toContain("┏"));
    expect(footer(lastFrame())).toContain("go to pane");
  });

  it("PgDn moves the selection by the visible card rows", async () => {
    ROWS.list = Array.from({ length: 12 }, (_, i) =>
      makeRow({
        session_id: `s-${String(i).padStart(2, "0")}`,
        title: `card ${String(i).padStart(2, "0")}`,
        start_time: new Date(Date.parse(T1) + i * 60_000).toISOString(),
        running: true,
      }),
    );
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(lastFrame()).toContain("┏"));
    // the visible card rows = the lines whose left card is a `card NN` name,
    // counted WITH the selection (10-11: the detail strip takes a card row)
    const visible = lines(lastFrame()).filter((l) => /^[│┃] . card \d\d/.test(l)).length;
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThan(6);
    press(stdin, PG_DN);
    const target = `card ${String(visible * 2).padStart(2, "0")}`;
    await vi.waitFor(() => {
      const ls = lines(lastFrame());
      const top = ls.findIndex((l) => l.includes("┏"));
      expect(top).toBeGreaterThanOrEqual(0);
      expect(ls[top + 1]).toContain(target);
      // the selected card is fully drawn
      expect(ls[top + 6]).toContain("┗");
    });
  });

  it("the selected session leaving the roster clears the selection within one poll (fails closed)", async () => {
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(lastFrame()).toContain("┏"));
    ROWS.list = liveRows().slice(1);
    await vi.waitFor(() => expect(lastFrame()).not.toContain("┏"), { timeout: 5000 });
    expect(footer(lastFrame())).toContain("select agent");
    expect(lastFrame()).not.toContain("alpha task");
  });
});

// --- Phase 10 plan 10-10: Enter on a selected card or strip runs the go-to
// action (GOTO-01, GOTO-04, GOTO-05, D-09, D-12, D-13). Every probe and the
// opener are fakes injected through `gotoDeps`: no test runs ps or open.

const GO_URL = "warp://session/" + HEX32;
const PS_WARP_4242 = [
  " 4242  4241 claude",
  " 4241  4240 -zsh",
  " 4240     1 /Applications/Warp.app/Contents/MacOS/stable",
  "",
].join("\n");
const PS_SCREEN_4242 = [
  " 4242  4241 claude",
  " 4241  4235 -zsh",
  " 4235  4234 login",
  " 4234     1 SCREEN",
  "",
].join("\n");
const PS_NONE_4242 = [" 4242  4241 claude", " 4241     1 /bin/zsh", ""].join("\n");

function gotoRows(warp: SessionRow["warp"] = { focus_url: GO_URL }): SessionRow[] {
  return [
    makeRow({ session_id: "s-go", title: "go task", start_time: T1, running: true, pid: 4242, warp }),
    makeRow({ session_id: "s-strip", title: "strip task", start_time: T2, pid: 4242, warp }),
  ];
}

function fakeGoto(ps: string, open?: (url: string) => Promise<boolean>): { deps: GotoDeps; opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    deps: {
      probe: () => "alive",
      startedProbe: async () => "",
      procTable: async () => ps,
      open: (url) => {
        opened.push(url);
        return open ? open(url) : Promise.resolve(true);
      },
    },
  };
}

describe("PanelApp go-to (10-10, GOTO-01, GOTO-04, D-13)", () => {
  beforeEach(() => {
    ROWS.list = gotoRows();
  });
  afterEach(() => {
    ROWS.list = DEFAULT_ROWS;
  });

  it("Enter on a selected card opens its URL once and flashes focusing <name>; the flash clears, the selection stays", async () => {
    const clock = { t: 1000 };
    const g = fakeGoto(PS_WARP_4242);
    const { lastFrame, stdin } = await mountTty(
      <PanelApp
        tickMs={20}
        now={() => clock.t}
        gotoDeps={g.deps}
        initialUi={{ selectedAgentId: "s-go", lastKeyAt: 1000 }}
      />,
    );
    expect(lastFrame()).toContain("┏");
    press(stdin, KEYS.enter);
    await vi.waitFor(() => expect(footer(lastFrame())).toContain("focusing go task"), { timeout: 5000 });
    expect(g.opened).toEqual([GO_URL]);
    clock.t = 1000 + 2500;
    await vi.waitFor(() => expect(footer(lastFrame())).not.toContain("focusing"), { timeout: 5000 });
    // D-09: only the 15 s idle rule drops the selection
    expect(lastFrame()).toContain("┏");
    expect(footer(lastFrame())).toContain("go to pane");
  });

  it("Enter on a selected idle strip runs the same go-to", async () => {
    const g = fakeGoto(PS_WARP_4242);
    const { lastFrame, stdin } = await mountTty(
      <PanelApp tickMs={FROZEN} now={() => NOW} gotoDeps={g.deps} initialUi={{ selectedAgentId: "s-strip", lastKeyAt: NOW }} />,
    );
    expect(footer(lastFrame())).toContain("go to pane");
    press(stdin, KEYS.enter);
    await vi.waitFor(() => expect(footer(lastFrame())).toContain("focusing strip task"), { timeout: 5000 });
    expect(g.opened).toEqual([GO_URL]);
  });

  it("a GNU screen ancestry shows pane not findable and never opens (D-13)", async () => {
    const g = fakeGoto(PS_SCREEN_4242);
    const { lastFrame, stdin } = await mountTty(
      <PanelApp tickMs={FROZEN} now={() => NOW} gotoDeps={g.deps} initialUi={{ selectedAgentId: "s-go", lastKeyAt: NOW }} />,
    );
    press(stdin, KEYS.enter);
    await vi.waitFor(() => expect(footer(lastFrame())).toContain("pane not findable"), { timeout: 5000 });
    expect(g.opened).toEqual([]);
  });

  it("warp null: a Warp host gives pane not findable, no host gives not a Warp session", async () => {
    ROWS.list = gotoRows(null);
    const a = fakeGoto(PS_WARP_4242);
    const one = await mountTty(
      <PanelApp tickMs={FROZEN} now={() => NOW} gotoDeps={a.deps} initialUi={{ selectedAgentId: "s-go", lastKeyAt: NOW }} />,
    );
    press(one.stdin, KEYS.enter);
    await vi.waitFor(() => expect(footer(one.lastFrame())).toContain("pane not findable"), { timeout: 5000 });
    expect(a.opened).toEqual([]);
    live.pop()!.unmount();

    const b = fakeGoto(PS_NONE_4242);
    const two = await mountTty(
      <PanelApp tickMs={FROZEN} now={() => NOW} gotoDeps={b.deps} initialUi={{ selectedAgentId: "s-go", lastKeyAt: NOW }} />,
    );
    press(two.stdin, KEYS.enter);
    await vi.waitFor(() => expect(footer(two.lastFrame())).toContain("not a Warp session"), { timeout: 5000 });
    expect(b.opened).toEqual([]);
  });

  it("a second Enter while the first open is pending is ignored (one go-to at a time)", async () => {
    let release: (ok: boolean) => void = () => undefined;
    const pending = new Promise<boolean>((r) => {
      release = r;
    });
    const g = fakeGoto(PS_WARP_4242, () => pending);
    const { lastFrame, stdin } = await mountTty(
      <PanelApp tickMs={FROZEN} now={() => NOW} gotoDeps={g.deps} initialUi={{ selectedAgentId: "s-go", lastKeyAt: NOW }} />,
    );
    press(stdin, KEYS.enter);
    await vi.waitFor(() => expect(g.opened).toHaveLength(1), { timeout: 5000 });
    press(stdin, KEYS.enter);
    press(stdin, KEYS.enter);
    await sleep(150);
    expect(g.opened).toHaveLength(1);
    release(true);
    await vi.waitFor(() => expect(footer(lastFrame())).toContain("focusing go task"), { timeout: 5000 });
    // the guard is released afterwards: a later Enter runs again
    press(stdin, KEYS.enter);
    await vi.waitFor(() => expect(g.opened).toHaveLength(2), { timeout: 5000 });
  });

  it("Enter with the selected row gone from the roster: no flash, no open, the selection clears", async () => {
    const g = fakeGoto(PS_WARP_4242);
    const { lastFrame, stdin } = await mountTty(
      <PanelApp tickMs={FROZEN} now={() => NOW} gotoDeps={g.deps} initialUi={{ selectedAgentId: "s-gone", lastKeyAt: NOW }} />,
    );
    press(stdin, KEYS.enter);
    await sleep(150);
    expect(g.opened).toEqual([]);
    const f = footer(lastFrame());
    expect(f).toContain("select agent");
    for (const reason of ["focusing", "pane not findable", "not a Warp session", "process gone", "no Warp pane recorded"]) {
      expect(f).not.toContain(reason);
    }
  });
});

describe("PanelApp source (T-09-11, T-09-08c)", () => {
  const src = readFileSync(fileURLToPath(new URL("./PanelApp.tsx", import.meta.url)), "utf8");
  const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);

  it("imports exactly one action module, ./actions/goto.js (10-10, D-12)", () => {
    expect(imports.filter((spec) => spec.includes("actions/"))).toEqual(["./actions/goto.js"]);
  });

  it("never reads an open-command override from the environment", () => {
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join("\n");
    expect(code).not.toMatch(/CSM_OPEN_CMD/);
  });

  it("imports no action module (launch, the port scanner, child process, warp-url, registration)", () => {
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).not.toMatch(/launch/);
      // 10-15: the pure ./ui/build/ports.js builder is allowed; the scanner
      // module (which holds the kill backend) is not
      expect(spec).not.toMatch(/^\.\.\/ports(\.js)?$/);
      expect(spec).not.toMatch(/child_process/);
      expect(spec).not.toMatch(/warp-url/);
      expect(spec).not.toMatch(/registration/);
    }
  });

  it("imports the pure PORTS builder but never names the kill backend (10-15, T-10-39)", () => {
    expect(imports).toContain("./ui/build/ports.js");
    expect(imports).not.toContain("../ports.js");
    expect(imports).not.toContain("../ports");
    expect(src).not.toMatch(/\bkillPort\b/);
  });

  it("never imports the SAMPLE fixture: every pane is built from live data (10-16, D-23)", () => {
    expect(imports.filter((spec) => spec.includes("ui/sample"))).toEqual([]);
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l))
      .join("\n");
    expect(code).not.toMatch(/\bSAMPLE\b/);
  });

  it("has exactly one input handler and no focus manager", () => {
    expect(src.split("useInput(").length - 1).toBe(1);
    expect(src).not.toMatch(/useFocus|ink-text-input|dimColor/);
  });
});

// --- Phase 10 plan 10-11: the selection detail strip (LAYOUT-07, D-06, D-09, D-17)

describe("PanelApp detail strip (10-11, LAYOUT-07)", () => {
  const PROMPT = "move the coupon field into the cart summary, then recompute the total and run the tests";
  const detailRows = (): SessionRow[] => {
    const r = liveRows(PROMPT);
    r[0] = { ...r[0]!, intent: "checkout screen", pid: 4242 };
    r[1] = { ...r[1]!, pid: 5353 };
    return r;
  };
  const pill = (f: string, name: string): string | undefined => lines(f).find((l) => l.startsWith(`▐${name}▌`));
  beforeEach(() => {
    ROWS.list = detailRows();
    PORTS.list = [];
  });
  afterEach(() => {
    ROWS.list = DEFAULT_ROWS;
    PORTS.list = [];
  });

  it("selecting a card opens the strip (pill, intent, branch, prompt) under the grid; Esc closes it", async () => {
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    expect(pill(lastFrame(), "alpha task")).toBeUndefined();
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(pill(lastFrame(), "alpha task")).toBeDefined());
    const ls = lines(lastFrame());
    const y = ls.findIndex((l) => l.startsWith("▐alpha task▌"));
    expect(ls[y]).toContain("RUNNING");
    expect(ls[y]).toContain("opus 4.7");
    expect(leftOf(ls[y + 1]!)).toMatch(/^ {2}» checkout screen {4}⎇ main/);
    expect(leftOf(ls[y + 2]!)).toContain(`› ${PROMPT}`);
    // under the grid, above FILES
    expect(ls.findIndex((l) => l.includes("┏"))).toBeLessThan(y);
    expect(ls.findIndex((l) => leftOf(l).startsWith(" FILES "))).toBeGreaterThan(y + 2);
    // no up-front go-to marker (D-11)
    expect(lastFrame()).not.toContain("not a Warp session");
    expect(lastFrame()).not.toContain("no Warp pane recorded");

    press(stdin, KEYS.esc);
    await vi.waitFor(() => expect(pill(lastFrame(), "alpha task")).toBeUndefined());
    expect(lastFrame()).not.toContain("» checkout screen");
  });

  it("shows the ports the selected session owns (ancestry join), not another session's", async () => {
    const port = (p: number, command: string, ancestryPids: number[]) => ({
      port: p,
      pid: ancestryPids[0]!,
      command,
      exposed: false,
      ancestryPids,
      origin: "other" as const,
    });
    PORTS.list = [port(3000, "bun", [9001, 4242]), port(8088, "node", [9002, 5353])];
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(pill(lastFrame(), "alpha task")).toBeDefined());
    const ls = lines(lastFrame());
    const y = ls.findIndex((l) => l.startsWith("▐alpha task▌"));
    await vi.waitFor(() => expect(leftOf(lines(lastFrame())[y + 1]!)).toContain(":3000 bun"));
    expect(leftOf(lines(lastFrame())[y + 1]!)).not.toContain(":8088");
  });

  it("selecting an idle strip opens the strip with IDLE (D-06, D-17)", async () => {
    const { lastFrame } = await mountTty(
      <PanelApp tickMs={FROZEN} now={() => NOW} initialUi={{ selectedAgentId: "s-gamma", lastKeyAt: NOW }} />,
    );
    await vi.waitFor(() => expect(pill(lastFrame(), "gamma idle")).toBeDefined());
    expect(pill(lastFrame(), "gamma idle")).toContain("▐gamma idle▌ IDLE");
    const ls = lines(lastFrame());
    const y = ls.findIndex((l) => l.startsWith("▐gamma idle▌"));
    expect(leftOf(ls[y + 1]!)).toMatch(/^ {2}» — {4}⎇ main/);
  });

  it("drops the selection and the strip after 15 s without a key (D-09)", async () => {
    const clock = { t: 14_999 };
    const { lastFrame } = await mountTty(
      <PanelApp tickMs={20} now={() => clock.t} initialUi={{ selectedAgentId: "s-alpha", lastKeyAt: 0 }} />,
    );
    await vi.waitFor(() => expect(pill(lastFrame(), "alpha task")).toBeDefined());
    clock.t = 15_000;
    await vi.waitFor(() => expect(pill(lastFrame(), "alpha task")).toBeUndefined(), { timeout: 5000 });
    expect(lastFrame()).not.toContain("» checkout screen");
  });
});

// --- Phase 10 plan 10-12: the live FILES pane (LAYOUT-07, LAYOUT-03, LAYOUT-02, D-23)
// Two live rows write the same absolute path, so useRoster's detectConflicts
// (lexical fallback for a missing file) reports one conflict.

describe("PanelApp live FILES (10-12)", () => {
  const ROOT = "/nonexistent-csm-1012";
  const SHARED = `${ROOT}/src/server.js`;
  const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
  const fileRows = (alphaExtra = 0): SessionRow[] => {
    const r = liveRows();
    r[0] = {
      ...r[0]!,
      cwd: ROOT,
      files: [
        { file_path: SHARED, ts: at(1) },
        { file_path: `${ROOT}/src/alpha.ts`, ts: at(2) },
        ...Array.from({ length: alphaExtra }, (_, k) => ({ file_path: `${ROOT}/src/extra${k}.ts`, ts: at(3) })),
      ],
      reads: [{ file_path: `${ROOT}/README.md`, ts: at(1) }],
    };
    r[1] = {
      ...r[1]!,
      cwd: ROOT,
      files: [
        { file_path: SHARED, ts: at(5) },
        { file_path: `${ROOT}/src/beta.ts`, ts: at(5) },
      ],
    };
    return r;
  };
  const filesY = (f: string): number => lines(f).findIndex((l) => leftOf(l).startsWith(" FILES "));
  /** The FILES title and the next `n` lines of the left column. */
  const filesBlock = (f: string, n = 8): string[] => {
    const ls = lines(f);
    const y = filesY(f);
    return ls.slice(y, y + 1 + n).map((l) => leftOf(l).trimEnd());
  };
  afterEach(() => {
    ROWS.list = DEFAULT_ROWS;
  });

  it("shows the live conflict row and each session's files under its group; no FILES sample chip", async () => {
    ROWS.list = fileRows();
    const { lastFrame } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    await vi.waitFor(() => expect(lastFrame()).toContain("alpha task ✕ beta task"));
    const b = filesBlock(lastFrame());
    expect(b[0]).not.toContain("sample");
    expect(b[0]).toMatch(/ 4 files$/);
    expect(b[1]).toBe("▌ ! alpha task ✕ beta task   src/server.js");
    expect(b[2]).toBe("  ■ alpha task            ✎ src/server.js");
    expect(b[3]).toBe("                          ✎ src/alpha.ts");
    expect(b[4]).toBe("                          README.md");
    expect(b[5]).toBe("  ■ beta task             ✎ src/server.js");
    expect(b[6]).toBe("                          ✎ src/beta.ts");
    // gamma has no files: no group
    expect(b.join("\n")).not.toContain("gamma idle");
  });

  it("selecting a card narrows FILES to it (`FILES · N · esc: all`); Esc shows every session again", async () => {
    ROWS.list = fileRows();
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    await vi.waitFor(() => expect(lastFrame()).toContain("alpha task ✕ beta task"));
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(filesBlock(lastFrame())[0]).toContain("esc: all"));
    const b = filesBlock(lastFrame());
    expect(b[0]).toMatch(/^ FILES {2}· 3 · esc: all ─+$/);
    expect(b[1]).toBe("▌ ! alpha task ✕ beta task   src/server.js");
    expect(b[2]).toBe("  ■ alpha task            ✎ src/server.js");
    expect(b.join("\n")).not.toContain("■ beta task");
    expect(b.join("\n")).not.toContain("src/beta.ts");

    press(stdin, KEYS.esc);
    await vi.waitFor(() => expect(filesBlock(lastFrame())[0]).not.toContain("esc: all"));
    expect(filesBlock(lastFrame()).join("\n")).toContain("■ beta task");
  });

  it("the 15 s idle drop restores the full FILES list (D-09)", async () => {
    ROWS.list = fileRows();
    const clock = { t: NOW + 14_999 };
    const { lastFrame } = await mountTty(
      <PanelApp tickMs={20} now={() => clock.t} initialUi={{ selectedAgentId: "s-alpha", lastKeyAt: NOW }} />,
    );
    await vi.waitFor(() => expect(filesBlock(lastFrame())[0]).toContain("esc: all"));
    clock.t = NOW + 15_000;
    await vi.waitFor(() => expect(filesBlock(lastFrame())[0]).not.toContain("esc: all"), { timeout: 5000 });
    expect(filesBlock(lastFrame()).join("\n")).toContain("■ beta task");
  });

  it("the unnarrowed ticker scrolls on UI ticks; narrowed it stops and counts the hidden rows", async () => {
    ROWS.list = fileRows(8);
    const free = await mountTty(<PanelApp tickMs={20} now={() => NOW} />);
    await vi.waitFor(() => expect(free.lastFrame()).toContain("alpha task ✕ beta task"));
    const first = filesBlock(free.lastFrame()).slice(2).join("\n");
    await vi.waitFor(() => expect(filesBlock(free.lastFrame()).slice(2).join("\n")).not.toBe(first), {
      timeout: 5000,
    });
    free.inst.unmount();

    const sel = await mountTty(
      <PanelApp tickMs={20} now={() => NOW} initialUi={{ selectedAgentId: "s-alpha", lastKeyAt: NOW }} />,
    );
    await vi.waitFor(() => expect(filesBlock(sel.lastFrame())[0]).toContain("esc: all"));
    const fixed = filesBlock(sel.lastFrame()).join("\n");
    expect(fixed).toMatch(/\n {4}↓ \d+ more/);
    // the card spinner keeps the clock running: several frames go by, FILES never moves
    for (let k = 0; k < 3; k++) {
      await nextTick(sel.lastFrame);
      expect(filesBlock(sel.lastFrame()).join("\n")).toBe(fixed);
    }
  });
});

// --- Phase 10 plan 10-14: live PHASES and SESSIONS (KEYS-05, KEYS-02, KEYS-03, D-16, D-23)

/** Press keys one input chunk at a time (`press` writes synchronously, so "\t\t" or "oo" would arrive as one chunk). */
async function pressEach(stdin: NodeJS.ReadStream, ...keys: string[]): Promise<void> {
  for (const k of keys) {
    press(stdin, k);
    await sleep(40);
  }
}

describe("PanelApp live PHASES (10-14, KEYS-05, KEYS-02)", () => {
  const PG_UP = String.fromCharCode(27) + "[5~";
  const PG_DOWN = String.fromCharCode(27) + "[6~";
  const phase = (prefix: string, i: number, current: number) => ({
    number: String(i).padStart(2, "0"),
    name: `${prefix}-${String(i).padStart(2, "0")}`,
    plans: 2,
    summaries: i < current ? 2 : i === current ? 1 : 0,
    status: i < current ? "Complete" : i === current ? "In Progress" : "Pending",
  });
  const projectRows = (): SessionRow[] => [
    makeRow({ session_id: "s-pa", folder: "projA", cwd: "/projA", title: "work on A" }),
    makeRow({ session_id: "s-pb", folder: "projB", cwd: "/projB", title: "work on B" }),
  ];
  /** The right-column line showing `project i/N` (the dir row). */
  const projLine = (frame: string): string => lines(frame).find((l) => /project \d\/\d/.test(l)) ?? "";
  /** The phase name on the PHASES cursor row (`❯`). */
  const cursorPhase = (frame: string): string | null => {
    const l = lines(frame).find((x) => x.includes("❯"));
    return l === undefined ? null : (/(alpha|beta)-\d\d/.exec(l)?.[0] ?? null);
  };

  beforeEach(() => {
    ROWS.list = projectRows();
    PH.roots = ["/projA", "/projB"];
    PH.progress = {
      "/projA": {
        milestone_name: "Alpha",
        milestone_version: "v1",
        percent: 15,
        phases: Array.from({ length: 20 }, (_, i) => phase("alpha", i, 3)),
      },
      "/projB": {
        milestone_name: "Beta",
        milestone_version: "v2",
        percent: 33,
        phases: Array.from({ length: 3 }, (_, i) => phase("beta", i, 1)),
      },
    };
  });
  afterEach(() => {
    ROWS.list = DEFAULT_ROWS;
    PH.roots = [];
    PH.progress = {};
  });

  it("shows the live project with no sample chip; →/← cycle projects by root (wrapping); Tab never does", async () => {
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    await vi.waitFor(() => expect(lastFrame()).toContain("Alpha v1"), { timeout: 3000 });
    expect(projLine(lastFrame())).toContain("projA");
    expect(projLine(lastFrame())).toContain("project 1/2");
    expect(lines(lastFrame()).find((l) => l.includes("[r]"))).not.toContain("sample");

    press(stdin, KEYS.tab);
    await vi.waitFor(() => expect(lastFrame()).toContain("▐PHASES▌"));
    press(stdin, KEYS.right);
    await vi.waitFor(() => expect(projLine(lastFrame())).toContain("project 2/2"));
    expect(projLine(lastFrame())).toContain("projB");
    await vi.waitFor(() => expect(lastFrame()).toContain("Beta v2"), { timeout: 3000 });
    // → again wraps to the first project
    press(stdin, KEYS.right);
    await vi.waitFor(() => expect(projLine(lastFrame())).toContain("project 1/2"));
    expect(projLine(lastFrame())).toContain("projA");
    // ← wraps back the other way
    press(stdin, KEYS.left);
    await vi.waitFor(() => expect(projLine(lastFrame())).toContain("project 2/2"));

    // Tab moves focus to PORTS and round to PHASES; the project never changes
    press(stdin, KEYS.tab);
    await vi.waitFor(() => expect(lastFrame()).toContain("▐PORTS▌"));
    expect(projLine(lastFrame())).toContain("projB");
    await pressEach(stdin, KEYS.tab, KEYS.tab);
    await vi.waitFor(() => expect(lastFrame()).toContain("▐PHASES▌"));
    expect(projLine(lastFrame())).toContain("projB");
    expect(projLine(lastFrame())).toContain("project 2/2");
  });

  it("a re-ordered focus set keeps the same project on screen (identity, not index)", async () => {
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    await vi.waitFor(() => expect(lastFrame()).toContain("Alpha v1"), { timeout: 3000 });
    expect(projLine(lastFrame())).toContain("project 1/2");

    // before any ←/→: the shown root is kept across the re-order
    ROWS.list = projectRows().reverse();
    await vi.waitFor(() => expect(projLine(lastFrame())).toContain("project 2/2"), { timeout: 3000 });
    expect(projLine(lastFrame())).toContain("projA");
    expect(lastFrame()).toContain("Alpha v1");

    // after →: the picked root is kept across the next re-order
    await pressEach(stdin, KEYS.tab, KEYS.right);
    await vi.waitFor(() => expect(projLine(lastFrame())).toContain("projB"));
    expect(projLine(lastFrame())).toContain("project 1/2");
    ROWS.list = projectRows();
    await vi.waitFor(() => expect(projLine(lastFrame())).toContain("project 2/2"), { timeout: 3000 });
    expect(projLine(lastFrame())).toContain("projB");
  });

  it("↑/↓ move the phase cursor by number, PgUp/PgDn by the window; a project change resets it", async () => {
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    await vi.waitFor(() => expect(lastFrame()).toContain("Alpha v1"), { timeout: 3000 });
    press(stdin, KEYS.tab);
    // the default cursor is the current phase
    await vi.waitFor(() => expect(cursorPhase(lastFrame())).toBe("alpha-03"));
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(cursorPhase(lastFrame())).toBe("alpha-04"));
    press(stdin, KEYS.up);
    await vi.waitFor(() => expect(cursorPhase(lastFrame())).toBe("alpha-03"));
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(cursorPhase(lastFrame())).toBe("alpha-04"));

    // PgDn moves by the phases drawn in the window
    const drawn = new Set(lastFrame().match(/alpha-\d\d/g) ?? []).size;
    expect(drawn).toBeGreaterThan(1);
    const target = `alpha-${String(Math.min(19, 4 + drawn)).padStart(2, "0")}`;
    press(stdin, PG_DOWN);
    await vi.waitFor(() => expect(cursorPhase(lastFrame())).toBe(target));
    // PgUp past the top clamps to the first phase
    await pressEach(stdin, PG_UP, PG_UP, PG_UP, PG_UP, PG_UP);
    await vi.waitFor(() => expect(cursorPhase(lastFrame())).toBe("alpha-00"));

    // → shows project B with its cursor on B's current phase
    press(stdin, KEYS.right);
    await vi.waitFor(() => expect(cursorPhase(lastFrame())).toBe("beta-01"), { timeout: 3000 });
    // ← back to A: the cursor was cleared, so it rests on A's current phase again
    press(stdin, KEYS.left);
    await vi.waitFor(() => expect(cursorPhase(lastFrame())).toBe("alpha-03"));
  });

  it("the footer shows the PHASES hints from the keymap", async () => {
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    press(stdin, KEYS.tab);
    await vi.waitFor(() => expect(lastFrame()).toContain("▐PHASES▌"));
    const f = footer(lastFrame());
    expect(f).toContain("↑↓ browse phases");
    expect(f).toContain("←→ project");
    expect(f).toContain("r sessions");
  });
});

describe("PanelApp live SESSIONS (10-14, 08 D-14..D-19)", () => {
  const PG_UP = String.fromCharCode(27) + "[5~";
  const PG_DOWN = String.fromCharCode(27) + "[6~";
  const resumeRow = (id: string, label: string, ageMs: number) => ({
    id,
    label,
    labelKind: "name" as const,
    folder: "proj",
    cwd: "/nx-csm-1014",
    slug: "-nx-csm-1014",
    mtimeMs: NOW - ageMs,
    live: false,
  });
  /** The session name on the SESSIONS cursor row (`▸`). */
  const cursorSession = (frame: string): string | null => {
    const l = lines(frame).find((x) => x.includes("▸"));
    return l === undefined ? null : (/(first|second|third) sess/.exec(l)?.[0] ?? null);
  };
  const OPENED = "opened a new Terminal window";

  beforeEach(() => {
    SESS.list = [
      resumeRow("r-1", "first sess", 60_000),
      resumeRow("r-2", "second sess", 3_600_000),
      resumeRow("r-3", "third sess", 86_400_000 * 2),
    ];
    vi.mocked(copyResume).mockClear();
    vi.mocked(openResume).mockClear();
    vi.mocked(discoverSessions).mockClear();
  });
  afterEach(() => {
    SESS.list = [];
  });

  /** Mount, focus the right column and switch it to SESSIONS. */
  async function mountSessions() {
    const m = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    press(m.stdin, KEYS.tab);
    await vi.waitFor(() => expect(m.lastFrame()).toContain("▐PHASES▌"));
    press(m.stdin, KEYS.r);
    await vi.waitFor(() => expect(cursorSession(m.lastFrame())).toBe("first sess"));
    return m;
  }

  it("shows the live resume list with ages and the footer's SESSIONS hints; the scan runs only while shown", async () => {
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    await sleep(50);
    expect(discoverSessions).not.toHaveBeenCalled();
    await pressEach(stdin, KEYS.tab, KEYS.r);
    await vi.waitFor(() => expect(lastFrame()).toContain("third sess"));
    expect(discoverSessions).toHaveBeenCalledTimes(1);
    const f = lastFrame();
    expect(lines(f).find((l) => l.includes("first sess"))).toContain("1m");
    expect(lines(f).find((l) => l.includes("third sess"))).toContain("2d");
    expect(lines(f).find((l) => l.includes("[r]"))).not.toContain("sample");
    const ft = footer(f);
    expect(ft).toContain("↑↓ select session");
    expect(ft).toContain("⏎ copy resume");
    expect(ft).toContain("o new window");
  });

  it("↓/↑ and PgUp/PgDn move the cursor by id", async () => {
    const { lastFrame, stdin } = await mountSessions();
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(cursorSession(lastFrame())).toBe("second sess"));
    press(stdin, KEYS.up);
    await vi.waitFor(() => expect(cursorSession(lastFrame())).toBe("first sess"));
    press(stdin, PG_DOWN);
    await vi.waitFor(() => expect(cursorSession(lastFrame())).toBe("third sess"));
    press(stdin, PG_UP);
    await vi.waitFor(() => expect(cursorSession(lastFrame())).toBe("first sess"));
  });

  it("Enter copies the selected resume line and shows copied ✓; o opens it; r clears the status", async () => {
    const { lastFrame, stdin } = await mountSessions();
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(cursorSession(lastFrame())).toBe("second sess"));

    press(stdin, KEYS.enter);
    await vi.waitFor(() => expect(lastFrame()).toContain("copied ✓"));
    expect(copyResume).toHaveBeenCalledTimes(1);
    expect(vi.mocked(copyResume).mock.calls[0]![0]).toMatchObject({ id: "r-2", cwd: "/nx-csm-1014", live: false });
    expect(openResume).not.toHaveBeenCalled();

    press(stdin, "o");
    await vi.waitFor(() => expect(lastFrame()).toContain(OPENED));
    expect(openResume).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openResume).mock.calls[0]![0]).toMatchObject({ id: "r-2", live: false });

    // r back to PHASES clears the status; it is gone when SESSIONS shows again
    press(stdin, KEYS.r);
    await vi.waitFor(() => expect(footer(lastFrame())).toContain("r sessions"));
    press(stdin, KEYS.r);
    await vi.waitFor(() => expect(footer(lastFrame())).toContain("r phases"));
    await vi.waitFor(() => expect(lastFrame()).toContain("second sess"));
    expect(lastFrame()).not.toContain(OPENED);
    expect(lastFrame()).not.toContain("copied ✓");
  });

  it("a second o on the just-opened session copies instead of opening again (claim-before-await)", async () => {
    let release: () => void = () => undefined;
    vi.mocked(openResume).mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = () => res({ ok: true, copied: true, message: `${OPENED} · command copied` });
        }),
    );
    const { lastFrame, stdin } = await mountSessions();
    // two separate presses while the first launch is still pending
    press(stdin, "o");
    await vi.waitFor(() => expect(openResume).toHaveBeenCalledTimes(1));
    press(stdin, "o");
    await vi.waitFor(() => expect(openResume).toHaveBeenCalledTimes(2));
    // the first press launches (not live); the second sees the hold and only copies (live: true)
    expect(vi.mocked(openResume).mock.calls[0]![0]).toMatchObject({ id: "r-1", live: false });
    expect(vi.mocked(openResume).mock.calls[1]![0]).toMatchObject({ id: "r-1", live: true });
    release();
    await vi.waitFor(() => expect(lastFrame()).toContain("· live"));
  });

  it("Enter with PHASES showing never copies", async () => {
    const { stdin, lastFrame } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    press(stdin, KEYS.tab);
    await vi.waitFor(() => expect(lastFrame()).toContain("▐PHASES▌"));
    await pressEach(stdin, KEYS.enter, "o");
    await sleep(100);
    expect(copyResume).not.toHaveBeenCalled();
    expect(openResume).not.toHaveBeenCalled();
  });
});

// --- Phase 10 plan 10-15: the live PORTS pane (KEYS-02, KEYS-03, LAYOUT-01, D-23)
// The scan is the usePorts mock (PORTS.list, cadence portScanMs); ownership is
// the real livePidMap / attribute join over the mocked live rows.

describe("PanelApp live PORTS (10-15, KEYS-02, KEYS-03)", () => {
  const PG_DOWN = String.fromCharCode(27) + "[6~";
  const sp = (port: number, pid: number, command: string, ancestryPids: number[], exposed = false) => ({
    port,
    pid,
    command,
    exposed,
    ancestryPids,
    origin: "other" as const,
  });
  const VITE = sp(5173, 20, "vite", [20, 10]);
  const BUN = sp(3000, 30, "bun", [30, 11]);
  const STEAM = sp(27036, 811, "steam_osx", [811], true);
  const portRows = (): SessionRow[] => [
    makeRow({ session_id: "s-dash", title: "dashboard research", pid: 10 }),
    makeRow({ session_id: "s-check", title: "checkout screen", pid: 11 }),
  ];
  /** The PORTS pane's non-blank rows below its title (the right column). */
  const portsBlock = (f: string): string[] => {
    const ls = lines(f);
    const y = ls.findIndex((l) => /PORTS/.test(l.split("│")[1] ?? ""));
    if (y < 0) return [];
    return ls
      .slice(y + 1)
      .map((l) => l.split("│")[1] ?? "")
      .filter((r) => r.trim() !== "");
  };
  const portsTitle = (f: string): string => lines(f).find((l) => /PORTS/.test(l.split("│")[1] ?? "")) ?? "";
  /** The port the `❯` sits on, or null when PORTS draws no cursor. */
  const cursorPort = (f: string): string | null => {
    const r = portsBlock(f).find((l) => l.includes("❯"));
    return r === undefined ? null : (r.match(/:(\d+)/)?.[1] ?? "?");
  };
  const setScanMs = (ms: number) => vi.mocked(portScanMs).mockReturnValue(ms);

  beforeEach(() => {
    ROWS.list = portRows();
    PORTS.list = [VITE, BUN, STEAM];
    setScanMs(10_000_000);
    vi.mocked(killPort).mockClear();
  });
  afterEach(() => {
    ROWS.list = DEFAULT_ROWS;
    PORTS.list = [];
    setScanMs(10_000_000);
  });

  it("unfocused: exposed first, then owned ports with their session; no sample chip (D-23)", async () => {
    const { lastFrame } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    await vi.waitFor(() => expect(lastFrame()).toContain(":27036"));
    const b = portsBlock(lastFrame()).map((l) => l.trim());
    expect(b[0]).toMatch(/^:27036 +steam_osx +⇡ exposed$/);
    expect(b[1]).toMatch(/^:3000 +bun$/);
    expect(b[2]).toBe("↳ checkout screen");
    expect(b[3]).toMatch(/^:5173 +vite$/);
    expect(b[4]).toBe("↳ dashboard research");
    expect(portsTitle(lastFrame())).not.toContain("sample");
    expect(cursorPort(lastFrame())).toBeNull();
    expect(lastFrame()).not.toContain("pid 30");
  });

  it("an unowned, unexposed port is counted as `+N others` when unfocused", async () => {
    PORTS.list = [VITE, BUN, STEAM, sp(8080, 90, "python3", [90])];
    const { lastFrame } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    await vi.waitFor(() => expect(portsBlock(lastFrame()).join("\n")).toContain("+1 others"));
    expect(lastFrame()).not.toContain(":8080");
  });

  it("every pane is live: no sample chip anywhere in the frame (LAYOUT-01)", async () => {
    const { lastFrame } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    await vi.waitFor(() => expect(lastFrame()).toContain(":27036"));
    expect(lastFrame()).not.toContain(" sample ");
  });

  it("Tab to PORTS lists every port with `pid N`, `❯` on the first; footer has no `⏎ actions`", async () => {
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    await vi.waitFor(() => expect(lastFrame()).toContain(":27036"));
    await pressEach(stdin, KEYS.tab, KEYS.tab);
    await vi.waitFor(() => expect(footer(lastFrame())).toContain("browse ports"));
    const b = portsBlock(lastFrame()).map((l) => l.trim());
    expect(b[0]).toMatch(/^❯ :3000 +bun +pid 30$/);
    expect(b[2]).toMatch(/^:5173 +vite +pid 20$/);
    expect(b[4]).toMatch(/^:27036 +steam_osx +⇡ exposed +pid 811$/);
    expect(portsTitle(lastFrame())).toContain("3 ports");
    expect(cursorPort(lastFrame())).toBe("3000");
    expect(footer(lastFrame()).trim()).toMatch(/↑↓ browse ports +esc agents +tab focus +q quit$/);
    expect(footer(lastFrame())).not.toContain("actions");
    expect(footer(lastFrame())).not.toContain("⏎");
  });

  it("↓ moves the cursor; a re-scan that re-orders the list keeps it on the same port (KEYS-02)", async () => {
    setScanMs(60);
    const { lastFrame, stdin } = await mountTty(
      <PanelApp tickMs={FROZEN} now={() => NOW} initialUi={{ focus: "ports" }} />,
    );
    await vi.waitFor(() => expect(cursorPort(lastFrame())).toBe("3000"));
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(cursorPort(lastFrame())).toBe("5173"));
    // the next scan inserts a port before the selection and arrives in reverse order
    PORTS.list = [STEAM, VITE, BUN, sp(2000, 40, "deno", [40])];
    await vi.waitFor(() => expect(lastFrame()).toContain(":2000"));
    const b = portsBlock(lastFrame()).map((l) => l.trim());
    expect(b[0]).toMatch(/^:2000 +deno/);
    expect(cursorPort(lastFrame())).toBe("5173");
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(cursorPort(lastFrame())).toBe("27036"));
  });

  it("a vanished selected port draws no `❯` (not first, not nearest); one ↓ then selects the first port (fail closed)", async () => {
    setScanMs(60);
    const { lastFrame, stdin } = await mountTty(
      <PanelApp tickMs={FROZEN} now={() => NOW} initialUi={{ focus: "ports" }} />,
    );
    await vi.waitFor(() => expect(cursorPort(lastFrame())).toBe("3000"));
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(cursorPort(lastFrame())).toBe("5173"));
    PORTS.list = [BUN, STEAM];
    await vi.waitFor(() => expect(lastFrame()).not.toContain(":5173"));
    expect(portsTitle(lastFrame())).toContain("2 ports");
    expect(cursorPort(lastFrame())).toBeNull();
    expect(portsBlock(lastFrame()).some((l) => l.includes("❯"))).toBe(false);
    // the stale key stays (no state change brings the cursor back on its own)
    await sleep(200);
    expect(cursorPort(lastFrame())).toBeNull();
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(cursorPort(lastFrame())).toBe("3000"));
  });

  it("PgDn with more ports than the window moves the cursor by the drawn window", async () => {
    // 175x55 focused PORTS fits about 40 one-row ports, so 60 make it overflow
    PORTS.list = Array.from({ length: 60 }, (_, i) => sp(4000 + i, 100 + i, "node", [100 + i]));
    const { lastFrame, stdin } = await mountTty(
      <PanelApp tickMs={FROZEN} now={() => NOW} initialUi={{ focus: "ports" }} />,
    );
    await vi.waitFor(() => expect(cursorPort(lastFrame())).toBe("4000"));
    const drawn = portsBlock(lastFrame()).filter((l) => /:\d{4}/.test(l)).length;
    expect(drawn).toBeGreaterThan(1);
    expect(drawn).toBeLessThan(60);
    press(stdin, PG_DOWN);
    await vi.waitFor(() => expect(cursorPort(lastFrame())).toBe(String(4000 + drawn)));
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(cursorPort(lastFrame())).toBe(String(4000 + drawn + 1)));
  });

  it("Enter on a port does nothing: no flash, no frame change, no process signal (T-10-39)", async () => {
    const { lastFrame, stdin } = await mountTty(
      <PanelApp tickMs={FROZEN} now={() => NOW} initialUi={{ focus: "ports" }} />,
    );
    await vi.waitFor(() => expect(cursorPort(lastFrame())).toBe("3000"));
    const before = lastFrame();
    press(stdin, KEYS.enter);
    await sleep(150);
    expect(lastFrame()).toBe(before);
    expect(killPort).not.toHaveBeenCalled();
  });
});

// --- Phase 10 plan 10-16: no SAMPLE anywhere (D-23) -------------------------

describe("PanelApp is SAMPLE-free (10-16, D-23)", () => {
  const phaseRow = (i: number) => ({
    number: String(i).padStart(2, "0"),
    name: `live-phase-${i}`,
    plans: 2,
    summaries: i < 4 ? 2 : 0,
    status: i < 4 ? "Complete" : "Pending",
  });
  beforeEach(() => {
    ROWS.list = [
      makeRow({ session_id: "s-live-a", folder: "liveA", cwd: "/liveA", title: "live alpha", pid: 10, asking: true }),
      makeRow({ session_id: "s-live-b", folder: "liveA", cwd: "/liveA", title: "live beta", pid: 11, running: true }),
      makeRow({ session_id: "s-live-c", folder: "liveA", cwd: "/liveA", title: "live gamma" }),
    ];
    PORTS.list = [
      { port: 5173, pid: 20, command: "vite", exposed: false, ancestryPids: [20, 10], origin: "other" },
      { port: 8080, pid: 90, command: "python3", exposed: true, ancestryPids: [90], origin: "other" },
    ];
    PH.roots = ["/liveA"];
    PH.progress = {
      "/liveA": { milestone_name: "Live", milestone_version: "v1", percent: 40, phases: Array.from({ length: 8 }, (_, i) => phaseRow(i)) },
    };
    SESS.list = [
      { id: "r-live-1", label: "live resume one", labelKind: "name", folder: "liveA", cwd: "/liveA", slug: "-liveA", mtimeMs: NOW - 60_000, live: false },
    ];
  });
  afterEach(() => {
    ROWS.list = DEFAULT_ROWS;
    PORTS.list = [];
    PH.roots = [];
    PH.progress = {};
    SESS.list = [];
  });

  it("no line of a live frame carries the ` sample ` chip, in every focus and both tabs", async () => {
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(":5173");
      expect(lastFrame()).toContain("live-phase-4");
    });
    const noSample = (label: string) => {
      for (const l of lines(lastFrame())) expect(l, label).not.toContain(" sample ");
    };
    expect(lastFrame()).toContain("live alpha");
    noSample("AGENTS focused, PHASES tab");
    press(stdin, KEYS.tab);
    await vi.waitFor(() => expect(lastFrame()).toContain("▐PHASES▌"));
    noSample("right focused, PHASES tab");
    press(stdin, KEYS.r);
    await vi.waitFor(() => expect(lastFrame()).toContain("live resume one"));
    noSample("right focused, SESSIONS tab");
    press(stdin, KEYS.tab);
    await vi.waitFor(() => expect(lastFrame()).toContain("▐PORTS▌"));
    noSample("PORTS focused");
    press(stdin, KEYS.tab);
    press(stdin, KEYS.down);
    await vi.waitFor(() => expect(lastFrame()).toContain("┏"));
    noSample("AGENTS selection with the detail strip");
  });
});
