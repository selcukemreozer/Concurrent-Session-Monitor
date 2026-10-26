/**
 * The pure selection navigator (Phase 10 plan 10-07; KEYS-02, D-06, D-16).
 *
 *   - Identities in, identities out: every function takes id arrays (in the
 *     freshest display order) plus integers, and returns an id (or a grid row
 *     number). No function takes or returns a list index as identity, so a
 *     selection survives a re-sort — callers simply pass the fresh order.
 *   - The AGENTS grid mirrors drawAgentsPane (draw/agents.ts): cards fill one
 *     slot each, then idle strips fill slots three at a time; slots flow
 *     row-major across `cols` columns. In calm mode (no cards) the strip slots
 *     start at slot 0.
 *   - ←/→ step ±1 item in list order; ↑/↓ move one grid row, walking inside a
 *     3-strip stack first; PgUp/PgDn move several grid rows (D-16). Every
 *     move clamps — no wrap — except project cycling (`cycleId`), which wraps
 *     like the legacy `cycleIndex`.
 *   - With no current id (null or no longer present) the first press selects
 *     the first item (D-06).
 *   - Pure: no React, no Ink, no clock. Every loop is bounded by the input
 *     length.
 */
export type Dir = "up" | "down" | "left" | "right";

export interface GridItem {
  id: string;
  kind: "card" | "strip";
  /** The grid slot (row-major across `cols`). */
  slot: number;
  /** Position inside a 3-strip stack (always 0 for a card). */
  sub: number;
}

/** Strips per idle slot (drawAgentsPane packs three per slot). */
const STRIPS_PER_SLOT = 3;

function normCols(cols: number): number {
  return Number.isFinite(cols) ? Math.max(1, Math.floor(cols)) : 1;
}

function normInt(n: number): number {
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** The first (or last) item in `slot`, or undefined when the slot is empty. */
function atSlot(items: readonly GridItem[], slot: number, which: "first" | "last"): GridItem | undefined {
  let found: GridItem | undefined;
  for (const it of items) {
    if (it.slot !== slot) continue;
    if (which === "first") return it;
    found = it;
  }
  return found;
}

/** The grid items for the cards and idle strips in display order. */
export function gridItems(cardIds: readonly string[], stripIds: readonly string[]): GridItem[] {
  const out: GridItem[] = [];
  const nCards = cardIds.length;
  for (let i = 0; i < nCards; i++) out.push({ id: cardIds[i]!, kind: "card", slot: i, sub: 0 });
  for (let k = 0; k < stripIds.length; k++) {
    out.push({
      id: stripIds[k]!,
      kind: "strip",
      slot: nCards + Math.floor(k / STRIPS_PER_SLOT),
      sub: k % STRIPS_PER_SLOT,
    });
  }
  return out;
}

/** The id after one arrow press in the grid, or null when the grid is empty. */
export function moveGrid(
  items: readonly GridItem[],
  cols: number,
  currentId: string | null,
  dir: Dir,
): string | null {
  const n = items.length;
  if (n === 0) return null;
  const i = currentId === null ? -1 : items.findIndex((x) => x.id === currentId);
  if (i < 0) return items[0]!.id;
  const cur = items[i]!;
  const c = normCols(cols);
  switch (dir) {
    case "left":
      return items[Math.max(0, i - 1)]!.id;
    case "right":
      return items[Math.min(n - 1, i + 1)]!.id;
    case "down": {
      const next = items[i + 1];
      if (next !== undefined && next.slot === cur.slot) return next.id;
      const below = atSlot(items, cur.slot + c, "first");
      if (below !== undefined) return below.id;
      const last = items[n - 1]!;
      if (Math.floor(last.slot / c) > Math.floor(cur.slot / c)) return last.id;
      return cur.id;
    }
    case "up": {
      if (cur.sub > 0 && i > 0) return items[i - 1]!.id;
      if (cur.slot - c >= 0) {
        const above = atSlot(items, cur.slot - c, "last");
        if (above !== undefined) return above.id;
      }
      return cur.id;
    }
  }
}

/** The id after PgUp (-1) / PgDn (+1) by `rows` grid rows, clamped (D-16). */
export function pageGrid(
  items: readonly GridItem[],
  cols: number,
  currentId: string | null,
  rows: number,
  dir: -1 | 1,
): string | null {
  const n = items.length;
  if (n === 0) return null;
  const i = currentId === null ? -1 : items.findIndex((x) => x.id === currentId);
  if (i < 0) return items[0]!.id;
  const c = normCols(cols);
  const r = Math.max(1, normInt(rows));
  const target = items[i]!.slot + dir * r * c;
  if (dir === 1) {
    const hit = target <= items[n - 1]!.slot ? atSlot(items, target, "first") : undefined;
    return (hit ?? items[n - 1]!).id;
  }
  const hit = target >= 0 ? atSlot(items, target, "last") : undefined;
  return (hit ?? items[0]!).id;
}

/** The grid row of an id's slot, or -1 when the id is not in the grid. */
export function slotRow(items: readonly GridItem[], id: string, cols: number): number {
  const it = items.find((x) => x.id === id);
  return it === undefined ? -1 : Math.floor(it.slot / normCols(cols));
}

/** A clamped move by `delta` through a flat list (no wrap). */
export function moveList(ids: readonly string[], currentId: string | null, delta: number): string | null {
  const n = ids.length;
  if (n === 0) return null;
  const i = currentId === null ? -1 : ids.indexOf(currentId);
  if (i < 0) return ids[0]!;
  return ids[Math.min(n - 1, Math.max(0, i + normInt(delta)))]!;
}

/** A wrapping step through a list (project cycling, like legacy cycleIndex). */
export function cycleId(ids: readonly string[], currentId: string | null, dir: -1 | 1): string | null {
  const n = ids.length;
  if (n === 0) return null;
  const i = currentId === null ? -1 : ids.indexOf(currentId);
  if (i < 0) return dir === 1 ? ids[0]! : ids[n - 1]!;
  return ids[(((i + dir) % n) + n) % n]!;
}
