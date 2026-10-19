import type { Screen } from "../screen.js";
import { cellWidth, oneLine, truncateEnd } from "../text.js";
import { PALETTE } from "../palette.js";
import { V2 } from "../glyphs.js";
import type { Hint } from "../keymap.js";
import type { Flash } from "../models.js";

/**
 * The v2 footer row (Phase 9, plan 09-05; UI-SPEC § Footer, § Keys-off footer).
 *
 *   - Legend at x1: `✎` (fg) ` written` (dim), 3 cells, `read` (blue),
 *     3 cells, `! conflict` (red).
 *   - Flash slot 6 cells after the legend: fg for neutral messages, running
 *     green when `ok`. Dynamic text, so it goes through the text boundary.
 *   - Hints right-aligned ending at cols-2: key (fg bold) + 1 cell + label
 *     (dim), pairs 3 cells apart. The hints are the `Hint[]` produced by
 *     `hintsFor(ui)` from the single keymap table: the footer never hard-codes
 *     key text (D-19).
 *   - Overflow, decided with `cellWidth` before drawing: drop hint pairs from
 *     the end (table order is priority order), then drop the legend, then
 *     truncate the flash with `…`, keeping at least 12 cells.
 *   - Keys off (D-21, KEYS-06): on a non-TTY the hint slot holds
 *     KEYS_OFF_NOTICE (dim, right-aligned) and no hint pair is drawn. No extra
 *     line is used, and PanelApp mounts no input handler in this case.
 */

export const KEYS_OFF_NOTICE = `${V2.keysOff} keys off — started without a TTY`;

const WRITTEN = " written";
const READ = "read";
const CONFLICT = `${V2.conflict} conflict`;
/** x just after the legend (30 with the V2 glyphs). */
const LEGEND_END = 1 + cellWidth(V2.write) + cellWidth(WRITTEN) + 3 + cellWidth(READ) + 3 + cellWidth(CONFLICT);
const FLASH_GAP = 6;
/** Blank cells kept between the left block and the right slot. */
const GAP = 3;
const PAIR_GAP = 3;
const FLASH_MIN = 12;

function pairsWidth(pairs: readonly Hint[]): number {
  if (pairs.length === 0) return 0;
  return pairs.reduce((s, h) => s + cellWidth(h.key) + 1 + cellWidth(h.label), 0) + PAIR_GAP * (pairs.length - 1);
}

export function drawFooter(
  scr: Screen,
  y: number,
  cols: number,
  o: { hints: readonly Hint[]; keysOff: boolean; flash: Flash | null },
): void {
  /** The right slot ends at cols-2 (exclusive end cols-1). */
  const rightEnd = cols - 1;
  let legend = true;
  let flash = o.flash ? oneLine(o.flash.text) : "";

  const flashStart = (): number => (legend ? LEGEND_END + FLASH_GAP : 1);
  const hasLeft = (): boolean => legend || flash !== "";
  const leftEnd = (): number => (flash !== "" ? flashStart() + cellWidth(flash) : legend ? LEGEND_END : 1);
  /** Earliest x for the right slot. */
  const minStart = (): number => (hasLeft() ? leftEnd() + GAP : 2);
  const truncFlash = (cells: number): void => {
    if (flash !== "") flash = truncateEnd(flash, Math.max(FLASH_MIN, cells));
  };

  const pairs: Hint[] = [];
  let notice = "";
  if (o.keysOff) {
    const nw = cellWidth(KEYS_OFF_NOTICE);
    const fits = (): boolean => minStart() + nw <= rightEnd;
    if (!fits()) legend = false;
    if (!fits()) truncFlash(rightEnd - nw - GAP - flashStart());
    notice = truncateEnd(KEYS_OFF_NOTICE, Math.min(nw, rightEnd - minStart()));
  } else {
    pairs.push(...o.hints);
    const fits = (): boolean =>
      pairs.length > 0 ? minStart() + pairsWidth(pairs) <= rightEnd : leftEnd() <= rightEnd;
    while (!fits() && pairs.length > 0) pairs.pop();
    if (!fits()) legend = false;
    if (!fits()) truncFlash(rightEnd - flashStart());
  }

  if (legend) {
    let x = scr.put(1, y, V2.write, { fg: PALETTE.fg });
    x = scr.put(x, y, WRITTEN, { fg: PALETTE.dim });
    x = scr.put(x + 3, y, READ, { fg: PALETTE.blue });
    scr.put(x + 3, y, CONFLICT, { fg: PALETTE.red });
  }
  if (flash !== "") {
    scr.put(flashStart(), y, flash, { fg: o.flash?.ok ? PALETTE.running : PALETTE.fg });
  }

  if (notice !== "") {
    scr.put(rightEnd - cellWidth(notice), y, notice, { fg: PALETTE.dim });
    return;
  }
  if (pairs.length === 0) return;
  let hx = rightEnd - pairsWidth(pairs);
  for (const h of pairs) {
    hx = scr.put(hx, y, h.key, { fg: PALETTE.fg, bold: true });
    hx = scr.put(hx + 1, y, h.label, { fg: PALETTE.dim }) + PAIR_GAP;
  }
}
