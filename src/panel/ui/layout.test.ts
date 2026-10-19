import { describe, it, expect } from "vitest";
import { allocate, type Demand } from "./layout.js";

// Phase 9 plan 09-03 Task 2: the allocate() height-budget core (UI-SPEC
// § Height allocation priority / Shrink order under pressure).
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const sum = (r: Record<string, number>): number => Object.values(r).reduce((a, b) => a + b, 0);

describe("allocate: stepped growth", () => {
  const demands: Demand[] = [
    { id: "g", min: 7, max: 23, step: 8 },
    { id: "f", min: 3, max: 6 },
  ];
  it("total 30 -> g=23 f=6, and every total >= 29 gives the same", () => {
    expect(allocate(30, demands, ["g", "f"])).toEqual({ g: 23, f: 6 });
    for (let t = 29; t <= 80; t++) expect(allocate(t, demands, ["g", "f"])).toEqual({ g: 23, f: 6 });
  });
  it("total 20 -> g grows in whole steps (15), f takes the rest (5)", () => {
    expect(allocate(20, demands, ["g", "f"])).toEqual({ g: 15, f: 5 });
  });
  it("a stepped demand never gets a partial step", () => {
    for (let t = 10; t <= 40; t++) {
      const g = allocate(t, demands, ["g", "f"]).g!;
      expect((g - 7) % 8).toBe(0);
    }
  });
});

describe("allocate: priority under pressure", () => {
  it("earlier demand keeps its min, later gets the rest", () => {
    expect(
      allocate(5, [
        { id: "a", min: 3, max: 3 },
        { id: "b", min: 3, max: 3 },
      ]),
    ).toEqual({ a: 3, b: 2 });
  });
  it("later demands get 0, never negative", () => {
    expect(
      allocate(2, [
        { id: "a", min: 3, max: 3 },
        { id: "b", min: 3, max: 3 },
      ]),
    ).toEqual({ a: 2, b: 0 });
  });
});

describe("allocate: zero / negative totals", () => {
  const d: Demand[] = [
    { id: "a", min: 1, max: 4 },
    { id: "b", min: 2, max: 9, step: 3 },
  ];
  it("total 0 -> all zeros", () => {
    expect(allocate(0, d)).toEqual({ a: 0, b: 0 });
  });
  it("negative total is treated as 0", () => {
    expect(allocate(-7, d)).toEqual({ a: 0, b: 0 });
  });
  it("NaN total is treated as 0", () => {
    expect(allocate(Number.NaN, d)).toEqual({ a: 0, b: 0 });
  });
});

describe("allocate: growOrder", () => {
  const d: Demand[] = [
    { id: "a", min: 1, max: 5 },
    { id: "b", min: 1, max: 5 },
  ];
  it("defaults to array order", () => {
    expect(allocate(6, d)).toEqual({ a: 5, b: 1 });
  });
  it("follows an explicit order", () => {
    expect(allocate(6, d, ["b", "a"])).toEqual({ a: 1, b: 5 });
  });
  it("ids missing from growOrder never grow past min", () => {
    expect(allocate(100, d, ["b"])).toEqual({ a: 1, b: 5 });
  });
  it("unknown ids in growOrder are ignored", () => {
    expect(allocate(6, d, ["zzz", "a"])).toEqual({ a: 5, b: 1 });
  });
});

describe("allocate: property (500 random cases)", () => {
  it("never over-allocates and respects min/max/step", () => {
    const rand = rng(0x09_03);
    const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
    for (let c = 0; c < 500; c++) {
      const n = int(0, 7);
      const demands: Demand[] = [];
      for (let i = 0; i < n; i++) {
        const min = int(0, 8);
        const max = min + int(0, 20);
        const stepped = rand() < 0.4;
        demands.push(stepped ? { id: `d${i}`, min, max, step: int(1, 8) } : { id: `d${i}`, min, max });
      }
      const total = int(-5, 60);
      const ids = demands.map((d) => d.id);
      const order = rand() < 0.5 ? undefined : ids.filter(() => rand() < 0.8).sort(() => rand() - 0.5);
      const out = allocate(total, demands, order);

      expect(sum(out)).toBeLessThanOrEqual(Math.max(0, total));
      let mins = 0;
      for (const d of demands) {
        const v = out[d.id]!;
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(d.max);
        mins += d.min;
        if (mins <= total) expect(v).toBeGreaterThanOrEqual(d.min);
        if (d.step && v >= d.min) expect((v - d.min) % d.step).toBe(0);
      }
    }
  });
});
