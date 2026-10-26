import type { Screen } from "../screen.js";
import type { Flash, PortEntry, Project, Rect, SessionEntry } from "../models.js";
import type { UiState } from "../uiState.js";
import { allocate } from "../layout.js";
import type { Band } from "../geometry.js";
import { PALETTE } from "../palette.js";
import { V2 } from "../glyphs.js";
import { drawTabs } from "./title.js";
import { drawPhases, PHASES_HEADER_ROWS } from "./phases.js";
import { drawSessions } from "./sessions.js";
import { drawPortsPane, visiblePortEntries } from "./ports.js";

/**
 * The v2 right column (Phase 9, plan 09-08; D-02, D-20; UI-SPEC W2 layout,
 * the approved 175x55 frame rows 2-34 at RX = 101, RW = 74). A port of the
 * design file's `drawRight()` plus the PORTS placement of `draw()`.
 *
 *   1. The PHASES | SESSIONS tabs with the sample chip and `[r]` on `r.y`;
 *      the active tab uses the focused style when the right column has focus.
 *   2. The active tab body from `r.y + 2`: PHASES (focused when focus is on
 *      the right column and the tab is phases) or SESSIONS (the same rule;
 *      the cursor is the first session, the status is `sessionStatus`).
 *   3. The PORTS title on `max(bodyEnd + 2, portsMinY)`, so it lines up with
 *      the FILES title row in the left column. When that would leave PORTS
 *      fewer rows inside `r` than it needs (3, or a focused PORTS pane's
 *      budget), it goes right under the body instead (`bodyEnd + 2`).
 *
 * The body height is budgeted with `allocate` before drawing, so nothing
 * passes `r.y + r.h - 1` (T-09-14a). The budget depends on the focus
 * (Phase 10 plan 10-01, D-19):
 *   - PORTS focused (WR-08): PORTS is served first and grows to the rows its
 *     ports need (`portRowsNeeded`: title + spacer + 2 rows per owned port,
 *     1 per other port); the unfocused PHASES|SESSIONS body takes what is
 *     left, down to 0 rows (its tab row stays). A focused PORTS pane is never
 *     held to one port row while the body has rows to give. Its title still
 *     lines up with FILES unless that would cost PORTS budgeted rows.
 *   - PHASES|SESSIONS focused (WR-09): the body keeps at least 3 rows and
 *     grows first; the unfocused PORTS pane may shrink to its title row.
 *     `focusedFloor()` tells the shell how many rows the focused pane needs
 *     to show real content: for PHASES the 4 header rows plus one timeline
 *     row (+1 for the `↓ N more` row when there is more than one phase).
 *   - Otherwise: the body keeps 3 rows, PORTS its minimum (title + spacer +
 *     1 row) and the body takes the rest.
 * A focused PORTS pane under an empty (0-row) body that would get only a
 * 1-row list folds the two spacer rows into one (Phase 10 plan 10-02, WR-05),
 * so the cursor row keeps its `↓ N more` row.
 * With 9+ rows and the default focus (every split-mode column) the output is
 * unchanged from Phase 9.
 * Returns the last row used (`end`, absolute) and the PORTS title row. Pure.
 *
 * The S2 bottom band (Phase 10 plan 10-03; LAYOUT-04, UI-SPEC § Layout &
 * Breakpoints, the S2 row and the stacked S2 schematic): at 100-164 columns
 * the shell draws AGENTS -> FILES -> a band in which PHASES|SESSIONS (left,
 * `band.leftW` = floor((cols - 5) / 2) wide) and PORTS (right, from
 * `band.rightX`) sit side by side, their titles on the band's first row, with
 * an edge-colored `│` at `band.divX` on the band's rows only. `drawTabsBody`
 * (the tabs + active body, shared with `drawRightColumn`) draws the left half
 * and `drawPortsPane` the right half; both clip to their half (WR-06), so no
 * half bleeds into the gutter or the other half. `bandFloor()` is the band's
 * focused floor: PORTS sits beside the tabs, so each half only needs its own
 * rows.
 */

export interface RightColumnModel {
  ui: UiState;
  projects: readonly Project[];
  projectIndex: number;
  sessions: readonly SessionEntry[];
  sessionStatus: Flash | null;
  ports: readonly PortEntry[];
  sample: boolean;
  portsMinY: number;
}

/** Tabs row, the spacer under it and the spacer above the PORTS title. */
const CHROME_ROWS = 3;
const BODY_MIN = 3;
/** PORTS title + spacer + one row. */
const PORTS_MIN = 3;
/** Focused PHASES/SESSIONS floor (09-16, D-13): tabs, spacer, one body row and the spacer row kept above PORTS. */
export const FOCUSED_TAB_FLOOR = CHROME_ROWS + 1;
/** Focused PORTS floor (09-16, D-13): tabs, spacer, a 0-row body, spacer, PORTS title + spacer + one port row. */
export const FOCUSED_PORTS_FLOOR = CHROME_ROWS + PORTS_MIN;

