import { describe, it, expect } from "vitest";
import { Screen, lineText, type Line } from "../screen.js";
import { cellWidth, graphemes } from "../text.js";
import { PALETTE } from "../palette.js";
import type { DetailModel } from "../models.js";
import { DETAIL_ROWS, drawDetail } from "./detail.js";

// Phase 10 plan 10-11 Task 1: the selection detail strip (UI-SPEC § Selection
// detail strip; 09 D-12, D-06, D-11, D-17; T-10-28).

interface Cell {
  ch: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

function cells(line: Line): Cell[] {
  const out: Cell[] = [];
  for (const s of line) {
    for (const g of graphemes(s.text)) {
      const c: Cell = { ch: g };
      if (s.fg !== undefined) c.fg = s.fg;
      if (s.bg !== undefined) c.bg = s.bg;
      if (s.bold) c.bold = true;
      out.push(c);
      for (let i = 1; i < cellWidth(g); i++) out.push({ ch: "" });
    }
  }
  return out;
}

const P = "move the coupon field into the cart summary, then recompute the total and run the tests";
const LONG = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");

const D: DetailModel = {
  id: "s1",
  name: "checkout screen",
  state: "running",
  uptime: "6m",
  model: "opus 4.7",
  intent: "checkout screen",
  branch: "main",
  ports: [
    { port: 3000, proc: "bun" },
    { port: 5173, proc: "vite" },
  ],
  prompt: P,
};

function draw(d: DetailModel, w = 96, h = DETAIL_ROWS, x = 0, y = 0, scrW = w, scrH = h) {
  const scr = new Screen(scrW, scrH);
  const used = drawDetail(scr, { x, y, w, h }, d);
  const lines = scr.toLines();
  return { scr, used, lines, text: lines.map(lineText) };
}

/** The cell index of `s` in row `y` of a frame's text. */
function indexOf(t: string, s: string): number {
  return Array.from(t.slice(0, t.indexOf(s))).length;
}

const REASONS = ["pane not findable", "not a Warp session", "process gone", "no Warp pane recorded"];

describe("drawDetail", () => {
  it("is 4 rows", () => {
    expect(DETAIL_ROWS).toBe(4);
  });

  it("draws the pill row, the segment row and the prompt at width 96", () => {
    const { text, used } = draw(D);
    expect(used).toBe(4);
    expect(text[0]!.startsWith("▐checkout screen▌ RUNNING · 6m · opus 4.7 ─")).toBe(true);
    expect(cellWidth(text[0]!)).toBe(96);
    expect(text[0]!.endsWith("─")).toBe(true);
    expect(text[1]).toBe("  » checkout screen    ⎇ main    :3000 bun, :5173 vite");
    expect(text[2]).toBe(`  › ${P}`);
    expect(text[3]).toBe("");
  });

  it("colors the pill, the caps, the label, the meta and the rule", () => {
    const { lines, text } = draw(D);
    const row0 = cells(lines[0]!);
    expect(row0[0]).toMatchObject({ ch: "▐", fg: PALETTE.running });
    expect(row0[0]!.bg).toBeUndefined();
    expect(row0[1]).toMatchObject({ ch: "c", fg: PALETTE.bg, bg: PALETTE.running, bold: true });
    expect(row0[16]).toMatchObject({ ch: "▌", fg: PALETTE.running });
    expect(row0[16]!.bg).toBeUndefined();
    expect(row0[18]).toMatchObject({ ch: "R", fg: PALETTE.running, bold: true });
    expect(row0[26]).toMatchObject({ fg: PALETTE.dim });
    expect(row0[95]).toMatchObject({ ch: "─", fg: PALETTE.edge });
    const row1 = cells(lines[1]!);
    expect(row1[2]).toMatchObject({ ch: "»", fg: PALETTE.dim });
    expect(row1[4]).toMatchObject({ ch: "c", fg: PALETTE.fg });
    const b = indexOf(text[1]!, "⎇");
    expect(row1[b]).toMatchObject({ fg: PALETTE.dim });
    expect(row1[b + 2]).toMatchObject({ ch: "m", fg: PALETTE.fg });
    const p = indexOf(text[1]!, ":3000");
    expect(row1[p]).toMatchObject({ ch: ":", fg: PALETTE.hi, bold: true });
    expect(row1[p + 6]).toMatchObject({ ch: "b", fg: PALETTE.dim });
    const row2 = cells(lines[2]!);
    expect(row2[2]).toMatchObject({ ch: "›", fg: PALETTE.dim });
    expect(row2[4]).toMatchObject({ ch: "m", fg: PALETTE.fg });
  });

  it("wraps a long prompt at w - 5 cells over 2 lines and ends with the ellipsis", () => {
    const { text } = draw({ ...D, prompt: LONG });
    expect(text[2]!.startsWith("  › word0 ")).toBe(true);
    expect(text[3]!.startsWith("    word")).toBe(true);
    expect(cellWidth(text[2]!)).toBeLessThanOrEqual(95);
    expect(cellWidth(text[3]!)).toBeLessThanOrEqual(95);
    expect(text[3]!.endsWith("…")).toBe(true);
    // the first line breaks on a word boundary
    expect(text[2]!.slice(4).split(" ").every((w) => /^word\d+$/.test(w))).toBe(true);
  });

  it("a prompt that fits in 2 lines has no ellipsis", () => {
    const two = Array.from({ length: 14 }, (_, i) => `word${i}`).join(" ");
    const { text } = draw({ ...D, prompt: two }, 60);
    expect(text[3]!.length).toBeGreaterThan(0);
    expect(text.join("")).not.toContain("…");
    expect(`${text[2]!.slice(4)} ${text[3]!.slice(4)}`).toBe(two);
  });

  it("hard-breaks a word longer than the line", () => {
    const { text } = draw({ ...D, prompt: "x".repeat(150) }, 60);
    expect(text[2]).toBe(`  › ${"x".repeat(55)}`);
    expect(text[3]).toBe(`    ${"x".repeat(54)}…`);
  });

  it("h 3 gives the prompt one line, ending with the ellipsis when longer", () => {
    const { text, used } = draw({ ...D, prompt: LONG }, 96, 3, 0, 0, 96, 5);
    expect(used).toBe(3);
    expect(text[2]!.endsWith("…")).toBe(true);
    expect(text[3] ?? "").toBe("");
  });

  it("h < 3 draws what fits from the top and nothing outside the rect", () => {
    for (const h of [0, 1, 2]) {
      const { text, used } = draw(D, 96, h, 0, 1, 96, 6);
      expect(used).toBe(h);
      expect(text[0] ?? "").toBe("");
      for (let y = 1 + h; y < 6; y++) expect(text[y] ?? "").toBe("");
      if (h >= 1) expect(text[1]!.startsWith("▐checkout")).toBe(true);
    }
  });

  it("stays inside a narrow rect offset in a wider screen", () => {
    const ports = Array.from({ length: 6 }, (_, i) => ({ port: 3000 + i, proc: "node" }));
    const { text } = draw({ ...D, prompt: LONG, ports }, 30, 4, 10, 0, 60, 4);
    for (const t of text) {
      expect(t.slice(0, 10).trim()).toBe("");
      expect(cellWidth(t)).toBeLessThanOrEqual(40);
    }
  });

  it("an unset intent reads `» —` in dim2", () => {
    const { text, lines } = draw({ ...D, intent: null });
    expect(text[1]!.startsWith("  » —    ⎇ main")).toBe(true);
    const row1 = cells(lines[1]!);
    expect(row1[2]).toMatchObject({ fg: PALETTE.dim2 });
    expect(row1[4]).toMatchObject({ ch: "—", fg: PALETTE.dim2 });
  });

  it("omits the ports segment without ports", () => {
    const { text } = draw({ ...D, ports: [] });
    expect(text[1]).toBe("  » checkout screen    ⎇ main");
  });

  it("shows the ports that fit then ` +N` (6 ports at width 60)", () => {
    const ports = Array.from({ length: 6 }, (_, i) => ({ port: 3000 + i, proc: "node" }));
    const { text } = draw({ ...D, ports }, 60);
    const t = text[1]!;
    expect(cellWidth(t)).toBeLessThanOrEqual(60);
    const m = / \+(\d+)$/.exec(t);
    expect(m).not.toBeNull();
    const shown = (t.match(/:\d+ node/g) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown + Number(m![1])).toBe(6);
    expect(t).toContain(":3000 node, :3001 node");
  });

  it("caps the intent at 32 and the branch at 20 cells", () => {
    const { text } = draw({ ...D, intent: "i".repeat(50), branch: "b".repeat(40), ports: [] }, 120);
    expect(text[1]).toBe(`  » ${"i".repeat(31)}…    ⎇ ${"b".repeat(19)}…`);
  });

  it("an idle selection uses the idle pill with hi text and the IDLE label in dim (D-17)", () => {
    const { text, lines } = draw({ ...D, state: "idle" });
    expect(text[0]!.startsWith("▐checkout screen▌ IDLE · 6m")).toBe(true);
    const row0 = cells(lines[0]!);
    expect(row0[0]).toMatchObject({ fg: PALETTE.idle });
    expect(row0[1]).toMatchObject({ fg: PALETTE.hi, bg: PALETTE.idle, bold: true });
    expect(row0[18]).toMatchObject({ ch: "I", fg: PALETTE.dim });
  });

  it("each state colors its pill", () => {
    for (const s of ["asking", "waiting", "subagent"] as const) {
      const row0 = cells(draw({ ...D, state: s }).lines[0]!);
      expect(row0[1]).toMatchObject({ bg: PALETTE[s] });
      expect(row0[18]).toMatchObject({ fg: PALETTE[s], bold: true });
    }
  });

  it("a missing model and prompt show the dash", () => {
    const { text } = draw({ ...D, model: null, prompt: null });
    expect(text[0]).toContain("RUNNING · 6m · — ─");
    expect(text[2]).toBe("  › —");
  });

  it("never lets escape or control bytes reach the Screen (T-10-28)", () => {
    const evil = "\u001b[31mred\u0007‮bidi\u009b2J";
    const { lines } = draw({
      ...D,
      name: evil,
      intent: evil,
      branch: evil,
      ports: [{ port: 1, proc: evil }],
      prompt: `${evil} ${evil}`,
      model: evil,
      uptime: evil,
    });
    for (const l of lines) {
      for (const c of cells(l)) {
        for (const ch of c.ch) {
          const cp = ch.codePointAt(0)!;
          expect(cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)).toBe(false);
        }
      }
    }
    // the name goes through the NAME-02 pipeline, which drops bidi controls
    expect(lineText(lines[0]!).slice(0, 12)).not.toContain("‮");
  });

  it("never shows a go-to reachability reason (D-11)", () => {
    for (const d of [D, { ...D, state: "idle" as const }, { ...D, intent: null, ports: [], prompt: null }]) {
      for (const w of [40, 96, 145]) {
        const all = draw(d, w).text.join("\n");
        for (const r of REASONS) expect(all).not.toContain(r);
        expect(all).not.toContain("unreachable");
      }
    }
  });
});
