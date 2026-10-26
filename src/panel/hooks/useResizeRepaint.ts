import React from "react";
import { useStdout } from "ink";

/**
 * Absolute repaint on terminal resize, v2 panel only (Phase 10, plan 10-04;
 * LAYOUT-05; CONTEXT D-01 / D-02 / D-04; RESEARCH Q2).
 *
 * Why ghosts happen (ink@8.0.0, ink.js `resized()` + log-update):
 *   - A frame that fits the screen is replaced by erasing `previousLineCount`
 *     lines RELATIVE TO THE CURSOR, then printing the new frame.
 *   - Ink's own resize listener clears (still relatively) only when the width
 *     shrinks. When Warp reflows the old frame or moves the cursor (sidebar
 *     toggle, edge drag, hotkey window), the relative erase misses rows and
 *     the next frame starts lower, leaving copies of the header above it.
 *
 * The fix (D-01):
 *   - On every `resize` event, write HOME_ERASE_DOWN (cursor home + erase to
 *     end of screen: Ink's own `homeAndEraseDown`) at once.
 *   - Arm one trailing timer; RESIZE_SETTLE_MS after the LAST event it writes
 *     the same clear again, catching Warp's late reflow. A burst of events
 *     resets the timer, so it fires exactly once.
 *
 * Why the write goes through Ink's `useStdout().write`:
 *   - That is Ink's writeToStdout: `bsu; log.clear(); write(data);
 *     restoreLastOutput(); esu`. Ink wipes, our clear homes the cursor and
 *     erases the screen, then Ink repaints its latest frame from row 0 and
 *     log-update's line count matches the screen again.
 *   - Writing to the process stream behind Ink's back would desync that line
 *     count and recreate the ghosts (T-10-09). This hook never does it.
 *   - Never the full-screen / scrollback erase codes: some terminals push those
 *     into scrollback (Ink comment #935).
 *   - writeToStdout is a no-op after unmount, so a late timer is harmless; the
 *     cleanup clears it anyway (T-10-10).
 *
 * Non-TTY guard (Pitfall 5, T-10-08): when stdout is not a TTY the hook does
 * nothing, so piped runs and bundle-smoke stay byte-clean.
 *
 * D-04: only PanelApp (v2) mounts this; the legacy App gets no resize fix.
 *
 * Contingency if the live D-03 gate still shows residue (each a small change
 * here): (1) also write HOME_ERASE_DOWN from a useLayoutEffect keyed on
 * [rows, columns], after the new-size commit; or (2) lower the settle to about
 * 100 ms or add a second trailing pass at about 400 ms. A same-size hide/show
 * of the hotkey window sends no resize event and is NOT covered (RESEARCH open
 * question 1, Pitfall 11).
 */
export const RESIZE_SETTLE_MS = 150;

/** CUP(1,1) + ED(0): cursor home, erase to the end of the screen. */
export const HOME_ERASE_DOWN = "\u001B[1;1H\u001B[0J";

/** Injectable timer pair, so tests drive the trailing repaint with a fake clock. */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(h: unknown): void;
}

export const REAL_TIMERS: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

export function useResizeRepaint(o: { settleMs?: number; timers?: Timers } = {}): void {
  const { stdout, write } = useStdout();
  const settle = o.settleMs ?? RESIZE_SETTLE_MS;
  const timers = o.timers ?? REAL_TIMERS;
  React.useEffect(() => {
    // Ink types stdout as a plain Writable; a real terminal stream carries isTTY.
    if ((stdout as { isTTY?: boolean }).isTTY !== true) return undefined;
    let pending: unknown = null;
    const repaint = (): void => write(HOME_ERASE_DOWN);
    const onResize = (): void => {
      // Immediate: wipe and repaint Ink's latest frame from row 0.
      repaint();
      if (pending !== null) timers.clear(pending);
      pending = timers.set(() => {
        pending = null;
        // Trailing: after the terminal's late reflow (D-01).
        repaint();
      }, settle);
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
      if (pending !== null) timers.clear(pending);
      pending = null;
    };
  }, [stdout, write, settle, timers]);
}