/** Rows the PORTS list needs to show every port it would list (+1 for the `+N others` row). */
function portRowsNeeded(ports: readonly PortEntry[], focused: boolean): number {
  const { shown, others } = visiblePortEntries(ports, focused);
  let rows = others > 0 ? 1 : 0;
  for (const p of shown) rows += p.owner !== null ? 2 : 1;
  return rows;
}

/**
 * The rows a focused right-column pane needs before it shows real content
 * (D-13 floor; WR-08, WR-09). PORTS: FOCUSED_PORTS_FLOOR, and one more for
 * the `↓ N more` row when the port list needs more than one row (a 1-row list
 * would show one port and no indicator). PHASES on a project with phases:
 * tabs, spacer, the 4 header rows, one timeline row, the spacer above PORTS,
 * and one more for the `↓ N more` row when there is more than one phase.
 * Anything else (SESSIONS, a project with no phases, no projects):
 * FOCUSED_TAB_FLOOR. The shell uses it to decide when the grid yields.
 */
export function focusedFloor(m: RightColumnModel): number {
  if (m.ui.focus === "ports") return FOCUSED_PORTS_FLOOR + (portRowsNeeded(m.ports, true) > 1 ? 1 : 0);
  if (m.ui.focus === "right" && m.ui.rightTab === "phases" && m.projects.length > 0) {
    const pi = Math.min(Math.max(0, Math.trunc(m.projectIndex) || 0), m.projects.length - 1);
    const n = m.projects[pi]?.phases.length ?? 0;
    if (n > 0) return CHROME_ROWS + PHASES_HEADER_ROWS + 1 + (n > 1 ? 1 : 0);
  }
  return FOCUSED_TAB_FLOOR;
}

/**
 * The S2 band's focused floor (10-03): the rows the band needs before the
 * focused half shows real content. PORTS: title + spacer + one port row, + 1
 * for the `↓ N more` row when the list needs more than one row (the same rule
 * as focusedFloor, so the cursor row is never traded for the arrow row).
 * PHASES on a project with phases: tabs, spacer, the header rows, one
 * timeline row, + 1 when there is more than one phase. SESSIONS (or PHASES
 * with no phases): tabs, spacer, one row. AGENTS focused: tabs, spacer and
 * the 3-row body minimum.
 */
export function bandFloor(m: RightColumnModel): number {
  if (m.ui.focus === "ports") return PORTS_MIN + (portRowsNeeded(m.ports, true) > 1 ? 1 : 0);
  if (m.ui.focus === "right") {
    if (m.ui.rightTab === "phases" && m.projects.length > 0) {
      const pi = Math.min(Math.max(0, Math.trunc(m.projectIndex) || 0), m.projects.length - 1);
      const n = m.projects[pi]?.phases.length ?? 0;
      if (n > 0) return 2 + PHASES_HEADER_ROWS + 1 + (n > 1 ? 1 : 0);
    }
    return 3;
  }
  return 2 + BODY_MIN;
}

/**
 * The PHASES | SESSIONS tabs on `r.y` and the active tab body (focused when
 * the right column has focus) in `{ r.x, r.y + 2, r.w, bodyH }`, the body cut
 * to the rect. Draws no PORTS. Returns the last row used (`end`, absolute,
 * never past `r.y + r.h - 1`) and the body rows drawn.
 */
export function drawTabsBody(
  scr: Screen,
  r: Rect,
  m: RightColumnModel,
  bodyH: number,
): { end: number; bodyRows: number } {
  if (r.w <= 0 || r.h <= 0) return { end: r.y - 1, bodyRows: 0 };
  const ui = m.ui;
  const rightFocused = ui.focus === "right";
  drawTabs(scr, r.x, r.y, r.w, { active: ui.rightTab, columnFocused: rightFocused, sample: m.sample });

  const h = Math.max(0, Math.min(Math.trunc(bodyH) || 0, r.h - 2));
  const bodyRect: Rect = { x: r.x, y: r.y + 2, w: r.w, h };
  const bodyRows =
    ui.rightTab === "phases"
      ? drawPhases(scr, bodyRect, {
          projects: m.projects,
          projectIndex: m.projectIndex,
          focused: rightFocused,
          cursor: null,
        })
      : drawSessions(scr, bodyRect, {
          sessions: m.sessions,
          focused: rightFocused,
          cursorId: m.sessions[0]?.id ?? null,
          status: m.sessionStatus,
          scanning: false,
        });
  return { end: bodyRows > 0 ? bodyRect.y + bodyRows - 1 : r.y, bodyRows };
}

