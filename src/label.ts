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
 *     every format / default-ignorable code point (\p{Cf} and
 *     \p{Default_Ignorable_Code_Point}: bidi controls incl. U+061C, zero-width
 *     spaces, U+FEFF, U+00AD, tag characters U+E0000-U+E007F, variation
 *     selectors) is dropped except ZWJ U+200D and the emoji presentation
 *     selectors U+FE0E/U+FE0F - T-07-02; whitespace runs collapse; any grapheme
 *     cluster longer than MAX_CLUSTER_CP code points (piled combining marks)
 *     becomes a space; trim; whole clusters are kept up to MAX_TITLE_CP code
 *     points), THEN cap at NAME_CAP grapheme clusters plus one U+2026
 *     ellipsis. Invisible code points are removed rather than merely left
 *     uncounted, and no cluster can carry more than MAX_CLUSTER_CP code
 *     points, so a 24-grapheme label is bounded in code points too (T-07-06).
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
 * scripts/on-user-prompt.mjs and scripts/on-session-start.mjs carry the
 * writer-side normalizeTitle, which applies the same per-code-point,
 * per-cluster and total caps. Any change here must be made there too.
 *
 * This source is kept ASCII-only (the ellipsis is written as an escape and
 * invisible code points are matched by \p{...} / \u escapes or compared
 * numerically, never written as literal characters).
 */

/** D-09: display cap in grapheme clusters (the ellipsis is extra). */
export const NAME_CAP = 24;

/** U+2026 horizontal ellipsis (>= 0xA0, so sanitize() keeps it). */
export const ELLIPSIS = "\u2026";

/** D-06/D-07: dim hint shown by SessionCard and CompactRow only. */
export const UNNAMED = "(unnamed)";

/**
 * T-07-06: longest grapheme cluster kept, in code points. Covers every RGI
 * emoji ZWJ sequence (the skin-toned kiss is 10); longer clusters are piled
 * combining marks (zalgo) or hidden payloads and become a space.
 */
export const MAX_CLUSTER_CP = 10;

/** T-07-06: total code points kept (whole clusters only); equals the hook writers' MAX_TITLE. */
export const MAX_TITLE_CP = 256;

/** T-07-02 / T-07-06: format and default-ignorable (invisible) code points. */
const HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

/**
 * True for a code point that can reorder or hide text and is dropped: every
 * \p{Cf} / default-ignorable code point except ZWJ (U+200D) and the emoji
 * presentation selectors U+FE0E/U+FE0F, which emoji sequences need.
 */
function isHidden(ch: string, cp: number): boolean {
  return cp !== 0x200d && cp !== 0xfe0e && cp !== 0xfe0f && HIDDEN.test(ch);
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
 * Clean an untrusted title: sanitize() first (D-09 order), drop hidden
 * (format / default-ignorable) code points, collapse whitespace, turn any
 * cluster over MAX_CLUSTER_CP code points into a space, trim, keep whole
 * clusters up to MAX_TITLE_CP code points. A result holding nothing but
 * joiners/selectors is "". Non-string -> "". Idempotent.
 */
export function cleanTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let out = "";
  for (const ch of sanitize(raw)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isHidden(ch, cp)) continue;
    out += ch;
  }
  let kept = "";
  for (const g of graphemes(out.replace(/\s+/g, " "))) {
    kept += Array.from(g).length > MAX_CLUSTER_CP ? " " : g;
  }
  kept = kept.replace(/\s+/g, " ").trim();
  let res = "";
  let n = 0;
  for (const g of graphemes(kept)) {
    const len = Array.from(g).length;
    if (n + len > MAX_TITLE_CP) break;
    res += g;
    n += len;
  }
  res = res.trim();
  return /[^\s\u200d\ufe0e\ufe0f]/u.test(res) ? res : "";
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
