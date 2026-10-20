import { Screen, type Line } from "../screen.js";
import { CARD_PITCH_Y, geometry } from "../geometry.js";
import { allocate, type Demand } from "../layout.js";
import { PALETTE } from "../palette.js";
import { V2 } from "../glyphs.js";
import { hintsFor } from "../keymap.js";
import type { UiState } from "../uiState.js";
import type { Flash, HeaderModel, PanesModel, Rect } from "../models.js";
import { drawHeader } from "./header.js";
import { drawAgentsPane } from "./agents.js";
import { drawFilesPane } from "./files.js";
import { drawRightColumn } from "./right.js";
import { drawFooter } from "./footer.js";
import { drawTooSmall } from "./tooSmall.js";

/**
 * The v2 shell: one pure composition of the whole panel frame (Phase 9, plan
 * 09-09; UI-SPEC section Layout & Breakpoints, the approved 175x55 frame).
 *
 *   - D-02 / D-28: at W2 (165-213 cols, the 175x55 target) and W3 (>= 214) the
 *     frame is split. AGENTS + FILES sit in the left column, the PHASES |
 *     SESSIONS tabs + PORTS in the right column, with an edge-colored divider
 *     at `divX` on rows 2..end. The PORTS title lines up with the FILES title
 *     row (`portsMinY = filesY`).
 *   - D-27: below 60x16 the too-small screen is returned instead.
 *   - RESEARCH Open Question 2 (Claude's discretion, recorded in 09-09): every
 *     width from 60 to 164 is drawn as the S1 full-width stack AGENTS -> FILES
 *     -> PHASES|SESSIONS -> PORTS. S2's side-by-side bottom band is Phase 10
 *     work (`geometry()` already returns its numbers), so the size invariants
 *     hold at every size from day one.
 *   - D-20: every pane carries the ` sample ` chip while `sample` is set; the
 *     header never does.
 *
 * Vertical budget: row 0 header, row 1 blank, content on rows 2..rows-3, one
 * spacer, then the footer directly after the content (`end + 2`). The shell
 * never stretches to fill a tall window. Heights are handed out by
 * `allocate()` over `rows - 4` before anything is drawn, from the panes'
 * natural heights (measured by drawing into a scratch Screen):
 *   - split:   minimums FILES (title + conflict rows + up to 3 ticker rows),
 *              AGENTS (title + 1 card row = 8), then the spacer after the grid;
 *              growth: that spacer, AGENTS (whole card rows of 8), FILES (to
 *              6 ticker rows). The spacer grows before the grid so a clipped
 *              grid always gets its `down N more` row (8k + 1) and no rows are
 *              wasted on a card row that cannot be drawn.
 *   - stacked: minimums AGENTS, FILES title + conflict rows, FILES ticker (up
 *              to 3), the right column's collapsed minimum (tabs, a 3-row body,
 *              the PORTS title); growth: grid spacer, AGENTS, FILES ticker,
 *              right column, then the spacer above the tabs. With focus on the
 *              right column or PORTS, the right column's expanded minimum
 *              (tabs + 4 body rows + PORTS title + 2 rows) moves ahead of the
 *              FILES ticker and the right column grows first, so a collapsed
 *              bottom pane that gets focus expands (UI-SPEC: it takes rows
 *              from the FILES ticker, down to 0, and the grid, down to 1 card
 *              row). At 80x24 that is exactly the 10-row expanded minimum.
 *
 * Every pane clips to the rect it is given (09-09 rect clip), so nothing is
 * drawn outside its rect, every line is at most `cols` cells and at most
 * `rows` lines are returned.
 *
 * Motion (UI-SPEC section Motion): `tick` drives the spinners (one 250 ms UI
 * tick) and `step` drives the FILES ticker (one step every 2 ticks, frozen
 * while paused). Both are plain inputs: the function is pure, so tests need no
 * timers. The footer hints come from the keymap table (`hintsFor(ui)`).
 */

