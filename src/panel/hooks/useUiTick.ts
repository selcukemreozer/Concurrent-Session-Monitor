import React from "react";

/**
 * The one v2 animation clock (Phase 9, plan 09-12; UI-SPEC § Motion & timing;
 * RESEARCH Pitfall 11).
 *
 *   - One UI tick every 250 ms drives the spinners (1 frame per tick).
 *   - The FILES ticker moves one row every `TICKER_TICKS` (2) ticks = 500 ms,
 *     and is frozen while FILES is paused.
 *   - The interval runs only while something animates (`active`), so an idle
 *     panel renders nothing between data polls.
 *   - Flicker fallback (spinner 500 ms, ticker 1000 ms): plan 09-15 applies it,
 *     only if the live Warp check needs it, by changing `UI_TICK_MS` to 500 and
 *     keeping `TICKER_TICKS` at 2.
 *   - Tests drive time through the pure `animStep`, never real timers.
 */
export const UI_TICK_MS = 250;
export const TICKER_TICKS = 2;

export interface Anim {
  tick: number;
  step: number;
}

/** The next animation state: the tick always advances; the ticker step advances
 * every `tickerTicks` ticks unless paused. Pure. */
export function animStep(a: Anim, paused: boolean, tickerTicks: number = TICKER_TICKS): Anim {
  const tick = a.tick + 1;
  const n = Math.max(1, Math.floor(tickerTicks));
  const step = !paused && tick % n === 0 ? a.step + 1 : a.step;
  return { tick, step };
}

/**
 * One interval at `tickMs` while `active`, one functional state update per
 * tick (so one render per tick). The latest `paused` is read through a ref, so
 * pausing never restarts the clock. Cleared when inactive and on unmount.
 */
export function useUiTick(o: { active: boolean; paused: boolean; tickMs?: number }): Anim {
  const tickMs = o.tickMs ?? UI_TICK_MS;
  const [anim, setAnim] = React.useState<Anim>({ tick: 0, step: 0 });
  const pausedRef = React.useRef(o.paused);
  pausedRef.current = o.paused;
  React.useEffect(() => {
    if (!o.active) return undefined;
    const t = setInterval(() => {
      setAnim((a) => animStep(a, pausedRef.current));
    }, tickMs);
    return () => clearInterval(t);
  }, [o.active, tickMs]);
  return anim;
}
