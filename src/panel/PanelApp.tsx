import React from "react";
import { Box, useApp, useInput, useStdin, useWindowSize } from "ink";
import { useRoster } from "./hooks/useRoster.js";
import { useUpdateCheck } from "./hooks/useUpdateCheck.js";
import { useUiTick, UI_TICK_MS } from "./hooks/useUiTick.js";
import { useResizeRepaint } from "./hooks/useResizeRepaint.js";
import { headerFromRoster } from "./ui/headerModel.js";
import {
  effectiveUi,
  flashVisible,
  initialUi,
  selectionExpired,
  uiReducer,
  type Action,
  type UiState,
} from "./ui/uiState.js";
import { contextOf, isIntent, resolve, type HintContext, type Intent, type KeyInput } from "./ui/keymap.js";
import { drawShellFrame, EMPTY_SCROLL, type SampleFlags, type ScrollState } from "./ui/draw/shell.js";
import { tickerRows } from "./ui/draw/files.js";
import { SAMPLE } from "./ui/sample.js";
import { ScreenView } from "./ui/ScreenView.js";

/**
 * The v2 panel root behind `CSM_UI=v2` (Phase 9, plan 09-12). Plan 09-13 wires
 * it into Root; until then nothing in the bundle imports it.
 *
 *   - D-20: the header is LIVE (the shared useRoster / useUpdateCheck hooks:
 *     real agent count, asking / waiting / conflict chips, clock, update
 *     notice), while every pane draws the SAMPLE fixture under the ` sample `
 *     chip. Phase 10 replaces SAMPLE pane by pane.
 *   - KEYS-01: exactly one input dispatcher, `V2Keyboard` (one useInput). It
 *     routes every key through the keymap table into the pure uiReducer and
 *     never uses Ink's focus manager.
 *   - D-21 / 04.2 D-08: on a non-TTY stdin the keyboard child is never
 *     mounted (no raw mode, no handler); the shell still renders and the
 *     footer shows `⌨ keys off — started without a TTY`.
 *   - D-24: `q` calls Ink's own `useApp().exit()`, the same handleExit path as
 *     Ctrl+C (raw mode off, cursor shown, waitUntilExit resolves), so entry.ts
 *     runs unregisterPanel and cleanupWarpTabConfig after waitUntilExit
 *     exactly as for Ctrl+C. Components never call process.exit.
 *   - Motion: one animation clock (useUiTick) drives the spinners and the
 *     FILES ticker; it runs only while something animates.
 *   - RESEARCH Open Question 3: `incrementalRendering` is NOT enabled up
 *     front; plan 09-15 enables it for v2 only if the live Warp check shows
 *     flicker.
 *   - Phase 9 PanelApp never opens a URL, kills a process, copies to the
 *     clipboard or launches anything: every P10–P12 key resolves to a noop.
 *
 * Phase 10 plan 10-08 (KEYS-01..03, D-09, D-12, D-23, LAYOUT-02):
 *   - One intent dispatcher behind the single V2Keyboard (`onKey`): every key
 *     first records `keyAt(now())`, then resolves against
 *     `effectiveUi(uiRef.current, view ids)`, so a vanished selection never
 *     routes as `agentsSelected` (Pitfall 4). `quit` exits, an intent goes to
 *     `onIntent(intent, ctx)` (per-context cases filled by later plans; all
 *     no-ops here, so SAMPLE panes never trigger anything, T-10-19), every
 *     other action goes to the reducer.
 *   - `viewRef` holds the per-render view facts the dispatcher reads (the
 *     drawn agent ids for now); `scrollRef` holds the ScrollState returned by
 *     drawShellFrame and feeds it back on the next draw (sticky windows, no
 *     state, no extra render).
 *   - The footer flash slot shows a flash for FLASH_MS (2500 ms) on the
 *     injected clock; an agent selection drops after SELECTION_IDLE_MS (15 s)
 *     without a key. The UI tick runs while either is pending, so both expire
 *     on time without a key press.
 *   - The draw and the footer hints use `effectiveUi`, so a selection that no
 *     longer resolves never shows `⏎ go to pane` (KEYS-03).
 */
export interface PanelAppProps {
  tickMs?: number;
  now?: () => number;
  /** Tests only: merged over `initialUi` once at mount. */
  initialUi?: Partial<UiState>;
  /** Tests only: observes every intent the dispatcher routes, with its context. */
  intentSpy?: (intent: Intent, ctx: HintContext) => void;
}

/** The view facts the dispatcher resolves keys against (10-08; later plans add rows, ports, phases, sessions). */
interface ViewFacts {
  agentIds: ReadonlySet<string>;
}

/** Every pane still draws SAMPLE (D-20); each flag turns false when its pane goes live (D-23). */
const SAMPLE_FLAGS: SampleFlags = { agents: true, files: true, phases: true, sessions: true, ports: true };

/** Rows the FILES ticker shows before it starts scrolling. */
const TICKER_VISIBLE = 6;

