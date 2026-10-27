import type { Screen, Style } from "../screen.js";
import { cellWidth, graphemes, nameText, pathText } from "../text.js";
import { PALETTE, stateColor } from "../palette.js";
import { V2 } from "../glyphs.js";
import type { FileConflict, FileEntry, FileGroup, Rect } from "../models.js";
import { drawTitle } from "./title.js";

/**
 * The v2 FILES pane (Phase 9, plan 09-07; D-02; UI-SPEC section FILES, the
 * approved 175x55 frame rows 27-34). A port of the FILES part of the design
 * file's `drawLeft()` with the English copy.
 *
 *   - Conflict rows come first, on the red background across the whole pane
 *     width: `| ! a x b   path`. They never scroll; at most 3 are drawn and
 *     with more the 3rd reads `! +N more conflicts` (T-09-02d).
 *   - Then the ticker, at most 6 rows, grouped by agent (writes first, then
 *     reads). It scrolls only when the rows do not fit: one row per step,
 *     wrapping through a `back to top` separator row, with a scrollbar in the
 *     pane's last column. A group split at the window top repeats its square
 *     and name in dim2.
 *   - `step` is the ticker position. PanelApp advances it every 2 UI ticks
 *     (500 ms) and freezes it while paused (`space`, D-15); this function stays
 *     pure and only reads it.
 *   - FILES is never focusable (D-13), so its title is always unfocused.
 *   - Narrowed (Phase 10 plan 10-12, LAYOUT-07 / LAYOUT-02): while a card or
 *     idle strip is selected the caller passes only that session's rows and
 *     `narrowed: true`. The title reads `FILES · N · esc: all` (N hi bold, the
 *     rest dim, no right info), conflict rows still come first, the ticker
 *     stops (no scrolling, no scrollbar, `step` ignored) and when the rows do
 *     not fit the last visible row is `↓ N more` (dim, x4) counting the hidden
 *     file rows.
 *   - A conflict with `more` > 0 (3+ sessions on the file, RESEARCH open
 *     question 3) draws ` +N` after `b`; `b` is shortened to leave room so the
 *     name and the count together stay inside the 21-cell name column and the
 *     count is never cut.
 *
 * Every name goes through `nameText` (21 cells) and every path through
 * `pathText` (start truncation, the file name stays visible), and every piece
 * is hard-clipped to the pane, so nothing paints outside `r` (T-09-01c,
 * T-09-02c). Pure: no Ink, no I/O.
 */

/** U+2014, shown for a name that cleans to nothing. */
const DASH = "\u2014";
/** ` U+00B7 `, the title right-info separator. */
const SEP = " \u00b7 ";
const JOIN = ` ${V2.join} `;
const WRAP_ROW = `${V2.dashed}${V2.dashed} back to top ${V2.dashed}${V2.dashed}`;

const MAX_CONFLICT_ROWS = 3;
const MAX_TICKER_ROWS = 6;
const NAME_W = 21;
const PATH_X = 26;
const WRITE_PATH_X = 28;

export interface TickerRow {
  group: FileGroup;
  first: boolean;
  file: FileEntry;
}

/** Unique paths across the groups and the conflicts. */
export function countFiles(conflicts: readonly FileConflict[], groups: readonly FileGroup[]): number {
  const all = new Set<string>();
  for (const g of groups) for (const f of g.files) all.add(f.path);
  for (const c of conflicts) all.add(c.path);
  return all.size;
}

/** One row per file, group by group, writes before reads; `first` marks a group's first row. */
export function tickerRows(groups: readonly FileGroup[]): TickerRow[] {
  const out: TickerRow[] = [];
  for (const group of groups) {
    const files = [
      ...group.files.filter((f) => f.kind === "write"),
      ...group.files.filter((f) => f.kind !== "write"),
    ];
    files.forEach((file, j) => out.push({ group, first: j === 0, file }));
  }
  return out;
}

/** Put `text` at (x, y), hard-clipped to end before `end`. Returns x + the full width. */
function putIn(scr: Screen, x: number, y: number, text: string, st: Style, end: number): number {
  let out = "";
  let w = 0;
  for (const g of graphemes(text)) {
    const gw = cellWidth(g);
    if (x + w + gw > end) break;
    out += g;
    w += gw;
  }
  if (out !== "") scr.put(x, y, out, st);
  return x + cellWidth(text);
}

