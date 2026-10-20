import React from "react";

/**
 * The shared panel interval (Phase 9, plan 09-10; strangler step S1).
 *
 * Replaces the hand-rolled interval effects App.tsx used to carry (the store
 * poll, the port scan and the branch scan) with one primitive that LegacyApp and
 * PanelApp share:
 *
 * - ONE interval, armed once (`[]` deps). `cadence` is evaluated exactly once,
 *   inside the effect, so an env-gated cadence (`portScanMs()`) is read at mount
 *   just as the inline effects did.
 * - It always calls the LATEST `tick` (held in a ref), so a caller may pass an
 *   inline closure without re-arming the interval every render.
 * - `immediate: true` runs one tick on mount ("scan once on mount").
 * - Overlap guard: while a tick's returned promise is pending, later ticks are
 *   skipped. The guard is released on BOTH settle paths (`.then(release,
 *   release)`), so a rejecting tick can never raise an unhandled rejection and
 *   never wedges the guard closed.
 * - Lifetime `alive()`: the tick receives a function that returns false once the
 *   effect is cleaned up (unmount), so a late async resolve can drop its state
 *   update. Cleanup also clears the interval, so no tick runs after unmount.
 *
 * A synchronous tick (returning void) is never guarded — each interval calls it.
 */
export function usePoll(
  tick: (alive: () => boolean) => void | Promise<unknown>,
  cadence: number | (() => number),
  opts?: { immediate?: boolean },
): void {
  const tickRef = React.useRef(tick);
  tickRef.current = tick;
  // Captured at first render: the effect below is `[]`-scoped, so the cadence and
  // immediate flag are read once, exactly like the inline effects they replace.
  const cadenceRef = React.useRef(cadence);
  const immediateRef = React.useRef(opts?.immediate === true);
  const inFlight = React.useRef(false);

  React.useEffect(() => {
    let alive = true;
    const isAlive = () => alive;
    const release = () => {
      inFlight.current = false;
    };
    const run = () => {
      if (inFlight.current) return; // prior tick still running — skip, no overlap
      const result = tickRef.current(isAlive);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        inFlight.current = true;
        (result as Promise<unknown>).then(release, release);
      }
    };
    if (immediateRef.current) run(); // scan once on mount
    const c = cadenceRef.current;
    const t = setInterval(run, typeof c === "function" ? c() : c);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
}
