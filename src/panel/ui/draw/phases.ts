import type { Screen, Style } from "../screen.js";
import { cellWidth, graphemes, oneLine, plainText } from "../text.js";
import { PALETTE } from "../palette.js";
import { V2 } from "../glyphs.js";
import type { PhaseEntry, Project, Rect } from "../models.js";
import { windowSlice } from "../viewport.js";

/**
 * The v2 PHASES pane (Phase 9, plan 09-08; D-02, D-14; UI-SPEC section PHASES,
 * the approved 175x55 frame rows 4-18). A port of the design file's
 * `drawPhases()` with the English copy.
 *
 *   - Row +0: the project name (hi bold, x1). When focused and there is more
 *     than one project, the `<- ->` project hint (dim) sits at x(w-5).
 *   - Row +1: `dir . project i/N` (dim).
 *   - Row +2: the progress bar, a heavy rule of w-10 cells (green fill for the
 *     done phases, edge for the rest), then `done/total` (dim) at x(w-7).
 *   - Row +3: blank. The timeline starts on row +4.
 *   - Timeline rows: marker x2 (done green, current hi bold, pending dim2),
 *     number x5, name x11. Current or cursor rows are hi bold, done names dim2
 *     and pending names dim. A connector at x2 joins two phases: green between
 *     done phases (and into the current one), edge otherwise. The current phase
 *     has an extra `k/n plan` row with a mini-bar (k green, n-k edge, scaled to
 *     12 cells when n > 12).
 *   - Unfocused: a +-2 window around the current phase, with
 *     `N earlier phases` / `N more phases` rows (dim, marker x2, text x5). In a
 *     short rect the window narrows to +-1, then to the current phase alone.
 *     Phase 10 plan 10-02 (WR-04): when radius 0 is still too tall it becomes
 *     `[earlier?, current phase, more?]` (the plan row and connector go first,
 *     then `earlier`; `more` goes last), and a rect with room for one timeline
 *     row (h = 5) drops the blank header row, so hidden phases always come
 *     with a `⋮` row.
 *   - Focused: the full list with the cursor (hi bold, x0; default: the current
 *     phase), windowed with `windowSlice` and `^ N more` / `v N more` (dim, x2).
 *     A focused rect too short for the 4 header rows + 2 timeline rows (h < 6)
 *     keeps only the project-name row and starts the timeline on row +1, so a
 *     focused pane always shows phase rows (Phase 10 plan 10-01, WR-09).
 *
 * Every project, dir, number and name goes through `plainText` (T-09-01d) and
 * every piece is clipped to the rect on all four edges, so nothing paints
 * outside `r`; below 9 cells the `<- ->` hint is skipped, and `done/total` is
 * skipped when it would not start after the bar (Phase 10 plan 10-02, WR-06).
 * Returns the rows used, counted from `r.y` (the project-name row). Pure.
 */

export interface PhasesModel {
  projects: readonly Project[];
  projectIndex: number;
  focused: boolean;
  cursor: number | null;
}

const MARK_X = 2;
const NUM_X = 5;
const NAME_X = 11;
const NUM_W = 5;
const MINI_MAX = 12;
/** Rows above the timeline: project name, `dir · project i/N`, the progress bar and a blank row. */
export const PHASES_HEADER_ROWS = 4;
const HEADER_ROWS = PHASES_HEADER_ROWS;
/** The `<- ->` hint at x(w-5) needs the name's first cells before it (WR-06). */
const HINT_MIN_W = 9;
const SEP = ` ${V2.sep} `;

const DIM: Style = { fg: PALETTE.dim };
const HI_BOLD: Style = { fg: PALETTE.hi, bold: true };

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
  if (out !== "" && x >= 0) scr.put(x, y, out, st);
  return x + cellWidth(text);
}

/** One drawn timeline row. */
type Row = (y: number) => void;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The window a list draw used (10-13, Pattern 3): feed `offset` back next draw. */
export interface ListWindow {
  /** Rows used, counted from `r.y`. */
  rows: number;
  /** The window start (sticky offset) the draw used. */
  offset: number;
  /** Items fully or partly drawn in the window (used for PgUp / PgDn). */
  visible: number;
}

export function drawPhases(scr: Screen, r: Rect, m: PhasesModel): number {
  return drawPhasesWin(scr, r, m).rows;
}