/**
 * The S2 bottom band (10-03, LAYOUT-04): PHASES|SESSIONS in
 * `{ r.x, r.y, band.leftW, r.h }`, PORTS in
 * `{ r.x + band.rightX, r.y, band.rightW, r.h }`, both titles on `r.y`, and
 * the `│` divider at `r.x + band.divX` from `r.y` to the taller half's last
 * row. Returns that row (`end`, absolute, never past `r.y + r.h - 1`). Pure.
 */
export function drawBand(scr: Screen, r: Rect, band: Band, m: RightColumnModel): { end: number } {
  if (r.w <= 0 || r.h <= 0) return { end: r.y - 1 };
  const bottom = r.y + r.h;
  const left = drawTabsBody(scr, { x: r.x, y: r.y, w: band.leftW, h: r.h }, m, Math.max(0, r.h - 2));
  const portsFocused = m.ui.focus === "ports";
  const portsRows = drawPortsPane(
    scr,
    { x: r.x + band.rightX, y: r.y, w: band.rightW, h: r.h },
    {
      ports: m.ports,
      focused: portsFocused,
      cursorKey: portsFocused ? (m.ports[0]?.key ?? null) : null,
      sample: m.sample,
    },
  );
  const end = Math.min(bottom - 1, Math.max(r.y, left.end, r.y + portsRows - 1));
  for (let y = r.y; y <= end; y++) scr.put(r.x + band.divX, y, V2.vline, { fg: PALETTE.edge });
  return { end };
}

export function drawRightColumn(scr: Screen, r: Rect, m: RightColumnModel): { end: number; portsY: number } {
  const ui = m.ui;
  const rightFocused = ui.focus === "right";
  const bottom = r.y + r.h;
  if (r.w <= 0 || r.h <= 0) return { end: r.y - 1, portsY: r.y };

  const portsFocused = ui.focus === "ports";
  const avail = Math.max(0, r.h - CHROME_ROWS);
  let budget: Record<string, number>;
  if (portsFocused) {
    // WR-08: PORTS first, up to every port row; the body takes what is left.
    const ports = { id: "ports", min: PORTS_MIN, max: 2 + portRowsNeeded(m.ports, true) };
    budget = allocate(avail, [ports, { id: "body", min: 0, max: avail }], ["ports", "body"]);
  } else if (rightFocused) {
    // WR-09: the focused body grows first; the unfocused PORTS may keep only its title.
    const body = { id: "body", min: BODY_MIN, max: avail };
    budget = allocate(avail, [body, { id: "ports", min: 1, max: PORTS_MIN }], ["body", "ports"]);
  } else {
    const body = { id: "body", min: BODY_MIN, max: avail };
    budget = allocate(avail, [body, { id: "ports", min: PORTS_MIN, max: PORTS_MIN }], ["body"]);
  }

  const { bodyRows } = drawTabsBody(scr, r, m, budget.body ?? 0);
  const bodyEnd = r.y + 2 + bodyRows - 1;

  // Line PORTS up with FILES, unless that costs a focused PORTS its budgeted
  // rows (WR-08) or leaves an unfocused PORTS below its minimum.
  let portsY = Math.max(bodyEnd + 2, Math.trunc(m.portsMinY) || 0);
  const portsNeed = portsFocused ? (budget.ports ?? PORTS_MIN) : PORTS_MIN;
  if (bottom - portsY < portsNeed) portsY = bodyEnd + 2;
  // WR-05 (10-02): a focused PORTS pane under an empty body would get a
  // 1-row list (one port, or only `↓ N more` and no cursor). The two spacer
  // rows around the empty body fold into one, so the list keeps the cursor
  // row and its `↓ N more` row.
  if (portsFocused && bodyRows === 0 && bottom - portsY === PORTS_MIN && portRowsNeeded(m.ports, true) > 1) {
    portsY -= 1;
  }
  const portsRows = drawPortsPane(
    scr,
    { x: r.x, y: portsY, w: r.w, h: Math.max(0, bottom - portsY) },
    {
      ports: m.ports,
      focused: portsFocused,
      cursorKey: portsFocused ? (m.ports[0]?.key ?? null) : null,
      sample: m.sample,
    },
  );

  // `end` never points past the rect (09-09: tiny rects where the body gets 0 rows).
  const end = Math.min(bottom - 1, portsRows > 0 ? portsY + portsRows - 1 : Math.max(r.y, bodyEnd));
  return { end, portsY };
}
