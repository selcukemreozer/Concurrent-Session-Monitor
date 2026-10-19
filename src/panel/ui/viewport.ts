/**
 * The v2 list window (Phase 9, plan 09-03; UI-SPEC § "↑ N more / ↓ N more").
 *
 * `windowSlice()` is the one window function behind the AGENTS card grid,
 * PORTS, the PHASES list and SESSIONS. Given a list length, the rows the list
 * may use, the cursor index and the previous (sticky) offset, it returns the
 * half-open range `[start, end)` of visible items, the hidden item counts and
 * whether each indicator row is drawn.
 *
 *   - N always counts hidden ITEMS (cards + idle strips, phases, sessions or
 *     ports), never rows: `above = start`, `below = len - end`, and
 *     `above + visible + below === len`, so a list is never cut silently
 *     (T-09-02b).
 *   - `rows` is the rows actually used, item rows plus indicator rows, and is
 *     never more than `height` (T-09-14a). An item taller than the space left
 *     for it is counted clipped to that space (the caller clips its drawing).
 *   - The cursor is kept visible with `context` items of margin (default 1)
 *     when the window allows it. The offset is sticky: a cursor move that
 *     stays inside the margins does not move the window (same behavior as the
 *     v1 `followOffset` in src/sessions.ts).
 *   - Selection is kept by ID at the call sites (reconcileSelection); this
 *     function only receives the index that id resolves to (RESEARCH
 *     Pitfall 7).
 *
 * Indicator rows by height, when the list overflows:
 *   - height >= 3: `↑` exactly when start > 0, `↓` exactly when end < len.
 *   - height 2: one item row + one indicator: `↓` while items remain below
 *     the visible item, otherwise `↑`.
 *   - height 1: one item (the cursor item, or the item at the offset), no
 *     indicator.
 *
 * The indicators are evaluated per candidate start (`fill`), so they are
 * always consistent with the range; every search loop is bounded by `len`.
 * Pure: no Ink/React and no measuring loop.
 */

export interface WindowIn {
  /** Number of items. */
  len: number;
  /** Rows the list may use, indicator rows included. */
  height: number;
  /** Cursor item index, or -1 when there is no cursor. */
  cursor: number;
  /** The previous window start (sticky offset). */
  offset: number;
  /** Items of margin kept around the cursor (default 1). */
  context?: number;
  /** Per-item row heights (default 1 each). */
  heights?: readonly number[];
}

export interface WindowOut {
  /** The new sticky offset (=== start); feed it back next render. */
  offset: number;
  /** First visible item index. */
  start: number;
  /** One past the last visible item index. */
  end: number;
  /** Hidden items above (=== start). */
  above: number;
  /** Hidden items below (=== len - end). */
  below: number;
  /** Rows used, indicator rows included (<= height). */
  rows: number;
  /** An "↑ N more" row is drawn. */
  up: boolean;
  /** A "↓ N more" row is drawn. */
  down: boolean;
}

interface Fill {
  end: number;
  rows: number;
  up: boolean;
  down: boolean;
}

function toInt(n: number | undefined, fallback: number): number {
  return n !== undefined && Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function windowSlice(w: WindowIn): WindowOut {
  const len = Math.max(0, toInt(w.len, 0));
  const height = Math.max(0, toInt(w.height, 0));
  const context = Math.max(0, toInt(w.context, 1));
  let cursor = toInt(w.cursor, -1);
  if (cursor < 0 || len === 0) cursor = -1;
  else if (cursor >= len) cursor = len - 1;
  const offset = Math.min(Math.max(0, toInt(w.offset, 0)), len);

  const h: number[] = new Array<number>(len);
  for (let i = 0; i < len; i++) {
    const v = w.heights?.[i];
    h[i] = v !== undefined && Number.isFinite(v) && v >= 1 ? Math.trunc(v) : 1;
  }
  // suffix[i] = rows of items i..len-1
  const suffix: number[] = new Array<number>(len + 1);
  suffix[len] = 0;
  for (let i = len - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + h[i]!;

  const out = (start: number, f: Fill): WindowOut => ({
    offset: start,
    start,
    end: f.end,
    above: start,
    below: len - f.end,
    rows: f.rows,
    up: f.up,
    down: f.down,
  });

  if (height <= 0 || len === 0) {
    return out(offset, { end: offset, rows: 0, up: false, down: false });
  }
  if (suffix[0]! <= height) {
    return out(0, { end: len, rows: suffix[0]!, up: false, down: false });
  }

  // The window for a given start (the list overflows from here on).
  const fill = (s: number): Fill => {
    if (height === 1) return { end: s + 1, rows: 1, up: false, down: false };
    if (height === 2) {
      const down = s + 1 < len;
      const up = !down && s > 0;
      const ind = up || down ? 1 : 0;
      return { end: s + 1, rows: ind + Math.min(h[s]!, height - ind), up, down };
    }
    const up = s > 0;
    const budget = height - (up ? 1 : 0);
    if (suffix[s]! <= budget) return { end: len, rows: (up ? 1 : 0) + suffix[s]!, up, down: false };
    const b2 = budget - 1;
    let end = s;
    let used = 0;
    while (end < len && used + h[end]! <= b2) used += h[end++]!;
    if (end === s) {
      // Not even the first item fits: show it clipped.
      end = s + 1;
      if (end === len) return { end, rows: (up ? 1 : 0) + Math.min(h[s]!, budget), up, down: false };
      used = Math.min(h[s]!, b2);
    }
    return { end, rows: (up ? 1 : 0) + used + 1, up, down: true };
  };

  // The smallest start whose window reaches the end of the list.
  let maxStart = len - 1;
  for (let s = 0; s < len; s++) {
    if (fill(s).end === len) {
      maxStart = s;
      break;
    }
  }

  let start = Math.min(offset, maxStart);

  if (cursor >= 0) {
    const ctxTop = Math.min(context, cursor);
    const needEnd = Math.min(len, cursor + context + 1);
    const top = (): void => {
      if (start > cursor - ctxTop) start = cursor - ctxTop;
    };
    const bottom = (): void => {
      while (start < cursor && fill(start).end < needEnd) start++;
    };
    // The margin in the direction of travel wins when both cannot fit.
    if (cursor >= start) {
      top();
      bottom();
    } else {
      bottom();
      top();
    }
    // The cursor itself is always visible.
    while (start < cursor && cursor >= fill(start).end) start++;
    start = Math.min(start, maxStart);
  }

  return out(start, fill(start));
}
