import { describe, it, expect } from "vitest";
import { Screen, type Line } from "../screen.js";
import { cellWidth, graphemes } from "../text.js";
import { SAMPLE } from "../sample.js";
import type { Flash, SessionEntry } from "../models.js";
import { drawSessions, drawSessionsWin } from "./sessions.js";

// Phase 9 plan 09-08 Task 1: the SESSIONS pane, the shipped OTURUMLAR look in
// English (08 D-15..D-17): cursor, name, ago, `. live`, the in-pane outcome
// line, scanning / empty copy and the windowed list.

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

const rowOf = (scr: Screen, y: number): Line => scr.toLines()[y] ?? [];
const cellAt = (scr: Screen, x: number, y: number): Cell => cells(rowOf(scr, y))[x] ?? { ch: " " };

function text(scr: Screen, y: number, from = 0, to = scr.cols): string {
  return cells(rowOf(scr, y))
    .slice(from, to)
    .map((c) => c.ch)
    .join("")
    .replace(/ +$/, "");
}

const GREEN = "#5FD47A";
const HI = "#f5f3ec";
const FG = "#d6d3cb";
const DIM = "#85827a";
const LIVE = "#4f9a62";

const X = 101;
const RECT = { x: X, y: 4, w: 74, h: 20 };

interface M {
  sessions: readonly SessionEntry[];
  focused: boolean;
  cursorId: string | null;
  status: Flash | null;
  scanning: boolean;
}

function pane(o: Partial<M> = {}, rect = RECT): { scr: Screen; rows: number } {
  const scr = new Screen(200, 40);
  const rows = drawSessions(scr, rect, {
    sessions: SAMPLE.sessions,
    focused: true,
    cursorId: SAMPLE.sessions[0]!.id,
    status: null,
    scanning: false,
    ...o,
  });
  return { scr, rows };
}

function paneText(scr: Screen, r = RECT): string[] {
  const out: string[] = [];
  for (let y = r.y; y < r.y + r.h; y++) out.push(text(scr, y, r.x, r.x + r.w));
  return out;
}

describe("drawSessions rows", () => {
  it("draws the cursor row at the contract offsets", () => {
    const { scr, rows } = pane();
    expect(text(scr, 4, X, X + 74)).toBe("▸ csm p8 plan                 now     · live");
    expect(cellAt(scr, X, 4)).toMatchObject({ ch: "▸", fg: HI, bold: true });
    expect(cellAt(scr, X + 2, 4)).toMatchObject({ ch: "c", fg: HI, bold: true });
    expect(cellAt(scr, X + 30, 4)).toMatchObject({ ch: "n", fg: DIM });
    expect(cellAt(scr, X + 38, 4)).toMatchObject({ ch: "·", fg: LIVE });
    expect(rows).toBe(11);
  });

  it("draws live names fg and non-live names dim", () => {
    const { scr } = pane();
    expect(cellAt(scr, X + 2, 5)).toMatchObject({ ch: "c", fg: FG });
    expect(cellAt(scr, X + 2, 5).bold).toBeUndefined();
    // row 12 = 9th session (mvp-dashboard-beta), not live
    expect(text(scr, 12, X, X + 74)).toBe("  mvp-dashboard-beta          3d");
    expect(cellAt(scr, X + 2, 12)).toMatchObject({ ch: "m", fg: DIM });
  });

  it("lists every session in order", () => {
    const { scr } = pane();
    const names = paneText(scr)
      .slice(0, 11)
      .map((l) => l.slice(2, 29).trim());
    expect(names).toEqual(SAMPLE.sessions.map((s) => s.name));
  });

  it("finds the cursor by id", () => {
    const { scr } = pane({ cursorId: SAMPLE.sessions[3]!.id });
    expect(cellAt(scr, X, 7)).toMatchObject({ ch: "▸" });
    expect(cellAt(scr, X, 4).ch).toBe(" ");
  });
});

