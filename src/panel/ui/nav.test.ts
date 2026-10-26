import { describe, it, expect } from "vitest";
import { gridItems, moveGrid, pageGrid, slotRow, moveList, cycleId, type Dir } from "./nav.js";

// Phase 10 plan 10-07 Task 2: the pure navigator over ids (KEYS-02, D-06,
// D-16). Identities in, identities out — never an index.

const CARDS = ["c1", "c2", "c3"];
const STRIPS = ["s1", "s2", "s3", "s4"];
const items = gridItems(CARDS, STRIPS);

describe("gridItems", () => {
  it("lays cards one per slot, then idle strips three per slot", () => {
    expect(items).toEqual([
      { id: "c1", kind: "card", slot: 0, sub: 0 },
      { id: "c2", kind: "card", slot: 1, sub: 0 },
      { id: "c3", kind: "card", slot: 2, sub: 0 },
      { id: "s1", kind: "strip", slot: 3, sub: 0 },
      { id: "s2", kind: "strip", slot: 3, sub: 1 },
      { id: "s3", kind: "strip", slot: 3, sub: 2 },
      { id: "s4", kind: "strip", slot: 4, sub: 0 },
    ]);
  });

  it("starts strip slots at slot 0 in calm mode (no cards)", () => {
    expect(gridItems([], STRIPS).map((g) => [g.id, g.slot, g.sub])).toEqual([
      ["s1", 0, 0],
      ["s2", 0, 1],
      ["s3", 0, 2],
      ["s4", 1, 0],
    ]);
  });

  it("is empty for no cards and no strips", () => {
    expect(gridItems([], [])).toEqual([]);
  });
});

describe("moveGrid: no or unknown current", () => {
  it.each<Dir>(["up", "down", "left", "right"])("null current → first item (%s)", (d) => {
    expect(moveGrid(items, 2, null, d)).toBe("c1");
  });

  it.each<Dir>(["up", "down", "left", "right"])("unknown current → first item (%s)", (d) => {
    expect(moveGrid(items, 2, "gone", d)).toBe("c1");
  });

  it("empty items → null", () => {
    expect(moveGrid([], 2, null, "down")).toBeNull();
    expect(moveGrid([], 2, "c1", "up")).toBeNull();
  });
});

describe("moveGrid: cols 2", () => {
  const m = (id: string, d: Dir) => moveGrid(items, 2, id, d);

  it("left/right walk list order and clamp (cards walk into strips, D-06)", () => {
    expect(m("c1", "right")).toBe("c2");
    expect(m("c1", "left")).toBe("c1");
    expect(m("c3", "right")).toBe("s1");
    expect(m("s1", "left")).toBe("c3");
    expect(m("s4", "right")).toBe("s4");
  });

  it("down moves one grid row, inside a strip stack first", () => {
    expect(m("c1", "down")).toBe("c3");
    expect(m("c2", "down")).toBe("s1");
    expect(m("s1", "down")).toBe("s2");
    expect(m("s3", "down")).toBe("s4");
    expect(m("s4", "down")).toBe("s4");
  });

  it("up moves one grid row, inside a strip stack first", () => {
    expect(m("s2", "up")).toBe("s1");
    expect(m("s1", "up")).toBe("c2");
    expect(m("c3", "up")).toBe("c1");
    expect(m("c1", "up")).toBe("c1");
  });

  it("up into a strip stack lands on its LAST strip", () => {
    // calm grid: slot 0 = s1..s3, slot 1 = s4; cols 1 → s4 up → s3.
    const calm = gridItems([], STRIPS);
    expect(moveGrid(calm, 1, "s4", "up")).toBe("s3");
  });

  it("cols < 1 is treated as 1", () => {
    expect(moveGrid(items, 0, "c1", "down")).toBe("c2");
    expect(moveGrid(items, -3, "c2", "up")).toBe("c1");
  });
});

