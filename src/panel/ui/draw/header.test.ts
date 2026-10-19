import { describe, it, expect } from "vitest";
import { Screen, lineText, lineWidth, type Line, type Seg } from "../screen.js";
import { cellWidth } from "../text.js";
import { SAMPLE_HEADER } from "../sample.js";
import type { HeaderModel } from "../models.js";
import { drawHeader, fmtClock24 } from "./header.js";

// Phase 9 plan 09-05 Task 2: the live header (row 0) per UI-SPEC § Header.

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

function header(cols: number, h: HeaderModel): Line {
  const scr = new Screen(cols, 1);
  drawHeader(scr, cols, h);
  return scr.toLines()[0] ?? [];
}

const UPDATE = "⬆ v1.7.1 available";

describe("drawHeader at 175 with SAMPLE_HEADER", () => {
  const l = header(175, SAMPLE_HEADER);
  const t = lineText(l);

  it("draws brand, count and chips in order", () => {
    expect(t.startsWith(" ◆ CSM   8 agents   1 asking   1 waiting   1 conflict")).toBe(true);
  });

  it("right-aligns the clock ending at cols-2", () => {
    expect(t.trimEnd().endsWith("22:18:58")).toBe(true);
    expect(lastInk(l)).toBe(173);
    expect(seg(l, "22:18:58")?.fg).toBe("#85827a");
  });

  it("colors brand, CSM and the agent count", () => {
    expect(segAt(l, 1)).toMatchObject({ text: "◆", fg: "#E8C24A" });
    expect(seg(l, "CSM")).toEqual({ text: "CSM", fg: "#f5f3ec", bold: true });
    expect(seg(l, "8 agents")).toEqual({ text: "8 agents", fg: "#85827a" });
  });

  it("draws the chips on their state colors", () => {
    expect(seg(l, " 1 asking ")).toEqual({ text: " 1 asking ", fg: "#1b1b19", bg: "#E86AD9", bold: true });
    expect(seg(l, " 1 waiting ")).toEqual({ text: " 1 waiting ", fg: "#1b1b19", bg: "#F2B33D", bold: true });
    expect(seg(l, " 1 conflict ")).toEqual({
      text: " 1 conflict ",
      fg: "#1b1b19",
      bg: "#F0545A",
      bold: true,
    });
  });

  it("never carries the sample chip (D-20)", () => {
    expect(l.some((s) => s.text.includes("sample"))).toBe(false);
  });
});

describe("drawHeader at 220", () => {
  it("ends the clock at x218", () => {
    const l = header(220, SAMPLE_HEADER);
    expect(lastInk(l)).toBe(218);
    expect(lineWidth(l)).toBeLessThanOrEqual(220);
  });
});

describe("drawHeader counts", () => {
  it("uses the singular for one agent", () => {
    const t = lineText(header(175, { ...SAMPLE_HEADER, agents: 1 }));
    expect(t).toContain(" 1 agent ");
    expect(t).not.toContain("1 agents");
  });

  it("pluralizes conflicts", () => {
    const l = header(175, { ...SAMPLE_HEADER, conflicts: 2 });
    expect(seg(l, " 2 conflicts ")?.bg).toBe("#F0545A");
  });

  it("draws no chip for a zero count", () => {
    const t = lineText(header(175, { ...SAMPLE_HEADER, asking: 0, waiting: 0, conflicts: 0 }));
    expect(t).not.toContain("asking");
    expect(t).not.toContain("waiting");
    expect(t).not.toContain("conflict");
    expect(t.startsWith(" ◆ CSM   8 agents ")).toBe(true);
  });

  it("only the non-zero chips appear, in order", () => {
    const t = lineText(header(175, { ...SAMPLE_HEADER, asking: 0 }));
    expect(t.startsWith(" ◆ CSM   8 agents   1 waiting   1 conflict")).toBe(true);
  });
});

describe("drawHeader update notice", () => {
  const l = header(175, { ...SAMPLE_HEADER, update: UPDATE });

  it("sits before the clock", () => {
    expect(lineText(l).trimEnd().endsWith(`${UPDATE} · 22:18:58`)).toBe(true);
    expect(lastInk(l)).toBe(173);
  });

  it("is dim bold, with a dim separator and dim clock", () => {
    expect(seg(l, UPDATE)).toEqual({ text: UPDATE, fg: "#85827a", bold: true });
    const sepClock = l.find((s) => s.text.includes("22:18:58"));
    expect(sepClock?.fg).toBe("#85827a");
    expect(sepClock?.bold).toBeUndefined();
    expect(lineText(l)).toContain(" · ");
  });

  it("is sanitized", () => {
    const t = lineText(header(175, { ...SAMPLE_HEADER, update: "\u001b]0;x\u0007⬆ v9 available" }));
    expect(t).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});

describe("drawHeader drop order", () => {
  const h: HeaderModel = { ...SAMPLE_HEADER, update: UPDATE };

  it("keeps everything at 120", () => {
    const t = lineText(header(120, h));
    expect(t).toContain(UPDATE);
    expect(t).toContain("22:18:58");
    expect(t).toContain("8 agents");
  });

  it("drops the update notice first (70)", () => {
    const t = lineText(header(70, h));
    expect(t).not.toContain("available");
    expect(t).toContain("22:18:58");
    expect(t).toContain("8 agents");
  });

  it("then the clock, then the agent count (50)", () => {
    const t = lineText(header(50, h));
    expect(t).not.toContain("available");
    expect(t).not.toContain("22:18:58");
    expect(t).not.toContain("agents");
    expect(t.startsWith(" ◆ CSM   1 asking   1 waiting   1 conflict")).toBe(true);
  });

  it.each([175, 120, 100, 80, 70, 60, 55, 50, 45, 40, 35, 30, 20, 10])(
    "brand and chips stay; width <= cols at %i",
    (cols) => {
      const l = header(cols, h);
      expect(lineWidth(l)).toBeLessThanOrEqual(cols);
      const t = lineText(l);
      expect(t.startsWith(" ◆ CSM")).toBe(cols >= 6);
      // the first chip always starts where the agent count would be dropped to
      if (cols >= 18) expect(t).toContain(" 1 asking ");
    },
  );

  it("drops the clock before the agent count", () => {
    // find a width where the clock is gone but the count stays
    let seen = false;
    for (let cols = 175; cols >= 30; cols--) {
      const t = lineText(header(cols, h));
      if (!t.includes("22:18:58") && t.includes("8 agents")) seen = true;
      if (t.includes("22:18:58")) expect(t).toContain("8 agents");
      if (t.includes(UPDATE)) expect(t).toContain("22:18:58");
    }
    expect(seen).toBe(true);
  });
});

describe("fmtClock24", () => {
  it("zero-pads local HH:MM:SS", () => {
    expect(fmtClock24(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe("03:04:05");
    expect(fmtClock24(new Date(2026, 9, 20, 23, 59, 9).getTime())).toBe("23:59:09");
    expect(fmtClock24(new Date(2026, 9, 20, 0, 0, 0).getTime())).toBe("00:00:00");
  });
});
