import type { Screen, Style } from "../screen.js";
import { cellWidth, nameText, pathText, plainText } from "../text.js";
import { PALETTE, stateColor, type AgentState } from "../palette.js";
import { V2 } from "../glyphs.js";
import { CARD_H, CARD_PITCH_X, CARD_PITCH_Y, CARD_W } from "../geometry.js";
import type { AgentCard, IdleStrip, Rect } from "../models.js";
import { drawTitle } from "./title.js";

/**
 * The v2 AGENTS column (Phase 9, plan 09-07; UI-SPEC section Session card, the
 * approved 175x55 frame rows 2-25).
 *
 *   - D-09: a card is 7 rows x 47 cells: state-color top edge, icon + name,
 *     `dir . branch . uptime`, model, `> last prompt`, STATE label with the
 *     right-aligned `!N wN rN` counts, and a light bottom or a red conflict
 *     edge. There is no task-annotation, skill or target-branch line: the
 *     annotation moves to the Phase 10 detail strip.
 *   - D-11: the prompt row is the LAST USER PROMPT, read from the transcript
 *     in Phase 10. The asking card keeps its interior tint but shows the last
 *     prompt like every other card; the AskUserQuestion text is never drawn.
 *   - D-12 (card look only): the selected card draws the heavy frame in its
 *     state color (red bottom when in conflict); the other cards dim to dim2
 *     while keeping the state icon and every red element (red is never
 *     dimmed). The selection itself, the detail strip and the 15 s selection
 *     drop arrive in Phase 10.
 *   - D-10: idle sessions are 2-row strips stacked 3 per card slot after the
 *     last active card (in calm mode from slot 0, i.e. column by column).
 *   - D-08: always cards. The grid shows whole card rows only; hidden rows
 *     are announced with `up N more` (under the title) / `down N more` (in
 *     the spacer row after the last visible card row), N counting hidden
 *     cards + strips. `firstRow` is the scroll input Phase 10 drives from the
 *     selection.
 *
 * Every dynamic string is made cell-safe before Screen.put (T-09-01c): names
 * through `nameText`, everything else through `plainText`, each within a
 * fixed cell budget (T-09-02c). Pure: no Ink, no I/O.
 */

/** U+2014, shown for a missing model or prompt. */
const DASH = "\u2014";
/** ` U+00B7 `, the meta-line separator. */
const SEP = " \u00b7 ";
/** U+00D7, the subagent count prefix. */
const TIMES = "\u00d7";

/** Interior width between the side borders (x1..x45). */
const INNER = CARD_W - 2;
/** Name / meta / model budget: x4..x44. */
const TEXT_W = 41;
/** Prompt budget: x6..x43. */
const PROMPT_W = 38;
/** Counts end at x44: their exclusive end is x45. */
const COUNT_END = CARD_W - 2;
/** waitFor budget (`4m`, `12m`, `3h51m`). */
const WAIT_W = 6;

const LABEL: Record<AgentState, string> = {
  asking: "ASKING",
  waiting: "WAITING",
  running: "RUNNING",
  subagent: "SUBAGENT",
};

const ICON: Record<AgentState, string> = {
  asking: V2.asking,
  waiting: V2.waiting,
  running: V2.running,
  subagent: V2.subagent,
};

export const EMPTY_HEADING = "no Claude Code sessions";
export const EMPTY_BODY = "start claude in any project folder; it appears here within a second";

