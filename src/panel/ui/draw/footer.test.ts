import { describe, it, expect } from "vitest";
import { Screen, lineText, lineWidth, type Line, type Seg } from "../screen.js";
import { cellWidth } from "../text.js";
import { hintsFor, type Hint } from "../keymap.js";
import { initialUi } from "../uiState.js";
import type { Flash } from "../models.js";
import { drawFooter, KEYS_OFF_NOTICE } from "./footer.js";

// Phase 9 plan 09-05 Task 3: the footer (legend, flash, hints) and the
// keys-off notice per UI-SPEC § Footer / § Keys-off footer (D-21, KEYS-06).

function segAt(line: Line, x: number): Seg | undefined {
  let cx = 0;
  for (const s of line) {
    const w = cellWidth(s.text);
    if (x >= cx && x < cx + w) return s;
    cx += w;
  }
  return undefined;
}

const seg = (line: Line, t: string): Seg | undefined => line.find((s) => s.text === t);

function lastInk(line: Line): number {
  return cellWidth(lineText(line).replace(/ +$/, "")) - 1;
}

const HINTS = hintsFor(initialUi);

function footer(cols: number, o: { hints?: readonly Hint[]; keysOff?: boolean; flash?: Flash | null }): Line {
  const scr = new Screen(cols, 2);
  drawFooter(scr, 1, cols, { hints: o.hints ?? HINTS, keysOff: o.keysOff ?? false, flash: o.flash ?? null });
  return scr.toLines()[1] ?? [];
}

const LONG = "a".repeat(80);

describe("KEYS_OFF_NOTICE", () => {
  it("is the UI-SPEC copy", () => {
    expect(KEYS_OFF_NOTICE).toBe("⌨ keys off — started without a TTY");
  });
});

describe("drawFooter at 175, keys on", () => {
  const l = footer(175, {});
  const t = lineText(l);

  it("draws the legend", () => {
    expect(t.startsWith(" ✎ written   read   ! conflict")).toBe(true);
    expect(segAt(l, 1)).toMatchObject({ text: "✎", fg: "#d6d3cb" });
    expect(seg(l, " written")?.fg).toBe("#85827a");
    expect(seg(l, "read")?.fg).toBe("#6FA8FF");
    expect(seg(l, "! conflict")?.fg).toBe("#F0545A");
  });

  it("right-aligns the hints ending at cols-2", () => {
    expect(t.trimEnd().endsWith("tab focus   ←↑↓→ select agent   space pause files   r sessions   q quit")).toBe(
      true,
    );
    expect(lastInk(l)).toBe(173);
  });

  it("draws keys fg bold and descriptions dim", () => {
    for (const h of HINTS) {
      expect(seg(l, h.key), h.key).toEqual({ text: h.key, fg: "#d6d3cb", bold: true });
      expect(seg(l, h.label), h.label).toEqual({ text: h.label, fg: "#85827a" });
    }
  });

  it("hint text comes from the hints passed in", () => {
    const custom: Hint[] = [{ binding: "quit", key: "Q", label: "leave" }];
    expect(lineText(footer(175, { hints: custom })).trimEnd().endsWith("Q leave")).toBe(true);
  });
});

