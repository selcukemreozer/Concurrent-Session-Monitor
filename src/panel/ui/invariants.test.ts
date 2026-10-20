/**
 * v2 shell size invariants, the pure half (Phase 9, plan 09-09).
 *
 * This is the ROADMAP Phase 9 "Test harness" item: at every terminal size the
 * shell draws "line count <= rows, line 1 is the brand, every line's width <=
 * cols". Phase 10 reuses this matrix unchanged as each pane goes live; plan
 * 09-13 appends the "through Ink" half, which renders PanelApp and splits the
 * last frame.
 *
 * Four parts:
 *   1. the rows x cols matrix x UI states x ticks x keys off, over SAMPLE;
 *   2. the same matrix over a wide fixture (24-grapheme CJK/emoji/ZWJ/combining
 *      names with an RLO bidi control, 200-character paths);
 *   3. rect containment: every pane draw, at every height the shell can hand
 *      it, writes nothing outside its rect (Screen.put clips only at the
 *      screen edge, so each pane must clip itself).
 *   4. focus visibility (09-16 gap closure, KEYS-01, D-13): at every size from
 *      60x16 and every focus, exactly one inverse title, on the focused pane;
 *      PHASES/SESSIONS/PORTS also show a body row. AGENTS body rows at split
 *      16-18 rows are WR-02, deferred to Phase 10.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import stringWidth from "string-width";
import { PanelApp, type PanelAppProps } from "../PanelApp.js";
import { frameLines, nonTtyStdin, renderCapture } from "./test-harness.js";
import { Screen, lineText, lineWidth, type Line } from "./screen.js";
import { cellWidth, graphemes, isControlCp } from "./text.js";
import { FOCUS_ORDER, initialUi, type UiState } from "./uiState.js";
import { SAMPLE, SAMPLE_HEADER } from "./sample.js";
import { PALETTE } from "./palette.js";
import { V2 } from "./glyphs.js";
import type { PanesModel, Rect } from "./models.js";
import { drawShell, type ShellInput } from "./draw/shell.js";
import { drawAgentsPane } from "./draw/agents.js";
import { drawFilesPane } from "./draw/files.js";
import { drawRightColumn } from "./draw/right.js";

/** [rows, cols] */
const SIZES: ReadonlyArray<readonly [number, number]> = [
  [16, 60],
  [24, 80],
  [40, 120],
  [55, 164],
  [55, 165],
  [55, 175],
  [55, 213],
  [55, 214],
  [55, 220],
  [80, 300],
  [10, 40],
  [16, 59],
  [15, 175],
  [30, 100],
  [20, 96],
  [60, 99],
];

const STATES: ReadonlyArray<readonly [string, UiState]> = [
  ["initial", initialUi],
  ["focus right", { ...initialUi, focus: "right" }],
  ["focus ports", { ...initialUi, focus: "ports" }],
  ["sessions tab", { ...initialUi, rightTab: "sessions" }],
  ["files paused", { ...initialUi, filesPaused: true }],
  ["selected agent", { ...initialUi, selectedAgentId: SAMPLE.agents[2]!.id }],
];

const TICKS = [0, 1, 2, 3];
const BRAND = "◆ CSM";
const RLO = String.fromCodePoint(0x202e);

function shell(rows: number, cols: number, ui: UiState, tick: number, keysOff: boolean, panes: PanesModel): Line[] {
  const input: ShellInput = {
    rows,
    cols,
    ui,
    tick,
    step: tick * 3 + 11,
    header: SAMPLE_HEADER,
    panes,
    keysOff,
    flash: null,
    sample: true,
  };
  return drawShell(input);
}

function controlIn(lines: Line[]): string | null {
  for (const l of lines) {
    for (const s of l) {
      for (const ch of s.text) {
        const cp = ch.codePointAt(0) ?? 0;
        if (isControlCp(cp)) return `U+${cp.toString(16)} in ${JSON.stringify(s.text)}`;
      }
    }
  }
  return null;
}

/** Assert every invariant on one frame; returns the line count. */
function check(lines: Line[], rows: number, cols: number): number {
  expect(lines.length).toBeLessThanOrEqual(rows);
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) expect(lineWidth(l)).toBeLessThanOrEqual(cols);
  expect(lineText(lines[0] as Line)).toContain(BRAND);
  expect(controlIn(lines)).toBeNull();
  return lines.length;
}

