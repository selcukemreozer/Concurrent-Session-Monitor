import stringWidth from "string-width";
import { sanitize } from "../../sanitize.js";
import { cleanTitle, truncateLabel, ELLIPSIS } from "../../label.js";

/**
 * The v2 text boundary (Phase 9, plan 09-02; RESEARCH Pitfall 6).
 *
 * Every dynamic string the v2 shell draws (session names, file paths, prompts,
 * branch names, process names) is untrusted and must be made cell-safe HERE,
 * before it reaches `Screen.put`, always in this order:
 *
 *   1. sanitize   - C0/C1 controls removed (`sanitize()`), or for names the
 *                   NAME-02 `cleanTitle()` mapping (controls -> space, hidden /
 *                   bidi code points dropped);
 *   2. label cap  - names only: the 24-grapheme `truncateLabel()` cap (H4);
 *   3. width      - truncation by terminal CELLS, not graphemes, so a CJK or
 *                   emoji string can never overflow its budget.
 *
 * No new control stripper lives here: the sanitize and label modules are reused.
 * This is the ONLY non-test module that imports `string-width` (the same hoisted
 * copy Ink measures with), so every width in the v2 shell agrees with Ink.
 *
 * Source kept ASCII-only (special code points are written as escapes).
 */

/** Terminal cell width of a string (Ink's own measurer). */
export function cellWidth(s: string): number {
  return stringWidth(s);
}

let segmenter: Intl.Segmenter | null | undefined;

/** Split into grapheme clusters; code-point fallback when Intl.Segmenter is absent. */
export function graphemes(s: string): string[] {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
  }
  if (segmenter === null) return Array.from(s);
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

/** True for C0 (0x00-0x1F), DEL (0x7F) and C1 (0x80-0x9F) code points. */
export function isControlCp(cp: number): boolean {
  return cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f);
}

/** ASCII whitespace runs only (tab, LF, VT, FF, CR, space); NBSP is kept. */
const ASCII_WS = /[\t\n\v\f\r ]+/g;

/**
 * One terminal-safe line: coerce with String(), collapse ASCII whitespace runs
 * to one space, strip C0/C1 controls (sanitize), trim.
 */
export function oneLine(raw: unknown): string {
  return sanitize(String(raw).replace(ASCII_WS, " ")).trim();
}

/**
 * Cut from the END to at most `cells` terminal cells. A cut string ends with
 * the one-cell ellipsis; a grapheme is never split; `cells <= 0` returns "".
 */
export function truncateEnd(s: string, cells: number): string {
  if (cells <= 0) return "";
  if (cellWidth(s) <= cells) return s;
  const budget = cells - 1;
  let out = "";
  let w = 0;
  for (const g of graphemes(s)) {
    const gw = cellWidth(g);
    if (w + gw > budget) break;
    out += g;
    w += gw;
  }
  return out + ELLIPSIS;
}

/**
 * Cut from the START to at most `cells` terminal cells: ellipsis + tail, so a
 * path keeps its file name visible. Same rules as truncateEnd.
 */
export function truncateStart(s: string, cells: number): string {
  if (cells <= 0) return "";
  if (cellWidth(s) <= cells) return s;
  const budget = cells - 1;
  const gs = graphemes(s);
  let out = "";
  let w = 0;
  for (let i = gs.length - 1; i >= 0; i--) {
    const g = gs[i] as string;
    const gw = cellWidth(g);
    if (w + gw > budget) break;
    out = g + out;
    w += gw;
  }
  return ELLIPSIS + out;
}

/** Plain dynamic text: oneLine, then end-truncated to `cells`. */
export function plainText(raw: unknown, cells: number): string {
  return truncateEnd(oneLine(raw), cells);
}

/** A path: oneLine, then start-truncated to `cells` (the file name stays). */
export function pathText(raw: unknown, cells: number): string {
  return truncateStart(oneLine(raw), cells);
}

/**
 * A session name through the NAME-02 pipeline: cleanTitle (controls -> space,
 * hidden/bidi dropped; H5), the 24-grapheme label cap (H4), then width
 * truncation. Returns "" when the cleaned name is empty (caller shows unnamed).
 */
export function nameText(raw: unknown, cells: number): string {
  const clean = cleanTitle(raw);
  if (clean === "") return "";
  return truncateEnd(truncateLabel(clean), cells);
}