describe("drawFooter flash", () => {
  it("draws a neutral flash 6 cells after the legend in fg", () => {
    const l = footer(175, { flash: { text: "focusing checkout screen", ok: false } });
    expect(lineText(l)).toContain("! conflict      focusing checkout screen");
    expect(segAt(l, 36)).toMatchObject({ text: "focusing checkout screen", fg: "#d6d3cb" });
  });

  it("draws a success flash in green", () => {
    const l = footer(175, { flash: { text: "✓ copied", ok: true } });
    expect(seg(l, "✓ copied")?.fg).toBe("#5FD47A");
  });

  it("sanitizes the flash", () => {
    const t = lineText(footer(175, { flash: { text: "a\u001b[2Jb\u0007c", ok: false } }));
    expect(t).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});

describe("drawFooter overflow", () => {
  it("drops hint pairs from the end first", () => {
    const t100 = lineText(footer(100, {}));
    expect(t100).toContain("r sessions");
    expect(t100).not.toContain("q quit");
    expect(t100).toContain("written");

    const t90 = lineText(footer(90, {}));
    expect(t90).toContain("space pause files");
    expect(t90).not.toContain("r sessions");
    expect(t90).not.toContain("q quit");
  });

  it("keeps a full hint pair or none (never half a pair)", () => {
    for (let cols = 60; cols <= 175; cols++) {
      const t = lineText(footer(cols, {}));
      for (const h of HINTS) {
        expect(t.includes(`${h.key} ${h.label}`) || !t.includes(h.label), `${cols}:${h.label}`).toBe(true);
      }
    }
  });

  it("then drops the legend", () => {
    const l = footer(100, { flash: { text: LONG, ok: false } });
    const t = lineText(l);
    expect(t).not.toContain("written");
    expect(t).not.toContain("tab focus");
    expect(t).toContain(LONG);
    expect(segAt(l, 1)?.text).toBe(LONG);
  });

  it("then truncates the flash with an ellipsis", () => {
    const l = footer(50, { flash: { text: LONG, ok: false } });
    const f = l.find((s) => s.text.startsWith("aaa"));
    expect(f?.text.endsWith("…")).toBe(true);
    expect(cellWidth(f?.text ?? "")).toBeGreaterThanOrEqual(12);
    expect(lastInk(l)).toBeLessThanOrEqual(48);
  });

  it("keeps at least 12 flash cells at a tiny width", () => {
    const scr = new Screen(200, 1);
    drawFooter(scr, 0, 8, { hints: HINTS, keysOff: false, flash: { text: LONG, ok: false } });
    const f = (scr.toLines()[0] ?? []).find((s) => s.text.startsWith("aaa"));
    expect(cellWidth(f?.text ?? "")).toBe(12);
  });

  it("stays within cols at every width 60..175", () => {
    const flashes: Array<Flash | null> = [null, { text: "focusing checkout screen", ok: false }, { text: LONG, ok: true }];
    for (let cols = 60; cols <= 175; cols++) {
      for (const flash of flashes) {
        for (const keysOff of [false, true]) {
          expect(lineWidth(footer(cols, { flash, keysOff })), `${cols}`).toBeLessThanOrEqual(cols);
        }
      }
    }
  });
});

describe("drawFooter keys off (D-21, KEYS-06)", () => {
  it("replaces the hints with the dim notice at 175", () => {
    const l = footer(175, { keysOff: true });
    const t = lineText(l);
    expect(t.trimEnd().endsWith(KEYS_OFF_NOTICE)).toBe(true);
    expect(lastInk(l)).toBe(173);
    expect(seg(l, KEYS_OFF_NOTICE)?.fg).toBe("#85827a");
    expect(t).not.toContain("tab focus");
    expect(t).not.toContain("q quit");
    expect(t.startsWith(" ✎ written   read   ! conflict")).toBe(true);
  });

  it("drops the legend at 60 and keeps the notice whole", () => {
    const t = lineText(footer(60, { keysOff: true }));
    expect(t).not.toContain("written");
    expect(t).toContain(KEYS_OFF_NOTICE);
  });

  it("keeps the notice whole at 37", () => {
    expect(lineText(footer(37, { keysOff: true }))).toContain(KEYS_OFF_NOTICE);
  });

  it.each([36, 30, 20, 10])("truncates the notice with an ellipsis at %i", (cols) => {
    const l = footer(cols, { keysOff: true });
    const t = lineText(l).trim();
    expect(t.endsWith("…")).toBe(true);
    expect(t.startsWith("⌨")).toBe(true);
    expect(lineWidth(l)).toBeLessThanOrEqual(cols);
  });
});
