import type { Screen, Style } from "../screen.js";
import { cellWidth, graphemes, nameText, oneLine, plainText, truncateEnd } from "../text.js";
import { PALETTE, stateColor, type AgentState } from "../palette.js";
import { V2 } from "../glyphs.js";
import type { DetailModel, Rect } from "../models.js";

/**
 * The selection detail strip (Phase 10 plan 10-11; UI-SPEC § Selection detail
 * strip, LAYOUT-07).
 *
 *   - 09 D-12: while a card is selected, a 4-row strip sits between the grid
 *     and the FILES title (the shell adds 1 spacer row after it):
 *       row 0  `▐name▌` pill (fg bg-color on the state color, bold; the caps
 *              in the state color), 1 cell, the STATE label (state color
 *              bold), ` · uptime · model` (dim), then a `─` rule (edge) to the
 *              rect's right edge;
 *       row 1  at x2, segments joined by 4 cells: `» intent` (≤ 32 cells;
 *              `» —` in dim2 when unset), `⎇ branch` (≤ 20 cells), the owned
 *              ports `:3000 bun` (port hi bold, proc dim; joined by `, `;
 *              overflow ` +N`; the segment is omitted without ports);
 *       rows 2-3  x2 `›` dim, x4 the full last prompt (fg) word-wrapped to
 *              w - 5 cells over at most 2 lines, the last one ending with `…`
 *              on overflow; unused lines stay blank so the height never
 *              jitters. Under pressure (h 3) the prompt gets 1 line (UI-SPEC
 *              shrink step 4); below that the rows that fit are drawn from
 *              the top.
 *   - 10 D-06 / D-17: an idle strip opens the strip too; its pill is on the
 *     idle color with hi text and its label reads `IDLE` in dim.
 *   - 10 D-11: there is no up-front `unreachable` marker; go-to reasons
 *     appear only on Enter, in the footer flash.
 *
 * T-10-28: the name goes through nameText, every other field through
 * plainText / oneLine, before it reaches the escape-dropping Screen. Every
 * write is clipped to the rect. Pure: no Ink, no I/O.
 */

/** The strip's fixed height (the shell's spacer row is extra). */
export const DETAIL_ROWS = 4;

/** U+2014, shown for an unset intent, model or prompt. */
const DASH = "—";
/** ` U+00B7 `, the meta separator. */
const SEP = ` ${V2.sep} `;
/** The gap between the row-1 segments, in cells. */
const GAP = 4;
const INTENT_W = 32;
const BRANCH_W = 20;
const PROC_W = 16;
const META_W = 24;

const LABEL: Record<AgentState | "idle", string> = {
  asking: "ASKING",
  waiting: "WAITING",
  running: "RUNNING",
  subagent: "SUBAGENT",
  idle: "IDLE",
};

