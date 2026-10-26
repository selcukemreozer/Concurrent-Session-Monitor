import { describe, it, expect } from "vitest";
import { Screen, type Line } from "../screen.js";
import { cellWidth, graphemes } from "../text.js";
import { SAMPLE } from "../sample.js";
import type { FileConflict, FileGroup } from "../models.js";
import { countFiles, drawFilesPane, tickerRows } from "./files.js";

// Phase 9 plan 09-07 Task 2: the FILES pane (D-02): conflict rows first, then
// the agent-grouped ticker with the wrap separator and the scrollbar,
// reproduced cell-exactly from the approved 175x55 frame rows 27-34.

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

const RED = "#F0545A";
const RED_BG = "#3a1a1b";
const HI = "#f5f3ec";
const FG = "#d6d3cb";
const DIM2 = "#5c5a54";
const BLUE = "#6FA8FF";

// UI-SPEC primary frame rows 27..34 (the FILES pane), cut to cells 0..95.
const FRAME_FILES = [
  " FILES  sample  " + "─".repeat(71) + " 14 files",
  "▌ ! dashboard research ✕ checkout screen   src/server.js",
  "  ■ dashboard research    src/lib/metrics.ts".padEnd(95) + "│",
  "                          src/pages/Overview.tsx".padEnd(95) + "│",
  "    ┄┄ back to top ┄┄".padEnd(95) + "│",
  "  ■ csm p8 plan           .planning/ROADMAP.md".padEnd(95) + "┃",
  "                          .planning/phase-8.md".padEnd(95) + "┃",
  "                          .planning/phase-9.md".padEnd(95) + "┃",
];

const M = { conflicts: SAMPLE.conflicts, groups: SAMPLE.groups, paused: false, step: 11, sample: true };
const RECT = { x: 0, y: 27, w: 96, h: 8 };

function pane(o: Partial<typeof M> = {}, rect = RECT): { scr: Screen; rows: number } {
  const scr = new Screen(175, 40);
  const rows = drawFilesPane(scr, rect, { ...M, ...o });
  return { scr, rows };
}

const w = (path: string) => ({ path, kind: "write" as const });
const r = (path: string) => ({ path, kind: "read" as const });

describe("countFiles", () => {
  it("counts unique paths, conflict paths included", () => {
    expect(countFiles(SAMPLE.conflicts, SAMPLE.groups)).toBe(14);
  });

  it("does not double-count a path shared by two groups", () => {
    const g: FileGroup[] = [
      { agentId: "a", name: "a", state: "running", files: [w("x.ts")] },
      { agentId: "b", name: "b", state: "running", files: [r("x.ts"), r("y.ts")] },
    ];
    expect(countFiles([{ a: "a", b: "b", path: "x.ts" }], g)).toBe(2);
    expect(countFiles([], [])).toBe(0);
  });
});

describe("tickerRows", () => {
  const rows = tickerRows(SAMPLE.groups);

  it("has one row per file", () => {
    expect(rows).toHaveLength(13);
  });

  it("marks exactly the first row of each group", () => {
    const firsts = rows.filter((x) => x.first);
    expect(firsts.map((x) => x.group.name)).toEqual(SAMPLE.groups.map((g) => g.name));
    for (const g of SAMPLE.groups) {
      const mine = rows.filter((x) => x.group === g);
      expect(mine[0]?.first).toBe(true);
      expect(mine.slice(1).every((x) => !x.first)).toBe(true);
    }
  });

  it("puts writes before reads inside a group", () => {
    const g: FileGroup = {
      agentId: "a",
      name: "a",
      state: "running",
      files: [r("r1"), w("w1"), r("r2"), w("w2")],
    };
    expect(tickerRows([g]).map((x) => x.file.path)).toEqual(["w1", "w2", "r1", "r2"]);
  });
});

describe("drawFilesPane: frame fidelity (175x55, rows 27..34, step 11)", () => {
  const { scr, rows } = pane();

  it("reproduces the approved frame rows exactly", () => {
    for (let i = 0; i < FRAME_FILES.length; i++) {
      expect(text(scr, 27 + i, 0, 96)).toBe(FRAME_FILES[i]);
    }
  });

  it("returns 8 rows and draws nothing outside the rect", () => {
    expect(rows).toBe(8);
    for (let y = 0; y < 40; y++) {
      if (y < 27 || y > 34) expect(text(scr, y)).toBe("");
      expect(text(scr, y, 96)).toBe("");
    }
  });

  it("draws the scrollbar thumb dim and the track edge", () => {
    for (let y = 29; y <= 31; y++) expect(cellAt(scr, 95, y)).toMatchObject({ ch: "│", fg: "#3a3936" });
    for (let y = 32; y <= 34; y++) expect(cellAt(scr, 95, y)).toMatchObject({ ch: "┃", fg: "#85827a" });
    expect(cellAt(scr, 95, 28).ch).toBe(" ");
  });

  it("draws the separator in dim2 at x4", () => {
    expect(cellAt(scr, 4, 31)).toMatchObject({ ch: "┄", fg: DIM2 });
    expect(cellAt(scr, 7, 31)).toMatchObject({ ch: "b", fg: DIM2 });
  });
});

