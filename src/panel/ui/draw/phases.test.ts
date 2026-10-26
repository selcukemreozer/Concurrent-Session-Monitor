import { describe, it, expect } from "vitest";
import { Screen, type Line } from "../screen.js";
import { cellWidth, graphemes } from "../text.js";
import { SAMPLE } from "../sample.js";
import type { PhaseEntry, Project } from "../models.js";
import { drawPhases } from "./phases.js";

// Phase 9 plan 09-08 Task 1: the PHASES pane (D-02): project header, progress
// bar and the windowed timeline, reproduced cell-exactly from the approved
// 175x55 frame rows 4-18 (right column, RX = 101, RW = 74).

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

const GREEN = "#5FD47A";
const HI = "#f5f3ec";
const DIM = "#85827a";
const DIM2 = "#5c5a54";
const EDGE = "#3a3936";

// UI-SPEC primary frame rows 4..18, cut to cells 101..174 and right-trimmed.
const FRAME_PHASES = [
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
];

const RECT = { x: 101, y: 4, w: 74, h: 20 };

function pane(
  o: Partial<{ projects: readonly Project[]; projectIndex: number; focused: boolean; cursor: number | null }> = {},
  rect = RECT,
): { scr: Screen; rows: number } {
  const scr = new Screen(175, 40);
  const rows = drawPhases(scr, rect, {
    projects: SAMPLE.projects,
    projectIndex: 1,
    focused: false,
    cursor: null,
    ...o,
  });
  return { scr, rows };
}

/** n phases with the current one at `cur` (plans k/n on the current phase). */
function project(n: number, cur: number, plans: [number, number] = [1, 2]): Project {
  const phases: PhaseEntry[] = [];
  for (let i = 0; i < n; i++) {
    phases.push({
      number: String(i + 1),
      name: `phase ${i + 1}`,
      status: i < cur ? "done" : i === cur ? "current" : "pending",
      plansDone: i === cur ? plans[0] : null,
      plansTotal: i === cur ? plans[1] : null,
    });
  }
  return { name: "proj", dir: "dir", phases };
}

/** All rows of the pane cut to the rect. */
function paneText(scr: Screen, r = RECT): string[] {
  const out: string[] = [];
  for (let y = r.y; y < r.y + r.h; y++) out.push(text(scr, y, r.x, r.x + r.w));
  return out;
}

describe("drawPhases frame fidelity", () => {
  it("reproduces frame rows 4..18 of the right column", () => {
    const { scr, rows } = pane();
    const got: string[] = [];
    for (let y = 4; y <= 18; y++) got.push(text(scr, y, 101, 175));
    expect(got).toEqual(FRAME_PHASES);
    expect(rows).toBe(15);
  });

  it("draws nothing outside the rect", () => {
    const { scr } = pane();
    for (let y = 0; y < 40; y++) {
      expect(text(scr, y, 0, 101)).toBe("");
      if (y < 4 || y > 18) expect(text(scr, y)).toBe("");
    }
  });
});

describe("drawPhases colors", () => {
  it("styles the done markers and their connectors green", () => {
    const { scr } = pane();
    expect(cellAt(scr, 103, 8)).toMatchObject({ ch: "●", fg: GREEN });
    expect(cellAt(scr, 103, 10)).toMatchObject({ ch: "●", fg: GREEN });
    expect(cellAt(scr, 103, 9)).toMatchObject({ ch: "│", fg: GREEN });
    expect(cellAt(scr, 103, 11)).toMatchObject({ ch: "│", fg: GREEN });
  });

  it("styles the current marker and name hi bold", () => {
    const { scr } = pane();
    expect(cellAt(scr, 103, 12)).toMatchObject({ ch: "◉", fg: HI, bold: true });
    expect(cellAt(scr, 112, 12)).toMatchObject({ ch: "c", fg: HI, bold: true });
    expect(cellAt(scr, 106, 12)).toMatchObject({ ch: "3", fg: HI, bold: true });
  });

  it("styles done names dim2, pending markers dim2 and pending names dim", () => {
    const { scr } = pane();
    expect(cellAt(scr, 112, 8)).toMatchObject({ ch: "a", fg: DIM2 });
    expect(cellAt(scr, 112, 8).bold).toBeUndefined();
    expect(cellAt(scr, 103, 15)).toMatchObject({ ch: "○", fg: DIM2 });
    expect(cellAt(scr, 112, 15)).toMatchObject({ ch: "v", fg: DIM });
  });

  it("styles the connectors after the current phase in edge", () => {
    const { scr } = pane();
    for (const y of [13, 14, 16]) expect(cellAt(scr, 103, y)).toMatchObject({ ch: "│", fg: EDGE });
  });

  it("styles the project header and the bar", () => {
    const { scr } = pane();
    expect(cellAt(scr, 102, 4)).toMatchObject({ ch: "S", fg: HI, bold: true });
    expect(cellAt(scr, 102, 5)).toMatchObject({ ch: "m", fg: DIM });
    // round(2/12 * 64) = 11 green cells, then edge
    for (let x = 102; x < 102 + 11; x++) expect(cellAt(scr, x, 6)).toMatchObject({ ch: "━", fg: GREEN });
    for (let x = 113; x < 102 + 64; x++) expect(cellAt(scr, x, 6)).toMatchObject({ ch: "━", fg: EDGE });
    expect(cellAt(scr, 168, 6)).toMatchObject({ ch: "2", fg: DIM });
    expect(text(scr, 6, 168, 175)).toBe("2/12");
  });

  it("draws the plan mini-bar as 3 green and 4 edge cells", () => {
    const { scr } = pane();
    expect(cellAt(scr, 112, 13)).toMatchObject({ ch: "3", fg: DIM });
    for (let x = 122; x < 125; x++) expect(cellAt(scr, x, 13)).toMatchObject({ ch: "━", fg: GREEN });
    for (let x = 125; x < 129; x++) expect(cellAt(scr, x, 13)).toMatchObject({ ch: "━", fg: EDGE });
    expect(cellAt(scr, 129, 13).ch).toBe(" ");
  });

  it("draws the more line dim", () => {
    const { scr } = pane();
    expect(cellAt(scr, 103, 18)).toMatchObject({ ch: "⋮", fg: DIM });
    expect(cellAt(scr, 106, 18)).toMatchObject({ ch: "7", fg: DIM });
  });
});

