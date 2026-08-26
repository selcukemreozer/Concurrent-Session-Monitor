/**
 * Render-boundary control-character strip (T-1-02, Pitfall 6, ASVS V5).
 *
 * Untrusted strings read from the store — file paths and git branch names —
 * are printed to the terminal by Ink. A value containing raw escape sequences
 * could corrupt the panel layout or spoof its UI (an ESC "[2J" clears the
 * screen; an OSC could retitle the window). `sanitize()` removes the C0
 * (0x00-0x1F) and C1 (0x80-0x9F) control ranges before render, leaving every
 * normal printable character intact — including non-ASCII printable code
 * points at/above 0xA0 (accented latin, greek, symbols) and astral emoji.
 *
 * The deliberate `osc8()` hyperlink wrapper in Card.tsx is the ONLY exemption
 * (it must emit raw control bytes to be clickable); its url/label inputs are
 * themselves passed through this function first.
 *
 * Implemented by code-point iteration (not a control-char regex literal) so the
 * source stays plain ASCII and unambiguous; `for..of` walks full code points,
 * so surrogate-pair characters (all >= 0xA0) are preserved intact.
 */
export function sanitize(s: string): string {
  let out = "";
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    // Drop C0 controls (0x00-0x1F) and C1 controls (0x80-0x9F).
    if (cp <= 0x1f || (cp >= 0x80 && cp <= 0x9f)) continue;
    out += ch;
  }
  return out;
}