/**
 * drawPhases plus the window it used (Phase 10 plan 10-13, LAYOUT-02). The
 * focused list continues from `m.offset` (the previous window start; clamped by
 * `windowSlice`), so a cursor move inside the margins does not move the window.
 * Unfocused, the +-2 window is fixed: offset 0 and the phase items drawn.
 */
export function drawPhasesWin(scr: Screen, r: Rect, m: PhasesModel & { offset?: number }): ListWindow {
  const none = (rows: number): ListWindow => ({ rows, visible: 0, offset: 0 });
  if (r.w <= 0 || r.h <= 0) return none(0);
  const x = r.x;
  const end = r.x + r.w;
  const bottom = r.y + r.h;
  const put = (dx: number, y: number, text: string, st: Style): number => {
    // WR-06: clip on every edge, the left one too (a right-anchored piece in a
    // narrow rect would otherwise start left of r.x, in the neighbouring pane).
    if (y < r.y || y >= bottom || dx < 0) return x + dx + cellWidth(text);
    return putIn(scr, x + dx, y, text, st, end);
  };

  if (m.projects.length === 0) {
    put(1, r.y, plainText("no GSD projects", r.w - 1), DIM);
    return none(1);
  }

  const pi = Math.min(Math.max(0, Math.trunc(m.projectIndex) || 0), m.projects.length - 1);
  const p = m.projects[pi]!;
  const phases: readonly PhaseEntry[] = p.phases;
  const total = phases.length;

  // WR-09: a short focused rect drops the dir, bar and blank rows for the timeline.
  const compact = m.focused && total > 0 && r.h < HEADER_ROWS + 2;
  // WR-04: an unfocused rect with room for one timeline row only drops the
  // blank row, so the current phase keeps its `⋮` row.
  const tight = !m.focused && total > 1 && r.h === HEADER_ROWS + 1;
  const head = compact ? 1 : tight ? HEADER_ROWS - 1 : HEADER_ROWS;

  // Row +0: the project name and the project hint (only when it fits, WR-06).
  const hint = m.focused && m.projects.length > 1 && r.w >= HINT_MIN_W;
  put(1, r.y, plainText(p.name, hint ? r.w - 7 : r.w - 1), HI_BOLD);
  if (hint) put(r.w - 5, r.y, `${V2.left} ${V2.right}`, DIM);
  // Row +1: dir . project i/N.
  if (!compact) {
    put(1, r.y + 1, plainText(`${oneLine(p.dir)}${SEP}project ${pi + 1}/${m.projects.length}`, r.w - 1), DIM);
  }

  if (total === 0) {
    put(1, r.y + 2, plainText("no roadmap", r.w - 1), DIM);
    return none(Math.min(3, r.h));
  }

  // Row +2: the progress bar.
  const done = phases.filter((ph) => ph.status === "done").length;
  const bw = compact ? 0 : r.w - 10;
  if (bw >= 1) {
    const f = Math.min(bw, Math.max(0, Math.round((done / total) * bw)));
    put(1, r.y + 2, V2.heavyH.repeat(f), { fg: PALETTE.running });
    put(1 + f, r.y + 2, V2.heavyH.repeat(bw - f), { fg: PALETTE.edge });
  }
  // done/total sits at x(w-7), only when it starts after the bar (WR-06).
  if (!compact && r.w - 7 >= 1 + Math.max(0, bw)) put(r.w - 7, r.y + 2, `${done}/${total}`, DIM);

  const curIdx = phases.findIndex((ph) => ph.status === "current");
  const center = curIdx >= 0 ? curIdx : Math.min(done, total - 1);

  /** The first row of every phase item, so the items drawn can be counted. */
  const heads = new Set<Row>();
  /** The rows of phase k: the phase, its plan row (current only) and its connector. */
  const phaseRows = (k: number, last: boolean, contAfter: boolean, cursorHere: boolean): Row[] => {
    const ph = phases[k]!;
    const isDone = ph.status === "done";
    const isCur = ph.status === "current";
    const out: Row[] = [];
    out.push((y) => {
      if (cursorHere) put(0, y, V2.cursor, HI_BOLD);
      const mark = isDone ? V2.phaseDone : isCur ? V2.phaseCurrent : V2.phasePending;
      const markSt: Style = isDone ? { fg: PALETTE.running } : isCur ? HI_BOLD : { fg: PALETTE.dim2 };
      put(MARK_X, y, mark, markSt);
      const st: Style = isCur || cursorHere ? HI_BOLD : isDone ? { fg: PALETTE.dim2 } : DIM;
      put(NUM_X, y, plainText(ph.number, NUM_W), st);
      put(NAME_X, y, plainText(ph.name, r.w - NAME_X), st);
    });
    heads.add(out[0]!);
    if (isCur && ph.plansTotal !== null) {
      out.push((y) => {
        if (contAfter) put(MARK_X, y, V2.vline, { fg: PALETTE.edge });
        const n = Math.max(0, Math.trunc(ph.plansTotal ?? 0));
        const kd = Math.min(n, Math.max(0, Math.trunc(ph.plansDone ?? 0)));
        const label = `${kd}/${n} plan`;
        const tx = put(NAME_X, y, label, DIM) - x;
        const cellsN = n > MINI_MAX ? MINI_MAX : n;
        const fill = n > MINI_MAX ? Math.round((kd / n) * MINI_MAX) : kd;
        put(tx + 2, y, V2.heavyH.repeat(fill), { fg: PALETTE.running });
        put(tx + 2 + fill, y, V2.heavyH.repeat(cellsN - fill), { fg: PALETTE.edge });
      });
    }
    if (!last) {
      const next = phases[k + 1];
      const green = isDone && next !== undefined && next.status !== "pending";
      out.push((y) => put(MARK_X, y, V2.vline, { fg: green ? PALETTE.running : PALETTE.edge }));
    }
    return out;
  };

  const moreRow =
    (text: string): Row =>
    (y) => {
      put(MARK_X, y, V2.more, DIM);
      put(NUM_X, y, text, DIM);
    };
  const arrowRow =
    (arrow: string, n: number): Row =>
    (y) =>
      put(2, y, `${arrow} ${n} more`, DIM);

  const budget = Math.max(0, r.h - head);
  let rows: Row[] = [];
  let offset = 0;

  if (!m.focused) {
    for (const radius of [2, 1, 0]) {
      const a0 = Math.max(0, center - radius);
      const z = Math.min(total - 1, center + radius);
      const more = total - 1 - z;
      const list: Row[] = [];
      if (a0 > 0) list.push(moreRow(plural(a0, "earlier phase", "earlier phases")));
      for (let k = a0; k <= z; k++) list.push(...phaseRows(k, k === z, k < z || more > 0, false));
      if (more > 0) list.push(moreRow(plural(more, "more phase", "more phases")));
      rows = list;
      if (list.length <= budget) break;
      if (radius === 0) {
        // WR-04: radius 0 is still too tall. Shed the plan row and connector,
        // then the earlier row, but never slice off an indicator row:
        // [earlier?, current phase, more?] sized to the budget.
        const cur = phaseRows(center, true, false, false).slice(0, 1);
        const tail = more > 0 && budget >= 2 ? [moreRow(plural(more, "more phase", "more phases"))] : [];
        const head =
          a0 > 0 && budget >= 2 + tail.length ? [moreRow(plural(a0, "earlier phase", "earlier phases"))] : [];
        rows = [...head, ...cur, ...tail];
      }
    }
  } else {
    const cursor = m.cursor === null ? center : Math.min(total - 1, Math.max(0, Math.trunc(m.cursor)));
    const items: Row[][] = [];
    for (let k = 0; k < total; k++) items.push(phaseRows(k, k === total - 1, k < total - 1, k === cursor));
    const win = windowSlice({
      len: total,
      height: budget,
      cursor,
      offset: m.offset ?? 0,
      heights: items.map((i) => i.length),
    });
    offset = win.offset;
    if (win.up) rows.push(arrowRow(V2.up, win.above));
    for (let k = win.start; k < win.end; k++) rows.push(...items[k]!);
    if (win.down) {
      // Keep the down row inside the budget even when the last item was clipped.
      rows = rows.slice(0, Math.max(0, budget - 1));
      rows.push(arrowRow(V2.down, win.below));
    }
  }

  rows = rows.slice(0, budget);
  let y = r.y + head;
  for (const row of rows) row(y++);
  const visible = rows.filter((row) => heads.has(row)).length;
  return { rows: Math.min(r.h, rows.length > 0 ? y - r.y : 3), offset, visible };
}
