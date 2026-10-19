import { describe, it, expect } from "vitest";
import { windowSlice, type WindowIn, type WindowOut } from "./viewport.js";

// Phase 9 plan 09-03 Task 3: windowSlice, the one list window behind every
// "↑ N more" / "↓ N more" (UI-SPEC § indicators). N counts ITEMS, not rows.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function itemRows(w: WindowIn, o: WindowOut): number {
  let r = 0;
  for (let i = o.start; i < o.end; i++) r += w.heights?.[i] ?? 1;
  return r;
}

describe("windowSlice: no overflow", () => {
  it("len <= height shows everything from 0", () => {
    const o = windowSlice({ len: 5, height: 8, cursor: 3, offset: 2 });
    expect(o).toMatchObject({ offset: 0, start: 0, end: 5, above: 0, below: 0, rows: 5, up: false, down: false });
  });
  it("len === height still needs no indicators", () => {
    const o = windowSlice({ len: 6, height: 6, cursor: 5, offset: 0 });
    expect(o).toMatchObject({ start: 0, end: 6, rows: 6, up: false, down: false });
  });
  it("empty list", () => {
    expect(windowSlice({ len: 0, height: 5, cursor: -1, offset: 0 })).toMatchObject({ start: 0, end: 0, rows: 0 });
  });
});

describe("windowSlice: overflow, height >= 3", () => {
  it("top of list: no ↑, ↓ counts hidden items", () => {
    const o = windowSlice({ len: 20, height: 10, cursor: 0, offset: 0 });
    expect(o).toMatchObject({ start: 0, end: 9, above: 0, below: 11, rows: 10, up: false, down: true });
  });
  it("cursor far below scrolls so cursor + 1 item of context is visible", () => {
    const o = windowSlice({ len: 20, height: 10, cursor: 15, offset: 0 });
    expect(o.up).toBe(true);
    expect(o.down).toBe(true);
    expect(o.end).toBe(17);
    expect(o.start).toBe(9);
    expect(o.rows).toBe(10);
  });
  it("cursor on the last item: window ends at len, no ↓", () => {
    const o = windowSlice({ len: 20, height: 10, cursor: 19, offset: 0 });
    expect(o).toMatchObject({ start: 11, end: 20, above: 11, below: 0, rows: 10, up: true, down: false });
  });
  it("sticky offset: a move inside the window does not change start", () => {
    // offset 5 -> up + down rows, 8 items: [5, 13)
    for (const cursor of [6, 7, 9, 11]) {
      const o = windowSlice({ len: 20, height: 10, cursor, offset: 5 });
      expect(o.start).toBe(5);
      expect(o.end).toBe(13);
    }
    expect(windowSlice({ len: 20, height: 10, cursor: 12, offset: 5 }).start).toBe(6);
  });
  it("moving up keeps one item of context above", () => {
    expect(windowSlice({ len: 20, height: 10, cursor: 5, offset: 5 }).start).toBe(4);
    expect(windowSlice({ len: 20, height: 10, cursor: 0, offset: 5 }).start).toBe(0);
  });
  it("context 0 lets the cursor sit on the edge", () => {
    expect(windowSlice({ len: 20, height: 10, cursor: 5, offset: 5, context: 0 }).start).toBe(5);
    expect(windowSlice({ len: 20, height: 10, cursor: 12, offset: 5, context: 0 }).start).toBe(5);
  });
  it("an offset past the end is pulled back so the window is full", () => {
    const o = windowSlice({ len: 20, height: 10, cursor: -1, offset: 19 });
    expect(o).toMatchObject({ start: 11, end: 20, rows: 10 });
  });
  it("no cursor: window starts at the clamped offset", () => {
    const o = windowSlice({ len: 20, height: 10, cursor: -1, offset: 4 });
    expect(o).toMatchObject({ offset: 4, start: 4, end: 12, above: 4, below: 8, rows: 10 });
  });
});