/** A non-negative integer from an untrusted rect value. */
function int(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

/** The first `cells` cells of `s`, whole graphemes only, no ellipsis. */
function clip(s: string, cells: number): string {
  if (cells <= 0) return "";
  if (cellWidth(s) <= cells) return s;
  let out = "";
  let w = 0;
  for (const g of graphemes(s)) {
    const gw = cellWidth(g);
    if (w + gw > cells) break;
    out += g;
    w += gw;
  }
  return out;
}

/**
 * Greedy word wrap of a one-line string to `width` cells over at most `max`
 * lines; a word longer than the line is hard-broken. On overflow the last
 * line is the rest of the text end-truncated, so it ends with `…`.
 */
export function wrapPrompt(s: string, width: number, max: number): string[] {
  if (max <= 0 || width <= 0) return [];
  const lines: string[] = [];
  let cur = "";
  /** Close the current line; true once more than `max` lines exist (stop). */
  const push = (): boolean => {
    lines.push(cur);
    cur = "";
    return lines.length > max;
  };
  outer: for (const word of s.split(" ")) {
    if (word === "") continue;
    const ww = cellWidth(word);
    if (cur !== "" && cellWidth(cur) + 1 + ww <= width) {
      cur += ` ${word}`;
      continue;
    }
    if (cur !== "" && push()) break;
    if (ww <= width) {
      cur = word;
      continue;
    }
    // hard-break a word longer than the line
    let w = 0;
    for (const g of graphemes(word)) {
      const gw = cellWidth(g);
      if (w > 0 && w + gw > width) {
        if (push()) break outer;
        w = 0;
      }
      cur += g;
      w += gw;
    }
  }
  if (cur !== "" && lines.length <= max) lines.push(cur);
  if (lines.length <= max) return lines;
  // greedy wrap: the rest never fits one line, so truncateEnd always adds the ellipsis
  const head = lines.slice(0, max - 1);
  return [...head, truncateEnd(lines.slice(max - 1).join(" "), width)];
}

export function drawDetail(scr: Screen, r: Rect, d: DetailModel): number {
  const h = Math.min(int(r.h), DETAIL_ROWS);
  const w = int(r.w);
  if (h === 0 || w === 0) return h;
  const x0 = Number.isFinite(r.x) ? Math.trunc(r.x) : 0;
  const y0 = Number.isFinite(r.y) ? Math.trunc(r.y) : 0;
  const right = x0 + w;
  /** Write `text` at (x, y), clipped to the rect's right edge; returns the next x. */
  const put = (x: number, y: number, text: string, st: Style): number => {
    if (text === "") return x;
    const t = clip(text, right - x);
    if (t !== "") scr.put(x, y, t, st);
    return x + cellWidth(text);
  };

  // row 0: the pill, the STATE label, the meta and the rule
  const idle = d.state === "idle";
  const tone = idle ? PALETTE.idle : stateColor(d.state as AgentState);
  const name = nameText(d.name, Math.max(1, w - 2)) || plainText(d.id, Math.max(1, w - 2)) || DASH;
  let x = put(x0, y0, V2.capL, { fg: tone });
  x = put(x, y0, name, { fg: idle ? PALETTE.hi : PALETTE.bg, bg: tone, bold: true });
  x = put(x, y0, V2.capR, { fg: tone });
  x = put(x + 1, y0, LABEL[d.state] ?? LABEL.idle, idle ? { fg: PALETTE.dim } : { fg: tone, bold: true });
  const up = plainText(d.uptime, META_W) || DASH;
  const model = (d.model === null ? "" : plainText(d.model, META_W)) || DASH;
  x = put(x, y0, `${SEP}${up}${SEP}${model}`, { fg: PALETTE.dim });
  if (right - x - 1 > 0) put(x + 1, y0, V2.hline.repeat(right - x - 1), { fg: PALETTE.edge });

  // row 1: intent, branch, owned ports
  if (h >= 2) {
    const y = y0 + 1;
    let cx = x0 + 2;
    const intent = d.intent === null ? "" : plainText(d.intent, INTENT_W);
    if (intent === "") {
      cx = put(cx, y, `${V2.intent} ${DASH}`, { fg: PALETTE.dim2 });
    } else {
      cx = put(cx, y, `${V2.intent} `, { fg: PALETTE.dim });
      cx = put(cx, y, intent, { fg: PALETTE.fg });
    }
    cx = put(cx + GAP, y, `${V2.branch} `, { fg: PALETTE.dim });
    cx = put(cx, y, plainText(d.branch, BRANCH_W) || DASH, { fg: PALETTE.fg });
    const ports = Array.isArray(d.ports) ? d.ports : [];
    if (ports.length > 0) {
      cx += GAP;
      const n = ports.length;
      for (let k = 0; k < n; k++) {
        const p = ports[k]!;
        const num = `:${int(p.port)}`;
        const proc = plainText(p.proc, PROC_W);
        const sep = k > 0 ? ", " : "";
        const piece = cellWidth(sep) + cellWidth(num) + (proc === "" ? 0 : 1 + cellWidth(proc));
        const rest = n - k - 1;
        const reserve = rest > 0 ? cellWidth(` +${rest}`) : 0;
        if (cx + piece + reserve > right) {
          put(cx, y, k > 0 ? ` +${n - k}` : `+${n}`, { fg: PALETTE.dim });
          break;
        }
        cx = put(cx, y, sep, { fg: PALETTE.dim });
        cx = put(cx, y, num, { fg: PALETTE.hi, bold: true });
        if (proc !== "") cx = put(cx, y, ` ${proc}`, { fg: PALETTE.dim });
      }
    }
  }

  // rows 2-3: the last prompt, word-wrapped (shrinks 2 -> 1 line under pressure)
  const promptLines = Math.max(0, Math.min(2, h - 2));
  if (promptLines > 0) {
    const y = y0 + 2;
    put(x0 + 2, y, V2.prompt, { fg: PALETTE.dim });
    const text = d.prompt === null ? "" : oneLine(d.prompt);
    const lines = text === "" ? [DASH] : wrapPrompt(text, Math.max(1, w - 5), promptLines);
    lines.forEach((l, i) => put(x0 + 4, y + i, l, { fg: PALETTE.fg }));
  }
  return h;
}