/** A non-negative integer from untrusted numeric input. */
function int(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

/** A count as display text, capped so the counts never reach the label. */
function countText(n: number): string {
  const v = int(n);
  return v > 999 ? "999+" : String(v);
}

/**
 * `dir . branch . uptime` in 41 cells. The uptime is never cut (IN-02, Phase
 * 10 plan 10-02): the dir is budgeted to what the uptime, both separators and
 * one branch cell leave and is start-truncated (`pathText`, the folder name
 * stays); the branch then truncates first into the remaining room.
 */
function metaLine(c: AgentCard): string {
  const up = plainText(c.uptime, TEXT_W);
  const dirW = TEXT_W - cellWidth(up) - 2 * cellWidth(SEP) - 1;
  const dir = pathText(c.dir, Math.max(1, dirW));
  const room = TEXT_W - cellWidth(dir) - cellWidth(up) - 2 * cellWidth(SEP);
  const branch = plainText(c.branch, Math.max(1, room));
  return plainText(`${dir}${SEP}${branch}${SEP}${up}`, TEXT_W);
}

export function drawCard(
  scr: Screen,
  x: number,
  y: number,
  c: AgentCard,
  o: { tick: number; index: number; selected: boolean; dimmed: boolean },
): void {
  const sc = stateColor(c.state);
  const dim = o.dimmed && !o.selected;
  const tone = (color: string): string => (dim ? PALETTE.dim2 : color);
  const red: Style = { fg: PALETTE.red };
  const by = y + CARD_H - 1;

  // row 0: top edge (heavy frame top when selected)
  if (o.selected) scr.put(x, y, V2.heavyTL + V2.heavyH.repeat(INNER) + V2.heavyTR, { fg: sc });
  else scr.put(x, y, V2.edgeTop.repeat(CARD_W), { fg: dim ? PALETTE.edge : sc });

  // rows 1-5: side borders
  const side = o.selected ? V2.heavyV : V2.vline;
  const sideSt: Style = { fg: o.selected ? sc : tone(PALETTE.edge) };
  for (let r = 1; r < CARD_H - 1; r++) {
    scr.put(x, y + r, side, sideSt);
    scr.put(x + CARD_W - 1, y + r, side, sideSt);
  }

  // row 6: bottom (red is never dimmed)
  if (o.selected) {
    scr.put(x, by, V2.heavyBL + V2.heavyH.repeat(INNER) + V2.heavyBR, c.inConflict ? red : { fg: sc });
  } else if (c.inConflict) {
    scr.put(x, by, V2.edgeBottom.repeat(CARD_W), red);
  } else {
    scr.put(x, by, V2.cornerBL + V2.hline.repeat(INNER) + V2.cornerBR, { fg: tone(PALETTE.edge) });
  }

  // row 1: icon (keeps its state color even when dimmed) + name
  scr.put(x + 2, y + 1, ICON[c.state], { fg: sc, bold: true });
  const name = nameText(c.name, TEXT_W) || plainText(c.id, TEXT_W) || DASH;
  scr.put(x + 4, y + 1, name, { fg: tone(PALETTE.hi), bold: true });

  // row 2: meta
  scr.put(x + 4, y + 2, metaLine(c), { fg: tone(PALETTE.dim) });

  // row 3: model
  const model = c.model === null ? "" : plainText(c.model, TEXT_W);
  scr.put(x + 4, y + 3, model || DASH, { fg: tone(PALETTE.fg) });

  // row 4: last prompt (D-11)
  scr.put(x + 4, y + 4, V2.prompt, { fg: tone(PALETTE.dim) });
  const prompt = c.prompt === null ? "" : plainText(c.prompt, PROMPT_W);
  scr.put(x + 6, y + 4, prompt || DASH, { fg: tone(PALETTE.fg) });

  // row 5: STATE label (+ wait / subagents / spinner) and the counts
  let label = LABEL[c.state];
  if (c.state === "waiting" && c.waitFor !== null) {
    const wait = plainText(c.waitFor, WAIT_W);
    if (wait !== "") label += ` ${wait}`;
  }
  if (c.state === "subagent") label += ` ${TIMES}${countText(c.subagents)}`;
  const lx = scr.put(x + 2, y + 5, label, { fg: tone(sc), bold: true });
  if (c.state === "running") {
    const n = V2.spinner.length;
    const t = Number.isFinite(o.tick) ? Math.trunc(o.tick) : 0;
    const i = Number.isFinite(o.index) ? Math.trunc(o.index) : 0;
    const f = (((t + 3 * i) % n) + n) % n;
    scr.put(lx + 1, y + 5, V2.spinner[f] ?? V2.spinner[0], { fg: tone(sc) });
  }

  const parts: Array<[string, Style]> = [];
  if (int(c.conflicts) > 0) parts.push([V2.conflict + countText(c.conflicts), { fg: PALETTE.red, bold: true }]);
  if (int(c.writes) > 0) parts.push([V2.write + countText(c.writes), { fg: tone(PALETTE.fg) }]);
  if (int(c.reads) > 0) parts.push([V2.read + countText(c.reads), { fg: tone(PALETTE.blue) }]);
  const pl = parts.reduce((s, [t]) => s + cellWidth(t), 0) + Math.max(0, parts.length - 1);
  let cx = x + COUNT_END - pl;
  for (const [t, st] of parts) cx = scr.put(cx, y + 5, t, st) + 1;

  // the asking tint goes on last: Screen.fill keeps the drawn cells' text and fg
  if (c.state === "asking" && !dim) {
    for (let r = 1; r < CARD_H - 1; r++) scr.fill(x + 1, y + r, INNER, PALETTE.askBg);
  }
}

export function drawIdleStrip(scr: Screen, x: number, y: number, s: IdleStrip, o: { dimmed: boolean }): void {
  scr.put(x, y, V2.edgeTop.repeat(CARD_W), { fg: o.dimmed ? PALETTE.edge : PALETTE.idle });
  scr.put(x + 2, y + 1, V2.idleDot, { fg: PALETTE.dim2 });
  const ago = plainText(s.ago, 12);
  const name = nameText(s.name, CARD_W - 8 - cellWidth(ago)) || DASH;
  scr.put(x + 4, y + 1, name, { fg: o.dimmed ? PALETTE.dim2 : PALETTE.dim });
  scr.put(x + CARD_W - 2 - cellWidth(ago), y + 1, ago, { fg: PALETTE.dim2 });
}

type Slot = { card: AgentCard; index: number } | { strips: readonly IdleStrip[] };

function items(s: Slot): number {
  return "card" in s ? 1 : s.strips.length;
}

function sumItems(slots: readonly Slot[], from: number, to: number): number {
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(slots.length, to); i++) n += items(slots[i] as Slot);
  return n;
}

