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
 *   - Rows tagged `built: 11 | 12` resolve to a `noop` action (the UI-SPEC
 *     sample-shell scope: hinted P11–P12 keys are silent no-ops, T-09-11a).
 *     Each phase replaces its rows' actions.
 *   - Phase 10 (plan 10-07, RESEARCH Pattern 2): the `built: 10` rows emit
 *     INTENTS (`move`, `page`, `project`, `goto`, `copy`, `open`) instead of
 *     noops. An intent carries no target: the single dispatcher (10-08)
 *     resolves it against the live view-models by identity (KEYS-02), so the
 *     keymap stays pure and the footer still comes from this one table.
 *   - PgUp / PgDn are the `page` row (D-16): routed in every normal context
 *     but deliberately NOT in FOOTER_HINTS (no hint names them).
 *   - Ctrl+C is not a row: Ink's `exitOnCtrlC` consumes it before `useInput`.
 *   - Overlays (Phase 10 plan 10-02, IN-01): in `confirm` / `confirmKill`
 *     Esc resolves to `confirmNo` (the binding the `n / esc` hint names; its
 *     row sits before `close`), and `q` still closes. Tab / Shift+Tab move
 *     focus in the normal contexts and close an open menu (UI-SPEC), but a
 *     confirm is never dismissed by Tab.
 */
import type { Action, UiState } from "./uiState.js";
import type { Dir } from "./nav.js";

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
  pageUp?: boolean;
  pageDown?: boolean;
}

/**
 * A key's meaning that needs the live view-models to resolve (10-07). The
 * dispatcher (10-08) turns an intent into reducer actions by identity.
 */
export type Intent =
  | { t: "move"; dir: Dir }
  | { t: "page"; dir: -1 | 1 }
  | { t: "project"; dir: -1 | 1 }
  | { t: "goto" }
  | { t: "copy" }
  | { t: "open" };

const INTENT_TAGS: ReadonlySet<string> = new Set(["move", "page", "project", "goto", "copy", "open"]);

/** True for a keymap intent, false for a reducer Action. */
export function isIntent(a: Action | Intent): a is Intent {
  return INTENT_TAGS.has(a.t);
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
  action(ui: UiState, input: string, key: KeyInput): Action | Intent;
}

export interface Hint {
  binding: string;
  key: string;
  label: string;
}

type HintSpec = { binding: string; key: string; label: string | ((ui: UiState) => string) };

const NORMAL: readonly HintContext[] = ["agents", "agentsSelected", "phases", "sessions", "ports"];
const OVERLAYS: readonly HintContext[] = ["menu", "confirm", "confirmKill"];
/** Tab / Shift+Tab: the normal contexts and the menu, never a confirm (IN-01). */
const TAB_CONTEXTS: readonly HintContext[] = [...NORMAL, "menu"];

const plain = (key: KeyInput): boolean => !key.ctrl && !key.meta;
const char = (c: string) => (input: string, key: KeyInput) => plain(key) && input === c;
const anyArrow = (_: string, k: KeyInput) => !!(k.upArrow || k.downArrow || k.leftArrow || k.rightArrow);
const upDown = (_: string, k: KeyInput) => !!(k.upArrow || k.downArrow);
const leftRight = (_: string, k: KeyInput) => !!(k.leftArrow || k.rightArrow);
const esc = (_: string, k: KeyInput) => !!k.escape;
const enter = (_: string, k: KeyInput) => !!k.return;
const noop = (id: string) => (): Action => ({ t: "noop", binding: id });
const page = (_: string, k: KeyInput) => !!(k.pageUp || k.pageDown);

/** The arrow direction of a key (callers have already matched an arrow). */
function arrowDir(k: KeyInput): Dir {
  if (k.upArrow) return "up";
  if (k.downArrow) return "down";
  if (k.leftArrow) return "left";
  return "right";
}
const move = (_ui: UiState, _i: string, k: KeyInput): Intent => ({ t: "move", dir: arrowDir(k) });

export const KEYMAP: readonly Binding[] = [
  {
    // IN-01: before `close`, so Esc in a confirm is the hinted `n / esc` cancel.
    id: "confirmNo",
    built: 11,
    contexts: ["confirm", "confirmKill"],
    match: (i, k) => (plain(k) && i === "n") || !!k.escape,
    action: noop("confirmNo"),
  },
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
    // IN-01: Tab closes an open menu but never dismisses a confirm.
    id: "focus",
    built: 9,
    contexts: TAB_CONTEXTS,
    match: (_, k) => !!k.tab && !k.shift,
    action: () => ({ t: "focusNext" }),
  },
  {
    id: "focusPrev",
    built: 9,
    contexts: TAB_CONTEXTS,
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
    // D-16: PgUp / PgDn page every scrollable pane. A routed row with NO
    // footer hint (FOOTER_HINTS never names "page").
    id: "page",
    built: 10,
    contexts: NORMAL,
    match: page,
    action: (_ui, _i, k) => ({ t: "page", dir: k.pageUp ? -1 : 1 }),
  },
  {
    id: "agentsSelect",
    built: 10,
    contexts: ["agents"],
    match: anyArrow,
    action: move,
  },
  {
    id: "agentsMove",
    built: 10,
    contexts: ["agentsSelected"],
    match: anyArrow,
    action: move,
  },
  {
    id: "agentsGoto",
    built: 10,
    contexts: ["agentsSelected"],
    match: enter,
    action: () => ({ t: "goto" }),
  },
  {
    id: "phasesBrowse",
    built: 10,
    contexts: ["phases"],
    match: upDown,
    action: move,
  },
  {
    id: "phasesProject",
    built: 10,
    contexts: ["phases"],
    match: leftRight,
    action: (_ui, _i, k) => ({ t: "project", dir: k.leftArrow ? -1 : 1 }),
  },
  {
    id: "sessionsBrowse",
    built: 10,
    contexts: ["sessions"],
    match: upDown,
    action: move,
  },
  {
    id: "sessionsCopy",
    built: 10,
    contexts: ["sessions"],
    match: enter,
    action: () => ({ t: "copy" }),
  },
  {
    id: "sessionsOpen",
    built: 10,
    contexts: ["sessions"],
    match: char("o"),
    action: () => ({ t: "open" }),
  },
  {
    id: "portsBrowse",
    built: 10,
    contexts: ["ports"],
    match: upDown,
    action: move,
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

/**
 * The action or intent for a key press, or null when no row in this context
 * matches.
 */
export function resolve(input: string, key: KeyInput, ui: UiState): Action | Intent | null {
  const ctx = contextOf(ui);
  for (const b of KEYMAP) {
    if (b.contexts.includes(ctx) && b.match(input, key)) return b.action(ui, input, key);
  }
  return null;
}
