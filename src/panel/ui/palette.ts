/**
 * The v2 color tokens (Phase 9, plan 09-04; D-05, D-06).
 *
 *   - v2 only: the legacy panel keeps its own 1.6.x colors and never reads
 *     this table.
 *   - The panel never paints a global background; `bg` exists only for the
 *     few cells that need an explicit fill (e.g. selected/asking rows).
 *   - Dim text is always an explicit hex (`dim`, `dim2`), never the
 *     terminal's faint attribute (UI-SPEC Typography).
 *   - Magenta (`asking`) is reserved for the asking state only (D-06).
 */
export const PALETTE = {
  bg: "#1b1b19",
  fg: "#d6d3cb",
  hi: "#f5f3ec",
  dim: "#85827a",
  dim2: "#5c5a54",
  edge: "#3a3936",
  idle: "#4a4945",
  logo: "#E8C24A",
  asking: "#E86AD9",
  waiting: "#F2B33D",
  running: "#5FD47A",
  subagent: "#40E0D0",
  red: "#F0545A",
  redBg: "#3a1a1b",
  askBg: "#241822",
  blue: "#6FA8FF",
  live: "#4f9a62",
} as const;

export type AgentState = "asking" | "waiting" | "running" | "subagent";

/** The D-05 color for an agent state. */
export function stateColor(s: AgentState): string {
  return PALETTE[s];
}
