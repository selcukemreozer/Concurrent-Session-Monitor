import type { Screen, Style } from "../screen.js";
import { cellWidth, graphemes, nameText, plainText } from "../text.js";
import { PALETTE } from "../palette.js";
import { V2 } from "../glyphs.js";
import type { PortEntry, Rect } from "../models.js";
import { windowSlice } from "../viewport.js";
import { drawTitle } from "./title.js";

/**
 * The v2 PORTS pane (Phase 9, plan 09-08; D-02, D-06; UI-SPEC section PORTS,
 * the approved 175x55 frame rows 27-34). A port of the design file's
 * `drawPorts()` with the English copy.
 *
 *   - Title `PORTS` with the sample chip; the right info `N ports` only when
 *     focused. Rows start on `r.y + 2` (one spacer row under the title).
 *   - Unfocused: only agent-owned and exposed ports, then `+N others` (dim2,
 *     x2). Focused: every port, the cursor (hi bold, x0) and `pid N` (dim2)
 *     right-aligned to the pane's last cell.
 *   - Row: `:port` at x2 (hi bold, or red bold when exposed), proc at x10
 *     (dim, 11 cells), `^ exposed` at x22 (red bold). Exposed is always red,
 *     never magenta: magenta is the asking state only (D-06). An owned port
 *     gets a second row: `-> agent` (dim) at x4.
 *   - Narrow pane (w < 64, stacked modes only): `pid` drops first, then the
 *     proc column (below 31 cells, where `^ exposed` moves to x10). `:port`,
 *     `^ exposed` and the cursor never drop.
 *   - Windowed with `windowSlice` (an owned port is a 2-row item) and
 *     `^ N more` / `v N more` (dim, x2). The cursor is matched by
 *     `PortEntry.key`, never by index.
 *   - Empty: `no listening ports` (dim, x2).
 *
 * The port action menu (D-17), the kill / SIGKILL confirm rows (D-18) and the
 * inline name field are [P11] / [P12]: those phases draw them under the
 * selected port's block at the UI-SPEC offsets. Phase 9 never draws them
 * (T-09-11b).
 *
 * The proc goes through `plainText` and the owner agent through `nameText`
 * (T-09-01d); every piece is clipped to the rect. Returns the rows used,
 * counted from `r.y` (the title row). Pure.
 */

export interface PortsModel {
  ports: readonly PortEntry[];
  focused: boolean;
  cursorKey: string | null;
  sample: boolean;
}

const PORT_X = 2;
const PROC_X = 10;
const PROC_W = 11;
const EXPOSED_X = 22;
const OWNER_X = 4;
/** Below this width the pid column drops (UI-SPEC narrow PORTS rule). */
const PID_MIN_W = 64;
/** Below this width the proc column drops (`^ exposed` at x22 needs 31 cells). */
const PROC_MIN_W = EXPOSED_X + 9;
const EXPOSED = `${V2.exposed} exposed`;
/** U+2014, shown for an owner that cleans to nothing. */
const DASH = "\u2014";

const DIM: Style = { fg: PALETTE.dim };
const DIM2: Style = { fg: PALETTE.dim2 };
const RED_BOLD: Style = { fg: PALETTE.red, bold: true };
const HI_BOLD: Style = { fg: PALETTE.hi, bold: true };

/** Put `text` at (x, y), hard-clipped to end before `end`. */
function putIn(scr: Screen, x: number, y: number, text: string, st: Style, end: number): void {
  let out = "";
  let w = 0;
  for (const g of graphemes(text)) {
    const gw = cellWidth(g);
    if (x + w + gw > end) break;
    out += g;
    w += gw;
  }
  if (out !== "") scr.put(x, y, out, st);
}

/** The ports a pane shows: owned + exposed when unfocused, all when focused. */
export function visiblePortEntries(
  ports: readonly PortEntry[],
  focused: boolean,
): { shown: PortEntry[]; others: number } {
  if (focused) return { shown: [...ports], others: 0 };
  const shown = ports.filter((p) => p.owner !== null || p.exposed);
  return { shown, others: ports.length - shown.length };
}

export function drawPortsPane(scr: Screen, r: Rect, m: PortsModel): number {
  if (r.w <= 0 || r.h <= 0) return 0;
  const n = m.ports.length;
  drawTitle(scr, r.x, r.y, r.w, {
    label: "PORTS",
    focused: m.focused,
    sample: m.sample,
    right: m.focused ? `${n} ${n === 1 ? "port" : "ports"}` : null,
  });
  if (r.h < 3) return 1;

  const x = r.x;
  const end = r.x + r.w;
  const put = (dx: number, y: number, text: string, st: Style): void => putIn(scr, x + dx, y, text, st, end);
  let y = r.y + 2;

  if (n === 0) {
    put(PORT_X, y, plainText("no listening ports", r.w - PORT_X), DIM);
    return 3;
  }

  const { shown, others } = visiblePortEntries(m.ports, m.focused);
  let listH = r.h - 2;
  const showOthers = others > 0 && listH >= 2;
  if (showOthers) listH -= 1;

  const cursor = m.focused && m.cursorKey !== null ? shown.findIndex((p) => p.key === m.cursorKey) : -1;
  const win = windowSlice({
    len: shown.length,
    height: listH,
    cursor,
    offset: 0,
    heights: shown.map((p) => (p.owner !== null ? 2 : 1)),
  });
  // Item rows stop before the down row so a clipped item never pushes it out.
  const itemLimit = r.y + 2 + listH - (win.down ? 1 : 0);
  const showPid = m.focused && r.w >= PID_MIN_W;
  const showProc = r.w >= PROC_MIN_W;

  if (win.up) put(PORT_X, y++, `${V2.up} ${win.above} more`, DIM);
  for (let i = win.start; i < win.end && y < itemLimit; i++) {
    const p = shown[i]!;
    if (i === cursor) put(0, y, V2.cursor, HI_BOLD);
    put(PORT_X, y, `:${Math.trunc(p.port)}`, p.exposed ? RED_BOLD : HI_BOLD);
    if (showProc) put(PROC_X, y, plainText(p.proc, PROC_W), DIM);
    if (p.exposed) put(showProc ? EXPOSED_X : PROC_X, y, EXPOSED, RED_BOLD);
    if (showPid) {
      const t = `pid ${Math.trunc(p.pid)}`;
      put(r.w - cellWidth(t), y, t, DIM2);
    }
    y++;
    if (p.owner !== null && y < itemLimit) {
      const owner = nameText(p.owner, r.w - OWNER_X - 2) || DASH;
      put(OWNER_X, y, `${V2.owner} ${owner}`, DIM);
      y++;
    }
  }
  if (win.down) put(PORT_X, y++, `${V2.down} ${win.below} more`, DIM);
  if (showOthers) put(PORT_X, y++, `+${others} others`, DIM2);

  return y - r.y;
}
