/**
 * The glyph set (Phase 9, plan 09-04; D-04, D-06, D-07).
 *
 *   - Every V2 glyph and spinner frame was measured at exactly 1 cell with
 *     `string-width`, and none carries U+FE0F (glyphs.test.ts pins both).
 *   - The live Warp check in plan 09-15 may swap a glyph using the UI-SPEC
 *     substitution table (`▶`→`▸`, `⏎`→`enter`, `✎`→`+`, `◦`→`·`, `⇡`→`^`,
 *     braille spinner→`◐◓◑◒`). This object is the ONLY place to make that
 *     swap.
 *   - The legacy constants join this file in plan 09-11, with their 1.6.x
 *     values unchanged. They must never be merged with the V2 values.
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