function runMatrix(rows: number, cols: number, panes: PanesModel): void {
  for (const [, ui] of STATES) {
    for (const tick of TICKS) {
      const on = check(shell(rows, cols, ui, tick, false, panes), rows, cols);
      const off = check(shell(rows, cols, ui, tick, true, panes), rows, cols);
      // KEYS-06: the keys-off notice uses no extra line
      expect(off).toBe(on);
    }
  }
}

// --- the wide fixture: built from SAMPLE without mutating it ---------------

const CJK = String.fromCodePoint(0x6f22);
const EMOJI = String.fromCodePoint(0x1f600);
const ZWJ_FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
const COMBINING = "e" + String.fromCodePoint(0x0301);
const MIX = [CJK, EMOJI, ZWJ_FAMILY, COMBINING];
/** RLO + 24 graphemes cycling CJK / emoji / ZWJ family / combining. */
const WIDE_NAME = RLO + Array.from({ length: 24 }, (_, i) => MIX[i % MIX.length]).join("");
/** A 200-character path. */
const LONG_PATH = "/segment".repeat(25).slice(0, 192) + "/file.ts";

function wideFixture(): PanesModel {
  return {
    ...SAMPLE,
    agents: SAMPLE.agents.map((a) => ({ ...a, name: WIDE_NAME, dir: WIDE_NAME, branch: WIDE_NAME, prompt: WIDE_NAME })),
    idle: SAMPLE.idle.map((s) => ({ ...s, name: WIDE_NAME })),
    conflicts: SAMPLE.conflicts.map((c) => ({ ...c, a: WIDE_NAME, b: WIDE_NAME, path: LONG_PATH })),
    groups: SAMPLE.groups.map((g) => ({
      ...g,
      name: WIDE_NAME,
      files: g.files.map((f, i) => ({ ...f, path: `${LONG_PATH}${i}` })),
    })),
    projects: SAMPLE.projects.map((p) => ({
      ...p,
      name: WIDE_NAME,
      dir: LONG_PATH,
      phases: p.phases.map((ph) => ({ ...ph, name: WIDE_NAME })),
    })),
    sessions: SAMPLE.sessions.map((s) => ({ ...s, name: WIDE_NAME })),
    ports: SAMPLE.ports.map((p) => ({ ...p, proc: WIDE_NAME, owner: p.owner === null ? null : WIDE_NAME })),
  };
}

describe("v2 shell invariants (pure)", () => {
  it("the wide fixture really is wide and hostile", () => {
    expect(LONG_PATH.length).toBe(200);
    expect(WIDE_NAME.startsWith(RLO)).toBe(true);
    expect(cellWidth(WIDE_NAME)).toBeGreaterThan(24);
    // SAMPLE itself is untouched
    expect(SAMPLE.agents[0]!.name).not.toBe(WIDE_NAME);
  });

  it.each(SIZES)("%i rows x %i cols: sample data, every state, tick and keys-off flag", (rows, cols) => {
    runMatrix(rows, cols, SAMPLE);
  });

  it.each(SIZES)("%i rows x %i cols: wide fixture, every state, tick and keys-off flag", (rows, cols) => {
    const wide = wideFixture();
    runMatrix(rows, cols, wide);
    for (const [, ui] of STATES) {
      const lines = shell(rows, cols, ui, 0, false, wide);
      for (const l of lines) for (const s of l) expect(s.text.includes(RLO)).toBe(false);
    }
  });

  it("never stretches: a tall window returns the same content height", () => {
    expect(shell(80, 300, initialUi, 0, false, SAMPLE).length).toBe(shell(55, 300, initialUi, 0, false, SAMPLE).length);
  });
});

// --- rect containment ------------------------------------------------------

/** Cells drawn outside `r` on a Screen, as "x,y" strings. */
function outside(scr: Screen, r: Rect): string[] {
  const out: string[] = [];
  scr.toLines().forEach((l, y) => {
    let x = 0;
    for (const s of l) {
      for (const g of graphemes(s.text)) {
        const w = cellWidth(g);
        const inside = y >= r.y && y < r.y + r.h && x >= r.x && x < r.x + r.w;
        if (!inside && (g !== " " || s.bg !== undefined)) out.push(`${x},${y}`);
        x += w;
      }
    }
  });
  return out;
}