describe("drawFilesPane: conflict row styling", () => {
  const { scr } = pane();

  it("fills the whole row with the red background", () => {
    for (let x = 0; x < 96; x++) expect(cellAt(scr, x, 28).bg).toBe(RED_BG);
    expect(cellAt(scr, 96, 28).bg).toBeUndefined();
  });

  it("styles the marker, the names, the join and the path", () => {
    expect(cellAt(scr, 0, 28)).toMatchObject({ ch: "▌", fg: RED });
    expect(cellAt(scr, 2, 28)).toMatchObject({ ch: "!", fg: RED, bold: true });
    expect(cellAt(scr, 4, 28)).toMatchObject({ ch: "d", fg: HI, bold: true });
    expect(cellAt(scr, 23, 28)).toMatchObject({ ch: "✕", fg: RED, bold: true });
    expect(cellAt(scr, 25, 28)).toMatchObject({ ch: "c", fg: HI, bold: true });
    expect(cellAt(scr, 43, 28)).toMatchObject({ ch: "s", fg: HI });
    expect(cellAt(scr, 43, 28).bold).toBeUndefined();
  });

  it("puts the path at x26 when the names are short", () => {
    const { scr: s } = pane({ conflicts: [{ a: "a", b: "b", path: "p.ts" }] });
    expect(text(s, 28)).toBe("▌ ! a ✕ b".padEnd(26) + "p.ts");
  });
});

describe("drawFilesPane: ticker styling", () => {
  it("draws a write row with the pencil at x26 and the path at x28", () => {
    const { scr } = pane({ step: 3 });
    expect(text(scr, 29, 0, 95)).toBe("  ■ api refactor          ✎ src/routes/cart.js");
    expect(cellAt(scr, 2, 29)).toMatchObject({ ch: "■", fg: "#F2B33D" });
    expect(cellAt(scr, 4, 29)).toMatchObject({ ch: "a", fg: HI, bold: true });
    expect(cellAt(scr, 26, 29)).toMatchObject({ ch: "✎", fg: FG });
    expect(cellAt(scr, 28, 29)).toMatchObject({ ch: "s", fg: FG });
  });

  it("draws a read row with the path in blue at x26", () => {
    const { scr } = pane({ step: 0 });
    expect(cellAt(scr, 26, 29)).toMatchObject({ ch: ".", fg: BLUE });
    expect(cellAt(scr, 2, 29)).toMatchObject({ ch: "■", fg: "#E86AD9" });
  });

  it("repeats a group split at the window top in dim2", () => {
    const { scr } = pane();
    expect(cellAt(scr, 2, 29)).toMatchObject({ ch: "■", fg: DIM2 });
    expect(cellAt(scr, 4, 29)).toMatchObject({ ch: "d", fg: DIM2 });
    expect(cellAt(scr, 4, 29).bold).toBeUndefined();
    expect(cellAt(scr, 2, 32)).toMatchObject({ ch: "■", fg: "#E86AD9" });
  });

  it("colors an idle group's square with the idle color", () => {
    const g: FileGroup[] = [{ agentId: "z", name: "zz", state: "idle", files: [w("a.ts")] }];
    const { scr } = pane({ conflicts: [], groups: g });
    expect(cellAt(scr, 2, 28)).toMatchObject({ ch: "■", fg: "#4a4945" });
  });
});

describe("drawFilesPane: ticker wrap and pause", () => {
  it("wraps: step 25 (11 + 14) draws the same rows as step 11", () => {
    const a = pane({ step: 11 }).scr;
    const b = pane({ step: 25 }).scr;
    for (let y = 27; y <= 34; y++) expect(rowOf(b, y)).toEqual(rowOf(a, y));
  });

  it("handles a negative step", () => {
    const a = pane({ step: 11 }).scr;
    const b = pane({ step: 11 - 14 }).scr;
    for (let y = 27; y <= 34; y++) expect(rowOf(b, y)).toEqual(rowOf(a, y));
  });

  it("shows paused in the title right info", () => {
    const { scr } = pane({ paused: true });
    expect(text(scr, 27, 0, 96).endsWith("─ paused · 14 files")).toBe(true);
  });
});

