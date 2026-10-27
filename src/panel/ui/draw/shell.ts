import { Screen, type Line } from "../screen.js";
import { CARD_PITCH_Y, geometry } from "../geometry.js";
import { allocate, type Demand } from "../layout.js";
import { PALETTE } from "../palette.js";
import { V2 } from "../glyphs.js";
import { hintsFor } from "../keymap.js";
import type { UiState } from "../uiState.js";
import type { DetailModel, Flash, HeaderModel, PanesModel, Rect } from "../models.js";
import { drawHeader } from "./header.js";
import { drawAgentsPane } from "./agents.js";
import { DETAIL_ROWS, drawDetail } from "./detail.js";
import { drawFilesPane } from "./files.js";
import {
  bandFloor,
  drawBand,
  drawRightColumn,
  drawTabsBody,
  focusedFloor,
  portCursorKey,
  type RightColumnModel,
} from "./right.js";
import { drawPortsPane } from "./ports.js";
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
 *   - S1 (60-99 cols): the full-width stack AGENTS -> FILES ->
 *     PHASES|SESSIONS -> PORTS.
 *   - S2 (100-164 cols; Phase 10 plan 10-03, LAYOUT-04, UI-SPEC S2 row):
 *     AGENTS -> FILES -> a bottom band in which PHASES|SESSIONS (left,
 *     `band.leftW` = floor((cols - 5) / 2)) and PORTS (right, from
 *     `band.rightX`) sit side by side with their titles on the band's first
 *     row and the `│` divider at `band.divX` on the band rows only
 *     (`drawBand`). The band takes the right column's place in the stacked
 *     budget below; its height is the taller half's natural height.
 *   - D-20: every pane carries the ` sample ` chip while its `sample` flag is set; the
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
 *   - S2 band: the same as stacked, with the band in place of the right
 *              column: minimum tabs + spacer + a 3-row body (the PORTS half
 *              sits beside it), or `max(bandFloor(), 5)` when the band holds
 *              focus; the grid yields when one card row would leave the band
 *              below `bandFloor()`.
 *
 * Selection detail strip (Phase 10 plan 10-11; LAYOUT-07, UI-SPEC § Height
 * allocation priority 3 and shrink step 4): while `ui.selectedAgentId` names
 * `panes.detail`, a `detail` demand (pill row + segment row + 1 prompt row
 * minimum, 4 rows maximum) and a 0-1 `detailSpacer` join the left column,
 * drawn between the grid and the FILES title (drawLeft). Its minimum comes
 * right after the FILES title + conflict rows (they never yield, LAYOUT-03)
 * and before the grid's card row, so under pressure the grid collapses to its
 * title + `↓ N more` before the strip drops below 3 rows. It grows to 4 (the
 * second prompt line) before any extra card row.
 *   - split:   always that minimum (the right column does not compete). The
 *              detail spacer and the FILES ticker (to its preferred 6) grow
 *              before extra card rows, which gives the UI-SPEC 175x55 budget:
 *              5 card rows without a selection, 4 + the strip with one.
 *   - stacked / S2: that minimum only while AGENTS holds focus. With the
 *              right column, the band or PORTS focused the strip's minimum is
 *              0 and it grows only after the focused pane, so the 09-16 /
 *              10-01 floors stay authoritative (the strip yields first).
 *   - no detail, or a selection that is not `panes.detail.id`: every frame is
 *     exactly as before 10-11.
 *
 * Every pane clips to the rect it is given (09-09 rect clip), so nothing is
 * drawn outside its rect, every line is at most `cols` cells and at most
 * `rows` lines are returned.
 *
 * Sticky windows (Phase 10 plan 10-08, RESEARCH Pattern 3, LAYOUT-02):
 * `drawShellFrame` takes the previous frame's `ScrollState` as `input.scroll`
 * and returns the window each pane actually drew. The caller (PanelApp) keeps
 * it in a ref and feeds it back on the next draw, so a pane's window only
 * moves when its cursor leaves it. Every offset is clamped by the pane on every
 * render (agents: to the last start that still fills the rect), so a resize
 * can never leave a stale offset (milestone Pitfall 20). The grid's natural
 * height is always measured from offset 0, so allocation never depends on the
 * scroll position.
 *
 * 10-13 (LAYOUT-02, KEYS-02): PHASES, SESSIONS and PORTS join the sticky
 * windows. The shell resolves the cursors by identity: `ui.phaseCursor` (a
 * phase number) to its index in the shown project (a number that is not
 * there falls back to the current phase), `panes.sessionCursor` (a session
 * id) and `ui.portCursor` (a portKey; one that is gone draws no `❯`). The
 * previous offsets ride in from `input.scroll`, and `scroll.phases /
 * sessions / ports` report the windows the drawn right column or band used
 * (a pane not on screen keeps its offset with `visible: 0`). Natural heights
 * are measured without the offsets. With no cursors and no scroll input
 * every frame is unchanged.
 *
 * Per-pane sample chips (10-08, RESEARCH Pattern 4, D-23): `sample` is either
 * one boolean (every pane alike, as in Phase 9) or a `SampleFlags` record;
 * each pane's ` sample ` chip goes away when its own flag turns false. The
 * tabs row carries the chip of the ACTIVE tab.
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
  /** One flag for every pane, or one per pane (10-08, D-23). */
  sample: boolean | SampleFlags;
  /** The previous frame's windows (10-08, Pattern 3); absent = all at 0. */
  scroll?: ScrollState;
}