describe("v2 panes stay inside their rects (pure)", () => {
  // every pane width the shell hands out: S1/S2 full width, W2/W3 LW and RW
  const WIDTHS = [60, 74, 80, 96, 99, 120, 145, 164, 300];
  // every small height, plus the large rects the shell hands out (up to rows - 4 = 51 at 55 rows)
  const HEIGHTS = [...Array.from({ length: 21 }, (_, i) => i), 24, 25, 30, 36, 40, 51];
  const FIXTURES: ReadonlyArray<readonly [string, PanesModel]> = [
    ["sample", SAMPLE],
    ["wide", wideFixture()],
  ];
  /** A screen 3 cells/rows larger than the rect on every side. */
  const scratch = (r: Rect): Screen => new Screen(r.x + r.w + 3, r.y + r.h + 3);

  it.each(WIDTHS)("width %i: AGENTS at every height and card-column count", (w) => {
    for (const [, panes] of FIXTURES) {
      for (const h of HEIGHTS) {
        const r: Rect = { x: 3, y: 3, w, h };
        for (const cardCols of [1, 2, 3]) {
          for (const firstRow of [0, 1]) {
            const scr = scratch(r);
            const res = drawAgentsPane(scr, r, {
              agents: panes.agents,
              idle: panes.idle,
              focused: true,
              sample: true,
              cardCols,
              tick: 1,
              selectedId: null,
              firstRow,
            });
            expect(outside(scr, r)).toEqual([]);
            expect(res.rows).toBeLessThanOrEqual(h);
          }
        }
      }
    }
  });

  it.each(WIDTHS)("width %i: FILES at every height", (w) => {
    for (const [, panes] of FIXTURES) {
      for (const h of HEIGHTS) {
        const r: Rect = { x: 3, y: 3, w, h };
        for (const paused of [false, true]) {
          const scr = scratch(r);
          const rows = drawFilesPane(scr, r, {
            conflicts: panes.conflicts,
            groups: panes.groups,
            paused,
            step: 7,
            sample: true,
          });
          expect(outside(scr, r)).toEqual([]);
          expect(rows).toBeLessThanOrEqual(h);
        }
      }
    }
  });

  it.each(WIDTHS)("width %i: the right column at every height and UI state", (w) => {
    for (const [, panes] of FIXTURES) {
      for (const h of HEIGHTS) {
        const r: Rect = { x: 3, y: 3, w, h };
        for (const [, ui] of STATES) {
          const scr = scratch(r);
          const res = drawRightColumn(scr, r, {
            ui,
            projects: panes.projects,
            projectIndex: panes.projectIndex,
            sessions: panes.sessions,
            sessionStatus: panes.sessionStatus,
            ports: panes.ports,
            sample: true,
            portsMinY: r.y + Math.floor(h / 2),
          });
          expect(outside(scr, r)).toEqual([]);
          if (h > 0) expect(res.end).toBeLessThanOrEqual(r.y + h - 1);
        }
      }
    }
  });
});

// --- focus visibility (plan 09-16, KEYS-01) --------------------------------

// Stacked 60-164 cols and split 165+ cols, from the 60x16 floor (D-27) up.
const FOCUS_ROWS = [16, 17, 18, 19, 20, 21, 22, 23, 24, 30, 67];
const FOCUS_COLS = [60, 80, 96, 99, 100, 164, 165, 175, 213, 214, 284];
/** [rows, cols] */
const FOCUS_SIZES: ReadonlyArray<readonly [number, number]> = FOCUS_ROWS.flatMap((r) =>
  FOCUS_COLS.map((c) => [r, c] as const),
);
const INVERSE_TITLE = new RegExp(`${V2.capL}(AGENTS|PHASES|SESSIONS|PORTS)${V2.capR}`, "g");

/** SAMPLE with `n` copies of its conflict on distinct paths (SAMPLE is never mutated). */
function withConflicts(n: number): PanesModel {
  const c = SAMPLE.conflicts[0]!;
  return { ...SAMPLE, conflicts: Array.from({ length: n }, (_, i) => ({ ...c, path: `src/conflict-${i}.ts` })) };
}