/**
 * What drawAgentsPane reports: the rows used from `r.y`, the hidden-item count
 * below, and the grid window it drew (Phase 10 plan 10-08, RESEARCH Pattern 3):
 * `firstRow` is the clamped first card row drawn and `visibleRows` the number
 * of card rows drawn. The shell feeds `firstRow` back as the next render's
 * offset, so the window is sticky.
 */
export interface AgentsPaneResult {
  rows: number;
  moreBelow: number;
  firstRow: number;
  visibleRows: number;
}

/**
 * Draw the AGENTS pane into `r` and return the rows used from `r.y` (the
 * `down N more` row included) and the hidden-item count below (0 = no `down`
 * row). Clipping, with `available = r.h - 1` (minus 1 more for the `up` row):
 * when every remaining card row fits (`rows*8 - 1 <= available`) all are
 * drawn; otherwise `max(1, floor(available / 8))` card rows are drawn and the
 * `down` row takes the spacer after them. Nothing is ever drawn outside `r`
 * and `rows <= r.h` always (09-09 rect clip): with room for one card row but
 * not its `down` row (h = 8) the card row is drawn and the `down` row is
 * omitted (`moreBelow` still counts the hidden items); with less than one card
 * row only the `down` row is drawn. The shell places FILES after `rows`, plus
 * one spacer row when `rows < r.h`. A pane narrower than one card (`r.w <
 * CARD_W`) draws only its title and `down N more` counting every card and
 * strip (Phase 10 plan 10-02, WR-06).
 */
