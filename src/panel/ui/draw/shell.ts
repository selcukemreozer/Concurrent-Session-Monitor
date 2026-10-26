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
import { drawRightColumn, focusedFloor } from "./right.js";
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
 *   - D-27: below 60x16 the too-small screen is returned instead, drawn at
 *     the geometry-normalized size (a NaN, Infinity or negative size is 0),
 *     so a bad size can never build an unbounded Screen (WR-07).
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
 * Whenever the grid overflows one card row, its minimum is title + one card
 * row + the `↓ N more` row (`8 + 1`), so a clipped grid always says how many
 * cards and strips it hides (D-19, WR-01).
 *   - split:   minimums FILES title + conflict rows, AGENTS (that minimum),
 *              the FILES ticker (up to 3), then the spacer after the grid;
 *              growth: that spacer, AGENTS (whole card rows of 8), the FILES
 *              ticker (to 6). The grid's card row is served before the ticker,
 *              so a 16-row split frame shows a card (UI-SPEC shrink order:
 *              the ticker shrinks before the grid; WR-02). The spacer grows
 *              before the grid so no rows are wasted on a card row that
 *              cannot be drawn.
 *   - stacked: minimums AGENTS, FILES title + conflict rows, FILES ticker (up
 *              to 3), the right column's collapsed minimum (tabs, a 3-row body,
 *              the PORTS title); growth: grid spacer, AGENTS, FILES ticker,
 *              right column, then the spacer above the tabs. With focus on the
 *              right column or PORTS, the right column's expanded minimum
 *              (tabs + 4 body rows + PORTS title + 2 rows) moves ahead of the
 *              FILES ticker and the right column grows first, so a collapsed
 *              bottom pane that gets focus expands: it takes rows from the
 *              FILES ticker (down to 0) and from the grid. When even one card
 *              row would leave the focused pane below its floor
 *              (`focusedFloor()`: title + one body row; for PHASES title +
 *              the 4 header rows + one timeline row, WR-09), the unfocused
 *              AGENTS pane collapses to AGENTS_COLLAPSED rows (title + ↓ N
 *              more) instead, so the focused pane always draws its inverse
 *              title and real content (UI-SPEC § Shrink order, IN-05; D-13;
 *              09-16). FILES title and conflict rows never yield (LAYOUT-03).
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
/**
 * The unfocused AGENTS pane when the grid gives way to a focused bottom pane:
 * its title + the ↓ N more row drawAgentsPane draws when no card row fits.
 */
const AGENTS_COLLAPSED = 2;

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

/**
 * The grid's minimum (D-19, WR-01): title + one card row + the `↓ N more` row
 * whenever the grid overflows one card row, else its whole natural height.
 */
function cardMinOf(m: Measured): number {
  return m.agents > CARD_PITCH_Y ? CARD_PITCH_Y + 1 : m.agents;
}

/**
 * The grid and its trailing spacer as allocate() demands. An overflowing grid
 * (natural height 8K) grows on the 8k + 1 lattice from CARD_PITCH_Y + 1: k
 * card rows + the `↓ N more` row, or at k = K the whole grid + its spacer
 * (8K + 1). The spacer is then part of the grid demand, so the full grid is
 * still reachable (the approved 175x55 frame). A grid of one card row or less
 * keeps its natural height and a separate 0-1 spacer, as in Phase 9.
 */
function gridDemands(m: Measured): [Demand, Demand] {
  if (m.agents > CARD_PITCH_Y) {
    return [
      { id: "agents", min: CARD_PITCH_Y + 1, max: m.agents + 1, step: CARD_PITCH_Y },
      { id: "agentsSpacer", min: 0, max: 0 },
    ];
  }
  return [
    { id: "agents", min: m.agents, max: m.agents },
    { id: "agentsSpacer", min: 0, max: 1 },
  ];
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
  if (g.mode === "small") return drawTooSmall(g.cols, g.rows, input.header);

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
    // WR-02: FILES title + conflicts, then the grid's card row, then the ticker
    const [grid, gridSpacer] = gridDemands(m);
    const demands: Demand[] = [
      { id: "filesHard", min: m.filesHard, max: m.filesHard },
      grid,
      { id: "ticker", min: Math.min(TICKER_MIN, m.filesTicker), max: m.filesTicker },
      gridSpacer,
    ];
    const b = allocate(total, demands, ["agentsSpacer", "agents", "ticker"]);
    const left = drawLeft(
      scr,
      input,
      0,
      g.LW,
      g.cardCols,
      (b.agents ?? 0) + (b.agentsSpacer ?? 0),
      (b.filesHard ?? 0) + (b.ticker ?? 0),
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
    // 09-16: the grid keeps its one card row unless that would leave the focused pane below its floor
    const cardMin = cardMinOf(m);
    const focusFloor = Math.min(focusedFloor(rightModel(input, 0)), rNat);
    const gridYields = rightFocused && total - cardMin - m.filesHard < focusFloor;
    const collapsed = Math.min(AGENTS_COLLAPSED, m.agents);
    const [grid, gridSpacer] = gridDemands(m);
    const agents: Demand = gridYields ? { id: "agents", min: collapsed, max: collapsed } : grid;
    const filesHard: Demand = { id: "filesHard", min: m.filesHard, max: m.filesHard };
    const ticker: Demand = { id: "ticker", min: Math.min(TICKER_MIN, m.filesTicker), max: m.filesTicker };
    const right: Demand = { id: "right", min: Math.min(rightFocused ? RIGHT_FOCUS_MIN : RIGHT_MIN, rNat), max: rNat };
    const spacers: Demand[] = [
      gridYields ? { id: "agentsSpacer", min: 0, max: 1 } : gridSpacer,
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