const FOCUS_FIXTURES: ReadonlyArray<readonly [string, PanesModel]> = [
  ["sample", SAMPLE],
  ["no conflicts", withConflicts(0)],
  ["five conflicts", withConflicts(5)],
];

/** The label the focused pane's inverse title carries. */
function focusLabel(ui: UiState): string {
  if (ui.focus === "agents") return "AGENTS";
  if (ui.focus === "ports") return "PORTS";
  return ui.rightTab === "phases" ? "PHASES" : "SESSIONS";
}

describe("v2 shell focus visibility (pure, KEYS-01)", () => {
  it.each(FOCUS_SIZES)(
    "%i rows x %i cols: exactly one inverse title, on the focused pane, with a body row",
    (rows, cols) => {
      for (const [name, panes] of FOCUS_FIXTURES) {
        for (const focus of FOCUS_ORDER) {
          for (const rightTab of ["phases", "sessions"] as const) {
            const ui: UiState = { ...initialUi, focus, rightTab };
            const at = `${name}, focus ${focus}, tab ${rightTab}`;
            const lines = shell(rows, cols, ui, 0, false, panes);
            const t = lines.map((l) => lineText(l));
            const label = focusLabel(ui);
            const inverse = `${V2.capL}${label}${V2.capR}`;
            // (a) exactly one inverse title, and it is the focused pane's
            const found = t.join("\n").match(INVERSE_TITLE) ?? [];
            expect(found, `${at}: inverse titles`).toEqual([inverse]);
            // (b) its label cell really is drawn inverse
            const y = t.findIndex((s) => s.includes(inverse));
            const seg = (lines[y] as Line).find((s) => s.text === label);
            expect(seg?.bg, `${at}: label background`).toBe(PALETTE.hi);
            const footer = t.length - 1;
            if (focus === "ports") {
              // (c) the focused first-port row sits under the title, above the footer
              const cursorRow = t.slice(y + 1, footer).some((s) => s.includes(`${V2.cursor} :`));
              expect(cursorRow, `${at}: focused port row`).toBe(true);
            }
            if (focus === "right") {
              // (d) the first tab-body row, two rows under the tab title
              expect(y + 2, `${at}: body row above the footer`).toBeLessThan(footer);
              expect((t[y + 2] as string).trim(), `${at}: body row text`).not.toBe("");
            }
          }
        }
      }
    },
  );
});

// --- through Ink (plan 09-13) ----------------------------------------------

// The store, prune and update modules are mocked exactly as PanelApp.test.tsx
// does, so the live header has a stable roster and no network or disk access
// happens. vi.mock is hoisted; the pure tests above import none of these.
vi.mock("../../aggregate.js", () => ({ readAll: vi.fn(() => []) }));
vi.mock("../../prune.js", () => ({ pruneSession: vi.fn() }));
vi.mock("../../update.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../update.js")>();
  return {
    ...actual,
    startUpdateCheck: vi.fn(() => () => {}),
    installedVersion: vi.fn(() => "1.7.0"),
  };
});

describe("v2 shell invariants (through Ink)", () => {
  const INK_SIZES: ReadonlyArray<readonly [number, number]> = [
    [55, 175],
    [55, 220],
    [24, 80],
    [16, 60],
    [10, 40],
    [40, 120],
  ];
  const mounted: Array<{ unmount: () => void }> = [];
  afterEach(() => {
    while (mounted.length > 0) {
      try {
        mounted.pop()!.unmount();
      } catch {
        /* already unmounted */
      }
    }
  });

  // PanelApp's props parameter is optional, which createElement's overloads do
  // not infer; this is the same function with the parameter made required.
  const V2Root = PanelApp as (props: PanelAppProps) => React.ReactElement;

  it.each(INK_SIZES)("%i rows x %i cols: the last frame fits and line 1 is the brand", (rows, cols) => {
    const r = renderCapture(React.createElement(V2Root, { tickMs: 1000 }), {
      rows,
      columns: cols,
      stdin: nonTtyStdin(),
    });
    mounted.push(r.inst);
    const lines = frameLines(r.lastFrame());
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(rows);
    for (const l of lines) expect(stringWidth(l), `line ${JSON.stringify(l)}`).toBeLessThanOrEqual(cols);
    expect(lines[0]).toContain("◆ CSM");
  });
});
