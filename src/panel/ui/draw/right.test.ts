import { describe, it, expect } from "vitest";
import { Screen, type Line } from "../screen.js";
import { cellWidth, graphemes } from "../text.js";
import { SAMPLE } from "../sample.js";
import { initialUi, type UiState } from "../uiState.js";
import type { Rect } from "../models.js";
import {
  drawRightColumn,
  focusedFloor,
  FOCUSED_PORTS_FLOOR,
  FOCUSED_TAB_FLOOR,
  type RightColumnModel,
} from "./right.js";

// Phase 9 plan 09-08 Task 2: the right column composer (D-02, D-20): the
// PHASES | SESSIONS tabs with [r] and the sample chip, the active tab body and
// the PORTS pane aligned to the FILES title row, reproduced cell-exactly from
// the approved 175x55 frame rows 2-34 (RX = 101, RW = 74).

interface Cell {
  ch: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

function cells(line: Line): Cell[] {
  const out: Cell[] = [];
  for (const s of line) {
    for (const g of graphemes(s.text)) {
      const c: Cell = { ch: g };
      if (s.fg !== undefined) c.fg = s.fg;
      if (s.bg !== undefined) c.bg = s.bg;
      if (s.bold) c.bold = true;
      out.push(c);
      for (let i = 1; i < cellWidth(g); i++) out.push({ ch: "" });
    }
  }
  return out;
}

const rowOf = (scr: Screen, y: number): Line => scr.toLines()[y] ?? [];
const cellAt = (scr: Screen, x: number, y: number): Cell => cells(rowOf(scr, y))[x] ?? { ch: " " };

function text(scr: Screen, y: number, from = 0, to = scr.cols): string {
  return cells(rowOf(scr, y))
    .slice(from, to)
    .map((c) => c.ch)
    .join("")
    .replace(/ +$/, "");
}

const DIM = "#85827a";
const DIM2 = "#5c5a54";
const IDLE = "#4a4945";

// UI-SPEC primary frame rows 2..34, cut to cells 101..174 and right-trimmed.
const FRAME_RIGHT = [
  " PHASES   SESSIONS   sample  " + "─".repeat(41) + " [r]",
  "",
  " Scale & Insights v2.1",
  " mvp-dash · project 2/2",
  " " + "━".repeat(64) + "  2/12",
  "",
  "  ●  31    auth flow",
  "  │",
  "  ●  32    billing sync",
  "  │",
  "  ◉  33    ci pipeline monitoring",
  "  │        3/7 plan  ━━━━━━━",
  "  │",
  "  ○  34    v2.0 gate closure",
  "  │",
  "  ○  35    production platform on outplane",
  "  ⋮  7 more phases",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  " PORTS  sample  " + "─".repeat(57),
  "",
  "  :3000   bun",
  "    ↳ checkout screen",
  "  :5173   vite",
  "    ↳ dashboard research",
  "  :27036  steam_osx   ⇡ exposed",
  "  +5 others",
];

const X = 101;
const RECT: Rect = { x: X, y: 2, w: 74, h: 33 };

function column(ui: Partial<UiState> = {}, rect = RECT, portsMinY = 27) {
  const scr = new Screen(175, 55);
  const out = drawRightColumn(scr, rect, {
    ui: { ...initialUi, ...ui },
    projects: SAMPLE.projects,
    projectIndex: SAMPLE.projectIndex,
    sessions: SAMPLE.sessions,
    sessionStatus: null,
    ports: SAMPLE.ports,
    sample: true,
    portsMinY,
  });
  return { scr, ...out };
}

describe("drawRightColumn frame fidelity", () => {
  it("reproduces frame rows 2..34 of the right column", () => {
    const { scr, end, portsY } = column();
    const got: string[] = [];
    for (let y = 2; y <= 34; y++) got.push(text(scr, y, X, 175));
    expect(got).toEqual(FRAME_RIGHT);
    expect(portsY).toBe(27);
    expect(end).toBe(34);
  });

  it("draws nothing outside the rect", () => {
    const { scr } = column();
    for (let y = 0; y < 55; y++) {
      expect(text(scr, y, 0, X)).toBe("");
      if (y < 2 || y > 34) expect(text(scr, y)).toBe("");
    }
  });

  it("styles the unfocused tabs and [r]", () => {
    const { scr } = column();
    expect(cellAt(scr, X + 1, 2)).toMatchObject({ ch: "P", bg: IDLE, bold: true });
    expect(cellAt(scr, X + 10, 2)).toMatchObject({ ch: "S", fg: DIM2 });
    expect(cellAt(scr, X + 71, 2)).toMatchObject({ ch: "[", fg: DIM });
  });
});

describe("drawRightColumn tab state", () => {
  it("draws the SESSIONS list from row 4 on the sessions tab", () => {
    const { scr, portsY } = column({ rightTab: "sessions" });
    expect(text(scr, 4, X, 175)).toBe("▸ csm p8 plan                 now     · live");
    expect(cellAt(scr, X, 4)).toMatchObject({ ch: "▸", fg: DIM });
    expect(text(scr, 14, X, 175)).toBe("  csm p7 execute              6d");
    expect(cellAt(scr, X + 10, 2)).toMatchObject({ ch: "S", bg: IDLE, bold: true });
    expect(portsY).toBe(27);
    expect(text(scr, 27, X, 175).startsWith(" PORTS  sample ")).toBe(true);
  });

  it("focuses the PHASES tab and body when the right column is focused", () => {
    const { scr, end } = column({ focus: "right" });
    expect(text(scr, 2, X, 175).startsWith("▐PHASES▌ ")).toBe(true);
    expect(text(scr, 4, 170, 175)).toBe("← →");
    let cursorRows = 0;
    for (let y = 4; y <= end; y++) if (cellAt(scr, X, y).ch === "❯") cursorRows++;
    expect(cursorRows).toBe(1);
    expect(end).toBeLessThanOrEqual(34);
  });

  it("focuses the SESSIONS tab and body", () => {
    const { scr } = column({ focus: "right", rightTab: "sessions" });
    expect(text(scr, 2, X, 175)).toMatch(/^ PHASES {2}▐SESSIONS▌ /);
    expect(cellAt(scr, X, 4)).toMatchObject({ ch: "▸", bold: true });
  });

  it("focuses the PORTS title when focus is on ports", () => {
    const { scr, portsY } = column({ focus: "ports" });
    expect(text(scr, portsY, X, 175).startsWith("▐PORTS▌ sample ")).toBe(true);
    expect(text(scr, portsY, X, 175).endsWith(" 8 ports")).toBe(true);
    expect(cellAt(scr, X, portsY + 2).ch).toBe("❯");
    expect(text(scr, 2, X, 175).startsWith(" PHASES ")).toBe(true);
  });

  it("passes the session status into the SESSIONS body", () => {
    const scr = new Screen(175, 55);
    drawRightColumn(scr, RECT, {
      ui: { ...initialUi, rightTab: "sessions" },
      projects: SAMPLE.projects,
      projectIndex: SAMPLE.projectIndex,
      sessions: SAMPLE.sessions,
      sessionStatus: { text: "copied ✓", ok: true },
      ports: SAMPLE.ports,
      sample: true,
      portsMinY: 27,
    });
    expect(text(scr, 16, X, 175)).toBe("  ✓ copied ✓");
  });
});

describe("drawRightColumn short height", () => {
  // WR-09: `{ focus: "right" }` left this list. A focused PHASES body now
  // grows first and the unfocused PORTS pane may keep only its title (see the
  // WR-09 block below).
  it.each([16, 12, 9])("fits h=%i and keeps PORTS with a title and one row", (h) => {
    const r: Rect = { x: X, y: 2, w: 74, h };
    for (const ui of [{}, { rightTab: "sessions" as const }, { focus: "ports" as const }]) {
      const { scr, end, portsY } = column(ui, r);
      expect(end).toBeLessThanOrEqual(r.y + r.h - 1);
      for (let y = r.y + r.h; y < 55; y++) expect(text(scr, y)).toBe("");
      expect(text(scr, portsY, X, 175)).toMatch(/PORTS/);
      expect(portsY + 2).toBeLessThanOrEqual(r.y + r.h - 1);
      expect(text(scr, portsY + 2, X, 175)).not.toBe("");
      expect(end).toBeGreaterThanOrEqual(portsY + 2);
    }
  });

  it("ignores portsMinY when it would squeeze PORTS out", () => {
    const r: Rect = { x: X, y: 2, w: 74, h: 16 };
    const { portsY } = column({}, r, 27);
    expect(portsY).toBeLessThan(27);
  });
});

describe("drawRightColumn: a focused PORTS keeps its first port row (09-16)", () => {
  it.each([6, 7, 8])("h=%i: ▐PORTS▌ and the ❯ cursor row fit inside the rect", (h) => {
    const r: Rect = { x: X, y: 2, w: 74, h };
    const { scr, end, portsY } = column({ focus: "ports" }, r);
    expect(text(scr, portsY, X, 175).startsWith("▐PORTS▌")).toBe(true);
    expect(cellAt(scr, X, portsY + 2).ch).toBe("❯");
    expect(end).toBeLessThanOrEqual(2 + h - 1);
  });

  it("h=7 without PORTS focus still serves the 3-row body first", () => {
    const r: Rect = { x: X, y: 2, w: 74, h: 7 };
    for (const ui of [{ focus: "agents" as const }, { focus: "right" as const }]) {
      expect(column(ui, r).portsY).toBe(8);
    }
  });
});

// --- Phase 10 plan 10-01 (D-19): WR-08 / WR-09 -------------------------------

function model(ui: Partial<UiState>, over: Partial<RightColumnModel> = {}): RightColumnModel {
  return {
    ui: { ...initialUi, ...ui },
    projects: SAMPLE.projects,
    projectIndex: SAMPLE.projectIndex,
    sessions: SAMPLE.sessions,
    sessionStatus: null,
    ports: SAMPLE.ports,
    sample: true,
    portsMinY: 0,
    ...over,
  };
}

/** Rows of the column from `from` to the rect bottom, cut to the column. */
function rowsOf(scr: Screen, from: number, to: number): string[] {
  const out: string[] = [];
  for (let y = from; y < to; y++) out.push(text(scr, y, X, 175));
  return out;
}

function arrows(rows: readonly string[]): number {
  let n = 0;
  for (const s of rows) for (const m of s.matchAll(/[↑↓] (\d+) more/g)) n += Number(m[1]);
  return n;
}

describe("drawRightColumn: a focused PORTS pane grows past one port row (WR-08)", () => {
  // h=6 (FOCUSED_PORTS_FLOOR) leaves a 1-row list: one port and no indicator.
  // That is the viewport height-1 rule, WR-05, fixed in plan 10-02.
  it.each([12, 9, 7])("WR-08 h=%i: drawn ports + ↓ N more = every port", (h) => {
    const r: Rect = { x: X, y: 2, w: 74, h };
    const { scr, portsY, end } = column({ focus: "ports" }, r, 0);
    expect(end).toBeLessThanOrEqual(r.y + h - 1);
    const list = rowsOf(scr, portsY + 1, r.y + h);
    const drawn = list.filter((s) => /(^|\s):\d+/.test(s)).length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn + arrows(list), JSON.stringify(list)).toBe(SAMPLE.ports.length);
    if (drawn < SAMPLE.ports.length) expect(list.some((s) => /↓ \d+ more/.test(s))).toBe(true);
  });

  it("WR-08 h=12: PORTS takes the rows and the unfocused PHASES body shrinks to its tab row", () => {
    const r: Rect = { x: X, y: 2, w: 74, h: 12 };
    const { scr, portsY } = column({ focus: "ports" }, r, 0);
    // tabs, spacer, a 0-row body, spacer, then PORTS
    expect(portsY).toBe(r.y + 3);
    expect(text(scr, r.y, X, 175).startsWith(" PHASES ")).toBe(true);
    // PORTS gets all 9 rows: title + spacer + a 7-row list (2 owned ports, 2 single rows, ↓ 4 more)
    expect(rowsOf(scr, portsY + 2, r.y + 12)).toEqual([
      "❯ :3000   bun                                                    pid 41822",
      "    ↳ checkout screen",
      "  :5173   vite                                                   pid 38810",
      "    ↳ dashboard research",
      "  :27036  steam_osx   ⇡ exposed                                    pid 811",
      "  :37777  bun                                                     pid 4993",
      "  ↓ 4 more",
    ]);
  });

  it("WR-08 a tall column keeps the PORTS title on the FILES row when it has the rows", () => {
    const r: Rect = { x: X, y: 2, w: 74, h: 51 };
    const { portsY } = column({ focus: "ports" }, r, 27);
    expect(portsY).toBe(27);
  });

  it("WR-08 a short column drops the FILES alignment instead of the focused port rows", () => {
    const r: Rect = { x: X, y: 2, w: 74, h: 33 };
    const { scr, portsY, end } = column({ focus: "ports" }, r, 27);
    expect(portsY).toBeLessThan(27);
    const list = rowsOf(scr, portsY + 1, end + 1);
    expect(list.filter((s) => /(^|\s):\d+/.test(s))).toHaveLength(SAMPLE.ports.length);
  });
});

