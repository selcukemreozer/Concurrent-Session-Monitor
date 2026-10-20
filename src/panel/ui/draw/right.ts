import type { Screen } from "../screen.js";
import type { Flash, PortEntry, Project, Rect, SessionEntry } from "../models.js";
import type { UiState } from "../uiState.js";
import { allocate } from "../layout.js";
import { drawTabs } from "./title.js";
import { drawPhases } from "./phases.js";
import { drawSessions } from "./sessions.js";
import { drawPortsPane } from "./ports.js";

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
 *      fewer than 3 rows inside `r`, it goes right under the body instead
 *      (`bodyEnd + 2`).
 *
 * The body height is budgeted with `allocate` before drawing: the body keeps
 * at least 3 rows, PORTS keeps its minimum (title + spacer + 1 row) and the
 * body takes the rest, so nothing passes `r.y + r.h - 1` (T-09-14a).
 * With PORTS focused, the PORTS minimum is served before the body minimum, so
 * a short column shrinks the unfocused PHASES|SESSIONS body (its tab row
 * stays) before PORTS loses its first port row (09-16, KEYS-01; UI-SPEC: in
 * stacked modes the bottom band collapses to its title row(s)). With 9+ rows,
 * which is every split-mode column, both minimums fit and nothing changes.
 * Returns the last row used (`end`, absolute) and the PORTS title row. Pure.
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

export function drawRightColumn(scr: Screen, r: Rect, m: RightColumnModel): { end: number; portsY: number } {
  const ui = m.ui;
  const rightFocused = ui.focus === "right";
  const bottom = r.y + r.h;
  if (r.w <= 0 || r.h <= 0) return { end: r.y - 1, portsY: r.y };

  drawTabs(scr, r.x, r.y, r.w, { active: ui.rightTab, columnFocused: rightFocused, sample: m.sample });

  const portsFocused = ui.focus === "ports";
  const avail = Math.max(0, r.h - CHROME_ROWS);
  const body = { id: "body", min: BODY_MIN, max: avail };
  const ports = { id: "ports", min: PORTS_MIN, max: PORTS_MIN };
  const budget = allocate(avail, portsFocused ? [ports, body] : [body, ports], ["body"]);

  const bodyRect: Rect = { x: r.x, y: r.y + 2, w: r.w, h: budget.body ?? 0 };
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
  const bodyEnd = bodyRect.y + bodyRows - 1;

  let portsY = Math.max(bodyEnd + 2, Math.trunc(m.portsMinY) || 0);
  if (bottom - portsY < PORTS_MIN) portsY = bodyEnd + 2;
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