describe("drawSessions unfocused", () => {
  it("draws a dim cursor and a non-bold name", () => {
    const { scr } = pane({ focused: false });
    expect(cellAt(scr, X, 4)).toMatchObject({ ch: "▸", fg: DIM });
    expect(cellAt(scr, X, 4).bold).toBeUndefined();
    expect(cellAt(scr, X + 2, 4).bold).toBeUndefined();
    expect(cellAt(scr, X + 2, 4)).toMatchObject({ fg: FG });
  });
});

describe("drawSessions status line", () => {
  it("draws a success status after a spacer row", () => {
    const { scr, rows } = pane({ status: { text: "opened", ok: true } });
    expect(text(scr, 15, X, X + 74)).toBe("");
    expect(text(scr, 16, X, X + 74)).toBe("  ✓ opened");
    expect(cellAt(scr, X + 2, 16)).toMatchObject({ ch: "✓", fg: GREEN, bold: true });
    expect(cellAt(scr, X + 4, 16)).toMatchObject({ ch: "o", fg: FG });
    expect(rows).toBe(13);
  });

  // 10-13: a success message that already carries the check gets no second one.
  it("draws `copied ✓` green bold at x2 with no leading check", () => {
    const { scr, rows } = pane({ status: { text: "copied ✓", ok: true } });
    expect(text(scr, 16, X, X + 74)).toBe("  copied ✓");
    expect(cellAt(scr, X + 2, 16)).toMatchObject({ ch: "c", fg: GREEN, bold: true });
    expect(cellAt(scr, X + 9, 16)).toMatchObject({ ch: "✓", fg: GREEN, bold: true });
    expect(rows).toBe(13);
  });

  it("draws a non-success status at x+2 with no glyph", () => {
    const { scr } = pane({ status: { text: "session is no longer on disk", ok: false } });
    expect(text(scr, 16, X, X + 74)).toBe("  session is no longer on disk");
    expect(cellAt(scr, X + 2, 16)).toMatchObject({ ch: "s", fg: FG });
  });

  it("sanitizes the status text", () => {
    const { scr } = pane({ status: { text: "bad\u001b]0;x\u0007\nnews", ok: false } });
    expect(text(scr, 16, X, X + 74)).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});

describe("drawSessions scanning and empty", () => {
  it("shows scanning with no sessions", () => {
    const { scr, rows } = pane({ sessions: [], scanning: true, cursorId: null });
    expect(text(scr, 4, X, X + 74)).toBe("  scanning…");
    expect(cellAt(scr, X + 2, 4)).toMatchObject({ fg: DIM });
    expect(rows).toBe(1);
  });

  it("shows no resumable sessions when empty", () => {
    const { scr } = pane({ sessions: [], scanning: false, cursorId: null });
    expect(text(scr, 4, X, X + 74)).toBe("  no resumable sessions");
    expect(cellAt(scr, X + 2, 4)).toMatchObject({ fg: DIM });
  });
});

describe("drawSessions windowing", () => {
  it("keeps the cursor visible and counts every hidden session", () => {
    const r = { x: X, y: 4, w: 74, h: 5 };
    const { scr, rows } = pane({ cursorId: SAMPLE.sessions[8]!.id }, r);
    expect(rows).toBeLessThanOrEqual(5);
    const all = paneText(scr, r);
    expect(all.some((l) => l.startsWith("▸ mvp-dashboard-beta"))).toBe(true);
    const up = Number(/↑ (\d+) more/.exec(all.find((l) => l.includes("↑")) ?? "")?.[1] ?? 0);
    const down = Number(/↓ (\d+) more/.exec(all.find((l) => l.includes("↓")) ?? "")?.[1] ?? 0);
    const visible = all.filter((l) => /^[▸ ] \S/.test(l) && !/^ {2}[↑↓]/.test(l)).length;
    expect(up + visible + down).toBe(11);
    for (let y = 4 + 5; y < 40; y++) expect(text(scr, y)).toBe("");
  });
});

describe("drawSessions narrow width", () => {
  it("keeps every row inside w=40 and drops live when it does not fit", () => {
    const r = { x: X, y: 4, w: 40, h: 20 };
    const { scr } = pane({ status: { text: "x".repeat(80), ok: true } }, r);
    for (let y = 0; y < 40; y++) expect(text(scr, y, X + 40)).toBe("");
    for (const l of paneText(scr, r)) expect(l.includes("live")).toBe(false);
    expect(text(scr, 4, X, X + 40)).toBe("▸ csm p8 plan                 now");
  });

  it("caps a wide name to 27 cells so the ago column holds", () => {
    const wide = [{ id: "a", name: "漢".repeat(30), ago: "1m", live: true }];
    const { scr } = pane({ sessions: wide, cursorId: "a" });
    expect(cellAt(scr, X + 30, 4)).toMatchObject({ ch: "1", fg: DIM });
    expect(cellAt(scr, X + 38, 4).ch).toBe("·");
    expect(cellAt(scr, X + 29, 4).ch).toBe(" ");
  });

  it("drops the name of control bytes (plainText)", () => {
    const evil = [{ id: "a", name: "ev\u001b[2Jil\u0007", ago: "1m", live: false }];
    const { scr } = pane({ sessions: evil, cursorId: "a" });
    expect(text(scr, 4, X, X + 74)).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});

// Phase 10 plan 10-13 (LAYOUT-02, Pattern 3): the window-reporting variant.
describe("drawSessionsWin sticky window", () => {
  const many: SessionEntry[] = Array.from({ length: 30 }, (_, i) => ({
    id: `s${i}`,
    name: `session ${i}`,
    ago: `${i}m`,
    live: false,
  }));
  const r = { x: X, y: 4, w: 74, h: 10 };

  function step(cursor: number, offset: number): { scr: Screen; win: ReturnType<typeof drawSessionsWin> } {
    const scr = new Screen(200, 40);
    const win = drawSessionsWin(scr, r, {
      sessions: many,
      focused: true,
      cursorId: many[cursor]!.id,
      status: null,
      scanning: false,
      offset,
    });
    return { scr, win };
  }

  it("does not move until the cursor needs the margin, then moves by one, and stays on the way back", () => {
    const seen: Array<[number, number]> = [];
    let off = 0;
    for (const c of [0, 7, 8, 9, 7]) {
      const { scr, win } = step(c, off);
      off = win.offset;
      seen.push([win.offset, win.visible]);
      const lines = paneText(scr, r);
      const at = lines.findIndex((l) => l.startsWith("▸ "));
      expect(lines[at]).toBe(`▸ session ${c}`.padEnd(30) + `${c}m`);
    }
    expect(seen).toEqual([
      [0, 9],
      [0, 9],
      [2, 8],
      [3, 8],
      [3, 8],
    ]);
  });

  it("reports the items drawn and keeps the counts exact", () => {
    const { scr, win } = step(9, 3);
    const lines = paneText(scr, r);
    const up = Number(/↑ (\d+) more/.exec(lines[0]!)?.[1]);
    const down = Number(/↓ (\d+) more/.exec(lines.find((l) => l.includes("↓"))!)?.[1]);
    expect(up).toBe(win.offset);
    expect(up + win.visible + down).toBe(30);
  });

  it("clamps a stale offset after a resize instead of keeping it", () => {
    const scr = new Screen(200, 60);
    const tall = { x: X, y: 4, w: 74, h: 40 };
    const win = drawSessionsWin(scr, tall, {
      sessions: many,
      focused: true,
      cursorId: "s29",
      status: null,
      scanning: false,
      offset: 25,
    });
    expect(win).toMatchObject({ offset: 0, visible: 30 });
    expect(text(scr, 4, X, X + 74)).toMatch(/^ {2}session 0 /);
  });

  it("drawSessions returns the rows of drawSessionsWin and draws the same frame", () => {
    const a = new Screen(200, 40);
    const b = new Screen(200, 40);
    const m = { sessions: SAMPLE.sessions, focused: true, cursorId: SAMPLE.sessions[0]!.id, status: null, scanning: false };
    const rows = drawSessions(a, RECT, m);
    const win = drawSessionsWin(b, RECT, m);
    expect(win.rows).toBe(rows);
    expect(b.toLines()).toEqual(a.toLines());
    expect(win).toMatchObject({ offset: 0, visible: SAMPLE.sessions.length });
  });
});
