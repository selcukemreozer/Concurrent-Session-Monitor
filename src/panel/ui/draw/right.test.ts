import { describe, it, expect } from "vitest";
import { Screen, type Line } from "../screen.js";
import { cellWidth, graphemes } from "../text.js";
import { SAMPLE } from "../sample.js";
import { initialUi, type UiState } from "../uiState.js";
import type { Rect } from "../models.js";
import type { Band } from "../geometry.js";
import { PHASES_HEADER_ROWS } from "./phases.js";
import {
  bandFloor,
  drawBand,
  drawRightColumn,
  drawTabsBody,
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
// WR-05 (Phase 10 plan 10-02, D-19): the unfocused PORTS list puts the exposed
// port first, so the red security marker is the last port row to drop.
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
  "  :27036  steam_osx   ⇡ exposed",
  "  :3000   bun",
  "    ↳ checkout screen",
  "  :5173   vite",
  "    ↳ dashboard research",
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
  it("WR-05 reproduces frame rows 2..34 of the right column (exposed port first)", () => {
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

  it("WR-05 h=6: the spacers around the empty body fold into one, so the cursor keeps a ↓ 7 more row", () => {
    const r: Rect = { x: X, y: 2, w: 74, h: 6 };
    const { scr, end, portsY } = column({ focus: "ports" }, r, 0);
    expect(portsY).toBe(r.y + 2);
    expect(text(scr, r.y + 1, X, 175)).toBe("");
    expect(text(scr, portsY + 2, X, 175)).toMatch(/^❯ :3000 {3}bun/);
    expect(text(scr, portsY + 3, X, 175)).toBe("  ↓ 7 more");
    expect(end).toBe(2 + 6 - 1);
  });

  it("WR-05 h=7: one spacer row each side of the empty body (the 2-row list fits already)", () => {
    const r: Rect = { x: X, y: 2, w: 74, h: 7 };
    const { portsY } = column({ focus: "ports" }, r, 0);
    expect(portsY).toBe(r.y + 3);
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
  it("WR-08 PORTS focused: FOCUSED_PORTS_FLOOR + the ↓ row when the list needs more than one row", () => {
    expect(focusedFloor(model({ focus: "ports" }))).toBe(FOCUSED_PORTS_FLOOR + 1);
    const one = [SAMPLE.ports[3]!];
    expect(focusedFloor(model({ focus: "ports" }, { ports: one }))).toBe(FOCUSED_PORTS_FLOOR);
    expect(focusedFloor(model({ focus: "ports" }, { ports: [] }))).toBe(FOCUSED_PORTS_FLOOR);
    // one owned port needs 2 rows: the floor keeps a row for it
    expect(focusedFloor(model({ focus: "ports" }, { ports: [SAMPLE.ports[0]!] }))).toBe(FOCUSED_PORTS_FLOOR + 1);
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

// --- Phase 10 plan 10-03 (LAYOUT-04): the S2 bottom band ---------------------

describe("drawTabsBody (the tabs + active body, no PORTS)", () => {
  const r: Rect = { x: 0, y: 0, w: 47, h: 10 };

  it("draws the tabs on r.y and the PHASES body from r.y + 2, and no PORTS", () => {
    const scr = new Screen(47, 20);
    const { end } = drawTabsBody(scr, r, model({}), 8);
    expect(text(scr, 0)).toMatch(/^ PHASES {3}SESSIONS /);
    expect(text(scr, 0).endsWith("[r]")).toBe(true);
    expect(text(scr, 1)).toBe("");
    expect(text(scr, 2)).toBe(" Scale & Insights v2.1");
    for (let y = 0; y < 20; y++) expect(text(scr, y)).not.toMatch(/PORTS/);
    expect(end).toBeGreaterThanOrEqual(2);
    expect(end).toBeLessThanOrEqual(r.y + r.h - 1);
    for (let y = end + 1; y < 20; y++) expect(text(scr, y)).toBe("");
  });

  it("draws the SESSIONS body on the sessions tab, focused when the right column has focus", () => {
    const scr = new Screen(47, 20);
    drawTabsBody(scr, r, model({ focus: "right", rightTab: "sessions" }), 8);
    expect(text(scr, 0)).toMatch(/^ PHASES {2}▐SESSIONS▌ /);
    expect(text(scr, 2)).toMatch(/csm p8 plan/);
    expect(cellAt(scr, 0, 2)).toMatchObject({ ch: "▸", bold: true });
  });

  it("never returns an end past the rect, even for a body taller than the rect", () => {
    for (const h of [1, 2, 3, 5]) {
      const scr = new Screen(47, 20);
      const { end } = drawTabsBody(scr, { x: 0, y: 4, w: 47, h }, model({ focus: "right" }), 30);
      expect(end).toBeLessThanOrEqual(4 + h - 1);
      for (let y = 4 + h; y < 20; y++) expect(text(scr, y)).toBe("");
    }
  });
});

describe("drawBand (S2: PHASES|SESSIONS left, PORTS right; LAYOUT-04)", () => {
  const BAND: Band = { leftW: 47, divX: 49, rightX: 52, rightW: 48 };
  const R: Rect = { x: 0, y: 20, w: 100, h: 12 };
  const UIS: ReadonlyArray<Partial<UiState>> = [
    {},
    { rightTab: "sessions" },
    { focus: "right" },
    { focus: "right", rightTab: "sessions" },
    { focus: "ports" },
    { focus: "ports", rightTab: "sessions" },
  ];

  function band(ui: Partial<UiState>, r = R) {
    const scr = new Screen(100, 40);
    const out = drawBand(scr, r, BAND, model(ui));
    return { scr, ...out };
  }

  it("puts the tabs row and the PORTS title on the same row", () => {
    for (const ui of UIS) {
      const { scr } = band(ui);
      expect(text(scr, 20, 0, 47)).toMatch(/PHASES/);
      expect(text(scr, 20, 0, 47)).toMatch(/SESSIONS/);
      expect(text(scr, 20, 52, 100)).toMatch(/^[ ▐]PORTS\b/);
    }
  });

  it("draws the │ divider at divX on the band rows only, and nothing else in the gutter", () => {
    for (const ui of UIS) {
      const { scr, end } = band(ui);
      expect(end).toBeGreaterThanOrEqual(20);
      expect(end).toBeLessThanOrEqual(31);
      for (let y = 0; y < 40; y++) {
        const inBand = y >= 20 && y <= end;
        expect(cellAt(scr, 49, y).ch, `row ${y}`).toBe(inBand ? "│" : " ");
        if (inBand) expect(cellAt(scr, 49, y).fg).toBe("#3a3936");
        for (const x of [47, 48, 50, 51]) expect(cellAt(scr, x, y).ch, `${x},${y}`).toBe(" ");
      }
    }
  });

  it("keeps each half inside its rect", () => {
    for (const ui of UIS) {
      const { scr } = band(ui);
      for (let y = 0; y < 40; y++) {
        if (y < 20 || y > 31) expect(text(scr, y)).toBe("");
      }
    }
  });

  it("the divider stops at the taller half's last row", () => {
    const { scr, end } = band({}, { x: 0, y: 20, w: 100, h: 18 });
    let last = 20;
    for (let y = 20; y < 38; y++) {
      if (text(scr, y, 0, 47) !== "" || text(scr, y, 52, 100) !== "") last = y;
    }
    expect(end).toBe(last);
    expect(cellAt(scr, 49, end + 1).ch).toBe(" ");
  });

  it("a focused PORTS half shows every port or a ↓ N more row", () => {
    for (const h of [3, 4, 5, 8, 12]) {
      const r: Rect = { x: 0, y: 20, w: 100, h };
      const { scr } = band({ focus: "ports" }, r);
      expect(text(scr, 20, 52, 100).startsWith("▐PORTS▌")).toBe(true);
      const list: string[] = [];
      for (let y = 21; y < 20 + h; y++) list.push(text(scr, y, 52, 100));
      const drawn = list.filter((s) => /(^|\s):\d+/.test(s)).length;
      expect(drawn + arrows(list), `h=${h} ${JSON.stringify(list)}`).toBe(SAMPLE.ports.length);
    }
  });

  it("a focused PHASES half at bandFloor shows a phase marker", () => {
    const h = bandFloor(model({ focus: "right" }));
    const r: Rect = { x: 0, y: 20, w: 100, h };
    const { scr } = band({ focus: "right" }, r);
    expect(text(scr, 20, 0, 47).startsWith("▐PHASES▌")).toBe(true);
    const body: string[] = [];
    for (let y = 22; y < 20 + h; y++) body.push(text(scr, y, 0, 47));
    expect(body.some((s) => /[●◉○]|[↑↓] \d+ more/.test(s)), JSON.stringify(body)).toBe(true);
  });

  it("draws nothing into a 0-row or 0-width rect", () => {
    const scr = new Screen(100, 40);
    expect(drawBand(scr, { x: 0, y: 20, w: 100, h: 0 }, BAND, model({})).end).toBe(19);
    for (let y = 0; y < 40; y++) expect(text(scr, y)).toBe("");
  });
});

describe("bandFloor (the S2 band's focused floor)", () => {
  it("PORTS focused: title + spacer + one port row, + the ↓ row when the list needs more than one row", () => {
    expect(bandFloor(model({ focus: "ports" }, { ports: [SAMPLE.ports[3]!] }))).toBe(3);
    expect(bandFloor(model({ focus: "ports" }, { ports: [] }))).toBe(3);
    expect(bandFloor(model({ focus: "ports" }))).toBe(4);
  });

  it("PHASES focused: tabs + spacer + the header rows + one timeline row (+1 with more than one phase)", () => {
    expect(bandFloor(model({ focus: "right" }))).toBe(2 + PHASES_HEADER_ROWS + 1 + 1);
    const one = [{ ...SAMPLE.projects[0]!, phases: SAMPLE.projects[0]!.phases.slice(0, 1) }];
    expect(bandFloor(model({ focus: "right" }, { projects: one, projectIndex: 0 }))).toBe(2 + PHASES_HEADER_ROWS + 1);
  });

  it("SESSIONS focused, or PHASES with no phases: tabs + spacer + one row", () => {
    expect(bandFloor(model({ focus: "right", rightTab: "sessions" }))).toBe(3);
    const none = [{ ...SAMPLE.projects[0]!, phases: [] }];
    expect(bandFloor(model({ focus: "right" }, { projects: none, projectIndex: 0 }))).toBe(3);
  });

  it("AGENTS focused: tabs + spacer + the 3-row body minimum", () => {
    expect(bandFloor(model({}))).toBe(5);
  });
});
