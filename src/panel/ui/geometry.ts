/**
 * The v2 horizontal geometry (Phase 9, plan 09-03).
 *
 * One pure call per terminal size, implementing every breakpoint of the
 * approved UI-SPEC § Layout & Breakpoints. There is no Ink measuring loop:
 * the shell asks `geometry(cols, rows)` and draws to the numbers it gets.
 *
 *   - D-28: the primary target is 175x55 (W2: LW/RW 96/74, divider x98,
 *     RX 101); the reference width is 220, the design file's width
 *     (W3: 145/70, divider x147, RX 150).
 *   - D-27: the narrow widths (S2 100-164 stacked with a bottom band, S1 60-99
 *     full-width stack) and the too-small threshold (< 60 cols or < 16 rows).
 *
 * Split modes (W3 at >= 214 cols with n = 3, W2 at 165-213 with n = 2):
 *   LWcards = 47n + 2(n-1)
 *   RW      = clamp(cols - LWcards - 5, RW_MIN, RW_MAX)
 *   LW      = cols - 5 - RW
 *   divX    = LW + 2     (the edge-colored divider)
 *   RX      = LW + 5     (the right column start; RX + RW === cols)
 *
 * Stacked modes are unsplit and full width (LW = RW = cols, RX = 0). S2 adds a
 * bottom `band` (PHASES|SESSIONS on the left, PORTS on the right) whose
 * divider runs only through that band.
 */

/** Below this many columns the panel shows the too-small screen. */
export const MIN_COLS = 60;
/** Below this many rows the panel shows the too-small screen. */
export const MIN_ROWS = 16;
/** Agent cards are always 47 cells wide and 7 rows tall (D-09). */
export const CARD_W = 47;
export const CARD_H = 7;
/** Card column pitch (47 + 2 gap) and row pitch (7 + 1 gap). */
export const CARD_PITCH_X = 49;
export const CARD_PITCH_Y = 8;
/** Right-column width clamp in split modes. */
export const RW_MIN = 64;
export const RW_MAX = 90;

const W3_MIN_COLS = 214;
const W2_MIN_COLS = 165;
const S2_MIN_COLS = 100;
/** Gutter between LW and RW: 2 spaces, the divider, 2 spaces. */
const GUTTER = 5;

export type LayoutMode = "W3" | "W2" | "S2" | "S1" | "small";

/** The S2 bottom band: PHASES|SESSIONS (left) | PORTS (right). */
export interface Band {
  leftW: number;
  divX: number;
  rightX: number;
  rightW: number;
}

export interface Geometry {
  mode: LayoutMode;
  cols: number;
  rows: number;
  /** True in W3/W2: AGENTS+FILES left, PHASES/SESSIONS+PORTS right. */
  split: boolean;
  /** Card columns in the AGENTS grid (0 only in `small`). */
  cardCols: number;
  /** Left column width (full width when not split). */
  LW: number;
  /** Right column width (full width when not split). */
  RW: number;
  /** Right column start x (0 when not split). */
  RX: number;
  /** Split divider x, or null when not split. */
  divX: number | null;
  /** The S2 bottom band, or null in every other mode. */
  band: Band | null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function toCells(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

/** The width a grid of `n` card columns needs. */
function cardsWidth(n: number): number {
  return CARD_W * n + 2 * (n - 1);
}

export function geometry(cols: number, rows: number): Geometry {
  const c = toCells(cols);
  const r = toCells(rows);

  if (c < MIN_COLS || r < MIN_ROWS) {
    return { mode: "small", cols: c, rows: r, split: false, cardCols: 0, LW: c, RW: c, RX: 0, divX: null, band: null };
  }

  if (c >= W2_MIN_COLS) {
    const n = c >= W3_MIN_COLS ? 3 : 2;
    const RW = clamp(c - cardsWidth(n) - GUTTER, RW_MIN, RW_MAX);
    const LW = c - GUTTER - RW;
    return {
      mode: n === 3 ? "W3" : "W2",
      cols: c,
      rows: r,
      split: true,
      cardCols: n,
      LW,
      RW,
      RX: LW + GUTTER,
      divX: LW + 2,
      band: null,
    };
  }

  const fit = Math.floor((c + 2) / CARD_PITCH_X);

  if (c >= S2_MIN_COLS) {
    const leftW = Math.floor((c - GUTTER) / 2);
    const rightX = leftW + GUTTER;
    return {
      mode: "S2",
      cols: c,
      rows: r,
      split: false,
      cardCols: Math.min(3, fit),
      LW: c,
      RW: c,
      RX: 0,
      divX: null,
      band: { leftW, divX: leftW + 2, rightX, rightW: c - rightX },
    };
  }

  return { mode: "S1", cols: c, rows: r, split: false, cardCols: fit, LW: c, RW: c, RX: 0, divX: null, band: null };
}
