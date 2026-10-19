import { describe, it, expect } from "vitest";
import { lineText, lineWidth } from "../screen.js";
import { SAMPLE_HEADER } from "../sample.js";
import { drawTooSmall } from "./tooSmall.js";

// Phase 9 plan 09-05 Task 3: the too-small screen (D-27, LAYOUT-04;
// UI-SPEC § Terminal too small).

describe("drawTooSmall at 52x14", () => {
  const lines = drawTooSmall(52, 14, SAMPLE_HEADER);

  it("returns 5 lines", () => {
    expect(lines).toHaveLength(5);
  });

  it("draws the header with its chips on line 0", () => {
    expect(lineText(lines[0]!).startsWith(" ◆ CSM   1 asking   1 waiting   1 conflict")).toBe(true);
    expect(lines[1]).toEqual([]);
  });

  it("draws the message lines", () => {
    expect(lineText(lines[2]!)).toBe(" terminal too small");
    expect(lines[2]!.find((s) => s.text === "terminal too small")).toEqual({
      text: "terminal too small",
      fg: "#f5f3ec",
      bold: true,
    });
    expect(lineText(lines[3]!)).toBe(" now 52×14 · needs 60×16");
    expect(lines[3]!.find((s) => s.text.startsWith("now"))?.fg).toBe("#85827a");
    expect(lineText(lines[4]!)).toBe(" enlarge the window, or press q to quit");
    expect(lines[4]!.find((s) => s.text.startsWith("enlarge"))?.fg).toBe("#5c5a54");
  });
});

describe("drawTooSmall clipping", () => {
  it("stays inside 40x10", () => {
    const lines = drawTooSmall(40, 10, SAMPLE_HEADER);
    expect(lines.length).toBeLessThanOrEqual(10);
    for (const l of lines) expect(lineWidth(l)).toBeLessThanOrEqual(40);
    expect(lineText(lines[4]!).endsWith("…")).toBe(true);
  });

  it("returns exactly 3 lines at 30x3", () => {
    const lines = drawTooSmall(30, 3, SAMPLE_HEADER);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(lineWidth(l)).toBeLessThanOrEqual(30);
  });

  it.each([
    [59, 30],
    [100, 15],
    [20, 5],
    [10, 1],
    [1, 1],
  ])("respects %ix%i", (cols, rows) => {
    const lines = drawTooSmall(cols, rows, SAMPLE_HEADER);
    expect(lines.length).toBe(Math.min(rows, 5));
    for (const l of lines) expect(lineWidth(l)).toBeLessThanOrEqual(cols);
  });

  it("reports the actual size", () => {
    expect(lineText(drawTooSmall(100, 15, SAMPLE_HEADER)[3]!)).toBe(" now 100×15 · needs 60×16");
  });
});
