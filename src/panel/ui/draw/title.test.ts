import { describe, it, expect } from "vitest";
import { Screen, lineText, lineWidth, type Line, type Seg } from "../screen.js";
import { cellWidth } from "../text.js";
import { drawTitle, drawTabs, SAMPLE_CHIP } from "./title.js";

// Phase 9 plan 09-05 Task 2: pane titles, the right-column tabs and the
// ` sample ` chip draw cell-exactly per UI-SPEC § Pane title (D-02, D-20).

/** The Seg covering cell x, or undefined past the line's end. */
function segAt(line: Line, x: number): Seg | undefined {
  let cx = 0;
  for (const s of line) {
    const w = cellWidth(s.text);
    if (x >= cx && x < cx + w) return s;
    cx += w;
  }
  return undefined;
}

/** The Seg whose text is exactly t. */
function seg(line: Line, t: string): Seg | undefined {
  return line.find((s) => s.text === t);
}

/** Index (cells) of the last non-space cell, or -1. */
function lastInk(line: Line): number {
  const t = lineText(line).replace(/ +$/, "");
  return cellWidth(t) - 1;
}

const row = (scr: Screen, y: number): Line => scr.toLines()[y] ?? [];

describe("SAMPLE_CHIP", () => {
  it("is the padded word sample", () => {
    expect(SAMPLE_CHIP).toBe(" sample ");
  });
});

describe("drawTitle focused AGENTS", () => {
  const scr = new Screen(175, 3);
  drawTitle(scr, 0, 2, 96, { label: "AGENTS", focused: true, sample: true, right: "5 active · 3 idle" });
  const l = row(scr, 2);
  const t = lineText(l);

  it("starts with the inverse label, chip and rule", () => {
    expect(t.startsWith("▐AGENTS▌ sample  ─")).toBe(true);
  });

  it("ends with the right info at x95", () => {
    expect(t.trimEnd().endsWith("─ 5 active · 3 idle")).toBe(true);
    expect(lastInk(l)).toBe(95);
  });

  it("styles caps, label, chip, rule and right info", () => {
    expect(segAt(l, 0)).toMatchObject({ text: "▐", fg: "#f5f3ec" });
    expect(seg(l, "AGENTS")).toEqual({ text: "AGENTS", fg: "#1b1b19", bg: "#f5f3ec", bold: true });
    expect(segAt(l, 7)).toMatchObject({ text: "▌", fg: "#f5f3ec" });
    expect(seg(l, " sample ")).toEqual({ text: " sample ", fg: "#d6d3cb", bg: "#3a3936" });
    expect(segAt(l, 17)?.fg).toBe("#3a3936");
    expect(segAt(l, 17)?.text.startsWith("─")).toBe(true);
    expect(seg(l, "5 active · 3 idle")?.fg).toBe("#85827a");
  });
});

describe("drawTitle unfocused FILES", () => {
  const scr = new Screen(175, 40);
  drawTitle(scr, 0, 30, 96, { label: "FILES", focused: false, sample: true, right: "14 files" });
  const l = row(scr, 30);

  it("indents the dim bold label and keeps the chip", () => {
    expect(lineText(l).startsWith(" FILES  sample  ─")).toBe(true);
    expect(seg(l, "FILES")).toEqual({ text: "FILES", fg: "#85827a", bold: true });
    expect(seg(l, " sample ")).toBeDefined();
  });

  it("right-aligns the info at x95", () => {
    expect(lineText(l).trimEnd().endsWith("─ 14 files")).toBe(true);
    expect(lastInk(l)).toBe(95);
  });
});

