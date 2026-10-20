/**
 * The glyph set (Phase 9, plan 09-04; D-04, D-06, D-07).
 *
 *   - Every V2 glyph and spinner frame was measured at exactly 1 cell with
 *     `string-width`, and none carries U+FE0F (glyphs.test.ts pins both).
 *   - The live Warp check in plan 09-15 may swap a glyph using the UI-SPEC
 *     substitution table (`▶`→`▸`, `⏎`→`enter`, `✎`→`+`, `◦`→`·`, `⇡`→`^`,
 *     braille spinner→`◐◓◑◒`). This object is the ONLY place to make that
 *     swap.
 *   - The legacy constants (below the V2 object) joined this file in plan
 *     09-11, with their 1.6.x values unchanged. They must never be merged
 *     with the V2 values.
 */
export const V2 = {
  brand: "◆",
  // agent states
  asking: "?",
  waiting: "◉",
  running: "▶",
  subagent: "↻",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  // file activity
  conflict: "!",
  write: "✎",
  read: "◦",
  join: "✕",
  // edges and caps
  edgeTop: "▄",
  edgeBottom: "▀",
  rowMark: "▌",
  capL: "▐",
  capR: "▌",
  // light box
  vline: "│",
  hline: "─",
  cornerBL: "└",
  cornerBR: "┘",
  // heavy box
  heavyV: "┃",
  heavyH: "━",
  heavyTL: "┏",
  heavyTR: "┓",
  heavyBL: "┗",
  heavyBR: "┛",
  dashed: "┄",
  group: "■",
  // phases
  phaseDone: "●",
  phaseCurrent: "◉",
  phasePending: "○",
  more: "⋮",
  idleDot: "●",
  // cursors
  cursor: "❯",
  sessionCursor: "▸",
  // ports
  owner: "↳",
  exposed: "⇡",
  // card text
  intent: "»",
  prompt: "›",
  branch: "⎇",
  // arrows
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  enter: "⏎",
  // notices
  keysOff: "⌨",
  update: "⬆",
  // misc
  ok: "✓",
  ellipsis: "…",
  sep: "·",
  times: "×",
  guess: "~",
} as const;

// ---------------------------------------------------------------------------
// Legacy 1.6.x glyphs and colors — values frozen (D-23). Never merge with V2.
// Moved verbatim from Card.tsx (plan 09-11, strangler S2); the legacy panel
// imports them from here.
// ---------------------------------------------------------------------------

// Steady filled-circle liveness glyph (D-11): a plain colored character, NEVER
// a spinner/blink — the accessibility stance is a calm, non-animated cue.
export const DOT = "●";

/**
 * Read-line leading glyph (PANEL-06 D-08): a hollow diamond `◇` (U+25C7). It is
 * >= 0x00A0 so `sanitize()` preserves it, and it is visually distinct from the
 * liveness `●`, the conflict `⚠`, the swap `↔`, the filled `◆`, and the link
 * `↪` — a read must be unmistakable from a write at a glance.
 */
export const READ_GLYPH = "◇";

/**
 * Ink color name for read lines (PANEL-06 D-09): `blue` — deliberately NOT red
 * (conflicts), NOT green/yellow/grey (liveness dots), NOT cyan (osc8 links +
 * header border), and NOT turquoise #40E0D0 (subagent state, 260927-73b). This
 * keeps reads non-colliding with every existing colored cue.
 */
export const READ_COLOR = "blue";

/**
 * Leading marker for the card's intent line (PANEL-02 D-10): `»` (U+00BB). It is
 * >= 0x00A0 so `sanitize()` preserves it, and it deliberately avoids every
 * reserved cue — NOT red (conflicts), NOT green/yellow/grey (liveness dots), NOT
 * cyan (osc8 links/header), and NOT the blue read diamond `◇`. Intent is a
 * card-only surface (D-12): this glyph never appears in `CompactRow`.
 */
export const INTENT_GLYPH = "»";