describe("drawRightColumn: a focused PHASES pane shows a timeline row (WR-09)", () => {
  // h=9 is focusedFloor for the SAMPLE project (3 + 4 header + 1 timeline + 1).
  it.each([12, 10, 9])("WR-09 h=%i: the body shows a phase marker and PORTS keeps its title", (h) => {
    const r: Rect = { x: X, y: 2, w: 74, h };
    const { scr, portsY, end } = column({ focus: "right" }, r, 0);
    expect(end).toBeLessThanOrEqual(r.y + h - 1);
    const body = rowsOf(scr, r.y + 2, portsY);
    expect(body.some((s) => /[●◉○]|[↑↓] \d+ more/.test(s)), JSON.stringify(body)).toBe(true);
    expect(text(scr, portsY, X, 175).startsWith(" PORTS ")).toBe(true);
    expect(portsY).toBeLessThanOrEqual(r.y + h - 1);
  });

  it("WR-09 h=12: the unfocused PORTS pane shrinks to its title row", () => {
    const r: Rect = { x: X, y: 2, w: 74, h: 12 };
    const { scr, portsY, end } = column({ focus: "right" }, r, 0);
    expect(portsY).toBe(r.y + 11);
    expect(end).toBe(portsY);
    expect(rowsOf(scr, r.y + 6, r.y + 10).join("\n")).toMatch(/◉ {2}33/);
  });

  it("WR-09 the SESSIONS tab keeps PORTS with its first row at h=9", () => {
    const r: Rect = { x: X, y: 2, w: 74, h: 9 };
    const { scr, portsY } = column({ focus: "right", rightTab: "sessions" }, r, 0);
    expect(text(scr, r.y + 2, X, 175)).toMatch(/csm p8 plan/);
    expect(text(scr, portsY, X, 175).startsWith(" PORTS ")).toBe(true);
  });
});