describe("drawPhases focused", () => {
  it("lists the phases from the cursor with the cursor, hint and down count", () => {
    const { scr, rows } = pane({ focused: true, cursor: 0 });
    expect(rows).toBeLessThanOrEqual(RECT.h);
    expect(cellAt(scr, 101, 8)).toMatchObject({ ch: "❯", fg: HI, bold: true });
    expect(text(scr, 8, 101, 175)).toBe("❯ ●  31    auth flow");
    // cursor row name is hi bold even though the phase is done
    expect(cellAt(scr, 112, 8)).toMatchObject({ fg: HI, bold: true });
    expect(cellAt(scr, 170, 4)).toMatchObject({ ch: "←", fg: DIM });
    expect(text(scr, 4, 170, 175)).toBe("← →");
    // the window is cut: the last used row reads "↓ N more" and N counts hidden phases
    const all = paneText(scr);
    const down = all.find((l) => l.includes("↓"));
    expect(down).toBeDefined();
    const n = Number(/↓ (\d+) more/.exec(down!)?.[1]);
    const shown = all.filter((l) => /^. [●◉○] /.test(l)).length;
    expect(shown + n).toBe(12);
    expect(all.some((l) => l.includes("↑"))).toBe(false);
  });

  it("shows every phase number once across the window when it fits", () => {
    const r = { x: 101, y: 4, w: 74, h: 36 };
    const { scr } = pane({ focused: true, cursor: 0 }, r);
    const all = paneText(scr, r);
    const nums = all.filter((l) => /^. [●◉○] /.test(l)).map((l) => l.slice(5, 10).trim());
    expect(nums).toEqual(SAMPLE.projects[1]!.phases.map((p) => p.number));
    expect(all.some((l) => l.includes("more"))).toBe(false);
  });

  it("keeps a cursor near the end visible with an up count", () => {
    const { scr } = pane({ focused: true, cursor: 11 });
    const all = paneText(scr);
    const cur = all.find((l) => l.startsWith("❯"));
    expect(cur).toContain("research agent");
    const up = all.find((l) => l.includes("↑"));
    const n = Number(/↑ (\d+) more/.exec(up!)?.[1]);
    const shown = all.filter((l) => /^. [●◉○] /.test(l)).length;
    expect(n + shown).toBe(12);
  });

  it("defaults the cursor to the current phase", () => {
    const { scr } = pane({ focused: true, cursor: null });
    const cur = paneText(scr).find((l) => l.startsWith("❯"));
    expect(cur).toContain("ci pipeline monitoring");
  });

  it("omits the project hint with a single project", () => {
    const { scr } = pane({ focused: true, projects: [SAMPLE.projects[1]!], projectIndex: 0 });
    expect(text(scr, 4, 101, 175)).toBe(" Scale & Insights v2.1");
    expect(text(scr, 5, 101, 175)).toBe(" mvp-dash · project 1/1");
  });

  it("omits the project hint when unfocused", () => {
    const { scr } = pane();
    expect(text(scr, 4, 160, 175)).toBe("");
  });
});

