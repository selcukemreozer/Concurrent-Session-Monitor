/**
 * Card model labels (Phase 10, plan 10-06; D-07, RESEARCH Q3). Pure, no IO.
 *
 *   - shortModelName turns a raw model id into the short card label
 *     (`claude-opus-4-7` -> `opus 4.7`, `claude-3-5-sonnet-20241022` ->
 *     `sonnet 3.5`). The family is a generic `[a-z]+`, so a future family
 *     needs no code change. Unrecognised ids fall back to the id with one
 *     leading `claude-` removed.
 *   - cardModel applies the D-07 fallback order: the transcript's last real
 *     assistant model, then the session.json model when it is not the
 *     `unknown` sentinel (schema.ts), then null (the card draws a dash).
 *
 * The result is NOT sanitized here: model ids are untrusted text and the card
 * draws them through plainText (text.ts).
 */

/** New form: claude-<family>-<major>[-<minor>][-<yyyymmdd>]. */
const NEW_FORM = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
/** Legacy form: claude-<major>[-<minor>]-<family>[-<yyyymmdd>]. */
const LEGACY_FORM = /^claude-(\d+)(?:-(\d+))?-([a-z]+)(?:-\d{8})?$/;
/** One trailing bracketed suffix, e.g. the `[1m]` context-window tag. */
const BRACKET_SUFFIX = /\[[^\]]*\]$/;

function label(family: string, major: string, minor: string | undefined): string {
  return `${family} ${major}${minor ? "." + minor : ""}`;
}

/** Short card label for a raw model id, or null when there is nothing to show. */
export function shortModelName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw === "" || raw === "<synthetic>" || raw === "unknown") return null;
  const id = raw.replace(BRACKET_SUFFIX, "");
  if (id === "") return null;
  const n = NEW_FORM.exec(id);
  if (n) return label(n[1]!, n[2]!, n[3]);
  const l = LEGACY_FORM.exec(id);
  if (l) return label(l[3]!, l[1]!, l[2]);
  const rest = id.startsWith("claude-") ? id.slice("claude-".length) : id;
  return rest === "" ? null : rest;
}

/** The card's model label with the D-07 fallback chain. */
export function cardModel(row: { transcript_model?: string; model?: string }): string | null {
  return shortModelName(row.transcript_model) ?? shortModelName(row.model);
}