describe("drawTitle edge cases", () => {
  it("stops the rule 1 cell before the right edge without right info (frame PORTS title)", () => {
    const scr = new Screen(175, 1);
    drawTitle(scr, 0, 0, 96, { label: "PORTS", focused: false, sample: true });
    const l = row(scr, 0);
    expect(lastInk(l)).toBe(94);
    expect(segAt(l, 94)).toMatchObject({ fg: "#3a3936" });
    expect(lineText(l)[94]).toBe("─");
  });

  it("omits the chip when sample is not set", () => {
    const scr = new Screen(100, 1);
    drawTitle(scr, 0, 0, 96, { label: "PORTS", focused: false });
    expect(lineText(row(scr, 0)).includes("sample")).toBe(false);
    expect(lineText(row(scr, 0)).startsWith(" PORTS  ─")).toBe(true);
  });

  it("draws extra Segs after the chip", () => {
    const scr = new Screen(100, 1);
    drawTitle(scr, 0, 0, 96, {
      label: "FILES",
      focused: false,
      sample: true,
      extra: [{ text: "· paused", fg: "#F2B33D" }],
    });
    const l = row(scr, 0);
    expect(lineText(l).startsWith(" FILES  sample · paused ─")).toBe(true);
    expect(seg(l, "· paused")?.fg).toBe("#F2B33D");
  });

  it("starts at the pane x", () => {
    const scr = new Screen(175, 1);
    drawTitle(scr, 101, 0, 74, { label: "PORTS", focused: true, sample: true, right: "8 ports" });
    const l = row(scr, 0);
    expect(segAt(l, 101)?.text).toBe("▐");
    expect(lastInk(l)).toBe(174);
  });

  it.each([10, 20, 30, 40, 60, 96])("a long right info stays inside w=%i", (w) => {
    const scr = new Screen(175, 1);
    drawTitle(scr, 5, 0, w, {
      label: "AGENTS",
      focused: true,
      sample: true,
      right: "x".repeat(200),
    });
    const l = row(scr, 0);
    expect(lastInk(l)).toBeLessThanOrEqual(5 + w - 1);
    expect(lineWidth(l)).toBeLessThanOrEqual(175);
  });

  it("sanitizes the right info", () => {
    const scr = new Screen(100, 1);
    drawTitle(scr, 0, 0, 96, { label: "FILES", focused: false, right: "\u001b[31m4 files\u0007" });
    const t = lineText(row(scr, 0));
    expect(t).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(t.trimEnd().endsWith("[31m4 files")).toBe(true);
  });
});

describe("drawTabs", () => {
  it("draws PHASES active, column unfocused, with chip and [r]", () => {
    const scr = new Screen(175, 3);
    drawTabs(scr, 101, 2, 74, { active: "phases", columnFocused: false, sample: true });
    const l = row(scr, 2);
    const t = lineText(l);
    expect(t).toContain("  PHASES   SESSIONS   sample  ─");
    expect(t.trimEnd().endsWith("─ [r]")).toBe(true);
    expect(segAt(l, 172)?.text).toBe("[r]");
    expect(segAt(l, 172)?.fg).toBe("#85827a");
    expect(seg(l, " PHASES ")).toEqual({ text: " PHASES ", fg: "#d6d3cb", bg: "#4a4945", bold: true });
    expect(seg(l, " SESSIONS ")).toEqual({ text: " SESSIONS ", fg: "#5c5a54" });
    expect(seg(l, " sample ")).toBeDefined();
  });

  it("draws the focused active tab inverse", () => {
    const scr = new Screen(175, 3);
    drawTabs(scr, 101, 2, 74, { active: "phases", columnFocused: true, sample: true });
    const l = row(scr, 2);
    expect(lineText(l)).toContain("▐PHASES▌  SESSIONS ");
    expect(seg(l, "PHASES")).toEqual({ text: "PHASES", fg: "#1b1b19", bg: "#f5f3ec", bold: true });
  });

  it("moves the inverse to SESSIONS when it is active", () => {
    const scr = new Screen(175, 3);
    drawTabs(scr, 101, 2, 74, { active: "sessions", columnFocused: true, sample: true });
    const l = row(scr, 2);
    expect(lineText(l)).toContain(" PHASES  ▐SESSIONS▌");
    expect(seg(l, "SESSIONS")).toEqual({ text: "SESSIONS", fg: "#1b1b19", bg: "#f5f3ec", bold: true });
    expect(seg(l, " PHASES ")).toEqual({ text: " PHASES ", fg: "#5c5a54" });
  });

  it("draws the unfocused active SESSIONS tab on the idle bg", () => {
    const scr = new Screen(175, 3);
    drawTabs(scr, 101, 2, 74, { active: "sessions", columnFocused: false, sample: false });
    const l = row(scr, 2);
    expect(seg(l, " SESSIONS ")).toEqual({ text: " SESSIONS ", fg: "#d6d3cb", bg: "#4a4945", bold: true });
    expect(lineText(l).includes("sample")).toBe(false);
  });

  it("stays inside a narrow width", () => {
    const scr = new Screen(175, 1);
    drawTabs(scr, 50, 0, 20, { active: "phases", columnFocused: true, sample: true });
    expect(lastInk(row(scr, 0))).toBeLessThanOrEqual(69);
  });
});
