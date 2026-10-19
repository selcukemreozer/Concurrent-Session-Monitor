import type { Screen, Seg, Style } from "../screen.js";
import { cellWidth, graphemes, plainText } from "../text.js";
import { PALETTE } from "../palette.js";
import { V2 } from "../glyphs.js";
import type { RightTab } from "../uiState.js";

/**
 * v2 pane titles and the right-column tabs (Phase 9, plan 09-05; D-02, D-20;
 * UI-SPEC § Pane title, § sample marker). A port of the design file's
 * `title()` and the tab row of `drawRight()`.
 *
 *   - Focused:   `▐LABEL▌` (caps hi, label bg-on-hi bold).
 *   - Unfocused: 1 cell, `LABEL` dim bold, 1 cell.
 *   - Then the optional ` sample ` chip (every pane filled from the fixture,
 *     T-09-10), any `extra` Segs, a 1-cell gap, a `─` rule (edge) and the
 *     right info (dim) right-aligned to the pane's last cell.
 *
 * Everything is clipped to [x, x + w): a title never paints outside its pane.
 * The right info is dynamic text and goes through `plainText` (T-09-01b).
 */

export const SAMPLE_CHIP = " sample ";

const CHIP_STYLE: Style = { fg: PALETTE.fg, bg: PALETTE.edge };
const INVERSE: Style = { fg: PALETTE.bg, bg: PALETTE.hi, bold: true };
const CAP: Style = { fg: PALETTE.hi };

/** Hard-cut `s` to at most `cells` cells (no ellipsis; whole graphemes only). */
function clip(s: string, cells: number): string {
  if (cells <= 0) return "";
  if (cellWidth(s) <= cells) return s;
  let out = "";
  let w = 0;
  for (const g of graphemes(s)) {
    const gw = cellWidth(g);
    if (w + gw > cells) break;
    out += g;
    w += gw;
  }
  return out;
}

/** Put `text` at (x, y) clipped to end at `end` (exclusive). Returns the next x. */
function putIn(scr: Screen, x: number, y: number, text: string, st: Style, end: number): number {
  const t = clip(text, end - x);
  if (t === "") return Math.max(x, Math.min(end, x + cellWidth(text)));
  scr.put(x, y, t, st);
  return x + cellWidth(t);
}

/** Draw `label` in the focused (inverse) style. Returns the next x. */
function putInverse(scr: Screen, x: number, y: number, label: string, end: number): number {
  let cx = putIn(scr, x, y, V2.capL, CAP, end);
  cx = putIn(scr, cx, y, label, INVERSE, end);
  return putIn(scr, cx, y, V2.capR, CAP, end);
}

export function drawTitle(
  scr: Screen,
  x: number,
  y: number,
  w: number,
  o: { label: string; focused: boolean; sample?: boolean; right?: string | null; extra?: readonly Seg[] },
): void {
  const end = x + w;
  let cx: number;
  if (o.focused) {
    cx = putInverse(scr, x, y, o.label, end);
  } else {
    cx = putIn(scr, x + 1, y, o.label, { fg: PALETTE.dim, bold: true }, end) + 1;
  }
  if (o.sample) cx = putIn(scr, cx, y, SAMPLE_CHIP, CHIP_STYLE, end);
  for (const s of o.extra ?? []) {
    const { text, ...st } = s;
    cx = putIn(scr, cx, y, text, st, end);
  }
  cx += 1;
  if (cx >= end) return;

  const right = o.right ? plainText(o.right, end - cx) : "";
  if (right === "") {
    for (; cx < end; cx++) scr.put(cx, y, V2.hline, { fg: PALETTE.edge });
    return;
  }
  const rx = end - cellWidth(right);
  for (; cx < rx - 1; cx++) scr.put(cx, y, V2.hline, { fg: PALETTE.edge });
  scr.put(rx, y, right, { fg: PALETTE.dim });
}

const TABS: ReadonlyArray<readonly [RightTab, string]> = [
  ["phases", "PHASES"],
  ["sessions", "SESSIONS"],
];

export function drawTabs(
  scr: Screen,
  x: number,
  y: number,
  w: number,
  o: { active: RightTab; columnFocused: boolean; sample: boolean },
): void {
  const end = x + w;
  let cx = x;
  for (const [tab, label] of TABS) {
    const act = o.active === tab;
    if (act && o.columnFocused) cx = putInverse(scr, cx, y, label, end);
    else if (act) cx = putIn(scr, cx, y, ` ${label} `, { fg: PALETTE.fg, bg: PALETTE.idle, bold: true }, end);
    else cx = putIn(scr, cx, y, ` ${label} `, { fg: PALETTE.dim2 }, end);
    cx += 1;
  }
  if (o.sample) cx = putIn(scr, cx, y, SAMPLE_CHIP, CHIP_STYLE, end) + 1;

  const rx = end - 3;
  if (rx < cx) return;
  for (; cx < rx - 1; cx++) scr.put(cx, y, V2.hline, { fg: PALETTE.edge });
  scr.put(rx, y, "[r]", { fg: PALETTE.dim });
}