describe("drawFilesPane: conflict overflow", () => {
  const five: FileConflict[] = Array.from({ length: 5 }, (_, i) => ({ a: `a${i}`, b: `b${i}`, path: `p${i}.ts` }));

  it("draws at most 3 conflict rows, the 3rd as +N more", () => {
    const { scr } = pane({ conflicts: five }, { x: 0, y: 27, w: 96, h: 10 });
    expect(text(scr, 28)).toContain("! a0 ✕ b0");
    expect(text(scr, 29)).toContain("! a1 ✕ b1");
    expect(text(scr, 30)).toBe("▌ ! +3 more conflicts");
    for (const y of [28, 29, 30]) expect(cellAt(scr, 0, y).bg).toBe(RED_BG);
    expect(cellAt(scr, 0, 31).bg).toBeUndefined();
    expect(cellAt(scr, 2, 30)).toMatchObject({ ch: "!", fg: RED, bold: true });
    for (let y = 27; y < 40; y++) expect(text(scr, y)).not.toContain("a2");
  });

  it("WR-05 h=3 (2 conflict rows): row 2 reads +4 more conflicts, so drawn + N = 5", () => {
    const { scr } = pane({ conflicts: five }, { x: 0, y: 27, w: 96, h: 3 });
    expect(text(scr, 28)).toContain("! a0 ✕ b0");
    expect(text(scr, 29)).toBe("▌ ! +4 more conflicts");
    for (let y = 27; y < 40; y++) expect(text(scr, y)).not.toContain("a1");
  });

  it("WR-05 h=2 (1 conflict row): the only conflict row reads +5 more conflicts", () => {
    const { scr } = pane({ conflicts: five }, { x: 0, y: 27, w: 96, h: 2 });
    expect(text(scr, 28)).toBe("▌ ! +5 more conflicts");
  });

  it.each([2, 3, 4, 5, 8])("WR-05 h=%i: drawn conflicts + N in +N more conflicts = 5", (h) => {
    const { scr } = pane({ conflicts: five }, { x: 0, y: 27, w: 96, h });
    let drawn = 0;
    let more = 0;
    for (let y = 28; y < 27 + h; y++) {
      const t = text(scr, y);
      const m = /\+(\d+) more conflicts/.exec(t);
      if (m) more += Number(m[1]);
      else if (/! a\d ✕ b\d/.test(t)) drawn++;
    }
    expect(drawn + more).toBe(5);
  });
});

describe("drawFilesPane: no ticker and empty", () => {
  const four: FileGroup[] = [
    { agentId: "a", name: "one", state: "running", files: [w("a.ts"), r("b.ts")] },
    { agentId: "b", name: "two", state: "waiting", files: [w("c.ts"), r("d.ts")] },
  ];

  it("draws a short list without separator or scrollbar", () => {
    const { scr, rows } = pane({ groups: four });
    expect(rows).toBe(1 + 1 + 4);
    for (let y = 27; y < 40; y++) expect(text(scr, y)).not.toContain("back to top");
    // below the title (whose right info ends at x95) the scrollbar column stays blank
    for (let y = 28; y < 40; y++) expect(cellAt(scr, 95, y).ch).toBe(" ");
    expect(text(scr, 29)).toBe("  ■ one".padEnd(26) + "✎ a.ts");
    expect(text(scr, 30)).toBe("".padEnd(26) + "b.ts");
  });

  it("never shows paused when nothing scrolls", () => {
    const { scr } = pane({ groups: four, paused: true });
    expect(text(scr, 27, 0, 96)).not.toContain("paused");
  });

  it("shows no files and returns 1 when empty", () => {
    const { scr, rows } = pane({ conflicts: [], groups: [] });
    expect(rows).toBe(1);
    expect(text(scr, 27, 0, 96).endsWith("─ no files")).toBe(true);
    for (let y = 28; y < 40; y++) expect(text(scr, y)).toBe("");
  });
});

describe("drawFilesPane: paths and widths", () => {
  const long = "src/very/deep/folder/structure/that/keeps/going/and/going/forever/ui/components/Checkout.jsx";

  it("start-truncates a long path and keeps the scrollbar column free", () => {
    const g: FileGroup[] = [{ agentId: "a", name: "a", state: "running", files: [w(long), r(long + "x")] }];
    const { scr } = pane({ conflicts: [{ a: "a", b: "b", path: long }], groups: g });
    const row = text(scr, 29, 0, 96);
    expect(row.endsWith("/Checkout.jsx")).toBe(true);
    expect(cellAt(scr, 28, 29).ch).toBe("…");
    expect(cellAt(scr, 94, 29).ch).toBe("x");
    expect(cellAt(scr, 95, 29).ch).toBe(" ");
    expect(text(scr, 28, 0, 96).endsWith("/Checkout.jsx")).toBe(true);
    expect(cellAt(scr, 95, 28).ch).toBe(" ");
  });

  it("keeps every row inside the rect width", () => {
    const g: FileGroup[] = [
      { agentId: "a", name: "x".repeat(40), state: "running", files: [w(long), r(long)] },
    ];
    const c: FileConflict[] = [{ a: "y".repeat(40), b: "z".repeat(40), path: long }];
    for (const width of [40, 60, 96]) {
      const scr = new Screen(175, 40);
      drawFilesPane(scr, { x: 0, y: 0, w: width, h: 8 }, { ...M, conflicts: c, groups: [...SAMPLE.groups, ...g] });
      for (let y = 0; y < 40; y++) expect(text(scr, y, width)).toBe("");
    }
  });
});
