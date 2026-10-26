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
 *   - Focused: the full list with the cursor (hi bold, x0; default: the current
 *     phase), windowed with `windowSlice` and `^ N more` / `v N more` (dim, x2).
 *
 * Every project, dir, number and name goes through `plainText` (T-09-01d) and
 * every piece is clipped to the rect, so nothing paints outside `r`.
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

export function drawPhases(scr: Screen, r: Rect, m: PhasesModel): number {
  if (r.w <= 0 || r.h <= 0) return 0;
  const x = r.x;
  const end = r.x + r.w;
  const bottom = r.y + r.h;
  const put = (dx: number, y: number, text: string, st: Style): number => {
    if (y < r.y || y >= bottom) return x + dx + cellWidth(text);
    return putIn(scr, x + dx, y, text, st, end);
  };

  if (m.projects.length === 0) {
    put(1, r.y, plainText("no GSD projects", r.w - 1), DIM);
    return 1;
  }

  const pi = Math.min(Math.max(0, Math.trunc(m.projectIndex) || 0), m.projects.length - 1);
  const p = m.projects[pi]!;
  const phases: readonly PhaseEntry[] = p.phases;
  const total = phases.length;

  // Row +0: the project name and the project hint.
  const hint = m.focused && m.projects.length > 1;
  put(1, r.y, plainText(p.name, hint ? r.w - 7 : r.w - 1), HI_BOLD);
  if (hint) put(r.w - 5, r.y, `${V2.left} ${V2.right}`, DIM);
  // Row +1: dir . project i/N.
  put(1, r.y + 1, plainText(`${oneLine(p.dir)}${SEP}project ${pi + 1}/${m.projects.length}`, r.w - 1), DIM);

  if (total === 0) {
    put(1, r.y + 2, plainText("no roadmap", r.w - 1), DIM);
    return Math.min(3, r.h);
  }

  // Row +2: the progress bar.
  const done = phases.filter((ph) => ph.status === "done").length;
  const bw = r.w - 10;
  if (bw >= 1) {
    const f = Math.min(bw, Math.max(0, Math.round((done / total) * bw)));
    put(1, r.y + 2, V2.heavyH.repeat(f), { fg: PALETTE.running });
    put(1 + f, r.y + 2, V2.heavyH.repeat(bw - f), { fg: PALETTE.edge });
  }
  put(r.w - 7, r.y + 2, `${done}/${total}`, DIM);

  const curIdx = phases.findIndex((ph) => ph.status === "current");
  const center = curIdx >= 0 ? curIdx : Math.min(done, total - 1);

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

  const budget = Math.max(0, r.h - HEADER_ROWS);
  let rows: Row[] = [];

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
    }
  } else {
    const cursor = m.cursor === null ? center : Math.min(total - 1, Math.max(0, Math.trunc(m.cursor)));
    const items: Row[][] = [];
    for (let k = 0; k < total; k++) items.push(phaseRows(k, k === total - 1, k < total - 1, k === cursor));
    const win = windowSlice({ len: total, height: budget, cursor, offset: 0, heights: items.map((i) => i.length) });
    if (win.up) rows.push(arrowRow(V2.up, win.above));
    for (let k = win.start; k < win.end; k++) rows.push(...items[k]!);
    if (win.down) {
      // Keep the down row inside the budget even when the last item was clipped.
      rows = rows.slice(0, Math.max(0, budget - 1));
      rows.push(arrowRow(V2.down, win.below));
    }
  }

  rows = rows.slice(0, budget);
  let y = r.y + HEADER_ROWS;
  for (const row of rows) row(y++);
  return Math.min(r.h, rows.length > 0 ? y - r.y : 3);
}
