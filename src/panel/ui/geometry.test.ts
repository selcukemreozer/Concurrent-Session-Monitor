import { describe, it, expect } from "vitest";
import {
  geometry,
  MIN_COLS,
  MIN_ROWS,
  CARD_W,
  CARD_H,
  CARD_PITCH_X,
  CARD_PITCH_Y,
  RW_MIN,
  RW_MAX,
} from "./geometry.js";

// Phase 9 plan 09-03 Task 1: every UI-SPEC § Layout & Breakpoints breakpoint
// as one pure call (D-27 narrow widths + too-small, D-28 175x55 primary).
describe("geometry constants", () => {
  it("match the UI-SPEC card and threshold numbers", () => {
    expect(MIN_COLS).toBe(60);
    expect(MIN_ROWS).toBe(16);
    expect(CARD_W).toBe(47);
    expect(CARD_H).toBe(7);
    expect(CARD_PITCH_X).toBe(49);
    expect(CARD_PITCH_Y).toBe(8);
    expect(RW_MIN).toBe(64);
    expect(RW_MAX).toBe(90);
  });
});

describe("geometry: small", () => {
  it("is small below 60 cols or 16 rows", () => {
    expect(geometry(59, 55).mode).toBe("small");
    expect(geometry(175, 15).mode).toBe("small");
    expect(geometry(0, 0).mode).toBe("small");
  });
  it("60x16 is the first non-small size (S1)", () => {
    expect(geometry(60, 16).mode).toBe("S1");
  });
  it("small returns full-width, unsplit, zero card columns", () => {
    const g = geometry(40, 10);
    expect(g).toMatchObject({ mode: "small", cols: 40, rows: 10, split: false, cardCols: 0, divX: null, band: null });
    expect(g.LW).toBe(40);
    expect(g.RW).toBe(40);
  });
});

describe("geometry: W3 / W2 split modes", () => {
  const table: Array<[number, "W3" | "W2", number, number, number, number | null, number | null]> = [
    [220, "W3", 3, 145, 70, 147, 150],
    [175, "W2", 2, 96, 74, 98, 101],
    [165, "W2", 2, 96, 64, null, null],
    [213, "W2", 2, 118, 90, null, null],
    [214, "W3", 3, 145, 64, null, null],
    [300, "W3", 3, 205, 90, null, null],
  ];
  for (const [cols, mode, cardCols, LW, RW, divX, RX] of table) {
    it(`${cols} cols -> ${mode} ${LW}/${RW}`, () => {
      const g = geometry(cols, 55);
      expect(g.mode).toBe(mode);
      expect(g.split).toBe(true);
      expect(g.cardCols).toBe(cardCols);
      expect(g.LW).toBe(LW);
      expect(g.RW).toBe(RW);
      expect(g.band).toBeNull();
      if (divX !== null) expect(g.divX).toBe(divX);
      if (RX !== null) expect(g.RX).toBe(RX);
    });
  }
});

describe("geometry: S2 stacked", () => {
  it("card columns follow min(3, floor((cols+2)/49))", () => {
    expect(geometry(164, 55).cardCols).toBe(3);
    expect(geometry(120, 55).cardCols).toBe(2);
    expect(geometry(100, 55).cardCols).toBe(2);
    expect(geometry(164, 55).mode).toBe("S2");
    expect(geometry(100, 55).mode).toBe("S2");
  });
  it("120 cols: bottom band numbers, unsplit full width", () => {
    const g = geometry(120, 55);
    expect(g.mode).toBe("S2");
    expect(g.split).toBe(false);
    expect(g.LW).toBe(120);
    expect(g.RW).toBe(120);
    expect(g.RX).toBe(0);
    expect(g.divX).toBeNull();
    expect(g.band).toEqual({ leftW: 57, divX: 59, rightX: 62, rightW: 58 });
  });
});

describe("geometry: S1 stacked", () => {
  it("card columns follow floor((cols+2)/49)", () => {
    expect(geometry(99, 55).cardCols).toBe(2);
    expect(geometry(96, 55).cardCols).toBe(2);
    expect(geometry(95, 55).cardCols).toBe(1);
    expect(geometry(60, 55).cardCols).toBe(1);
    expect(geometry(99, 55).mode).toBe("S1");
  });
  it("full width, no band", () => {
    const g = geometry(80, 30);
    expect(g.band).toBeNull();
    expect(g.split).toBe(false);
    expect(g.LW).toBe(80);
    expect(g.RW).toBe(80);
    expect(g.divX).toBeNull();
  });
});

describe("geometry: invariants 60..320 x {16, 55}", () => {
  it("holds for every size", () => {
    for (let cols = 60; cols <= 320; cols++) {
      for (const rows of [16, 55]) {
        const g = geometry(cols, rows);
        expect(g.mode).not.toBe("small");
        expect(g.cols).toBe(cols);
        expect(g.rows).toBe(rows);
        expect(g.cardCols).toBeGreaterThanOrEqual(1);
        expect(CARD_W * g.cardCols + 2 * (g.cardCols - 1)).toBeLessThanOrEqual(g.LW);
        if (g.split) {
          expect(g.RX + g.RW).toBe(cols);
          expect(g.divX).toBe(g.LW + 2);
          expect(g.RW).toBeGreaterThanOrEqual(RW_MIN);
          expect(g.RW).toBeLessThanOrEqual(RW_MAX);
        } else {
          expect(g.LW).toBe(cols);
        }
        if (g.band) {
          expect(g.band.rightX + g.band.rightW).toBe(cols);
          expect(g.band.divX).toBe(g.band.leftW + 2);
        }
      }
    }
  });
});