describe("windowSlice: overflow, height 2", () => {
  it("one item + ↓ while items remain below", () => {
    const o = windowSlice({ len: 5, height: 2, cursor: 0, offset: 0 });
    expect(o).toMatchObject({ start: 0, end: 1, rows: 2, up: false, down: true });
    const m = windowSlice({ len: 5, height: 2, cursor: 2, offset: 0 });
    expect(m).toMatchObject({ start: 2, end: 3, rows: 2, up: false, down: true });
  });
  it("one item + ↑ on the last item", () => {
    const o = windowSlice({ len: 5, height: 2, cursor: 4, offset: 0 });
    expect(o).toMatchObject({ start: 4, end: 5, above: 4, below: 0, rows: 2, up: true, down: false });
  });
});

describe("windowSlice: overflow, height 1", () => {
  it("shows the cursor item and no indicator", () => {
    const o = windowSlice({ len: 5, height: 1, cursor: 3, offset: 0 });
    expect(o).toMatchObject({ start: 3, end: 4, rows: 1, up: false, down: false });
  });
  it("without a cursor shows the item at the offset", () => {
    expect(windowSlice({ len: 5, height: 1, cursor: -1, offset: 2 })).toMatchObject({ start: 2, end: 3, rows: 1 });
  });
});

describe("windowSlice: variable heights", () => {
  it("visible item heights + indicator rows fit the height", () => {
    const heights = [2, 1, 2, 1, 1];
    for (let cursor = -1; cursor < 5; cursor++) {
      const w: WindowIn = { len: 5, height: 4, cursor, offset: 0, heights };
      const o = windowSlice(w);
      expect(itemRows(w, o) + (o.up ? 1 : 0) + (o.down ? 1 : 0)).toBeLessThanOrEqual(4);
      expect(o.rows).toBeLessThanOrEqual(4);
      if (cursor >= 0) {
        expect(o.start).toBeLessThanOrEqual(cursor);
        expect(cursor).toBeLessThan(o.end);
      }
    }
  });
  it("cursor 0 shows items 0 and 1 then ↓", () => {
    const o = windowSlice({ len: 5, height: 4, cursor: 0, offset: 0, heights: [2, 1, 2, 1, 1] });
    expect(o).toMatchObject({ start: 0, end: 2, below: 3, rows: 4, down: true });
  });
});

describe("windowSlice: height <= 0", () => {
  it("shows nothing", () => {
    for (const height of [0, -3]) {
      const o = windowSlice({ len: 10, height, cursor: 4, offset: 2 });
      expect(o.start).toBe(o.end);
      expect(o.rows).toBe(0);
      expect(o.above + o.below).toBe(10);
    }
  });
});

describe("windowSlice: property (1000 random cases)", () => {
  it("counts items, never overflows, keeps the cursor visible", () => {
    const rand = rng(0x0903_0003);
    const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
    for (let c = 0; c < 1000; c++) {
      const len = int(0, 40);
      const height = int(0, 15);
      const cursor = len === 0 ? -1 : int(-1, len - 1);
      const offset = int(0, len);
      const heights = rand() < 0.5 ? Array.from({ length: len }, () => int(1, 3)) : undefined;
      const w: WindowIn = { len, height, cursor, offset, heights };
      const o = windowSlice(w);

      expect(o.above + (o.end - o.start) + o.below).toBe(len);
      expect(o.above).toBe(o.start);
      expect(o.below).toBe(len - o.end);
      expect(o.rows).toBeLessThanOrEqual(Math.max(0, height));
      expect(o.rows).toBeGreaterThanOrEqual(0);
      expect(o.offset).toBe(o.start);
      if (height <= 0) expect(o.start).toBe(o.end);
      if (cursor >= 0 && height >= 1) {
        expect(o.start).toBeLessThanOrEqual(cursor);
        expect(cursor).toBeLessThan(o.end);
      }
      if (height >= 3) {
        expect(o.up).toBe(o.above > 0);
        expect(o.down).toBe(o.below > 0);
        if (!heights) expect(o.rows).toBe(o.end - o.start + (o.up ? 1 : 0) + (o.down ? 1 : 0));
      }
      if (height === 2) expect(o.up && o.down).toBe(false);
      if (height <= 1) expect(o.up || o.down).toBe(false);
    }
  });
});