/**
 * Leading marker for the card-only skill line (SKILL-04 D-04): `⚙` (U+2699). It
 * is >= 0x00A0 so `sanitize()` preserves it, and — like `INTENT_GLYPH`/`READ_GLYPH`
 * — it collides with NO reserved cue: NOT the liveness `●`, the read `◇`, the
 * filled `◆`, the conflict `⚠`, the swap `↔`, the link `↪`, the intent `»`, or
 * the exposed-port `⇅`. It renders `dimColor` (neutral) and carries NO reserved
 * color (not red=conflict, green/yellow/grey=liveness, cyan=header/links,
 * blue=reads, magenta/bold=exposed) so a skill line can never masquerade as a
 * conflict/read/port/link (T-04.3-06). Skill is a card-only surface (D-04/D-12):
 * this glyph never appears in `CompactRow`.
 */
export const SKILL_GLYPH = "⚙";

/**
 * The right-angle separator joining a subagent label to its skill (SKILL-02
 * D-03): `›` (U+203A). It is >= 0x00A0 so `sanitize()` preserves it; it is only
 * rendered when a subagent sourced the skill.
 */
export const SKILL_SEP = " › ";

/**
 * Leading marker for the declared TARGET branch segment (TB-03 D-BR-05): `⎇`
 * (U+2387, the git-branch symbol). It is >= 0x00A0 so `sanitize()` preserves it,
 * and it collides with NO reserved cue — NOT the liveness `●`, read `◇`, filled
 * `◆`, conflict `⚠`, swap `↔`, link `↪`, intent `»`, exposed `⇅`, skill `⚙`, or
 * current-phase `▸`. It leads the target segment on the card header only (D-BR-03:
 * never in CompactRow).
 */
export const BRANCH_GLYPH = "⎇";

/**
 * The mismatch flag between the declared target and the current checkout (TB-03
 * D-BR-05): `≠` (U+2260). It is >= 0x00A0 so `sanitize()` preserves it and, like
 * BRANCH_GLYPH, collides with no reserved cue. The mismatch is a pure render-time
 * comparison `sanitize(target_branch) !== sanitize(branch)` — no boolean is
 * persisted anywhere (D-BR-05). The glyph carries the signal so the segment needs
 * no reserved color; a mismatch is emphasized with `bold` only.
 */
export const NEQ_GLYPH = "≠";

/**
 * The needs-you indicator glyph (ATTN-03 D-03; 260926-vfm): the fisheye `◉`
 * (U+25C9). It is >= 0x00A0 so `sanitize()` preserves it, and it collides with NO
 * reserved cue — NOT the liveness `●`, read `◇`, filled `◆`, conflict `⚠`, swap
 * `↔`, link `↪`, intent `»`, exposed `⇅`, skill `⚙`, current-phase `▸`, branch
 * `⎇`, running `▶`, or subagent `↻`. It leads TWO detail-free states, and asking takes precedence:
 *  - `s.asking` (Claude asked a question via AskUserQuestion; 260926-vfm) renders
 *    `magenta` + `bold` with the literal "asking". The magenta shares its hue with
 *    the PORTS-pane exposed badge but is disambiguated by the ◉ glyph + the
 *    "asking" literal, and it lives only on roster rows.
 *  - otherwise `s.attention` (permission prompt / idle) renders `yellowBright` +
 *    `bold` with the literal "waiting", unchanged.
 * Unlike the card-only reads/skill/intent markers, this indicator appears on BOTH
 * SessionCard AND CompactRow (D-01). The waiting visual never splits on the
 * Notification type (permission_prompt vs idle_prompt), per D-02; the row
 * consumes the pre-gated `s.asking` / `s.attention` booleans with no re-check here.
 */
export const ATTENTION_GLYPH = "◉";

/**
 * The running indicator glyph (260927-46l D-05): the bare `▶` (U+25B6, no
 * variation selector, so it stays text-presentation and one cell wide). It
 * leads the SessionCard "running" status line and the CompactRow token. It is
 * >= 0x00A0 so `sanitize()` keeps it, and it is distinct from `●` `◇` `◆` `⚠`
 * `↔` `↪` `»` `⇅` `⚙` `▸` `⎇` `≠` `◉` `↻`. Rendered green (a deliberate reuse of the
 * liveness green, since running IS the live/active state) and never bold (it is
 * not a needs-you state). Precedence: asking, then waiting, then running, then
 * subagent. The row consumes the pre-gated `s.running` boolean with no re-check
 * here.
 */
