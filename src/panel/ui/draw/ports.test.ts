import { describe, it, expect } from "vitest";
import { Screen, type Line } from "../screen.js";
import { cellWidth, graphemes } from "../text.js";
import { SAMPLE } from "../sample.js";
import type { PortEntry } from "../models.js";
import { drawPortsPane, visiblePortEntries } from "./ports.js";

// Phase 9 plan 09-08 Task 2: the PORTS pane (D-02, D-06): unfocused owned +
// exposed ports with `+N others`, focused all ports with the cursor and pid,
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
const MAGENTA = "#E86AD9";
const HI = "#f5f3ec";
const DIM = "#85827a";
const DIM2 = "#5c5a54";

// UI-SPEC primary frame rows 27..34, cut to cells 101..174 and right-trimmed.
const FRAME_PORTS = [
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
const RECT = { x: X, y: 27, w: 74, h: 10 };

interface M {
  ports: readonly PortEntry[];
  focused: boolean;
  cursorKey: string | null;
  sample: boolean;
}

function pane(o: Partial<M> = {}, rect = RECT, cols = 175): { scr: Screen; rows: number } {
  const scr = new Screen(cols, 40);
  const rows = drawPortsPane(scr, rect, { ports: SAMPLE.ports, focused: false, cursorKey: null, sample: true, ...o });
  return { scr, rows };
}

function paneText(scr: Screen, r = RECT): string[] {
  const out: string[] = [];
  for (let y = r.y; y < r.y + r.h; y++) out.push(text(scr, y, r.x, r.x + r.w));
  return out;
}

function allSegs(scr: Screen): Line {
  return scr.toLines().flat();
}

describe("visiblePortEntries", () => {
  it("keeps only owned and exposed ports when unfocused", () => {
    const v = visiblePortEntries(SAMPLE.ports, false);
    expect(v.shown.map((p) => p.port)).toEqual([3000, 5173, 27036]);
    expect(v.others).toBe(5);
  });

  it("keeps every port when focused", () => {
    const v = visiblePortEntries(SAMPLE.ports, true);
    expect(v.shown.length).toBe(8);
    expect(v.others).toBe(0);
  });
});

describe("drawPortsPane frame fidelity", () => {
  it("reproduces frame rows 27..34 of the right column", () => {
    const { scr, rows } = pane();
    const got: string[] = [];
    for (let y = 27; y <= 34; y++) got.push(text(scr, y, X, 175));
    expect(got).toEqual(FRAME_PORTS);
    expect(rows).toBe(8);
  });

  it("draws nothing outside the rect", () => {
    const { scr } = pane();
    for (let y = 0; y < 40; y++) {
      expect(text(scr, y, 0, X)).toBe("");
      if (y < 27 || y > 34) expect(text(scr, y)).toBe("");
    }
  });
});

describe("drawPortsPane colors", () => {
  it("styles owned ports hi bold with a dim proc", () => {
    const { scr } = pane();
    expect(cellAt(scr, X + 2, 29)).toMatchObject({ ch: ":", fg: HI, bold: true });
    expect(cellAt(scr, X + 10, 29)).toMatchObject({ ch: "b", fg: DIM });
  });

  it("styles exposed ports red bold (D-06)", () => {
    const { scr } = pane();
    expect(cellAt(scr, X + 2, 33)).toMatchObject({ ch: ":", fg: RED, bold: true });
    expect(cellAt(scr, X + 7, 33)).toMatchObject({ ch: "6", fg: RED, bold: true });
    expect(cellAt(scr, X + 22, 33)).toMatchObject({ ch: "⇡", fg: RED, bold: true });
    expect(cellAt(scr, X + 24, 33)).toMatchObject({ ch: "e", fg: RED, bold: true });
  });

  it("styles the owner line and the others count", () => {
    const { scr } = pane();
    expect(cellAt(scr, X + 4, 30)).toMatchObject({ ch: "↳", fg: DIM });
    expect(cellAt(scr, X + 6, 30)).toMatchObject({ ch: "c", fg: DIM });
    expect(cellAt(scr, X + 2, 34)).toMatchObject({ ch: "+", fg: DIM2 });
  });

  it("never uses magenta in the pane", () => {
    for (const focused of [false, true]) {
      const { scr } = pane({ focused, cursorKey: "27036" });
      for (const s of allSegs(scr)) {
        expect(s.fg).not.toBe(MAGENTA);
        expect(s.bg).not.toBe(MAGENTA);
      }
    }
  });
});

describe("drawPortsPane focused", () => {
  const tall = { x: X, y: 27, w: 74, h: 13 };

  it("draws the focused title with the port count", () => {
    const { scr } = pane({ focused: true, cursorKey: "3000" }, tall);
    const t = text(scr, 27, X, 175);
    expect(t.startsWith("▐PORTS▌ sample ")).toBe(true);
    expect(t.endsWith(" 8 ports")).toBe(true);
    expect(cellAt(scr, 174, 27).ch).toBe("s");
  });

  it("draws the cursor and the right-aligned pid", () => {
    const { scr } = pane({ focused: true, cursorKey: "3000" }, tall);
    expect(cellAt(scr, X, 29)).toMatchObject({ ch: "❯", fg: HI, bold: true });
    expect(text(scr, 29, X, 175)).toMatch(/^❯ :3000 {3}bun +pid 41822$/);
    expect(cellAt(scr, 166, 29)).toMatchObject({ ch: "p", fg: DIM2 });
    expect(cellAt(scr, 174, 29)).toMatchObject({ ch: "2", fg: DIM2 });
  });

  it("lists all 8 ports with no others line", () => {
    const { scr, rows } = pane({ focused: true, cursorKey: "3000" }, tall);
    const all = paneText(scr, tall);
    const ports = all.filter((l) => /^. :\d+/.test(l)).map((l) => Number(/:(\d+)/.exec(l)![1]));
    expect(ports).toEqual(SAMPLE.ports.map((p) => p.port));
    expect(all.some((l) => l.includes("others"))).toBe(false);
    expect(rows).toBe(12);
  });

  it("finds the cursor by key, not index", () => {
    const { scr } = pane({ focused: true, cursorKey: "9277" }, tall);
    const cur = paneText(scr, tall).find((l) => l.startsWith("❯"));
    expect(cur).toMatch(/^❯ :9277 /);
  });

  it("windows a short pane and counts the hidden ports", () => {
    const short = { x: X, y: 27, w: 74, h: 8 };
    const { scr, rows } = pane({ focused: true, cursorKey: "3000" }, short);
    expect(rows).toBeLessThanOrEqual(8);
    for (let y = 35; y < 40; y++) expect(text(scr, y)).toBe("");
    const all = paneText(scr, short);
    const shown = all.filter((l) => /^. :\d+/.test(l)).length;
    const down = Number(/↓ (\d+) more/.exec(all.find((l) => l.includes("↓")) ?? "")?.[1]);
    expect(shown + down).toBe(8);
  });

  it("keeps a late cursor visible with an up count", () => {
    const short = { x: X, y: 27, w: 74, h: 8 };
    const { scr } = pane({ focused: true, cursorKey: "57152" }, short);
    const all = paneText(scr, short);
    expect(all.some((l) => l.startsWith("❯ :57152"))).toBe(true);
    expect(all.some((l) => /↑ \d+ more/.test(l))).toBe(true);
  });
});

describe("drawPortsPane narrow", () => {
  it("drops pid below 64 cells", () => {
    const r = { x: X, y: 27, w: 50, h: 13 };
    const { scr } = pane({ focused: true, cursorKey: "27036" }, r);
    const all = paneText(scr, r);
    expect(all.some((l) => l.includes("pid"))).toBe(false);
    expect(all.some((l) => l.includes("steam_osx"))).toBe(true);
    expect(all.some((l) => l.startsWith("❯ :27036") && l.includes("⇡ exposed"))).toBe(true);
  });

  it("drops proc too at 30 cells and keeps port, exposed and cursor", () => {
    const r = { x: X, y: 27, w: 30, h: 13 };
    const { scr } = pane({ focused: true, cursorKey: "27036" }, r);
    const all = paneText(scr, r);
    expect(all.some((l) => l.includes("steam_osx") || l.includes("bun") || l.includes("vite"))).toBe(false);
    expect(all.some((l) => l.startsWith("❯ :27036") && l.includes("⇡ exposed"))).toBe(true);
  });

  it.each([20, 30, 40, 50, 63, 74])("keeps every row inside w=%i", (w) => {
    const r = { x: X, y: 27, w, h: 13 };
    for (const focused of [false, true]) {
      const { scr } = pane({ focused, cursorKey: "27036" }, r, 230);
      for (let y = 0; y < 40; y++) {
        expect(text(scr, y, 0, X)).toBe("");
        expect(text(scr, y, X + w)).toBe("");
      }
    }
  });
});

describe("drawPortsPane empty and sanitize", () => {
  it("shows no listening ports", () => {
    const { scr, rows } = pane({ ports: [] });
    expect(text(scr, 29, X, 175)).toBe("  no listening ports");
    expect(cellAt(scr, X + 2, 29)).toMatchObject({ fg: DIM });
    expect(rows).toBe(3);
  });

  it("strips control bytes from proc and owner", () => {
    const evil: PortEntry[] = [
      { key: "1", port: 1, proc: "p\u001b[2J\u0007x", pid: 1, exposed: true, owner: "o\u001b]0;t\u0007wn" },
    ];
    for (const focused of [false, true]) {
      const { scr } = pane({ ports: evil, focused, cursorKey: "1" });
      for (const l of paneText(scr)) expect(l).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
  });
});

describe("drawPortsPane has no Phase 11-12 rows", () => {
  const cases: Array<Partial<M>> = [
    { focused: false },
    { focused: true, cursorKey: "3000" },
    { focused: true, cursorKey: "27036" },
    { focused: true, cursorKey: "missing" },
    { focused: true, cursorKey: null },
  ];
  it.each(cases)("never draws the menu, confirm or name field (%o)", (o) => {
    const tall = { x: X, y: 27, w: 74, h: 13 };
    const { scr } = pane(o, tall);
    const body = paneText(scr, tall).slice(1);
    for (const l of body) {
      expect(l).not.toContain("go to");
      expect(l).not.toContain("stop?");
      expect(l).not.toContain("cancel");
      expect(l).not.toMatch(/▌ name/);
      expect(l).not.toContain("▌");
    }
  });
});