export function PanelApp(props: PanelAppProps = {}): React.ReactElement {
  const tickMs = props.tickMs ?? UI_TICK_MS;
  const now = props.now ?? Date.now;

  const roster = useRoster();
  const updateTo = useUpdateCheck();
  const { rows, columns } = useWindowSize();
  // LAYOUT-05 / D-01: on every resize, an absolute clear + repaint through
  // Ink at once and again 150 ms after the last event. useWindowSize already
  // re-renders the shell at the new size; this only resets Ink's frame
  // bookkeeping so no ghost header survives Warp's reflow. v2 only (D-04).
  useResizeRepaint();
  const { isRawModeSupported } = useStdin();
  const { exit } = useApp();

  // The ref is assigned before the state so quick successive keys each see the
  // previous key's effect (the T-08-11 stale-closure pattern).
  const [start] = React.useState<UiState>(() => ({ ...initialUi, ...props.initialUi }));
  const uiRef = React.useRef<UiState>(start);
  const [ui, setUi] = React.useState<UiState>(start);
  const apply = React.useCallback((action: Action) => {
    const next = uiReducer(uiRef.current, action);
    if (next === uiRef.current) return;
    uiRef.current = next;
    setUi(next);
  }, []);

  const animating =
    SAMPLE.agents.some((a) => a.state === "running") ||
    tickerRows(SAMPLE.groups).length > TICKER_VISIBLE;
  const flash = flashVisible(ui, now());
  // D-09 / D-12: the clock also runs while a flash is up or a selection may expire
  const { tick, step } = useUiTick({
    active: animating || flash !== null || ui.selectedAgentId !== null,
    paused: ui.filesPaused,
    tickMs,
  });

  // D-09: a selection idle for SELECTION_IDLE_MS is dropped (no special case for go-to)
  React.useEffect(() => {
    if (selectionExpired(uiRef.current, now())) apply({ t: "clearSelection" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ui.selectedAgentId, ui.lastKeyAt]);

  // The view facts of the panes drawn this render (SAMPLE: cards + idle strips).
  const viewRef = React.useRef<ViewFacts>({ agentIds: new Set() });
  viewRef.current = { agentIds: SAMPLE_AGENT_IDS };
  const scrollRef = React.useRef<ScrollState>(EMPTY_SCROLL);
  const uiForDraw = effectiveUi(ui, viewRef.current.agentIds);

  const header = headerFromRoster(roster, updateTo, now());
  const headerKey = [
    header.agents,
    header.asking,
    header.waiting,
    header.conflicts,
    header.clock,
    header.update ?? "",
  ].join("|");

  const flashKey = flash === null ? "" : `${flash.ok ? 1 : 0}|${flash.text}`;
  const sc = scrollRef.current;
  const scrollKey = [sc.grid, sc.phases, sc.sessions, sc.ports].map((w) => w.offset).join("|");

  const frame = React.useMemo(
    () =>
      drawShellFrame({
        rows,
        cols: columns,
        ui: uiForDraw,
        tick,
        step,
        header,
        panes: SAMPLE,
        keysOff: !isRawModeSupported,
        flash,
        sample: SAMPLE_FLAGS,
        scroll: scrollRef.current,
      }),
    // `header` is keyed by its fields (headerKey), the flash by its visible
    // text (flashKey) and the fed-back windows by their offsets (scrollKey): a
    // fresh object with the same values never re-draws the frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, columns, ui, uiForDraw.selectedAgentId, tick, step, isRawModeSupported, headerKey, flashKey, scrollKey],
  );
  // Pattern 3: the windows drawn are fed back on the next draw (a ref: no state, no extra render)
  scrollRef.current = frame.scroll;

  // The dispatcher's per-context intent handlers, reassigned every render so
  // they read the latest view-model. Every case is a no-op in 10-08: a handler
  // is added only by the plan that makes its pane live (T-10-19).
  const intentSpy = props.intentSpy;
  const intentRef = React.useRef<(intent: Intent, ctx: HintContext) => void>(() => undefined);
  intentRef.current = (intent: Intent, ctx: HintContext): void => {
    intentSpy?.(intent, ctx);
    switch (ctx) {
      case "agents": // select / move in the grid: 10-09
      case "agentsSelected": // move + go to pane: 10-09, 10-10
        return;
      case "phases": // browse + project: 10-13
      case "sessions": // browse + copy + open: 10-13
        return;
      case "ports": // browse + actions: 10-14
        return;
      case "menu":
      case "confirm":
      case "confirmKill":
      case "edit":
        return;
    }
  };

  // The single dispatcher (KEYS-01): keyAt first, then resolve against effectiveUi.
  const onKeyRef = React.useRef<(input: string, key: KeyInput) => void>(() => undefined);
  onKeyRef.current = (input: string, key: KeyInput): void => {
    const t = now();
    // D-09: an already-expired selection is dropped before this key counts
    if (selectionExpired(uiRef.current, t)) apply({ t: "clearSelection" });
    apply({ t: "keyAt", at: t });
    const eff = effectiveUi(uiRef.current, viewRef.current.agentIds);
    // Pitfall 4: a selection that no longer resolves fails closed in the state too
    if (eff !== uiRef.current) apply({ t: "clearSelection" });
    const action = resolve(input, key, eff);
    if (action === null) return;
    if (isIntent(action)) {
      intentRef.current(action, contextOf(eff));
      return;
    }
    if (action.t === "quit") {
      exit();
      return;
    }
    apply(action);
  };

  return (
    <Box flexDirection="column">
      {isRawModeSupported ? <V2Keyboard onKeyRef={onKeyRef} /> : null}
      <ScreenView lines={frame.lines} />
    </Box>
  );
}

/** The SAMPLE cards and idle strips a selection may resolve to. */
const SAMPLE_AGENT_IDS: ReadonlySet<string> = new Set([
  ...SAMPLE.agents.map((a) => a.id),
  ...SAMPLE.idle.map((s) => s.id),
]);

/**
 * The ONLY input handler in v2 (KEYS-01). Every key goes to PanelApp's single
 * dispatcher (`onKeyRef`, reassigned each render so it sees the latest view).
 * Mounted only on a TTY (see PanelApp).
 */
function V2Keyboard({
  onKeyRef,
}: {
  onKeyRef: React.RefObject<(input: string, key: KeyInput) => void>;
}): null {
  useInput((input, key) => {
    onKeyRef.current(input, key);
  });
  return null;
}
