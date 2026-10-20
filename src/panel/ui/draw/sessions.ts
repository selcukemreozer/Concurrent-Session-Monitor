import type { Screen, Style } from "../screen.js";
import { cellWidth, graphemes, plainText } from "../text.js";
import { PALETTE } from "../palette.js";
import { V2 } from "../glyphs.js";
import type { Flash, Rect, SessionEntry } from "../models.js";
import { windowSlice } from "../viewport.js";

/**
 * The v2 SESSIONS pane (Phase 9, plan 09-08; UI-SPEC section SESSIONS). The
 * look of the shipped 1.6.x OTURUMLAR resume list (08 D-15..D-17) in English,
 * with its behavior unchanged.
 *
 *   - One row per session from `r.y`: the cursor (x0; hi bold when focused,
 *     dim otherwise), the name (x2, at most min(27, w-3) cells), the ago (x30,
 *     dim) and `. live` (x38, the live green). The cursor row's name is hi bold
 *     when focused; otherwise live names are fg and the rest dim. The ago and
 *     the live marker are drawn only when they fit inside `w` (T-09-02e).
 *   - The list is windowed with `windowSlice` and `^ N more` / `v N more`
 *     (dim, x2). The cursor is found by session id, never by index.
 *   - The outcome line sits in the pane after a spacer row: a success draws
 *     the check (green bold, x2) and the message (fg, x4); any other outcome
 *     draws the message at x2 with no glyph. The outcome strings are the 1.6.x
 *     `launch.ts` copy, verbatim (UI-SPEC); Phase 10 passes them in as `status`.
 *   - With no sessions: `scanning...` while the first scan runs, otherwise
 *     `no resumable sessions` (dim, x2).
 *
 * Names and the status go through `plainText` (sanitize-drop, the same
 * pipeline as the shipped OTURUMLAR pane; T-08-01, T-09-01d). Every piece is
 * clipped to the rect. Returns the rows used, counted from `r.y`. Pure.
 */

export interface SessionsModel {
  sessions: readonly SessionEntry[];
  focused: boolean;
  cursorId: string | null;
  status: Flash | null;
  scanning: boolean;
}

const NAME_X = 2;
const NAME_MAX = 27;
const AGO_X = 30;
const AGO_W = 7;
const LIVE_X = 38;
const LIVE = `${V2.sep} live`;

const DIM: Style = { fg: PALETTE.dim };

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

export function drawSessions(scr: Screen, r: Rect, m: SessionsModel): number {
  if (r.w <= 0 || r.h <= 0) return 0;
  const x = r.x;
  const end = r.x + r.w;
  const put = (dx: number, y: number, text: string, st: Style): void => putIn(scr, x + dx, y, text, st, end);

  let y = r.y;
  const list = m.sessions;
  let statusRows = m.status ? 2 : 0;
  if (r.h - statusRows < 1) statusRows = 0;

  if (list.length === 0) {
    put(NAME_X, y, plainText(m.scanning ? `scanning${V2.ellipsis}` : "no resumable sessions", r.w - NAME_X), DIM);
    y++;
  } else {
    const cursor = m.cursorId === null ? -1 : list.findIndex((s) => s.id === m.cursorId);
    const win = windowSlice({ len: list.length, height: r.h - statusRows, cursor, offset: 0 });
    if (win.up) put(NAME_X, y++, `${V2.up} ${win.above} more`, DIM);
    for (let i = win.start; i < win.end; i++) {
      const s = list[i]!;
      const cur = i === cursor;
      if (cur) put(0, y, V2.sessionCursor, m.focused ? { fg: PALETTE.hi, bold: true } : DIM);
      const nameSt: Style =
        cur && m.focused ? { fg: PALETTE.hi, bold: true } : s.live ? { fg: PALETTE.fg } : DIM;
      put(NAME_X, y, plainText(s.name, Math.min(NAME_MAX, r.w - NAME_X - 1)), nameSt);
      const ago = plainText(s.ago, AGO_W);
      if (ago !== "" && AGO_X + cellWidth(ago) <= r.w) put(AGO_X, y, ago, DIM);
      if (s.live && LIVE_X + cellWidth(LIVE) <= r.w) put(LIVE_X, y, LIVE, { fg: PALETTE.live });
      y++;
    }
    if (win.down) put(NAME_X, y++, `${V2.down} ${win.below} more`, DIM);
  }

  if (m.status && statusRows > 0 && y + 1 < r.y + r.h) {
    y++;
    if (m.status.ok) {
      put(NAME_X, y, V2.ok, { fg: PALETTE.running, bold: true });
      put(NAME_X + 2, y, plainText(m.status.text, r.w - NAME_X - 2), { fg: PALETTE.fg });
    } else {
      put(NAME_X, y, plainText(m.status.text, r.w - NAME_X), { fg: PALETTE.fg });
    }
    y++;
  }

  return y - r.y;
}