/** A pane's window: the first row (or item) drawn and how many were drawn. */
export interface PaneWindow {
  offset: number;
  visible: number;
}

/** The windows of every scrollable pane, fed back on the next draw (Pattern 3). */
export interface ScrollState {
  grid: PaneWindow;
  phases: PaneWindow;
  sessions: PaneWindow;
  ports: PaneWindow;
}

const NO_WINDOW: PaneWindow = Object.freeze({ offset: 0, visible: 0 });

export const EMPTY_SCROLL: ScrollState = Object.freeze({
  grid: NO_WINDOW,
  phases: NO_WINDOW,
  sessions: NO_WINDOW,
  ports: NO_WINDOW,
});

/** Which panes still draw SAMPLE data, and so carry the ` sample ` chip (D-23). */
export interface SampleFlags {
  agents: boolean;
  files: boolean;
  phases: boolean;
  sessions: boolean;
  ports: boolean;
}

/** `sample` normalized to one flag per pane. */
function flags(input: ShellInput): SampleFlags {
  const s = input.sample;
  if (typeof s === "boolean") return { agents: s, files: s, phases: s, sessions: s, ports: s };
  return s;
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
/** S2 band collapsed: tabs + spacer + a 3-row body (PORTS sits beside it). */
const BAND_MIN = 5;
/**
 * The unfocused AGENTS pane when the grid gives way to a focused bottom pane:
 * its title + the ↓ N more row drawAgentsPane draws when no card row fits.
 */
const AGENTS_COLLAPSED = 2;
/** The detail strip's minimum: pill row + segment row + one prompt row (shrink step 4). */
const DETAIL_MIN = 3;

/** The detail model to draw this frame, or null (no selection, or not this one). */
function detailOf(input: ShellInput): DetailModel | null {
  const d = input.panes.detail;
  if (d === undefined || d === null) return null;
  const sel = input.ui.selectedAgentId;
  return sel !== null && sel === d.id ? d : null;
}

/** The left column's row grants, as drawLeft takes them. */
interface LeftRows {
  /** AGENTS + its trailing spacer. */
  agents: number;
  detail: number;
  detailSpacer: number;
  /** FILES title + conflicts + ticker. */
  files: number;
}

function leftRows(b: Record<string, number>): LeftRows {
  return {
    agents: (b.agents ?? 0) + (b.agentsSpacer ?? 0),
    detail: b.detail ?? 0,
    detailSpacer: b.detailSpacer ?? 0,
    files: (b.filesHard ?? 0) + (b.ticker ?? 0),
  };
}

interface Measured {
  agents: number;
  filesHard: number;
  filesTicker: number;
}

/** The AGENTS model; `firstRow` is the fed-back grid offset unless `natural` (measurement). */
function agentsModel(input: ShellInput, cardCols: number, natural = false): Parameters<typeof drawAgentsPane>[2] {
  return {
    agents: input.panes.agents,
    idle: input.panes.idle,
    focused: input.ui.focus === "agents",
    sample: flags(input).agents,
    cardCols,
    tick: input.tick,
    selectedId: input.ui.selectedAgentId,
    firstRow: natural ? 0 : (input.scroll?.grid.offset ?? 0),
  };
}

function filesModel(input: ShellInput): Parameters<typeof drawFilesPane>[2] {
  return {
    conflicts: input.panes.conflicts,
    groups: input.panes.groups,
    paused: input.ui.filesPaused,
    step: input.step,
    sample: flags(input).files,
    // 10-12 (LAYOUT-07): one model for measureLeft and drawLeft alike
    narrowed: input.panes.filesNarrowed === true,
  };
}

/** `ui.phaseCursor` (a phase number) as an index in the shown project, or null (10-13). */
function phaseCursorIndex(input: ShellInput): number | null {
  const id = input.ui.phaseCursor;
  const projects = input.panes.projects;
  if (id === null || projects.length === 0) return null;
  const pi = Math.min(Math.max(0, Math.trunc(input.panes.projectIndex) || 0), projects.length - 1);
  const k = projects[pi]?.phases.findIndex((ph) => ph.number === id) ?? -1;
  return k >= 0 ? k : null;
}

function rightModel(input: ShellInput, portsMinY: number): Parameters<typeof drawRightColumn>[2] {
  const p = input.panes;
  const f = flags(input);
  const sc = input.scroll;
  return {
    ui: input.ui,
    projects: p.projects,
    projectIndex: p.projectIndex,
    sessions: p.sessions,
    sessionStatus: p.sessionStatus,
    ports: p.ports,
    sample: f.phases || f.sessions,
    sampleTabs: f[input.ui.rightTab],
    samplePorts: f.ports,
    portsMinY,
    // 10-13: identity cursors and the previous windows
    phaseCursor: phaseCursorIndex(input),
    ...(p.sessionCursor !== undefined ? { sessionCursor: p.sessionCursor } : {}),
    portCursor: input.ui.portCursor,
    sessionsScanning: p.sessionsScanning === true,
    ...(sc !== undefined
      ? { offsets: { phases: sc.phases.offset, sessions: sc.sessions.offset, ports: sc.ports.offset } }
      : {}),
  };
}

/** The windows of panes that are not on screen this frame: the previous offsets, nothing drawn. */
function keptWindows(input: ShellInput): Pick<ScrollState, "phases" | "sessions" | "ports"> {
  const sc = input.scroll;
  return {
    phases: { offset: sc?.phases.offset ?? 0, visible: 0 },
    sessions: { offset: sc?.sessions.offset ?? 0, visible: 0 },
    ports: { offset: sc?.ports.offset ?? 0, visible: 0 },
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

/** The grid collapsed to its title + the `↓ N more` row (09-16; 10-11). */
function collapsedGrid(m: Measured): Demand {
  const n = Math.min(AGENTS_COLLAPSED, m.agents);
  return { id: "agents", min: n, max: n };
}

/** Natural AGENTS / FILES heights, measured by drawing into scratch Screens. */
function measureLeft(input: ShellInput, w: number, cardCols: number): Measured {
  const p = input.panes;
  const slots = p.agents.length + Math.ceil(p.idle.length / 3);
  const h = CARD_PITCH_Y * (slots + 1) + 2;
  const a = drawAgentsPane(new Screen(w, h), { x: 0, y: 0, w, h }, agentsModel(input, cardCols, true));
  const f = drawFilesPane(new Screen(w, FILES_MAX_H), { x: 0, y: 0, w, h: FILES_MAX_H }, filesModel(input));
  const filesHard = Math.min(f, 1 + Math.min(p.conflicts.length, MAX_CONFLICT_ROWS));
  return { agents: a.rows, filesHard, filesTicker: f - filesHard };
}

/**
 * The S2 band's natural height (10-03): the taller of the tabs half (tabs +
 * spacer + the active body's natural rows at `leftW`) and the PORTS half
 * (its natural rows at `rightW`), measured by drawing into scratch Screens.
 */
function bandNatural(rm: RightColumnModel, leftW: number, rightW: number, h: number): number {
  const left = drawTabsBody(new Screen(leftW, h), { x: 0, y: 0, w: leftW, h }, rm, h - 2).end + 1;
  const focused = rm.ui.focus === "ports";
  const ports = drawPortsPane(
    new Screen(rightW, h),
    { x: 0, y: 0, w: rightW, h },
    {
      ports: rm.ports,
      focused,
      cursorKey: portCursorKey(rm),
      sample: rm.samplePorts ?? rm.sample,
    },
  );
  return Math.max(left, ports);
}

/**
 * Draw AGENTS, the detail strip (10-11, while one is granted rows) and FILES
 * down one column; returns the FILES title row, the last row used and the
 * grid window drawn (10-08).
 */
function drawLeft(
  scr: Screen,
  input: ShellInput,
  x: number,
  w: number,
  cardCols: number,
  h: LeftRows,
  detail: DetailModel | null,
  bottom: number,
): { filesY: number; end: number; grid: PaneWindow } {
  const ar: Rect = { x, y: BODY_Y, w, h: h.agents };
  const a = drawAgentsPane(scr, ar, agentsModel(input, cardCols));
  let end = BODY_Y + a.rows - 1;
  // a spacer after the grid only when the rect has a row left for it
  let y = BODY_Y + a.rows + (a.rows < h.agents ? 1 : 0);
  if (detail !== null && h.detail > 0) {
    const dh = Math.max(0, Math.min(h.detail, bottom - y));
    const d = drawDetail(scr, { x, y, w, h: dh }, detail);
    if (d > 0) {
      end = y + d - 1;
      y += d + (h.detailSpacer > 0 ? 1 : 0);
    }
  }
  const filesY = y;
  const fh = Math.max(0, Math.min(h.files, bottom - filesY));
  const f = drawFilesPane(scr, { x, y: filesY, w, h: fh }, filesModel(input));
  if (f > 0) end = filesY + f - 1;
  return { filesY, end, grid: { offset: a.firstRow, visible: a.visibleRows } };
}

/** The frame lines only (every Phase 9 caller); see drawShellFrame. */
export function drawShell(input: ShellInput): Line[] {
  return drawShellFrame(input).lines;
}

/**
 * The frame plus the windows the panes drew (10-08, Pattern 3). Feed `scroll`
 * back as `input.scroll` on the next draw.
 */
export function drawShellFrame(input: ShellInput): { lines: Line[]; scroll: ScrollState } {
  const g = geometry(input.cols, input.rows);
  if (g.mode === "small") return { lines: drawTooSmall(g.cols, g.rows, input.header), scroll: EMPTY_SCROLL };

  const cols = g.cols;
  const rows = g.rows;
  const scr = new Screen(cols, rows);
  drawHeader(scr, cols, input.header);

  const total = rows - CHROME_ROWS;
  /** Exclusive end of the content rows (the spacer row above the footer). */
  const bottom = BODY_Y + total;
  let end: number;
  let gridWin: PaneWindow = NO_WINDOW;
  let lists = keptWindows(input);

  const detail = detailOf(input);

  if (g.split && g.divX !== null) {
    const m = measureLeft(input, g.LW, g.cardCols);
    // WR-02: FILES title + conflicts, then the grid's card row, then the ticker
    const [grid0, gridSpacer] = gridDemands(m);
    const filesHard: Demand = { id: "filesHard", min: m.filesHard, max: m.filesHard };
    const ticker: Demand = { id: "ticker", min: Math.min(TICKER_MIN, m.filesTicker), max: m.filesTicker };
    let b: Record<string, number>;
    if (detail === null) {
      b = allocate(total, [filesHard, grid0, ticker, gridSpacer], ["agentsSpacer", "agents", "ticker"]);
    } else {
      // 10-11: the strip's minimum before the grid's card row; the grid collapses first
      const yields = total - m.filesHard - DETAIL_MIN < cardMinOf(m);
      const grid: Demand = yields ? collapsedGrid(m) : grid0;
      b = allocate(
        total,
        [
          filesHard,
          { id: "detail", min: DETAIL_MIN, max: DETAIL_ROWS },
          grid,
          ticker,
          yields ? { id: "agentsSpacer", min: 0, max: 1 } : gridSpacer,
          { id: "detailSpacer", min: 0, max: 1 },
        ],
        ["agentsSpacer", "detail", "detailSpacer", "ticker", "agents"],
      );
    }
    const left = drawLeft(scr, input, 0, g.LW, g.cardCols, leftRows(b), detail, bottom);
    const right = drawRightColumn(scr, { x: g.RX, y: BODY_Y, w: g.RW, h: total }, rightModel(input, left.filesY));
    gridWin = left.grid;
    lists = right.windows;
    end = Math.max(left.end, right.end);
    for (let y = BODY_Y; y <= end; y++) scr.put(g.divX, y, V2.vline, { fg: PALETTE.edge });
  } else {
    const m = measureLeft(input, cols, g.cardCols);
    const rh = Math.max(1, total * 4);
    const band = g.band;
    const rm = rightModel(input, 0);
    // natural heights are measured from offset 0 (10-13), like the grid's
    const nat: RightColumnModel = { ...rm, offsets: undefined };
    // S2 (10-03): the band stands in for the right column; its natural height is the taller half's
    const rNat =
      band !== null
        ? bandNatural(nat, band.leftW, band.rightW, rh)
        : drawRightColumn(new Screen(cols, rh), { x: 0, y: 0, w: cols, h: rh }, nat).end + 1;
    const rightFocused = input.ui.focus === "right" || input.ui.focus === "ports";
    // 10-11: with AGENTS focused the strip's minimum comes before the grid's card row
    const detailMin = detail !== null && !rightFocused ? DETAIL_MIN : 0;
    // 09-16: the grid keeps its one card row unless that would leave the focused pane below its floor
    const cardMin = cardMinOf(m);
    const focusFloor = Math.min(band !== null ? bandFloor(rm) : focusedFloor(rm), rNat);
    const gridYields =
      (rightFocused && total - cardMin - m.filesHard < focusFloor) ||
      (detailMin > 0 && total - m.filesHard - detailMin < cardMin);
    const [grid, gridSpacer] = gridDemands(m);
    const agents: Demand = gridYields ? collapsedGrid(m) : grid;
    const filesHard: Demand = { id: "filesHard", min: m.filesHard, max: m.filesHard };
    const ticker: Demand = { id: "ticker", min: Math.min(TICKER_MIN, m.filesTicker), max: m.filesTicker };
    const rightMin =
      band !== null
        ? rightFocused
          ? Math.max(bandFloor(rm), BAND_MIN)
          : BAND_MIN
        : rightFocused
          ? RIGHT_FOCUS_MIN
          : RIGHT_MIN;
    const rid = band !== null ? "band" : "right";
    const right: Demand = { id: rid, min: Math.min(rightMin, rNat), max: rNat };
    const spacers: Demand[] = [
      gridYields ? { id: "agentsSpacer", min: 0, max: 1 } : gridSpacer,
      { id: "rightSpacer", min: 0, max: 1 },
    ];
    let demands = rightFocused
      ? [agents, filesHard, right, ticker, ...spacers]
      : [agents, filesHard, ticker, right, ...spacers];
    let grow = rightFocused
      ? [rid, "agentsSpacer", "agents", "ticker", "rightSpacer"]
      : ["agentsSpacer", "agents", "ticker", rid, "rightSpacer"];
    if (detail !== null) {
      // 10-11: FILES title + conflicts, the strip, then the rest; the strip grows before extra card rows
      const strip: Demand = { id: "detail", min: detailMin, max: DETAIL_ROWS };
      demands = rightFocused
        ? [agents, filesHard, right, strip, ticker, ...spacers]
        : [filesHard, strip, agents, ticker, right, ...spacers];
      demands.push({ id: "detailSpacer", min: 0, max: 1 });
      const at = grow.indexOf("agents");
      grow = [...grow.slice(0, at), "detail", ...grow.slice(at), "detailSpacer"];
    }
    const b = allocate(total, demands, grow);
    const left = drawLeft(scr, input, 0, cols, g.cardCols, leftRows(b), detail, bottom);
    gridWin = left.grid;
    end = left.end;
    const ry = left.end + 1 + (b.rightSpacer ?? 0);
    const rH = Math.max(0, Math.min(b[rid] ?? 0, bottom - ry));
    if (rH > 0) {
      const rect: Rect = { x: 0, y: ry, w: cols, h: rH };
      const r = band !== null ? drawBand(scr, rect, band, rm) : drawRightColumn(scr, rect, rm);
      end = Math.max(end, r.end);
      lists = r.windows;
    }
  }

  const footerY = Math.min(end + 2, rows - 1);
  drawFooter(scr, footerY, cols, { hints: hintsFor(input.ui), keysOff: input.keysOff, flash: input.flash });
  // 10-13: the list windows of the right column or band that landed on screen
  const scroll: ScrollState = { grid: gridWin, ...lists };
  return { lines: scr.toLines(footerY + 1), scroll };
}
