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
    expect(lastFrame()).toContain("ci pipeline monitoring");
    press(stdin, KEYS.r);
    await vi.waitFor(() => expect(footer(lastFrame())).toContain("r phases"));
    // The right column now draws SESSIONS, not the PHASES list.
    expect(lastFrame()).not.toContain("ci pipeline monitoring");

    // The tabs row in the frame is exactly the shell's row for rightTab
    // sessions, whose SESSIONS segment carries the active-tab background.
    const display = ROWS.list.map((row) => ({ id: row.session_id, row, ended: false }));
    const header = headerFromRoster({ display, live: 2, idle: 0, conflicts: [] }, null, NOW);
    // 10-09: AGENTS is live; 10-12: FILES is live (no files here); the rest is SAMPLE
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
      panes: { ...SAMPLE, agents: ag.agents, idle: ag.idle, conflicts: [], groups: [] },
      keysOff: false,
      flash: null,
      sample: { agents: false, files: false, phases: true, sessions: true, ports: true },
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
    expect(lastFrame()).toContain("ci pipeline monitoring");
    press(stdin, KEYS.r);
    // the right column switches to SESSIONS (agentsSelected hints carry no r)
    await vi.waitFor(() => expect(lastFrame()).not.toContain("ci pipeline monitoring"));
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

  it("PHASES / SESSIONS and PORTS keep their sample chips; FILES is live (10-12, D-23)", async () => {
    const { lastFrame, stdin } = await mountTty(<PanelApp tickMs={FROZEN} now={() => NOW} />);
    const ls = lines(lastFrame());
    expect(leftOf(ls.find((l) => leftOf(l).startsWith(" FILES "))!)).not.toContain("sample");
    expect(ls.find((l) => l.includes("PORTS"))).toContain("sample");
    expect(ls.find((l) => l.includes("[r]"))).toContain("sample");
    press(stdin, KEYS.r);
    await vi.waitFor(() => expect(footer(lastFrame())).toContain("r phases"));
    expect(lines(lastFrame()).find((l) => l.includes("[r]"))).toContain("sample");
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

  it("imports no action module (launch, ports, child process, warp-url, registration)", () => {
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).not.toMatch(/launch/);
      expect(spec).not.toMatch(/(^|\/)ports(\.js)?$/);
      expect(spec).not.toMatch(/child_process/);
      expect(spec).not.toMatch(/warp-url/);
      expect(spec).not.toMatch(/registration/);
    }
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