describe("drawPhases window ends", () => {
  it("shows earlier and more lines around a middle current phase", () => {
    const { scr } = pane({ projects: [project(20, 10)], projectIndex: 0 });
    const all = paneText(scr);
    expect(all).toContain("  ⋮  8 earlier phases");
    expect(all).toContain("  ⋮  7 more phases");
    expect(all.filter((l) => /^ {2}[●◉○] /.test(l)).length).toBe(5);
  });

  it("shows no earlier line when the current phase is the first", () => {
    const { scr } = pane({ projects: [project(10, 0)], projectIndex: 0 });
    const all = paneText(scr);
    expect(all.some((l) => l.includes("earlier"))).toBe(false);
    expect(all).toContain("  ⋮  7 more phases");
  });

  it("shows no more line when the window reaches the last phase", () => {
    const { scr } = pane({ projects: [project(5, 4)], projectIndex: 0 });
    const all = paneText(scr);
    expect(all).toContain("  ⋮  2 earlier phases");
    expect(all.some((l) => l.includes("more phases"))).toBe(false);
  });

  it("shrinks the window to fit a short rect", () => {
    const r = { x: 101, y: 4, w: 74, h: 9 };
    const { scr, rows } = pane({}, r);
    expect(rows).toBeLessThanOrEqual(9);
    for (let y = 4 + 9; y < 40; y++) expect(text(scr, y)).toBe("");
    const all = paneText(scr, r);
    expect(all.some((l) => l.includes("ci pipeline monitoring"))).toBe(true);
  });
});

describe("drawPhases mini-bar scaling", () => {
  it("scales a 30-plan current phase to at most 12 cells", () => {
    const { scr } = pane({ projects: [project(3, 1, [15, 30])], projectIndex: 0 });
    const all = paneText(scr);
    const plan = all.find((l) => l.includes("15/30 plan"));
    expect(plan).toBeDefined();
    const bar = [...plan!].filter((c) => c === "━").length;
    expect(bar).toBeLessThanOrEqual(12);
    expect(bar).toBeGreaterThan(0);
  });
});

describe("drawPhases empty", () => {
  it("shows no GSD projects with no projects", () => {
    const { scr, rows } = pane({ projects: [], projectIndex: 0 });
    expect(text(scr, 4, 101, 175)).toBe(" no GSD projects");
    expect(cellAt(scr, 102, 4)).toMatchObject({ fg: DIM });
    expect(rows).toBe(1);
  });

  it("shows no roadmap for a project without phases", () => {
    const { scr } = pane({ projects: [{ name: "bare", dir: "x", phases: [] }], projectIndex: 0 });
    const all = paneText(scr);
    expect(all).toContain(" no roadmap");
    expect(all[0]).toBe(" bare");
  });
});

describe("drawPhases width and sanitize", () => {
  it.each([20, 30, 40, 74])("keeps every row inside w=%i", (w) => {
    const r = { x: 101, y: 4, w, h: 30 };
    const scr = new Screen(101 + w + 20, 40);
    drawPhases(scr, r, { projects: SAMPLE.projects, projectIndex: 1, focused: true, cursor: 2 });
    for (let y = 0; y < 40; y++) {
      expect(text(scr, y, 0, 101)).toBe("");
      expect(text(scr, y, 101 + w)).toBe("");
    }
  });

  it("strips control bytes from project and phase names", () => {
    const p: Project = {
      name: "evil\u001b[31mname\u0007",
      dir: "d\u001b]0;x\u0007ir",
      phases: [{ number: "1\u001b", name: "ph\u0007ase", status: "current", plansDone: 0, plansTotal: 1 }],
    };
    const { scr } = pane({ projects: [p], projectIndex: 0 });
    for (const l of paneText(scr)) {
      expect(l).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
  });
});

describe("drawPhases: a short focused rect keeps phase rows (Phase 10 plan 10-01, WR-09)", () => {
  it.each([2, 3, 4, 5])("WR-09 focused h=%i: the project name, then timeline rows with the current phase", (h) => {
    const r = { x: 101, y: 4, w: 74, h };
    const { scr, rows } = pane({ focused: true, cursor: null }, r);
    const all = paneText(scr, r);
    expect(rows).toBeLessThanOrEqual(h);
    expect(all[0]).toMatch(/^ Scale & Insights v2\.1 +← →$/);
    // no dir row, no progress bar
    expect(all.some((l) => l.includes("project 2/2") || l.includes("━━━━━━━━━━"))).toBe(false);
    const body = all.slice(1);
    expect(body.some((l) => /[●◉○]|[↑↓] \d+ more/.test(l))).toBe(true);
    expect(body.some((l) => l.includes("ci pipeline monitoring"))).toBe(true);
    for (let y = r.y + h; y < 40; y++) expect(text(scr, y)).toBe("");
  });

  it("WR-09 focused h=6 keeps the full 4-row header and a timeline row + ↓", () => {
    const r = { x: 101, y: 4, w: 74, h: 6 };
    const { scr } = pane({ focused: true, cursor: null }, r);
    const all = paneText(scr, r);
    expect(all[1]).toBe(" mvp-dash · project 2/2");
    expect(all[2]).toContain("2/12");
    expect(all.slice(4).some((l) => /[●◉○]|[↑↓] \d+ more/.test(l))).toBe(true);
  });

  it("an unfocused short rect keeps the 4-row header (no compact mode)", () => {
    const r = { x: 101, y: 4, w: 74, h: 4 };
    const { scr } = pane({ focused: false }, r);
    expect(paneText(scr, r)[1]).toBe(" mvp-dash · project 2/2");
  });
});