/** Draw the FILES pane into `r`; returns the rows used from `r.y`. */
export function drawFilesPane(
  scr: Screen,
  r: Rect,
  m: {
    conflicts: readonly FileConflict[];
    groups: readonly FileGroup[];
    paused: boolean;
    step: number;
    sample: boolean;
    narrowed?: boolean;
  },
): number {
  if (r.h < 1 || r.w < 1) return 0;

  const rows = tickerRows(m.groups);
  const nConf = m.conflicts.length;
  const confRows = Math.min(nConf, MAX_CONFLICT_ROWS, r.h - 1);
  const H = Math.max(0, Math.min(MAX_TICKER_ROWS, r.h - 1 - confRows));
  const narrowed = m.narrowed === true;
  // narrowed: the ticker stops; rows that do not fit are announced instead
  const scrolling = !narrowed && H > 0 && rows.length > H;
  const overflow = narrowed && rows.length > H && H > 0;

  const n = countFiles(m.conflicts, m.groups);
  if (narrowed) {
    const dim: Style = { fg: PALETTE.dim };
    drawTitle(scr, r.x, r.y, r.w, {
      label: "FILES",
      focused: false,
      sample: m.sample,
      right: null,
      extra: [
        { text: SEP, ...dim },
        { text: `${n}`, fg: PALETTE.hi, bold: true },
        { text: `${SEP}esc: all`, ...dim },
      ],
    });
  } else {
    const files = `${n} ${n === 1 ? "file" : "files"}`;
    const right = n === 0 ? "no files" : scrolling && m.paused ? `paused${SEP}${files}` : files;
    drawTitle(scr, r.x, r.y, r.w, { label: "FILES", focused: false, sample: m.sample, right });
  }

  const end = r.x + r.w;
  // ticker rows and conflict paths keep the scrollbar column free
  const pend = end - 1;
  const red: Style = { fg: PALETTE.red };
  const redB: Style = { fg: PALETTE.red, bold: true };
  const hiB: Style = { fg: PALETTE.hi, bold: true };

  let y = r.y + 1;
  for (let i = 0; i < confRows; i++, y++) {
    putIn(scr, r.x, y, V2.rowMark, red, end);
    putIn(scr, r.x + 2, y, V2.conflict, redB, end);
    const c = m.conflicts[i];
    // WR-05: the overflow count goes on the last DRAWN conflict row, so drawn
    // conflicts + N always equal the conflict count, for every confRows.
    if (i === confRows - 1 && nConf > confRows) {
      putIn(scr, r.x + 4, y, `+${nConf - i} more conflicts`, { fg: PALETTE.hi }, pend);
    } else if (c) {
      let cx = putIn(scr, r.x + 4, y, nameText(c.a, NAME_W) || DASH, hiB, end);
      cx = putIn(scr, cx, y, JOIN, redB, end);
      const more = typeof c.more === "number" && Number.isFinite(c.more) ? Math.trunc(c.more) : 0;
      if (more > 0) {
        // open question 3: the count goes inside the name column, never cut
        const suffix = ` +${more}`;
        cx = putIn(scr, cx, y, nameText(c.b, NAME_W - cellWidth(suffix)) || DASH, hiB, end);
        cx = putIn(scr, cx, y, suffix, hiB, end);
      } else {
        cx = putIn(scr, cx, y, nameText(c.b, NAME_W) || DASH, hiB, end);
      }
      const px = Math.max(cx + 3, r.x + PATH_X);
      putIn(scr, px, y, pathText(c.path, pend - px), { fg: PALETTE.hi }, pend);
    }
    // the background goes on last: Screen.fill keeps the drawn text and fg
    scr.fill(r.x, y, r.w, PALETTE.redBg);
  }

  const N = rows.length + 1;
  const step = Number.isFinite(m.step) ? Math.trunc(m.step) : 0;
  const off = scrolling ? ((step % N) + N) % N : 0;
  const visible = scrolling ? H : Math.min(rows.length, H);
  // narrowed overflow: H - 1 file rows, then `↓ N more` on the last row
  const fileRows = overflow ? H - 1 : visible;

  for (let k = 0; k < fileRows; k++) {
    const yy = y + k;
    const idx = scrolling ? (off + k) % N : k;
    const it = rows[idx];
    if (!it) {
      putIn(scr, r.x + 4, yy, WRAP_ROW, { fg: PALETTE.dim2 }, pend);
      continue;
    }
    const name = nameText(it.group.name, NAME_W) || DASH;
    if (it.first) {
      const sq = it.group.state === "idle" ? PALETTE.idle : stateColor(it.group.state);
      putIn(scr, r.x + 2, yy, V2.group, { fg: sq }, pend);
      putIn(scr, r.x + 4, yy, name, hiB, pend);
    } else if (k === 0) {
      putIn(scr, r.x + 2, yy, V2.group, { fg: PALETTE.dim2 }, pend);
      putIn(scr, r.x + 4, yy, name, { fg: PALETTE.dim2 }, pend);
    }
    if (it.file.kind === "write") {
      putIn(scr, r.x + PATH_X, yy, V2.write, { fg: PALETTE.fg }, pend);
      const px = r.x + WRITE_PATH_X;
      putIn(scr, px, yy, pathText(it.file.path, pend - px), { fg: PALETTE.fg }, pend);
    } else {
      const px = r.x + PATH_X;
      putIn(scr, px, yy, pathText(it.file.path, pend - px), { fg: PALETTE.blue }, pend);
    }
  }

  if (overflow) {
    const hidden = rows.length - fileRows;
    putIn(scr, r.x + 4, y + fileRows, `${V2.down} ${hidden} more`, { fg: PALETTE.dim }, pend);
  }

  if (scrolling) {
    const sx = end - 1;
    const th = Math.max(1, Math.round((H * H) / N));
    const tt = Math.min(H - th, Math.floor((off / N) * H));
    for (let k = 0; k < H; k++) {
      const thumb = k >= tt && k < tt + th;
      scr.put(sx, y + k, thumb ? V2.heavyV : V2.vline, { fg: thumb ? PALETTE.dim : PALETTE.edge });
    }
  }

  return 1 + confRows + visible;
}