describe("focusedFloor (WR-09 content-aware floor)", () => {
  it("PORTS focused: FOCUSED_PORTS_FLOOR", () => {
    expect(focusedFloor(model({ focus: "ports" }))).toBe(FOCUSED_PORTS_FLOOR);
  });

  it("SESSIONS focused: FOCUSED_TAB_FLOOR", () => {
    expect(focusedFloor(model({ focus: "right", rightTab: "sessions" }))).toBe(FOCUSED_TAB_FLOOR);
  });

  it("PHASES focused with several phases: tabs + spacer + 4 header + 1 timeline + ↓ + spacer", () => {
    expect(focusedFloor(model({ focus: "right" }))).toBe(3 + 4 + 1 + 1);
  });

  it("PHASES focused with one phase: no ↓ row in the floor", () => {
    const one = [{ ...SAMPLE.projects[0]!, phases: SAMPLE.projects[0]!.phases.slice(0, 1) }];
    expect(focusedFloor(model({ focus: "right" }, { projects: one, projectIndex: 0 }))).toBe(3 + 4 + 1);
  });

  it("PHASES focused on a project with no phases, or no projects: FOCUSED_TAB_FLOOR", () => {
    const none = [{ ...SAMPLE.projects[0]!, phases: [] }];
    expect(focusedFloor(model({ focus: "right" }, { projects: none, projectIndex: 0 }))).toBe(FOCUSED_TAB_FLOOR);
    expect(focusedFloor(model({ focus: "right" }, { projects: [], projectIndex: 0 }))).toBe(FOCUSED_TAB_FLOOR);
  });

  it("clamps the project index like drawPhases", () => {
    expect(focusedFloor(model({ focus: "right" }, { projectIndex: 99 }))).toBe(9);
    expect(focusedFloor(model({ focus: "right" }, { projectIndex: Number.NaN }))).toBe(9);
  });
});
