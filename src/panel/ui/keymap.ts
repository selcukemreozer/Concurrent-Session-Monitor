/**
 * The v2 keymap (Phase 9, plan 09-04; D-13..D-19, D-24; RESEARCH Pattern 2).
 *
 *   - This table is the ONLY source of key routing AND of the footer hints.
 *     Every hint names a binding id that the tests prove is active in the
 *     hint's context, so the footer cannot lie (D-19, T-09-08b).
 *   - Rows are ordered; the first row whose contexts include the current
 *     context and whose `match` is true wins. Mode guards come first.
 *   - Deliberately absent: the help overlay (`?`), pane zoom (`z`), vim-style
 *     letter navigation (`j`/`k`), bracket project keys (`[`/`]`) and
 *     number-key focus (D-13, D-14, D-19). Tests prove they are unbound.
 *   - Rows tagged `built: 10 | 11 | 12` resolve to a `noop` action in Phase 9
 *     (the UI-SPEC sample-shell scope: hinted P10–P12 keys are silent no-ops
 *     on sample data, T-09-11a). Each phase replaces its rows' actions.
 *   - Ctrl+C is not a row: Ink's `exitOnCtrlC` consumes it before `useInput`.
 */
import type { Action, UiState } from "./uiState.js";

/** The subset of Ink's `Key` the keymap reads. Ink's `Key` is assignable. */
export interface KeyInput {
  tab?: boolean;
  shift?: boolean;
  escape?: boolean;
  return?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

export type HintContext =
  | "agents"
  | "agentsSelected"
  | "phases"
  | "sessions"
  | "ports"
  | "menu"
  | "confirm"
  | "confirmKill"
  | "edit";

export interface Binding {
  id: string;
  built: 9 | 10 | 11 | 12;
  contexts: readonly HintContext[];
  match(input: string, key: KeyInput): boolean;
  action(ui: UiState): Action;
}

export interface Hint {
  binding: string;
  key: string;
  label: string;
}

type HintSpec = { binding: string; key: string; label: string | ((ui: UiState) => string) };

const NORMAL: readonly HintContext[] = ["agents", "agentsSelected", "phases", "sessions", "ports"];
const OVERLAYS: readonly HintContext[] = ["menu", "confirm", "confirmKill"];
const NOT_EDIT: readonly HintContext[] = [...NORMAL, ...OVERLAYS];

const plain = (key: KeyInput): boolean => !key.ctrl && !key.meta;
const char = (c: string) => (input: string, key: KeyInput) => plain(key) && input === c;
const anyArrow = (_: string, k: KeyInput) => !!(k.upArrow || k.downArrow || k.leftArrow || k.rightArrow);
const upDown = (_: string, k: KeyInput) => !!(k.upArrow || k.downArrow);
const leftRight = (_: string, k: KeyInput) => !!(k.leftArrow || k.rightArrow);
const esc = (_: string, k: KeyInput) => !!k.escape;
const enter = (_: string, k: KeyInput) => !!k.return;
const noop = (id: string) => (): Action => ({ t: "noop", binding: id });

export const KEYMAP: readonly Binding[] = [
  {
    id: "close",
    built: 9,
    contexts: OVERLAYS,
    match: (i, k) => !!k.escape || (plain(k) && i === "q"),
    action: () => ({ t: "closeOverlay" }),
  },
  {
    id: "editCancel",
    built: 12,
    contexts: ["edit"],
    match: esc,
    action: noop("editCancel"),
  },
  {
    id: "editSave",
    built: 12,
    contexts: ["edit"],
    match: enter,
    action: noop("editSave"),
  },
  {
    id: "focus",
    built: 9,
    contexts: NOT_EDIT,
    match: (_, k) => !!k.tab && !k.shift,
    action: () => ({ t: "focusNext" }),
  },
  {
    id: "focusPrev",
    built: 9,
    contexts: NOT_EDIT,
    match: (_, k) => !!k.tab && !!k.shift,
    action: () => ({ t: "focusPrev" }),
  },
  {
    id: "menuCycle",
    built: 11,
    contexts: ["menu"],
    match: leftRight,
    action: noop("menuCycle"),
  },
  {
    id: "menuSelect",
    built: 11,
    contexts: ["menu"],
    match: enter,
    action: noop("menuSelect"),
  },
  {
    id: "confirmYes",
    built: 11,
    contexts: ["confirm"],
    match: (i, k) => (plain(k) && i === "y") || !!k.return,
    action: noop("confirmYes"),
  },
  {
    id: "confirmNo",
    built: 11,
    contexts: ["confirm", "confirmKill"],
    match: char("n"),
    action: noop("confirmNo"),
  },
  {
    id: "sigkillYes",
    built: 11,
    contexts: ["confirmKill"],
    match: char("y"),
    action: noop("sigkillYes"),
  },
  {
    id: "clearSelection",
    built: 10,
    contexts: ["agentsSelected"],
    match: esc,
    action: () => ({ t: "clearSelection" }),
  },
  {
    id: "toAgents",
    built: 9,
    contexts: ["phases", "sessions", "ports"],
    match: esc,
    action: () => ({ t: "focusAgents" }),
  },
  {
    id: "toggleRight",
    built: 9,
    contexts: NORMAL,
    match: char("r"),
    action: () => ({ t: "toggleRight" }),
  },
  {
    id: "pause",
    built: 9,
    contexts: NORMAL,
    match: char(" "),
    action: () => ({ t: "toggleFiles" }),
  },
  {
    id: "quit",
    built: 9,
    contexts: NORMAL,
    match: char("q"),
    action: () => ({ t: "quit" }),
  },
  {
    id: "agentsSelect",
    built: 10,
    contexts: ["agents"],
    match: anyArrow,
    action: noop("agentsSelect"),
  },
  {
    id: "agentsMove",
    built: 10,
    contexts: ["agentsSelected"],
    match: anyArrow,
    action: noop("agentsMove"),
  },
  {
    id: "agentsGoto",
    built: 10,
    contexts: ["agentsSelected"],
    match: enter,
    action: noop("agentsGoto"),
  },
  {
    id: "phasesBrowse",
    built: 10,
    contexts: ["phases"],
    match: upDown,
    action: noop("phasesBrowse"),
  },
  {
    id: "phasesProject",
    built: 10,
    contexts: ["phases"],
    match: leftRight,
    action: noop("phasesProject"),
  },
  {
    id: "sessionsBrowse",
    built: 10,
    contexts: ["sessions"],
    match: upDown,
    action: noop("sessionsBrowse"),
  },
  {
    id: "sessionsCopy",
    built: 10,
    contexts: ["sessions"],
    match: enter,
    action: noop("sessionsCopy"),
  },
  {
    id: "sessionsOpen",
    built: 10,
    contexts: ["sessions"],
    match: char("o"),
    action: noop("sessionsOpen"),
  },
  {
    id: "portsBrowse",
    built: 10,
    contexts: ["ports"],
    match: upDown,
    action: noop("portsBrowse"),
  },
  {
    id: "portsActions",
    built: 11,
    contexts: ["ports"],
    match: enter,
    action: noop("portsActions"),
  },
];

const TAB_FOCUS: HintSpec = { binding: "focus", key: "tab", label: "focus" };
const Q_QUIT: HintSpec = { binding: "quit", key: "q", label: "quit" };
const ESC_AGENTS: HintSpec = { binding: "toAgents", key: "esc", label: "agents" };

/** The UI-SPEC footer hint sets, in priority order (the right end drops first). */
export const FOOTER_HINTS: Record<HintContext, readonly HintSpec[]> = {
  agents: [
    TAB_FOCUS,
    { binding: "agentsSelect", key: "←↑↓→", label: "select agent" },
    {
      binding: "pause",
      key: "space",
      label: (ui) => (ui.filesPaused ? "resume files" : "pause files"),
    },
    {
      binding: "toggleRight",
      key: "r",
      label: (ui) => (ui.rightTab === "phases" ? "sessions" : "phases"),
    },
    Q_QUIT,
  ],
  agentsSelected: [
    { binding: "agentsGoto", key: "⏎", label: "go to pane" },
    { binding: "agentsMove", key: "←↑↓→", label: "move" },
    { binding: "clearSelection", key: "esc", label: "clear" },
    TAB_FOCUS,
    Q_QUIT,
  ],
  phases: [
    { binding: "phasesBrowse", key: "↑↓", label: "browse phases" },
    { binding: "phasesProject", key: "←→", label: "project" },
    { binding: "toggleRight", key: "r", label: "sessions" },
    ESC_AGENTS,
    TAB_FOCUS,
    Q_QUIT,
  ],
  sessions: [
    { binding: "sessionsBrowse", key: "↑↓", label: "select session" },
    { binding: "sessionsCopy", key: "⏎", label: "copy resume" },
    { binding: "sessionsOpen", key: "o", label: "new window" },
    { binding: "toggleRight", key: "r", label: "phases" },
    ESC_AGENTS,
    Q_QUIT,
  ],
  ports: [
    { binding: "portsBrowse", key: "↑↓", label: "browse ports" },
    { binding: "portsActions", key: "⏎", label: "actions" },
    ESC_AGENTS,
    TAB_FOCUS,
    Q_QUIT,
  ],
  menu: [
    { binding: "menuCycle", key: "←→", label: "choose" },
    { binding: "menuSelect", key: "⏎", label: "select" },
    { binding: "close", key: "esc", label: "close" },
  ],
  confirm: [
    { binding: "confirmYes", key: "y", label: "stop" },
    { binding: "confirmNo", key: "n / esc", label: "cancel" },
  ],
  confirmKill: [
    { binding: "sigkillYes", key: "y", label: "force stop" },
    { binding: "confirmNo", key: "n / esc", label: "cancel" },
  ],
  edit: [
    { binding: "editSave", key: "⏎", label: "save" },
    { binding: "editCancel", key: "esc", label: "cancel" },
  ],
};

/** The hint/routing context for a UI state. Overlay modes win. */
export function contextOf(ui: UiState): HintContext {
  if (ui.mode !== "normal") return ui.mode;
  switch (ui.focus) {
    case "agents":
      return ui.selectedAgentId === null ? "agents" : "agentsSelected";
    case "right":
      return ui.rightTab;
    case "ports":
      return "ports";
  }
}

/** The footer hints for a UI state, with dynamic labels resolved. */
export function hintsFor(ui: UiState): Hint[] {
  return FOOTER_HINTS[contextOf(ui)].map((h) => ({
    binding: h.binding,
    key: h.key,
    label: typeof h.label === "function" ? h.label(ui) : h.label,
  }));
}

/** The action for a key press, or null when no row in this context matches. */
export function resolve(input: string, key: KeyInput, ui: UiState): Action | null {
  const ctx = contextOf(ui);
  for (const b of KEYMAP) {
    if (b.contexts.includes(ctx) && b.match(input, key)) return b.action(ui);
  }
  return null;
}
