import { describe, it, expect } from "vitest";
import {
  cellWidth,
  graphemes,
  isControlCp,
  oneLine,
  truncateEnd,
  truncateStart,
  plainText,
  pathText,
  nameText,
} from "./text.js";

// Phase 9 plan 09-02 Task 1: the v2 text boundary. Every special code point is
// built with String.fromCharCode / String.fromCodePoint so this source stays
// plain ASCII (same convention as Card.test.tsx and label.test.ts).

const ESC = String.fromCharCode(27);
const E = String.fromCodePoint(0x2026); // ellipsis
const NBSP = String.fromCodePoint(0x00a0);
const RLO = String.fromCodePoint(0x202e);
const VS16 = String.fromCodePoint(0xfe0f);
const RUN = String.fromCodePoint(0x25b6);
const ACUTE = String.fromCodePoint(0x0301);
const CJK1 = String.fromCodePoint(0x4e2d);
const CJK2 = String.fromCodePoint(0x6587);
const THUMBS = String.fromCodePoint(0x1f44d);
const ZWJ = String.fromCodePoint(0x200d);
const FAMILY = [0x1f468, 0x1f469, 0x1f467].map((c) => String.fromCodePoint(c)).join(ZWJ);

/** Small deterministic PRNG (mulberry32) so the property test is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ["a", "b", "Z", "/", ".", " ", "7", CJK1, CJK2, THUMBS, FAMILY, "e" + ACUTE, "o" + ACUTE];

describe("cellWidth", () => {
  it("measures CJK, emoji, combining marks, bidi controls and VS16 sequences", () => {
    expect(cellWidth(CJK1 + CJK2)).toBe(4);
    expect(cellWidth(THUMBS)).toBe(2);
    expect(cellWidth("e" + ACUTE)).toBe(1);
    expect(cellWidth(RLO)).toBe(0);
    // Guard: appending VS16 to the run glyph makes it 2 cells (never append VS16).
    expect(cellWidth(RUN + VS16)).toBe(2);
  });
});

describe("graphemes / isControlCp", () => {
  it("never splits a ZWJ family or a combining pair", () => {
    expect(graphemes("a" + FAMILY + "e" + ACUTE)).toEqual(["a", FAMILY, "e" + ACUTE]);
  });

  it("flags C0, DEL and C1 only", () => {
    for (let cp = 0; cp <= 0x1f; cp++) expect(isControlCp(cp)).toBe(true);
    expect(isControlCp(0x7f)).toBe(true);
    for (let cp = 0x80; cp <= 0x9f; cp++) expect(isControlCp(cp)).toBe(true);
    expect(isControlCp(0x20)).toBe(false);
    expect(isControlCp(0x7e)).toBe(false);
    expect(isControlCp(0xa0)).toBe(false);
    expect(isControlCp(0x2026)).toBe(false);
  });
});

describe("oneLine", () => {
  it("collapses ASCII whitespace runs to one space", () => {
    expect(oneLine("a\n\tb  c")).toBe("a b c");
  });

  it("strips ESC (sanitize) but keeps the printable tail", () => {
    expect(oneLine("x" + ESC + "[31my")).toBe("x[31my");
  });

  it("keeps NBSP", () => {
    expect(oneLine("a" + NBSP + "b")).toBe("a" + NBSP + "b");
  });

  it("coerces undefined the same way sanitize does", () => {
    expect(oneLine(undefined)).toBe("undefined");
  });

  it("never lets a C0 or C1 code point survive", () => {
    const ws = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d]);
    const codes: number[] = [];
    for (let cp = 0; cp <= 0x1f; cp++) codes.push(cp);
    for (let cp = 0x80; cp <= 0x9f; cp++) codes.push(cp);
    for (const cp of codes) {
      const out = oneLine("x" + String.fromCodePoint(cp) + "y");
      for (const ch of out) expect(isControlCp(ch.codePointAt(0) ?? 0)).toBe(false);
      expect(out).toBe(ws.has(cp) ? "x y" : "xy");
    }
  });
});

describe("truncateEnd / truncateStart", () => {
  it("cuts at the end with an ellipsis", () => {
    expect(truncateEnd("abcdef", 4)).toBe("abc" + E);
  });

  it("returns a fitting string unchanged", () => {
    expect(truncateEnd("abc", 3)).toBe("abc");
  });

  it("never splits a wide grapheme (CJK at budget 5)", () => {
    const four = CJK1 + CJK2 + CJK1 + CJK2;
    const out = truncateEnd(four, 5);
    expect(out).toBe(CJK1 + CJK2 + E);
    expect(cellWidth(out)).toBe(5);
  });

  it("budget 0 (or less) returns the empty string", () => {
    expect(truncateEnd("abc", 0)).toBe("");
    expect(truncateStart("abc", 0)).toBe("");
    expect(truncateEnd("abc", -3)).toBe("");
  });

  it("truncateStart keeps the file-name tail", () => {
    const out = truncateStart("src/ui/Checkout.jsx", 12);
    expect(out).toBe(E + "heckout.jsx");
    expect(cellWidth(out)).toBe(12);
  });

  it("property: width <= budget and no grapheme is split (200 strings x budgets 0..30)", () => {
    const rand = rng(0x09_02);
    let cases = 0;
    for (let i = 0; i < 200; i++) {
      const len = Math.floor(rand() * 20);
      let s = "";
      for (let k = 0; k < len; k++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      const inputGraphemes = new Set(graphemes(s));
      for (let budget = 0; budget <= 30; budget++) {
        for (const fn of [truncateEnd, truncateStart]) {
          const out = fn(s, budget);
          expect(cellWidth(out)).toBeLessThanOrEqual(budget);
          for (const g of graphemes(out)) {
            if (g === E) continue;
            expect(inputGraphemes.has(g), `grapheme ${JSON.stringify(g)} of ${JSON.stringify(out)}`).toBe(true);
          }
        }
      }
      cases++;
    }
    expect(cases).toBeGreaterThanOrEqual(200);
  });
});

describe("plainText / pathText", () => {
  it("plainText = truncateEnd(oneLine(raw))", () => {
    expect(plainText("hello\n" + ESC + "world", 8)).toBe("hello w" + E);
  });

  it("pathText = truncateStart(oneLine(raw))", () => {
    expect(pathText("src/ui/\tCheckout.jsx", 9)).toBe(E + "kout.jsx");
  });
});

describe("nameText (NAME-02 pipeline)", () => {
  it("applies the 24-grapheme label cap (H4)", () => {
    expect(nameText("Logitech MK295 Mac tutukluluk sorunu", 41)).toBe("Logitech MK295 Mac tutuk" + E);
  });

  it("turns controls into a space (H5)", () => {
    expect(nameText("ev" + ESC + "[2Jil", 41)).toBe("ev [2Jil");
  });

  it("drops hidden bidi code points", () => {
    expect(nameText("ab" + RLO + "cd", 41)).toBe("abcd");
  });

  it("returns the empty string for a whitespace-only name", () => {
    expect(nameText("   ", 10)).toBe("");
  });

  it("width-truncates after the label cap", () => {
    expect(nameText("abcdefgh", 5)).toBe("abcd" + E);
  });
});
