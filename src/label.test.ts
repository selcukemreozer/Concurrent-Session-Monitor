import { describe, it, expect } from "vitest";

// RED (07-02): src/label.ts is the shared session-label module (D-06..D-09, NAME-02).
import {
  NAME_CAP,
  ELLIPSIS,
  UNNAMED,
  cleanTitle,
  truncateLabel,
  displayName,
  labelLead,
} from "./label.js";

// Control / invisible characters are built from code points so the test
// source itself stays free of literal control or invisible bytes.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b);
const TAB = String.fromCharCode(0x09);
const NBSP = String.fromCharCode(0x00a0);
const E = String.fromCodePoint(0x2026);
const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
const PAIR = "e" + String.fromCodePoint(0x0301);

function graphemes(s: string): string[] {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(seg.segment(s), (x) => x.segment);
}

describe("constants", () => {
  it("NAME_CAP is 24 (D-09)", () => {
    expect(NAME_CAP).toBe(24);
  });

  it("UNNAMED is the (unnamed) hint (D-06/D-07)", () => {
    expect(UNNAMED).toBe("(unnamed)");
  });

  it("ELLIPSIS is the single code point U+2026", () => {
    expect(ELLIPSIS).toBe(E);
    expect(ELLIPSIS.length).toBe(1);
  });
});

describe("truncateLabel (D-09 24-grapheme cap)", () => {
  it("returns a short string unchanged", () => {
    expect(truncateLabel("short")).toBe("short");
  });

  it("returns a string of exactly 24 graphemes unchanged", () => {
    const s = "abcdefghijklmnopqrstuvwx";
    expect(s.length).toBe(24);
    expect(truncateLabel(s)).toBe(s);
  });

  it("caps a 25-grapheme string to 24 plus the ellipsis", () => {
    expect(truncateLabel("abcdefghijklmnopqrstuvwxy")).toBe("abcdefghijklmnopqrstuvwx" + E);
  });

  it("renders the lockstep fixture 'Logitech MK295 Mac tutukluluk sorunu'", () => {
    expect(truncateLabel("Logitech MK295 Mac tutukluluk sorunu")).toBe(
      "Logitech MK295 Mac tutuk" + E,
    );
  });

  it("never splits a ZWJ emoji sequence", () => {
    const out = truncateLabel(FAMILY.repeat(25));
    expect(out).toBe(FAMILY.repeat(24) + E);
    const g = graphemes(out);
    expect(g.length).toBe(25);
    for (const cluster of g.slice(0, 24)) expect(cluster).toBe(FAMILY);
    expect(g[24]).toBe(E);
  });

  it("never leaves a dangling combining mark", () => {
    const out = truncateLabel(PAIR.repeat(25));
    expect(out).toBe(PAIR.repeat(24) + E);
    const g = graphemes(out);
    expect(g.length).toBe(25);
    for (const cluster of g.slice(0, 24)) expect(cluster).toBe(PAIR);
  });

  it("honors an explicit max", () => {
    expect(truncateLabel("abcdefgh", 5)).toBe("abcde" + E);
    expect(truncateLabel("abcde", 5)).toBe("abcde");
  });
});

describe("cleanTitle (sanitize first, then bidi strip, collapse, trim)", () => {
  it("drops ESC so an ANSI clear-screen cannot reach the terminal (T-07-01)", () => {
    const out = cleanTitle(ESC + "[2J" + "abc");
    expect(out).toBe("[2Jabc");
    expect(out).not.toContain(ESC);
  });

  it("drops the U+202E right-to-left override (T-07-02)", () => {
    expect(cleanTitle("abc" + String.fromCodePoint(0x202e) + "def")).toBe("abcdef");
  });

  it("drops every listed bidi/format code point", () => {
    const cps = [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    for (const cp of cps) {
      expect(cleanTitle("a" + String.fromCodePoint(cp) + "b")).toBe("ab");
    }
  });

  it("collapses whitespace runs (incl. NBSP) and trims", () => {
    expect(cleanTitle("  foo " + NBSP + "  bar  ")).toBe("foo bar");
  });

  it("drops a TAB via sanitize, then collapses the surrounding whitespace", () => {
    expect(cleanTitle("foo " + TAB + " bar")).toBe("foo bar");
  });

  it("returns an empty string for a non-string input", () => {
    expect(cleanTitle(undefined)).toBe("");
    expect(cleanTitle(null)).toBe("");
    expect(cleanTitle(42)).toBe("");
    expect(cleanTitle({ title: "x" })).toBe("");
  });
});

describe("displayName (NAME-02 unnamed detection, D-09 order)", () => {
  it("returns undefined for undefined", () => {
    expect(displayName(undefined)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(displayName(null)).toBeUndefined();
  });

  it("returns undefined for a number", () => {
    expect(displayName(42)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(displayName("")).toBeUndefined();
  });

  it("returns undefined for a whitespace-only string", () => {
    expect(displayName("   ")).toBeUndefined();
  });

  it("returns undefined for a control-only string", () => {
    expect(displayName(ESC + BEL + CSI + TAB)).toBeUndefined();
  });

  it("does not count stripped control characters toward the cap (T-07-06)", () => {
    const controls = (ESC + BEL + CSI).repeat(3) + ESC; // ten control characters
    expect(controls.length).toBe(10);
    const out = displayName("a".repeat(20) + controls + "b");
    expect(out).toBe("a".repeat(20) + "b");
    expect(out).not.toContain(E);
  });

  it("caps a long clean name to 24 graphemes plus the ellipsis", () => {
    expect(displayName("Logitech MK295 Mac tutukluluk sorunu")).toBe("Logitech MK295 Mac tutuk" + E);
  });
});

describe("labelLead (NAME-02 never-blank lead, D-07)", () => {
  it("returns the display name when the session is named", () => {
    expect(labelLead({ title: "My Name", folder: "proj" })).toBe("My Name");
  });

  it("returns the folder when no title is set", () => {
    expect(labelLead({ folder: "proj" })).toBe("proj");
  });

  it("falls back to the sanitized folder for a whitespace-only title", () => {
    expect(labelLead({ title: "   ", folder: "pr" + ESC + "oj" })).toBe("proj");
  });

  it("never appends the (unnamed) hint", () => {
    expect(labelLead({ folder: "proj" })).not.toContain(UNNAMED);
    expect(labelLead({ title: "", folder: "proj" })).not.toContain(UNNAMED);
    expect(labelLead({ title: "x", folder: "proj" })).not.toContain(UNNAMED);
  });
});
