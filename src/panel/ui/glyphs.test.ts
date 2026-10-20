import { describe, it, expect } from "vitest";
// Test files are exempt from the one-importer rule for string-width.
import stringWidth from "string-width";
import {
  V2,
  DOT,
  READ_GLYPH,
  READ_COLOR,
  INTENT_GLYPH,
  SKILL_GLYPH,
  SKILL_SEP,
  BRANCH_GLYPH,
  NEQ_GLYPH,
  ATTENTION_GLYPH,
  RUN_GLYPH,
  SUBAGENT_GLYPH,
  SUBAGENT_COLOR,
  WARN,
  JOIN,
  EXPOSED_GLYPH,
  PORT_CURSOR_GLYPH,
  CURRENT_GLYPH,
} from "./glyphs.js";
import * as Card from "../Card.js";

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

// Phase 9 plan 09-11 Task 1 (strangler S2): the legacy 1.6.x glyph and color
// constants moved out of Card.tsx into this module. Their values are frozen
// (D-23) and they are never merged with the V2 set.
describe("legacy 1.6.x glyphs (values frozen, D-23)", () => {
  it("pins every legacy value", () => {
    expect({
      DOT,
      READ_GLYPH,
      READ_COLOR,
      INTENT_GLYPH,
      SKILL_GLYPH,
      SKILL_SEP,
      BRANCH_GLYPH,
      NEQ_GLYPH,
      ATTENTION_GLYPH,
      RUN_GLYPH,
      SUBAGENT_GLYPH,
      SUBAGENT_COLOR,
      WARN,
      JOIN,
      EXPOSED_GLYPH,
      PORT_CURSOR_GLYPH,
      CURRENT_GLYPH,
    }).toEqual({
      DOT: "\u25CF",
      READ_GLYPH: "\u25C7",
      READ_COLOR: "blue",
      INTENT_GLYPH: "\u00BB",
      SKILL_GLYPH: "\u2699",
      SKILL_SEP: " \u203A ",
      BRANCH_GLYPH: "\u2387",
      NEQ_GLYPH: "\u2260",
      ATTENTION_GLYPH: "\u25C9",
      RUN_GLYPH: "\u25B6",
      SUBAGENT_GLYPH: "\u21BB",
      SUBAGENT_COLOR: "#40E0D0",
      WARN: "\u26A0",
      JOIN: " \u2194 ",
      EXPOSED_GLYPH: "\u21C5",
      PORT_CURSOR_GLYPH: "\u276F",
      CURRENT_GLYPH: "\u25B8",
    });
  });

  it("keeps RUN_GLYPH without a variation selector", () => {
    expect(RUN_GLYPH.length).toBe(1);
    expect(RUN_GLYPH.includes("\uFE0F")).toBe(false);
  });

  it("never unifies the legacy set with V2", () => {
    expect(V2.read).not.toBe(READ_GLYPH);
    expect(V2.exposed).not.toBe(EXPOSED_GLYPH);
  });

  it("Card.tsx re-exports the three public legacy constants by identity", () => {
    expect(Card.SUBAGENT_GLYPH).toBe(SUBAGENT_GLYPH);
    expect(Card.SUBAGENT_COLOR).toBe(SUBAGENT_COLOR);
    expect(Card.PORT_CURSOR_GLYPH).toBe(PORT_CURSOR_GLYPH);
  });
});
