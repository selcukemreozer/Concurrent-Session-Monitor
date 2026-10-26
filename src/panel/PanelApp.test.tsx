import { describe, it, expect, vi, afterEach } from "vitest";
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
const { UPDATE_STOP } = vi.hoisted(() => ({ UPDATE_STOP: vi.fn() }));
vi.mock("../update.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../update.js")>();
  return {
    ...actual,
    startUpdateCheck: vi.fn(() => UPDATE_STOP),
    installedVersion: vi.fn(() => "1.7.0"),
  };
});

ROWS.list = [
  makeRow({ session_id: "sess-ask", asking: true }),
  makeRow({ session_id: "sess-wait", attention: true }),
];

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
    const agentsTitle = ls.find((l) => l.includes("AGENTS"));
    expect(agentsTitle).toBeDefined();
    expect(agentsTitle).toContain("sample");
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
    const header = headerFromRoster(
      {
        display: ROWS.list.map((row) => ({ id: row.session_id, row, ended: false })),
        live: 2,
        idle: 0,
        conflicts: [],
      },
      null,
      NOW,
    );
    const expected = drawShell({
      rows: R,
      cols: C,
      ui: { ...initialUi, rightTab: "sessions" },
      tick: 0,
      step: 0,
      header,
      panes: SAMPLE,
      keysOff: false,
      flash: null,
      sample: true,
    });
    const tabsY = expected.findIndex((l) => lineText(l).includes("[r]"));
    expect(tabsY).toBeGreaterThan(0);
    const active = expected[tabsY]!.find((s) => s.text.includes("SESSIONS"));
    expect(active?.text).toBe(" SESSIONS ");
    expect(active?.bg).toBe(PALETTE.idle);
    expect(lines(lastFrame())[tabsY]).toBe(lineText(expected[tabsY]!));
  });

  it("space pauses the FILES ticker and flips its hint", async () => {
    const { lastFrame, stdin } = await mountTty();
    expect(lastFrame()).not.toContain("paused · 14 files");
    press(stdin, KEYS.space);
    await vi.waitFor(() => expect(lastFrame()).toContain("paused · 14 files"));
    expect(footer(lastFrame())).toContain("space resume files");
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

describe("PanelApp source (T-09-11, T-09-08c)", () => {
  const src = readFileSync(fileURLToPath(new URL("./PanelApp.tsx", import.meta.url)), "utf8");
  const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);

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
