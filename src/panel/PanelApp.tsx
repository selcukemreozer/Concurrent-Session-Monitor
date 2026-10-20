import React from "react";
import { Box, useApp, useInput, useStdin, useWindowSize } from "ink";
import { useRoster } from "./hooks/useRoster.js";
import { useUpdateCheck } from "./hooks/useUpdateCheck.js";
import { useUiTick, UI_TICK_MS } from "./hooks/useUiTick.js";
import { headerFromRoster } from "./ui/headerModel.js";
import { initialUi, uiReducer, type Action, type UiState } from "./ui/uiState.js";
import { resolve } from "./ui/keymap.js";
import { drawShell } from "./ui/draw/shell.js";
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
 */
export interface PanelAppProps {
  tickMs?: number;
  now?: () => number;
}

/** Rows the FILES ticker shows before it starts scrolling. */
const TICKER_VISIBLE = 6;

export function PanelApp(props: PanelAppProps = {}): React.ReactElement {
  const tickMs = props.tickMs ?? UI_TICK_MS;
  const now = props.now ?? Date.now;

  const roster = useRoster();
  const updateTo = useUpdateCheck();
  const { rows, columns } = useWindowSize();
  const { isRawModeSupported } = useStdin();

  // The ref is assigned before the state so quick successive keys each see the
  // previous key's effect (the T-08-11 stale-closure pattern).
  const uiRef = React.useRef<UiState>(initialUi);
  const [ui, setUi] = React.useState<UiState>(initialUi);
  const apply = React.useCallback((action: Action) => {
    const next = uiReducer(uiRef.current, action);
    if (next === uiRef.current) return;
    uiRef.current = next;
    setUi(next);
  }, []);

  const animating =
    SAMPLE.agents.some((a) => a.state === "running") ||
    tickerRows(SAMPLE.groups).length > TICKER_VISIBLE;
  const { tick, step } = useUiTick({ active: animating, paused: ui.filesPaused, tickMs });

  const header = headerFromRoster(roster, updateTo, now());
  const headerKey = [
    header.agents,
    header.asking,
    header.waiting,
    header.conflicts,
    header.clock,
    header.update ?? "",
  ].join("|");

  const lines = React.useMemo(
    () =>
      drawShell({
        rows,
        cols: columns,
        ui,
        tick,
        step,
        header,
        panes: SAMPLE,
        keysOff: !isRawModeSupported,
        flash: null,
        sample: true,
      }),
    // `header` is keyed by its fields (headerKey): a fresh object with the same
    // values never re-draws the frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, columns, ui, tick, step, isRawModeSupported, headerKey],
  );

  return (
    <Box flexDirection="column">
      {isRawModeSupported ? <V2Keyboard uiRef={uiRef} apply={apply} /> : null}
      <ScreenView lines={lines} />
    </Box>
  );
}

/**
 * The ONLY input handler in v2 (KEYS-01). A key resolves through the keymap
 * against the freshest UI state; `quit` becomes Ink's exit, every other action
 * goes to the reducer. Mounted only on a TTY (see PanelApp).
 */
function V2Keyboard({
  uiRef,
  apply,
}: {
  uiRef: React.RefObject<UiState>;
  apply: (action: Action) => void;
}): null {
  const { exit } = useApp();
  useInput((input, key) => {
    const action = resolve(input, key, uiRef.current);
    if (action === null) return;
    if (action.t === "quit") {
      exit();
      return;
    }
    apply(action);
  });
  return null;
}