export interface ShellInput {
  // size and state
  rows: number;
  cols: number;
  ui: UiState;
  // animation
  tick: number;
  step: number;
  // content
  header: HeaderModel;
  panes: PanesModel;
  // chrome
  keysOff: boolean;
  flash: Flash | null;
  sample: boolean;
}

/** The first content row (row 0 header, row 1 blank). */
const BODY_Y = 2;
/** Header + blank + spacer + footer. */
const CHROME_ROWS = 4;
/** Max conflict rows the FILES pane draws. */
const MAX_CONFLICT_ROWS = 3;
/** FILES ticker rows kept at minimum. */
const TICKER_MIN = 3;
/** FILES: title + 3 conflict rows + 6 ticker rows. */
const FILES_MAX_H = 10;
/** Right column collapsed: tabs + spacer + 3 body + spacer + PORTS title. */
const RIGHT_MIN = 7;
/** Right column focused: tabs + spacer + 4 body + spacer + PORTS title + 2 rows. */
const RIGHT_FOCUS_MIN = 10;

interface Measured {
  agents: number;
  filesHard: number;
  filesTicker: number;
}

function agentsModel(input: ShellInput, cardCols: number): Parameters<typeof drawAgentsPane>[2] {
  return {
    agents: input.panes.agents,
    idle: input.panes.idle,
    focused: input.ui.focus === "agents",
    sample: input.sample,
    cardCols,
    tick: input.tick,
    selectedId: input.ui.selectedAgentId,
    firstRow: 0,
  };
}

function filesModel(input: ShellInput): Parameters<typeof drawFilesPane>[2] {
  return {
    conflicts: input.panes.conflicts,
    groups: input.panes.groups,
    paused: input.ui.filesPaused,
    step: input.step,
    sample: input.sample,
  };
}

function rightModel(input: ShellInput, portsMinY: number): Parameters<typeof drawRightColumn>[2] {
  const p = input.panes;
  return {
    ui: input.ui,
    projects: p.projects,
    projectIndex: p.projectIndex,
    sessions: p.sessions,
    sessionStatus: p.sessionStatus,
    ports: p.ports,
    sample: input.sample,
    portsMinY,
  };
}

/** Natural AGENTS / FILES heights, measured by drawing into scratch Screens. */
function measureLeft(input: ShellInput, w: number, cardCols: number): Measured {
  const p = input.panes;
  const slots = p.agents.length + Math.ceil(p.idle.length / 3);
  const h = CARD_PITCH_Y * (slots + 1) + 2;
  const a = drawAgentsPane(new Screen(w, h), { x: 0, y: 0, w, h }, agentsModel(input, cardCols));
  const f = drawFilesPane(new Screen(w, FILES_MAX_H), { x: 0, y: 0, w, h: FILES_MAX_H }, filesModel(input));
  const filesHard = Math.min(f, 1 + Math.min(p.conflicts.length, MAX_CONFLICT_ROWS));
  return { agents: a.rows, filesHard, filesTicker: f - filesHard };
}

/** Draw AGENTS then FILES down one column; returns the FILES title row and the last row used. */
function drawLeft(
  scr: Screen,
  input: ShellInput,
  x: number,
  w: number,
  cardCols: number,
  agentsH: number,
  filesH: number,
  bottom: number,
): { filesY: number; end: number } {
  const ar: Rect = { x, y: BODY_Y, w, h: agentsH };
  const a = drawAgentsPane(scr, ar, agentsModel(input, cardCols));
  // a spacer after the grid only when the rect has a row left for it
  const filesY = BODY_Y + a.rows + (a.rows < agentsH ? 1 : 0);
  const fh = Math.max(0, Math.min(filesH, bottom - filesY));
  const f = drawFilesPane(scr, { x, y: filesY, w, h: fh }, filesModel(input));
  const end = f > 0 ? filesY + f - 1 : BODY_Y + a.rows - 1;
  return { filesY, end };
}

