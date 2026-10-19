import { Screen, type Line } from "../screen.js";
import { truncateEnd } from "../text.js";
import { PALETTE } from "../palette.js";
import { V2 } from "../glyphs.js";
import { MIN_COLS, MIN_ROWS } from "../geometry.js";
import type { HeaderModel } from "../models.js";
import { drawHeader } from "./header.js";

/**
 * The "terminal too small" screen (Phase 9, plan 09-05; D-27, LAYOUT-04;
 * UI-SPEC § Terminal too small). Shown below MIN_COLS x MIN_ROWS.
 *
 *   row 0  the normal header (same drop rules; chips stay)
 *   row 2  ` terminal too small` (hi bold)
 *   row 3  ` now C×R · needs 60×16` (dim)
 *   row 4  ` enlarge the window, or press q to quit` (dim2)
 *
 * Each text starts at x1 and is cut with `…` to cols-1 cells; rows past `rows`
 * are dropped. Phase 9 renders it so the size invariants (lines <= rows, every
 * line width <= cols) hold at every terminal size.
 */
export function drawTooSmall(cols: number, rows: number, h: HeaderModel): Line[] {
  const c = Math.max(0, Math.floor(cols));
  const r = Math.max(0, Math.floor(rows));
  const scr = new Screen(c, r);
  drawHeader(scr, c, h);
  const cells = c - 1;
  const size = `now ${c}${V2.times}${r} ${V2.sep} needs ${MIN_COLS}${V2.times}${MIN_ROWS}`;
  scr.put(1, 2, truncateEnd("terminal too small", cells), { fg: PALETTE.hi, bold: true });
  scr.put(1, 3, truncateEnd(size, cells), { fg: PALETTE.dim });
  scr.put(1, 4, truncateEnd("enlarge the window, or press q to quit", cells), { fg: PALETTE.dim2 });
  return scr.toLines(Math.min(r, 5));
}
