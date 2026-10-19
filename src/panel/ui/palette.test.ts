import { describe, it, expect } from "vitest";
import { PALETTE, stateColor } from "./palette.js";

// Phase 9 plan 09-04 Task 1: the D-05 hex tokens, pinned key by key.
describe("PALETTE", () => {
  it("equals the D-05 table exactly", () => {
    expect(PALETTE).toEqual({
      bg: "#1b1b19",
      fg: "#d6d3cb",
      hi: "#f5f3ec",
      dim: "#85827a",
      dim2: "#5c5a54",
      edge: "#3a3936",
      idle: "#4a4945",
      logo: "#E8C24A",
      asking: "#E86AD9",
      waiting: "#F2B33D",
      running: "#5FD47A",
      subagent: "#40E0D0",
      red: "#F0545A",
      redBg: "#3a1a1b",
      askBg: "#241822",
      blue: "#6FA8FF",
      live: "#4f9a62",
    });
  });

  it("holds only 6-digit hex values", () => {
    for (const [k, v] of Object.entries(PALETTE)) {
      expect(v, k).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe("stateColor", () => {
  it("maps each agent state to its D-05 color", () => {
    expect(stateColor("asking")).toBe("#E86AD9");
    expect(stateColor("waiting")).toBe("#F2B33D");
    expect(stateColor("running")).toBe("#5FD47A");
    expect(stateColor("subagent")).toBe("#40E0D0");
  });
});