export const RUN_GLYPH = "▶";

/**
 * The subagent indicator glyph (260927-73b D-05): `↻` (U+21BB). It leads the
 * SessionCard "subagent" status line and the CompactRow token, shown while the
 * main turn has ended but background subagents/workflows it launched are still
 * running. It is >= 0x00A0 so `sanitize()` keeps it, and it is distinct from
 * `●` `◇` `◆` `⚠` `↔` `↪` `»` `⇅` `⚙` `▸` `⎇` `≠` `◉` `▶`. Bold, because it
 * replaces a needs-you marker. Lowest precedence: asking > waiting > running >
 * subagent. The row consumes the pre-gated `s.subagent` / `s.subagent_count`
 * with no re-check here.
 */
export const SUBAGENT_GLYPH = "↻";

/**
 * The subagent state colour (260927-73b D-05): turquoise "#40E0D0", a distinct
 * reserved hue owned by the subagent state — NOT the plain `cyan` used for the
 * osc8 links and the header border. On 16-colour terminals chalk downsamples it
 * to cyan, the only overlap.
 */
export const SUBAGENT_COLOR = "#40E0D0";

/** Warning glyph leading each band line and the `↔` that joins the labels — both
 * printable code points >= 0x00A0, so `sanitize()` preserves them (ASVS V5). */
export const WARN = "⚠";
export const JOIN = " ↔ ";

/**
 * The exposed-port security badge glyph (PORT-05 D-03): `⇅` (U+21C5). It is
 * >= 0x00A0 so `sanitize()` preserves it, and it is visually distinct from every
 * reserved cue — the liveness `●`, the read `◇`, the filled `◆`, the conflict
 * `⚠`, the swap `↔`, the link `↪`, and the intent `»`. Paired with `magenta`
 * `bold` (a color owned by NO other cue: red=conflict, green/yellow/grey=liveness,
 * cyan=header/links, blue=reads) so an off-host bind stands out as a warning
 * WITHOUT colliding with the conflict-red alarm.
 */
export const EXPOSED_GLYPH = "⇅";

/**
 * The PORTLAR row-cursor glyph (260927-8ge D-04): `❯` (U+276F). It replaces the
 * two leading spaces of the selected port row (so columns stay aligned) and is
 * rendered bold. It is >= 0x00A0 so `sanitize()` keeps it, single cell wide, and
 * distinct from `●` `◇` `◆` `»` `⚙` `›` `⎇` `≠` `◉` `▶` `↻` `⚠` `↔` `↪` `⇅` `▸`
 * `⌨`. It only appears once the user presses j/k on a real TTY.
 */
export const PORT_CURSOR_GLYPH = "❯";

/**
 * Leading marker for the in-progress phase row in the FAZLAR pane (PANEL-07
 * D-05): `▸` (U+25B8). It is >= 0x00A0 so `sanitize()` preserves it, and it
 * collides with NO reserved cue — NOT the liveness `●`, read `◇`, filled `◆`,
 * conflict `⚠`, swap `↔`, link `↪`, intent `»`, exposed `⇅`, or skill `⚙`. The
 * current row is emphasized with this marker + `bold`; completed rows render
 * green (`color="green"`); all other rows render neutral. Completed phases are
 * INTENTIONALLY colored green — a user-directed relaxation of T-04.2-05b. Green
 * is otherwise the liveness-dot color, but FAZLAR rows live in a distinct
 * pane/region, so the collision is acceptable and deliberate. No OTHER reserved
 * color is applied (not red=conflict, yellow/grey=liveness, cyan=header/links,
 * blue=reads, magenta/bold=exposed). The `▸` marker, the scroll arrows `▲`/`▼`
 * (U+25B2/U+25BC), the en-dash `–` (U+2013), and the truncation `…` (U+2026) are
 * all >= 0x00A0 and survive `sanitize()`.
 */
export const CURRENT_GLYPH = "▸";
