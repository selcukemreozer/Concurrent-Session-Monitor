import { sanitize } from "./sanitize.js";

/**
 * Shared session-label helpers (Phase 7: D-06..D-09, NAME-02).
 *
 * A session name is user-chosen text read from disk (title.json or the
 * transcript `custom-title` line) and printed to the terminal, so it is
 * untrusted. Every label surface renders it through this one module so all
 * surfaces show an identical name:
 *
 *   - D-09 order: clean FIRST (sanitize() drops C0/C1 controls - T-07-01;
 *     the bidi/format code points U+200E, U+200F, U+202A-U+202E and
 *     U+2066-U+2069 are dropped - T-07-02; whitespace runs collapse; trim),
 *     THEN cap at NAME_CAP grapheme clusters plus one U+2026 ellipsis. Hidden
 *     bytes therefore never count toward the cap (T-07-06).
 *   - NAME-02 / D-01: labelLead() never returns blank - an empty,
 *     whitespace-only, non-string or control-only title counts as unnamed and
 *     falls back to the sanitized folder.
 *   - D-06 / D-07: UNNAMED is exported for the two roster surfaces
 *     (SessionCard, CompactRow) only; labelLead() never appends it (D-08: the
 *     compact surfaces use the lead as-is).
 *
 * LOCKSTEP: scripts/csm-status.mjs and scripts/on-pre-tool.mjs are
 * self-contained stdlib-only scripts that cannot import src/; they carry
 * mirrors of NAME_CAP, ELLIPSIS, cleanTitle, truncateLabel and displayName.
 * Any change here must be made there too.
 *
 * This source is kept ASCII-only (the ellipsis is written as an escape and
 * invisible code points are compared numerically, never as regex literals).
 */

/** D-09: display cap in grapheme clusters (the ellipsis is extra). */
export const NAME_CAP = 24;

/** U+2026 horizontal ellipsis (>= 0xA0, so sanitize() keeps it). */
export const ELLIPSIS = "\u2026";

/** D-06/D-07: dim hint shown by SessionCard and CompactRow only. */
export const UNNAMED = "(unnamed)";

/** T-07-02: bidi/format code points that can visually reorder or hide text. */
function isBidiFormat(cp: number): boolean {
  return (
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

let segmenter: Intl.Segmenter | null | undefined;

/** Split into grapheme clusters; code-point fallback when Intl.Segmenter is absent. */
function graphemes(s: string): string[] {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
  }
  if (segmenter === null) return Array.from(s);
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

/**
 * Clean an untrusted title: sanitize() first (D-09 order), drop bidi/format
 * code points, collapse whitespace runs to one space, trim. Non-string -> "".
 */
export function cleanTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let out = "";
  for (const ch of sanitize(raw)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isBidiFormat(cp)) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Cap to `max` grapheme clusters plus ELLIPSIS; a string within the cap is
 * returned unchanged. The caller passes an ALREADY-cleaned string (D-09).
 * ZWJ emoji and combining sequences are never split.
 */
export function truncateLabel(s: string, max: number = NAME_CAP): string {
  const g = graphemes(s);
  return g.length > max ? g.slice(0, max).join("") + ELLIPSIS : s;
}

/** Display name, or undefined when the cleaned title is empty (NAME-02 unnamed). */
export function displayName(raw: unknown): string | undefined {
  const clean = cleanTitle(raw);
  return clean.length > 0 ? truncateLabel(clean, NAME_CAP) : undefined;
}

/**
 * Never-blank lead segment (NAME-02): the display name when the session is
 * named, else the sanitized folder. Never appends UNNAMED (D-07).
 */
export function labelLead(s: { title?: string; folder: string }): string {
  return displayName(s.title) ?? sanitize(s.folder);
}
