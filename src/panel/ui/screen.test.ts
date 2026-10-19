import { describe, it, expect } from "vitest";
import { Screen, lineText, lineWidth, type Style } from "./screen.js";
import { isControlCp } from "./text.js";

// Phase 9 plan 09-02 Task 2: the pure cell-buffer Screen (port of the design
// file's Buf.put / fill / toRows). Special code points are built with
// String.fromCharCode / String.fromCodePoint so this source stays plain ASCII.

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI1 = String.fromCodePoint(0x9b);
const RLO = String.fromCodePoint(0x202e);
const CJK = String.fromCodePoint(0x4e2d);
const THUMBS = String.fromCodePoint(0x1f44d);
const ACUTE = String.fromCodePoint(0x0301);
const ZWJ = String.fromCodePoint(0x200d);
const FAMILY = [0x1f468, 0x1f469, 0x1f467].map((c) => String.fromCodePoint(c)).join(ZWJ);
const FG = "#f5f3ec";

/** mulberry32: deterministic PRNG for the randomized invariant. */
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

describe("Screen.put", () => {
  it("writes at a cell offset, returns the x after the text, trims trailing blanks", () => {
    const s = new Screen(10, 2);
    expect(s.put(1, 0, "ab", { fg: FG })).toBe(3);
    expect(s.toLines()[0]).toEqual([{ text: " " }, { text: "ab", fg: FG }]);
  });

  it("clips at the right edge and still advances x", () => {
    const s = new Screen(10, 1);
    expect(s.put(8, 0, "abcd")).toBe(12);
    expect(lineText(s.toLines()[0]!)).toBe("        ab");
  });

  it("clips at the left edge", () => {
    const s = new Screen(10, 1);
    expect(s.put(-1, 0, "ab")).toBe(1);
    expect(lineText(s.toLines()[0]!)).toBe("b");
  });

  it("writes nothing for an out-of-range row", () => {
    const s = new Screen(10, 2);
    s.put(0, 5, "x");
    s.put(0, -1, "y");
    expect(s.toLines()).toEqual([[], []]);
  });

  it("drops a wide grapheme that would cross the right edge, keeps it when it fits", () => {
    const a = new Screen(10, 1);
    expect(a.put(9, 0, CJK)).toBe(11);
    expect(a.toLines()[0]).toEqual([]);
    const b = new Screen(10, 1);
    b.put(8, 0, CJK);
    expect(lineText(b.toLines()[0]!)).toBe("        " + CJK);
    expect(lineWidth(b.toLines()[0]!)).toBe(10);
  });

  it("repairs a wide grapheme whose right half is overwritten", () => {
    const s = new Screen(10, 1);
    s.put(0, 0, CJK + "z", { fg: FG });
    s.put(1, 0, "x");
    const line = s.toLines()[0]!;
    expect(lineText(line)).toBe(" xz");
    expect(lineWidth(line)).toBeLessThanOrEqual(10);
  });

  it("repairs a wide grapheme whose left half is overwritten", () => {
    const s = new Screen(10, 1);
    s.put(0, 0, CJK + "z");
    s.put(0, 0, "x");
    expect(lineText(s.toLines()[0]!)).toBe("x z");
  });

  it("never lets ESC, BEL, C1 CSI or a zero-width RLO reach any Seg", () => {
    const s = new Screen(20, 1);
    const end = s.put(0, 0, "a" + ESC + "[2J" + BEL + CSI1 + RLO + "b");
    const text = lineText(s.toLines()[0]!);
    expect(text).toBe("a[2Jb");
    expect(end).toBe(5);
  });

  it("keeps ZWJ families and combining pairs whole", () => {
    const s = new Screen(10, 1);
    expect(s.put(0, 0, FAMILY + "e" + ACUTE)).toBe(3);
    expect(lineText(s.toLines()[0]!)).toBe(FAMILY + "e" + ACUTE);
  });
});

describe("Screen.fill", () => {
  it("sets bg on the cells and keeps their characters; styled blanks are not trimmed", () => {
    const s = new Screen(10, 1);
    s.put(0, 0, "abcd");
    s.fill(2, 0, 3, "#3a1a1b");
    expect(s.toLines()[0]).toEqual([
      { text: "ab" },
      { text: "cd ", bg: "#3a1a1b" },
    ]);
  });

  it("clips out-of-range cells", () => {
    const s = new Screen(4, 1);
    s.fill(-2, 0, 10, "#000000");
    s.fill(0, 3, 2, "#111111");
    expect(s.toLines()[0]).toEqual([{ text: "    ", bg: "#000000" }]);
  });
});

describe("Screen.toLines", () => {
  it("merges adjacent cells with an identical style", () => {
    const s = new Screen(10, 1);
    s.put(0, 0, "ab", { fg: FG, bold: true });
    s.put(2, 0, "cd", { fg: FG, bold: true });
    s.put(4, 0, "e", { fg: FG });
    expect(s.toLines()[0]).toEqual([
      { text: "abcd", fg: FG, bold: true },
      { text: "e", fg: FG },
    ]);
  });

  it("honours a height cap and returns an empty Line for a blank row", () => {
    const s = new Screen(5, 3);
    s.put(0, 2, "x");
    expect(s.toLines(1)).toEqual([[]]);
    expect(s.toLines(99)).toHaveLength(3);
    expect(s.toLines()[0]).toEqual([]);
  });

  it("does not share style objects between cells (fill does not leak)", () => {
    const st: Style = { fg: FG };
    const s = new Screen(4, 1);
    s.put(0, 0, "ab", st);
    s.fill(0, 0, 1, "#222222");
    expect(st.bg).toBeUndefined();
    expect(s.toLines()[0]).toEqual([
      { text: "a", fg: FG, bg: "#222222" },
      { text: "b", fg: FG },
    ]);
  });
});

describe("Screen invariant (randomized, 300 iterations)", () => {
  it("lines <= rows, width <= cols, no control code point in any Seg", () => {
    const rand = rng(0x0902_5c);
    const pool = ["a", "Z", " ", "-", CJK, THUMBS, FAMILY, "e" + ACUTE, ESC, BEL, CSI1, RLO, String.fromCharCode(0x7f), "\n"];
    const styles: Style[] = [{}, { fg: FG }, { fg: "#E8C24A", bold: true }, { bg: "#3a1a1b" }];
    let iterations = 0;
    for (let i = 0; i < 300; i++) {
      const cols = 1 + Math.floor(rand() * 20);
      const rows = 1 + Math.floor(rand() * 5);
      const s = new Screen(cols, rows);
      const ops = 1 + Math.floor(rand() * 12);
      for (let k = 0; k < ops; k++) {
        const x = Math.floor(rand() * (cols + 6)) - 3;
        const y = Math.floor(rand() * (rows + 2)) - 1;
        if (rand() < 0.2) {
          s.fill(x, y, Math.floor(rand() * 8), "#101010");
          continue;
        }
        let text = "";
        const n = Math.floor(rand() * 8);
        for (let j = 0; j < n; j++) text += pool[Math.floor(rand() * pool.length)];
        s.put(x, y, text, styles[Math.floor(rand() * styles.length)]);
      }
      const lines = s.toLines();
      expect(lines.length).toBeLessThanOrEqual(rows);
      for (const line of lines) {
        expect(lineWidth(line)).toBeLessThanOrEqual(cols);
        for (const seg of line) {
          for (const ch of seg.text) expect(isControlCp(ch.codePointAt(0) ?? 0)).toBe(false);
        }
      }
      iterations++;
    }
    expect(iterations).toBeGreaterThanOrEqual(300);
  });
});
