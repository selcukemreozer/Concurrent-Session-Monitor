/**
 * v2 shell size invariants, the pure half (Phase 9, plan 09-09).
 *
 * This is the ROADMAP Phase 9 "Test harness" item: at every terminal size the
 * shell draws "line count <= rows, line 1 is the brand, every line's width <=
 * cols". Phase 10 reuses this matrix unchanged as each pane goes live; plan
 * 09-12 appends the "through Ink" half, which renders PanelApp and splits the
 * last frame.
 *
 * Three parts:
 *   1. the rows x cols matrix x UI states x ticks x keys off, over SAMPLE;
 *   2. the same matrix over a wide fixture (24-grapheme CJK/emoji/ZWJ/combining
 *      names with an RLO bidi control, 200-character paths);
 *   3. rect containment: every pane draw, at every height the shell can hand
 *      it, writes nothing outside its rect (Screen.put clips only at the
 *      screen edge, so each pane must clip itself).
 */
import { describe, expect, it } from "vitest";
import { Screen, lineText, lineWidth, type Line } from "./screen.js";
import { cellWidth, graphemes, isControlCp } from "./text.js";
import { initialUi, type UiState } from "./uiState.js";
import { SAMPLE, SAMPLE_HEADER } from "./sample.js";
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
