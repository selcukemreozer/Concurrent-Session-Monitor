import type { Screen } from "../screen.js";
import { cellWidth, plainText } from "../text.js";
import { PALETTE } from "../palette.js";
import { V2 } from "../glyphs.js";
import type { HeaderModel } from "../models.js";

/**
 * The v2 live header, row 0 (Phase 9, plan 09-05; UI-SPEC § Header).
 *
 *   - x1 `◆` (logo), x3 `CSM` (hi bold), 3 cells, `N agent(s)` (dim).
 *   - Chips ` N asking ` / ` N waiting ` / ` N conflict(s) `, each preceded by
 *     1 cell, bg-on-color bold, only when N > 0, in that order.
 *   - Right-aligned, ending at cols-2: an optional update notice (dim bold)
 *     + ` · ` (dim), then the clock (dim).
 *   - Overflow drop order, decided with `cellWidth` before drawing: update
 *     notice -> clock -> agent count. The brand and chips never drop; past
 *     the screen edge they are clipped by `Screen.put`.
 *   - The header is live: it never carries the ` sample ` chip (D-20).
 *   - The update notice and clock go through `plainText` (T-09-01b).
 */

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `HH:MM:SS`, 24 h, local time. */
export function fmtClock24(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** x just after ` ◆ CSM`. */
const BRAND_END = 6;
const SEP = " · ";

export function drawHeader(scr: Screen, cols: number, h: HeaderModel): void {
  const y = 0;
  const agentsText = plural(h.agents, "agent", "agents");
  const chips = [
    { n: h.asking, text: ` ${h.asking} asking `, bg: PALETTE.asking },
    { n: h.waiting, text: ` ${h.waiting} waiting `, bg: PALETTE.waiting },
    { n: h.conflicts, text: ` ${plural(h.conflicts, "conflict", "conflicts")} `, bg: PALETTE.red },
  ].filter((c) => c.n > 0);
  const chipsW = chips.reduce((s, c) => s + 1 + cellWidth(c.text), 0);

  const clock = plainText(h.clock, cols);
  const update = h.update ? plainText(h.update, cols) : "";

  let showAgents = true;
  let showClock = clock !== "";
  let showUpdate = update !== "";

  const leftEnd = (): number =>
    showAgents ? BRAND_END + 3 + cellWidth(agentsText) + 1 + chipsW : BRAND_END + 1 + chipsW;
  const rightW = (): number => {
    let w = showClock ? cellWidth(clock) : 0;
    if (showUpdate) w += cellWidth(update) + (showClock ? SEP.length : 0);
    return w;
  };
  // The right block ends at cols-2 and keeps 1 blank cell after the left block;
  // with nothing on the right the left block must end by cols-2.
  const fits = (): boolean => {
    const rw = rightW();
    return rw === 0 ? leftEnd() <= cols - 1 : cols - 1 - rw >= leftEnd() + 1;
  };

  if (showUpdate && !fits()) showUpdate = false;
  if (showClock && !fits()) showClock = false;
  if (showAgents && !fits()) showAgents = false;

  scr.put(1, y, V2.brand, { fg: PALETTE.logo });
  let x = scr.put(3, y, "CSM", { fg: PALETTE.hi, bold: true });
  x = showAgents ? scr.put(x + 3, y, agentsText, { fg: PALETTE.dim }) + 1 : x + 1;
  for (const c of chips) x = scr.put(x + 1, y, c.text, { fg: PALETTE.bg, bg: c.bg, bold: true });

  const rw = rightW();
  if (rw === 0) return;
  let rx = cols - 1 - rw;
  if (showUpdate) {
    rx = scr.put(rx, y, update, { fg: PALETTE.dim, bold: true });
    if (showClock) rx = scr.put(rx, y, SEP, { fg: PALETTE.dim });
  }
  if (showClock) scr.put(rx, y, clock, { fg: PALETTE.dim });
}