export function drawAgentsPane(
  scr: Screen,
  r: Rect,
  m: {
    agents: readonly AgentCard[];
    idle: readonly IdleStrip[];
    focused: boolean;
    sample: boolean;
    cardCols: number;
    tick: number;
    selectedId: string | null;
    firstRow: number;
  },
): AgentsPaneResult {
  if (r.h < 1 || r.w < 1) return { rows: 0, moreBelow: 0, firstRow: 0, visibleRows: 0 };
  const nA = m.agents.length;
  const nI = m.idle.length;
  const right =
    nA === 0 && nI === 0 ? "0 active" : nA === 0 ? `${nI} idle` : `${nA} active${SEP}${nI} idle`;
  drawTitle(scr, r.x, r.y, r.w, { label: "AGENTS", focused: m.focused, sample: m.sample, right });

  const dimSt: Style = { fg: PALETTE.dim };

  if (nA === 0 && nI === 0) {
    let rows = 1;
    if (r.h >= 2) {
      scr.put(r.x + 2, r.y + 1, plainText(EMPTY_HEADING, r.w - 2), dimSt);
      rows = 2;
    }
    if (r.h >= 3) {
      scr.put(r.x + 2, r.y + 2, plainText(EMPTY_BODY, r.w - 2), { fg: PALETTE.dim2 });
      rows = 3;
    }
    return { rows, moreBelow: 0, firstRow: 0, visibleRows: 0 };
  }

  // WR-06 (Phase 10 plan 10-02): a pane narrower than one card draws no card
  // (drawCard paints 47 fixed cells): only its title and `↓ N more`.
  const fit = Math.floor((r.w + 2) / CARD_PITCH_X);
  if (fit === 0) {
    const n = nA + nI;
    if (r.h >= 2 && r.w > 2) {
      scr.put(r.x + 2, r.y + 1, plainText(`${V2.down} ${n} more`, r.w - 2), dimSt);
      return { rows: 2, moreBelow: n, firstRow: 0, visibleRows: 0 };
    }
    return { rows: 1, moreBelow: n, firstRow: 0, visibleRows: 0 };
  }
  const want = Number.isFinite(m.cardCols) ? Math.trunc(m.cardCols) : 1;
  const cols = Math.min(fit, Math.max(1, want));

  const slots: Slot[] = m.agents.map((card, index) => ({ card, index }));
  for (let j = 0; j < nI; j += 3) slots.push({ strips: m.idle.slice(j, j + 3) });
  const cardRows = Math.ceil(slots.length / cols);

  const fr = Number.isFinite(m.firstRow) ? Math.trunc(m.firstRow) : 0;
  // 10-08 (Pattern 3, Pitfall 20): a fed-back offset is clamped to the last
  // start whose remaining card rows still fill the rect (under the `up` row),
  // and to 0 when the whole grid fits, so a resize never leaves rows hidden
  // above a window that has room for them.
  const allFit = cardRows * CARD_PITCH_Y - 1 <= r.h - 1;
  const maxStart = allFit ? 0 : Math.max(0, cardRows - Math.max(1, Math.floor((r.h - 1) / CARD_PITCH_Y)));
  const first = Math.min(Math.max(0, fr), maxStart);
  // the `up` row needs a row under the title inside the rect (09-09 rect clip)
  const up = first > 0 && r.h >= 2;
  const available = r.h - 1 - (up ? 1 : 0);
  const remaining = cardRows - first;
  // Rect clip (09-09): every row drawn lies inside r. When all remaining card
  // rows fit they are all drawn; otherwise as many whole card rows as leave
  // room for the `down` row. If not even one card row + the `down` row fits,
  // one card row is still drawn when it fits on its own (the `down` row is
  // then omitted); below that only the `down` row is drawn.
  let k: number;
  let downRow = true;
  if (remaining * CARD_PITCH_Y - 1 <= available) {
    k = remaining;
  } else {
    k = Math.min(remaining, Math.floor(available / CARD_PITCH_Y));
    if (k === 0 && available >= CARD_H) {
      k = 1;
      downRow = false;
    } else if (k === 0 && available < 1) {
      downRow = false;
    }
  }
  const above = sumItems(slots, 0, first * cols);
  const below = sumItems(slots, (first + k) * cols, slots.length);

  const hasSel = m.selectedId !== null && m.agents.some((a) => a.id === m.selectedId);
  let gy = r.y + 1;
  if (up) {
    scr.put(r.x + 2, gy, `${V2.up} ${above} more`, dimSt);
    gy += 1;
  }

  for (let row = first; row < first + k; row++) {
    const sy = gy + (row - first) * CARD_PITCH_Y;
    for (let col = 0; col < cols; col++) {
      const slot = slots[row * cols + col];
      if (!slot) continue;
      const sx = r.x + col * CARD_PITCH_X;
      if ("card" in slot) {
        const sel = hasSel && slot.card.id === m.selectedId;
        drawCard(scr, sx, sy, slot.card, {
          tick: m.tick,
          index: slot.index,
          selected: sel,
          dimmed: hasSel && !sel,
        });
      } else {
        slot.strips.forEach((s, j) => drawIdleStrip(scr, sx, sy + 2 * j, s, { dimmed: hasSel }));
      }
    }
  }

  let rows = 1 + (up ? 1 : 0) + Math.max(0, k * CARD_PITCH_Y - 1);
  if (below > 0 && downRow) {
    const dy = k > 0 ? gy + k * CARD_PITCH_Y - 1 : gy;
    scr.put(r.x + 2, dy, `${V2.down} ${below} more`, dimSt);
    rows = dy - r.y + 1;
  }
  return { rows: Math.min(rows, r.h), moreBelow: below, firstRow: first, visibleRows: k };
}
