/**
 * The v2 UI state reducer (Phase 9, plan 09-04; D-12, D-13, D-15, D-24).
 *
 *   - This reducer is the single source of truth for focus, the right-column
 *     tab, the FILES pause, the overlay mode and the agent selection. It is
 *     pure: no React, no ink, no timers.
 *   - Selection is tracked by id, never by index, and resolved against the
 *     freshest list at action time; a removed item fails closed to null
 *     (RESEARCH Pitfall 7, T-09-07).
 *   - The `menu` / `confirm` / `confirmKill` / `edit` modes exist now so the
 *     `q` / Esc precedence is testable; Phases 11–12 are what enter them.
 *   - `SELECTION_IDLE_MS` is the UI-SPEC constant (not a knob) used from
 *     Phase 10 to drop an idle selection.
 */
export type Pane = "agents" | "right" | "ports";
export type RightTab = "phases" | "sessions";
export type Mode = "normal" | "menu" | "confirm" | "confirmKill" | "edit";

export interface UiState {
  focus: Pane;
  rightTab: RightTab;
  filesPaused: boolean;
  mode: Mode;
  selectedAgentId: string | null;
}

export type Action =
  | { t: "focusNext" }
  | { t: "focusPrev" }
  | { t: "focusAgents" }
  | { t: "clearSelection" }
  | { t: "select"; id: string }
  | { t: "closeOverlay" }
  | { t: "toggleRight" }
  | { t: "toggleFiles" }
  | { t: "quit" }
  | { t: "noop"; binding: string };

export const initialUi: UiState = {
  focus: "agents",
  rightTab: "phases",
  filesPaused: false,
  mode: "normal",
  selectedAgentId: null,
};

/** Tab order. FILES is never focusable (D-13, D-14). */
export const FOCUS_ORDER: readonly Pane[] = ["agents", "right", "ports"];

/** UI-SPEC: an agent selection idle this long is cleared (from Phase 10). */
export const SELECTION_IDLE_MS = 15000;

function step(focus: Pane, delta: 1 | -1): Pane {
  const n = FOCUS_ORDER.length;
  const i = FOCUS_ORDER.indexOf(focus);
  return FOCUS_ORDER[(((i + delta) % n) + n) % n]!;
}

export function uiReducer(s: UiState, a: Action): UiState {
  switch (a.t) {
    case "focusNext":
      return { ...s, focus: step(s.focus, 1), mode: "normal" };
    case "focusPrev":
      return { ...s, focus: step(s.focus, -1), mode: "normal" };
    case "focusAgents":
      return { ...s, focus: "agents" };
    case "clearSelection":
      return { ...s, selectedAgentId: null };
    case "select":
      return { ...s, selectedAgentId: a.id };
    case "closeOverlay":
      return { ...s, mode: "normal" };
    case "toggleRight":
      if (s.mode !== "normal") return s;
      return { ...s, rightTab: s.rightTab === "phases" ? "sessions" : "phases" };
    case "toggleFiles":
      return { ...s, filesPaused: !s.filesPaused };
    case "quit":
    case "noop":
      return s;
  }
}

/**
 * The selected item looked up by id in the freshest list, or null when
 * nothing is selected or the item is gone (fails closed).
 */
export function resolveSelected<T extends { id: string }>(
  ui: UiState,
  items: readonly T[],
): T | null {
  if (ui.selectedAgentId === null) return null;
  return items.find((x) => x.id === ui.selectedAgentId) ?? null;
}