describe("moveGrid: cols 1", () => {
  it("down walks every item in order and stops at the last", () => {
    const seen: (string | null)[] = [];
    let cur: string | null = "c1";
    for (let i = 0; i < 9; i++) {
      cur = moveGrid(items, 1, cur, "down");
      seen.push(cur);
    }
    expect(seen).toEqual(["c2", "c3", "s1", "s2", "s3", "s4", "s4", "s4", "s4"]);
  });

  it("up walks back to the first and stops", () => {
    const seen: (string | null)[] = [];
    let cur: string | null = "s4";
    for (let i = 0; i < 8; i++) {
      cur = moveGrid(items, 1, cur, "up");
      seen.push(cur);
    }
    expect(seen).toEqual(["s3", "s2", "s1", "c3", "c2", "c1", "c1", "c1"]);
  });
});

describe("moveGrid: identity survives a re-sort", () => {
  it("the same id moves relative to the fresh order", () => {
    const resorted = gridItems(["c3", "c1", "c2"], STRIPS);
    expect(moveGrid(resorted, 2, "c1", "right")).toBe("c2");
    expect(moveGrid(resorted, 2, "c1", "left")).toBe("c3");
  });
});

describe("pageGrid", () => {
  it("moves `rows` grid rows down and up", () => {
    expect(pageGrid(items, 2, "c1", 2, 1)).toBe("s4");
    expect(pageGrid(items, 2, "s4", 2, -1)).toBe("c1");
  });

  it("lands on sub 0 going down and the last sub going up", () => {
    expect(pageGrid(items, 2, "c2", 1, 1)).toBe("s1");
    expect(pageGrid(items, 1, "s4", 1, -1)).toBe("s3");
  });

  it("clamps at both ends", () => {
    expect(pageGrid(items, 2, "s1", 10, 1)).toBe("s4");
    expect(pageGrid(items, 2, "c3", 10, -1)).toBe("c1");
    expect(pageGrid(items, 2, "s4", 5, 1)).toBe("s4");
    expect(pageGrid(items, 2, "c1", 5, -1)).toBe("c1");
  });

  it("treats rows < 1 as 1", () => {
    expect(pageGrid(items, 2, "c1", 0, 1)).toBe("c3");
  });

  it("null or unknown current → first item; empty → null", () => {
    expect(pageGrid(items, 2, null, 2, 1)).toBe("c1");
    expect(pageGrid(items, 2, "gone", 2, -1)).toBe("c1");
    expect(pageGrid([], 2, null, 2, 1)).toBeNull();
  });
});

describe("slotRow", () => {
  it("returns the grid row of an id's slot", () => {
    expect(slotRow(items, "s2", 2)).toBe(1);
    expect(slotRow(items, "c1", 2)).toBe(0);
    expect(slotRow(items, "s4", 2)).toBe(2);
    expect(slotRow(items, "s4", 1)).toBe(4);
  });

  it("returns -1 for an unknown id", () => {
    expect(slotRow(items, "zz", 2)).toBe(-1);
  });
});

describe("moveList", () => {
  const ids = ["a", "b", "c"];

  it("moves by delta and clamps with no wrap", () => {
    expect(moveList(ids, "b", 1)).toBe("c");
    expect(moveList(ids, "c", 1)).toBe("c");
    expect(moveList(ids, "b", -5)).toBe("a");
  });

  it("null or unknown current → first id", () => {
    expect(moveList(ids, null, 1)).toBe("a");
    expect(moveList(ids, "zz", -1)).toBe("a");
  });

  it("empty → null", () => {
    expect(moveList([], "a", 1)).toBeNull();
    expect(moveList([], null, -1)).toBeNull();
  });
});

describe("cycleId", () => {
  const ids = ["r1", "r2", "r3"];

  it("wraps in both directions", () => {
    expect(cycleId(ids, "r3", 1)).toBe("r1");
    expect(cycleId(ids, "r1", -1)).toBe("r3");
    expect(cycleId(ids, "r1", 1)).toBe("r2");
  });

  it("null or unknown current → first for +1, last for -1", () => {
    expect(cycleId(ids, null, -1)).toBe("r3");
    expect(cycleId(ids, null, 1)).toBe("r1");
    expect(cycleId(ids, "zz", 1)).toBe("r1");
    expect(cycleId(ids, "zz", -1)).toBe("r3");
  });

  it("empty → null", () => {
    expect(cycleId([], "r1", 1)).toBeNull();
  });
});