export function drawShell(input: ShellInput): Line[] {
  const g = geometry(input.cols, input.rows);
  if (g.mode === "small") return drawTooSmall(input.cols, input.rows, input.header);

  const cols = g.cols;
  const rows = g.rows;
  const scr = new Screen(cols, rows);
  drawHeader(scr, cols, input.header);

  const total = rows - CHROME_ROWS;
  /** Exclusive end of the content rows (the spacer row above the footer). */
  const bottom = BODY_Y + total;
  let end: number;

  if (g.split && g.divX !== null) {
    const m = measureLeft(input, g.LW, g.cardCols);
    const filesMin = m.filesHard + Math.min(TICKER_MIN, m.filesTicker);
    const demands: Demand[] = [
      { id: "files", min: filesMin, max: m.filesHard + m.filesTicker },
      { id: "agents", min: Math.min(CARD_PITCH_Y, m.agents), max: m.agents, step: CARD_PITCH_Y },
      { id: "agentsSpacer", min: 0, max: 1 },
    ];
    const b = allocate(total, demands, ["agentsSpacer", "agents", "files"]);
    const left = drawLeft(
      scr,
      input,
      0,
      g.LW,
      g.cardCols,
      (b.agents ?? 0) + (b.agentsSpacer ?? 0),
      b.files ?? 0,
      bottom,
    );
    const right = drawRightColumn(scr, { x: g.RX, y: BODY_Y, w: g.RW, h: total }, rightModel(input, left.filesY));
    end = Math.max(left.end, right.end);
    for (let y = BODY_Y; y <= end; y++) scr.put(g.divX, y, V2.vline, { fg: PALETTE.edge });
  } else {
    const m = measureLeft(input, cols, g.cardCols);
    const rh = Math.max(1, total * 4);
    const rNat = drawRightColumn(new Screen(cols, rh), { x: 0, y: 0, w: cols, h: rh }, rightModel(input, 0)).end + 1;
    const rightFocused = input.ui.focus === "right" || input.ui.focus === "ports";
    const agents: Demand = { id: "agents", min: Math.min(CARD_PITCH_Y, m.agents), max: m.agents, step: CARD_PITCH_Y };
    const filesHard: Demand = { id: "filesHard", min: m.filesHard, max: m.filesHard };
    const ticker: Demand = { id: "ticker", min: Math.min(TICKER_MIN, m.filesTicker), max: m.filesTicker };
    const right: Demand = { id: "right", min: Math.min(rightFocused ? RIGHT_FOCUS_MIN : RIGHT_MIN, rNat), max: rNat };
    const spacers: Demand[] = [
      { id: "agentsSpacer", min: 0, max: 1 },
      { id: "rightSpacer", min: 0, max: 1 },
    ];
    const demands = rightFocused
      ? [agents, filesHard, right, ticker, ...spacers]
      : [agents, filesHard, ticker, right, ...spacers];
    const grow = rightFocused
      ? ["right", "agentsSpacer", "agents", "ticker", "rightSpacer"]
      : ["agentsSpacer", "agents", "ticker", "right", "rightSpacer"];
    const b = allocate(total, demands, grow);
    const left = drawLeft(
      scr,
      input,
      0,
      cols,
      g.cardCols,
      (b.agents ?? 0) + (b.agentsSpacer ?? 0),
      (b.filesHard ?? 0) + (b.ticker ?? 0),
      bottom,
    );
    end = left.end;
    const ry = left.end + 1 + (b.rightSpacer ?? 0);
    const rH = Math.max(0, Math.min(b.right ?? 0, bottom - ry));
    if (rH > 0) {
      const r = drawRightColumn(scr, { x: 0, y: ry, w: cols, h: rH }, rightModel(input, 0));
      end = Math.max(end, r.end);
    }
  }

  const footerY = Math.min(end + 2, rows - 1);
  drawFooter(scr, footerY, cols, { hints: hintsFor(input.ui), keysOff: input.keysOff, flash: input.flash });
  return scr.toLines(footerY + 1);
}
