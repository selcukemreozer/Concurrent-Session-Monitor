import { describe, it, expect } from "vitest";
import {
  LAUNCH_HOLD_MS,
  claimLaunch,
  settleLaunch,
  settleHolds,
  applyHolds,
  type LaunchHolds,
} from "./launch-hold.js";

/** Minimal row shape: applyHolds / settleHolds only read id and live. */
type Row = { id: string; live: boolean; label?: string };

const row = (id: string, live = false): Row => ({ id, live, label: `l-${id}` });

describe("LAUNCH_HOLD_MS", () => {
  it("is 60 seconds", () => {
    expect(LAUNCH_HOLD_MS).toBe(60000);
  });
});

describe("claimLaunch", () => {
  it("claims an unheld id as in flight and returns true", () => {
    const holds: LaunchHolds = new Map();
    expect(claimLaunch(holds, "a", 1000, 1)).toBe(true);
    expect(holds.get("a")).toEqual({ at: 1000, token: 1, inFlight: true });
  });

  it("refuses a held id and leaves the map unchanged", () => {
    const holds: LaunchHolds = new Map();
    claimLaunch(holds, "a", 1000, 1);
    expect(claimLaunch(holds, "a", 2000, 2)).toBe(false);
    expect(holds.get("a")).toEqual({ at: 1000, token: 1, inFlight: true });
    expect(holds.size).toBe(1);
  });

  it("claims a different id independently", () => {
    const holds: LaunchHolds = new Map();
    claimLaunch(holds, "a", 1000, 1);
    expect(claimLaunch(holds, "b", 1500, 2)).toBe(true);
    expect(holds.size).toBe(2);
    expect(holds.get("b")).toEqual({ at: 1500, token: 2, inFlight: true });
  });
});

describe("settleLaunch", () => {
  it("drops the hold on a failed launch with the matching token", () => {
    const holds: LaunchHolds = new Map();
    claimLaunch(holds, "a", 1000, 7);
    expect(settleLaunch(holds, "a", 7, false)).toBe(true);
    expect(holds.has("a")).toBe(false);
  });

  it("keeps the hold but clears inFlight on a successful launch", () => {
    const holds: LaunchHolds = new Map();
    claimLaunch(holds, "a", 1000, 7);
    expect(settleLaunch(holds, "a", 7, true)).toBe(true);
    expect(holds.get("a")).toEqual({ at: 1000, token: 7, inFlight: false });
  });

  it("ignores a non-matching token", () => {
    const holds: LaunchHolds = new Map();
    claimLaunch(holds, "a", 1000, 7);
    expect(settleLaunch(holds, "a", 8, false)).toBe(false);
    expect(holds.get("a")).toEqual({ at: 1000, token: 7, inFlight: true });
    expect(settleLaunch(holds, "a", 8, true)).toBe(false);
    expect(holds.get("a")).toEqual({ at: 1000, token: 7, inFlight: true });
  });

  it("ignores a missing id", () => {
    const holds: LaunchHolds = new Map();
    expect(settleLaunch(holds, "nope", 1, false)).toBe(false);
    expect(holds.size).toBe(0);
  });
});

describe("settleHolds", () => {
  const settled = (at: number): LaunchHolds =>
    new Map([["a", { at, token: 1, inFlight: false }]]);

  it("drops a hold whose row a scan reports live (confirmed)", () => {
    const holds = settled(1000);
    expect(settleHolds(holds, [row("a", true)], 1001)).toBe(true);
    expect(holds.has("a")).toBe(false);
  });

  it("drops a confirmed hold even when the scan started before the claim", () => {
    const holds = settled(1000);
    expect(settleHolds(holds, [row("a", true)], 500)).toBe(true);
    expect(holds.has("a")).toBe(false);
  });

  it("keeps a hold when a scan started before the claim reports it not live", () => {
    const holds = settled(1000);
    expect(settleHolds(holds, [row("a", false)], 500)).toBe(false);
    expect(holds.has("a")).toBe(true);
  });

  it("keeps a hold when a scan started less than LAUNCH_HOLD_MS after the claim", () => {
    const holds = settled(1000);
    expect(settleHolds(holds, [row("a", false)], 1000 + LAUNCH_HOLD_MS - 1)).toBe(false);
    expect(holds.has("a")).toBe(true);
    expect(settleHolds(holds, [], 1000 + LAUNCH_HOLD_MS - 1)).toBe(false);
    expect(holds.has("a")).toBe(true);
  });

  it("drops a hold when a scan started LAUNCH_HOLD_MS after the claim reports it not live", () => {
    const holds = settled(1000);
    expect(settleHolds(holds, [row("a", false)], 1000 + LAUNCH_HOLD_MS)).toBe(true);
    expect(holds.has("a")).toBe(false);
  });

  it("drops a hold when a late-enough scan does not list the id at all", () => {
    const holds = settled(1000);
    expect(settleHolds(holds, [row("b", false)], 1000 + LAUNCH_HOLD_MS + 5)).toBe(true);
    expect(holds.has("a")).toBe(false);
  });

  it("never drops an in-flight hold", () => {
    const holds: LaunchHolds = new Map([["a", { at: 1000, token: 1, inFlight: true }]]);
    expect(settleHolds(holds, [row("a", true)], 1000 + LAUNCH_HOLD_MS * 10)).toBe(false);
    expect(holds.has("a")).toBe(true);
    expect(settleHolds(holds, [], 1000 + LAUNCH_HOLD_MS * 10)).toBe(false);
    expect(holds.has("a")).toBe(true);
  });

  it("settles each hold independently and reports any drop", () => {
    const holds: LaunchHolds = new Map([
      ["a", { at: 1000, token: 1, inFlight: false }],
      ["b", { at: 1000, token: 2, inFlight: false }],
      ["c", { at: 1000, token: 3, inFlight: true }],
    ]);
    expect(settleHolds(holds, [row("a", true), row("b", false), row("c", true)], 2000)).toBe(true);
    expect([...holds.keys()].sort()).toEqual(["b", "c"]);
  });

  it("returns false on an empty map", () => {
    expect(settleHolds(new Map(), [row("a", true)], 0)).toBe(false);
  });
});

describe("applyHolds", () => {
  it("returns null for null rows", () => {
    expect(applyHolds<Row>(null, new Map())).toBeNull();
  });

  it("returns the same array when no row is held", () => {
    const rows = [row("a"), row("b")];
    const holds: LaunchHolds = new Map([["z", { at: 0, token: 1, inFlight: true }]]);
    expect(applyHolds(rows, holds)).toBe(rows);
    expect(applyHolds(rows, new Map())).toBe(rows);
  });

  it("overlays live on a held, not-live row as a copy without mutating input", () => {
    const a = row("a");
    const b = row("b");
    const rows = [a, b];
    const holds: LaunchHolds = new Map([["a", { at: 0, token: 1, inFlight: true }]]);
    const out = applyHolds(rows, holds)!;
    expect(out).not.toBe(rows);
    expect(out[0]).not.toBe(a);
    expect(out[0]).toEqual({ ...a, live: true });
    expect(out[1]).toBe(b);
    expect(a.live).toBe(false);
    expect(rows[0]).toBe(a);
  });

  it("keeps the identity of a held row that is already live", () => {
    const a = row("a", true);
    const rows = [a, row("b")];
    const holds: LaunchHolds = new Map([["a", { at: 0, token: 1, inFlight: false }]]);
    const out = applyHolds(rows, holds)!;
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(rows[1]);
  });
});
