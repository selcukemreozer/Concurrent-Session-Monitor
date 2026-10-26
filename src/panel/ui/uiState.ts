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
 *
 * Phase 10 (plan 10-07; D-09, D-12, D-23, KEYS-02, KEYS-03):
 *   - Every cursor is an IDENTITY, never a list index: `selectedAgentId`
 *     (cards and idle strips), `phaseCursor` (a phase number), `projectRoot`
 *     (the PHASES project) and `portCursor` (a portKey). A re-sort therefore
 *     cannot move a cursor onto a different item (T-10-16).
 *   - The footer flash slot and the 15 s idle drop are pure functions of the
 *     state and an injected `now` (`flashVisible`, `selectionExpired`); the
 *     reducer itself never reads a clock — `flash` / `keyAt` carry the time.
 *   - `effectiveUi` drops a selection that no longer resolves, so the footer
 *     context and key routing never act on a vanished card (Pitfall 4,
 *     T-10-17).
 *   - Every action returns the SAME object when nothing changes, so PanelApp
 *     can skip a re-render on identity.
 */
import type { Flash } from "./models.js";

export type Pane = "agents" | "right" | "ports";
export type RightTab = "phases" | "sessions";
export type Mode = "normal" | "menu" | "confirm" | "confirmKill" | "edit";

export interface UiState {
  focus: Pane;
  rightTab: RightTab;
  filesPaused: boolean;
  mode: Mode;
  selectedAgentId: string | null;
  /** The PHASES cursor: a phase number (e.g. "04.2"), never an index. */
  phaseCursor: string | null;
  /** The PHASES project identity (its root path, KEYS-05). */
  projectRoot: string | null;
  /** The PORTS cursor: a portKey. */
  portCursor: string | null;
  /** The footer flash slot; `at` is the injected time it was raised. */
  flash: { text: string; ok: boolean; at: number } | null;
  /** The injected time of the last key press (drives the idle drop). */
  lastKeyAt: number;
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
  | { t: "noop"; binding: string }
  | { t: "setPhaseCursor"; n: string | null }
  | { t: "setProject"; root: string }
  | { t: "setPortCursor"; key: string | null }
  | { t: "flash"; text: string; ok: boolean; at: number }
  | { t: "keyAt"; at: number };

export const initialUi: UiState = {
  focus: "agents",
  rightTab: "phases",
  filesPaused: false,
  mode: "normal",
  selectedAgentId: null,
  phaseCursor: null,
  projectRoot: null,
  portCursor: null,
  flash: null,
  lastKeyAt: 0,
};

/** Tab order. FILES is never focusable (D-13, D-14). */
export const FOCUS_ORDER: readonly Pane[] = ["agents", "right", "ports"];

/** UI-SPEC: an agent selection idle this long is cleared (from Phase 10). */
export const SELECTION_IDLE_MS = 15000;

/** UI-SPEC footer flash slot: a flash shows for this long (D-12). */
export const FLASH_MS = 2500;

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
      if (s.focus === "agents") return s;
      return { ...s, focus: "agents" };
    case "clearSelection":
      if (s.selectedAgentId === null) return s;
      return { ...s, selectedAgentId: null };
    case "select":
      if (s.selectedAgentId === a.id) return s;
      return { ...s, selectedAgentId: a.id };
    case "closeOverlay":
      if (s.mode === "normal") return s;
      return { ...s, mode: "normal" };
    case "toggleRight":
      if (s.mode !== "normal") return s;
      return { ...s, rightTab: s.rightTab === "phases" ? "sessions" : "phases" };
    case "toggleFiles":
      return { ...s, filesPaused: !s.filesPaused };
    case "setPhaseCursor":
      if (s.phaseCursor === a.n) return s;
      return { ...s, phaseCursor: a.n };
    case "setProject":
      if (s.projectRoot === a.root && s.phaseCursor === null) return s;
      return { ...s, projectRoot: a.root, phaseCursor: null };
    case "setPortCursor":
      if (s.portCursor === a.key) return s;
      return { ...s, portCursor: a.key };
    case "flash":
      if (s.flash !== null && s.flash.text === a.text && s.flash.ok === a.ok && s.flash.at === a.at) {
        return s;
      }
      return { ...s, flash: { text: a.text, ok: a.ok, at: a.at } };
    case "keyAt":
      if (s.lastKeyAt === a.at) return s;
      return { ...s, lastKeyAt: a.at };
    case "quit":
    case "noop":
      return s;
  }
}

/** The flash to draw at `now`, or null when none or it has expired (D-12). */
export function flashVisible(ui: UiState, now: number): Flash | null {
  const f = ui.flash;
  if (f === null) return null;
  if (now < f.at || now >= f.at + FLASH_MS) return null;
  return { text: f.text, ok: f.ok };
}

/** True when a selection exists and no key arrived for SELECTION_IDLE_MS (D-09). */
export function selectionExpired(ui: UiState, now: number): boolean {
  return ui.selectedAgentId !== null && now - ui.lastKeyAt >= SELECTION_IDLE_MS;
}

/**
 * The UI state with an unresolvable selection dropped (fails closed,
 * Pitfall 4). Returns `ui` itself when nothing changes.
 */
export function effectiveUi(ui: UiState, agentIds: ReadonlySet<string>): UiState {
  if (ui.selectedAgentId === null || agentIds.has(ui.selectedAgentId)) return ui;
  return { ...ui, selectedAgentId: null };
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
