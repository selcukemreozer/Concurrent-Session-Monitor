import { describe, it, expect } from "vitest";
// Test files are exempt from the one-importer rule for string-width.
import stringWidth from "string-width";
import { V2 } from "./glyphs.js";

// Phase 9 plan 09-04 Task 1: every V2 glyph is one cell wide, carries no
// emoji presentation selector, and matches the approved UI-SPEC glyph set.
const values = (): string[] => {
  const out: string[] = [];
  for (const v of Object.values(V2)) {
    if (Array.isArray(v)) out.push(...(v as readonly string[]));
    else out.push(v as string);
  }
  return out;
};

describe("V2 glyph set", () => {
  it("measures every glyph and spinner frame at exactly 1 cell (D-04)", () => {
    for (const [k, v] of Object.entries(V2)) {
      const list = Array.isArray(v) ? (v as readonly string[]) : [v as string];
      for (const g of list) expect(stringWidth(g), `${k} ${g}`).toBe(1);
    }
  });

  it("carries no U+FE0F and no rejected U+2197 arrow", () => {
    for (const g of values()) {
      expect(g.includes("️"), g).toBe(false);
      expect(g).not.toBe("↗");
    }
  });

  it("pins the D-06 / D-07 choices", () => {
    expect(V2.read).toBe("◦");
    expect(V2.exposed).toBe("⇡");
    expect(V2.running).toBe("▶");
  });

  it("has the 10 braille spinner frames in order", () => {
    expect(V2.spinner).toEqual(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
  });

  it("matches the approved glyph table", () => {
    expect(V2).toMatchObject({
      brand: "◆",
      asking: "?",
      waiting: "◉",
      running: "▶",
      subagent: "↻",
      conflict: "!",
      write: "✎",
      read: "◦",
      join: "✕",
      edgeTop: "▄",
      edgeBottom: "▀",
      rowMark: "▌",
      capL: "▐",
      capR: "▌",
      vline: "│",
      hline: "─",
      cornerBL: "└",
      cornerBR: "┘",
      heavyV: "┃",
      heavyH: "━",
      heavyTL: "┏",
      heavyTR: "┓",
      heavyBL: "┗",
      heavyBR: "┛",
      dashed: "┄",
      group: "■",
      phaseDone: "●",
      phaseCurrent: "◉",
      phasePending: "○",
      more: "⋮",
      idleDot: "●",
      cursor: "❯",
      sessionCursor: "▸",
      owner: "↳",
      exposed: "⇡",
      intent: "»",
      prompt: "›",
      branch: "⎇",
      up: "↑",
      down: "↓",
      left: "←",
      right: "→",
      enter: "⏎",
      keysOff: "⌨",
      update: "⬆",
      ok: "✓",
      ellipsis: "…",
      sep: "·",
      times: "×",
      guess: "~",
    });
  });
});
