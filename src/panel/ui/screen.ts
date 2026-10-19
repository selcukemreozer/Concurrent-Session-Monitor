import { cellWidth, graphemes, isControlCp } from "./text.js";

/**
 * The v2 cell-buffer screen (Phase 9, plan 09-02; RESEARCH Pattern 1).
 *
 * A pure port of the design file's `Buf.put()` / `fill()` / `toRows()`: the
 * UI-SPEC is written in absolute cell offsets, so the shell draws into a
 * cols x rows grid and Ink only paints the resulting lines (ScreenView). That
 * makes "lines <= rows, every line width <= cols" true by construction (no Yoga
 * squash, Pitfall 1) and lets tests assert colors on `Seg` data, not ANSI.
 *
 * Callers still pass every untrusted string through `text.ts` first (sanitize
 * -> label cap -> width). `put` is a second line of defence: it drops any
 * grapheme carrying a C0/DEL/C1 code point and any zero-width grapheme (bidi
 * controls measure 0), so no Seg can ever carry a control byte (T-09-01/02).
 *
 * All widths go through `cellWidth` (text.ts), never the width library directly.
 */

export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
}

export interface Seg extends Style {
  text: string;
}

export type Line = Seg[];

/** A head cell holds one grapheme; `null` marks the right half of a wide grapheme. */
type Cell = { ch: string; st: Style } | null;

/** Copy only the defined style keys (bold only when true) so Segs stay minimal. */
function cleanStyle(st: Style | undefined): Style {
  const out: Style = {};
  if (st?.fg !== undefined) out.fg = st.fg;
  if (st?.bg !== undefined) out.bg = st.bg;
  if (st?.bold === true) out.bold = true;
  return out;
}

function sameStyle(a: Style, b: Style): boolean {
  return a.fg === b.fg && a.bg === b.bg && (a.bold === true) === (b.bold === true);
}

/** True when any code point of the grapheme is a C0/DEL/C1 control. */
function hasControl(g: string): boolean {
  for (const ch of g) {
    if (isControlCp(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

export class Screen {
  private readonly grid: Cell[][];

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.grid = [];
    for (let y = 0; y < rows; y++) {
      const row: Cell[] = [];
      for (let x = 0; x < cols; x++) row.push({ ch: " ", st: {} });
      this.grid.push(row);
    }
  }

  /**
   * Write `text` at cell (x, y). Graphemes outside the grid are clipped (a wide
   * grapheme that would cross the right edge is dropped whole); control and
   * zero-width graphemes are skipped. Returns the x just after the text, as if
   * nothing had been clipped.
   */
  put(x: number, y: number, text: string, st?: Style): number {
    const style = cleanStyle(st);
    const row = y >= 0 && y < this.rows ? this.grid[y] : undefined;
    let cx = x;
    for (const g of graphemes(String(text))) {
      if (hasControl(g)) continue;
      const w = cellWidth(g);
      if (w <= 0) continue;
      if (row && cx >= 0 && cx + w <= this.cols) this.write(row, cx, g, w, style);
      cx += w;
    }
    return cx;
  }

  /** Set the background of the in-range cells [x, x + w) on row y; characters stay. */
  fill(x: number, y: number, w: number, bg: string): void {
    if (y < 0 || y >= this.rows) return;
    const row = this.grid[y] as Cell[];
    const from = Math.max(0, x);
    const to = Math.min(this.cols, x + w);
    for (let i = from; i < to; i++) {
      const cell = row[i];
      if (cell) row[i] = { ch: cell.ch, st: { ...cell.st, bg } };
    }
  }

  /**
   * The grid as styled lines (at most `height` and at most `rows`): same-style
   * runs merged, wide-grapheme tails skipped, trailing unstyled blanks trimmed
   * (a blank with a bg is kept). An all-blank row is an empty Line.
   */
  toLines(height: number = this.rows): Line[] {
    const n = Math.max(0, Math.min(height, this.rows));
    const lines: Line[] = [];
    for (let y = 0; y < n; y++) {
      const row = this.grid[y] as Cell[];
      let end = row.length;
      while (end > 0) {
        const c = row[end - 1];
        if (c && c.ch === " " && c.st.bg === undefined) end--;
        else break;
      }
      const line: Line = [];
      for (let i = 0; i < end; i++) {
        const c = row[i];
        if (!c) continue;
        const last = line[line.length - 1];
        if (last && sameStyle(last, c.st)) last.text += c.ch;
        else line.push({ text: c.ch, ...c.st });
      }
      lines.push(line);
    }
    return lines;
  }

  /** Place grapheme g (width w) at column x, repairing any wide pair it splits. */
  private write(row: Cell[], x: number, g: string, w: number, st: Style): void {
    // Right side: a tail just past the new grapheme whose head we overwrite
    // becomes a space carrying the old head's style.
    let q = x + w;
    if (q < this.cols && row[q] === null) {
      let h = q - 1;
      while (h > 0 && row[h] === null) h--;
      const headSt = row[h]?.st ?? {};
      while (q < this.cols && row[q] === null) {
        row[q] = { ch: " ", st: { ...headSt } };
        q++;
      }
    }
    // Left side: overwriting a tail orphans its head (and any tails before x).
    if (row[x] === null) {
      let h = x - 1;
      while (h > 0 && row[h] === null) h--;
      const headSt = row[h]?.st ?? {};
      for (let i = h; i < x; i++) row[i] = { ch: " ", st: { ...headSt } };
    }
    row[x] = { ch: g, st: { ...st } };
    for (let i = 1; i < w; i++) row[x + i] = null;
  }
}

/** Concatenated text of a line. */
export function lineText(l: Line): string {
  return l.map((s) => s.text).join("");
}

/** Total cell width of a line. */
export function lineWidth(l: Line): number {
  let w = 0;
  for (const s of l) w += cellWidth(s.text);
  return w;
}
