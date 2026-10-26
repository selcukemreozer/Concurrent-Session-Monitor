import type { SessionRow } from "../../../aggregate.js";
import type { Conflict } from "../../../conflicts.js";
import type { DisplayRow } from "../../hooks/useRoster.js";
import { labelLead } from "../../../label.js";
import { liveBranch } from "../../../branch.js";
import { fmtUptime } from "../../../liveness.js";
import { fmtAge } from "../../../sessions.js";
import { cardModel } from "../model-name.js";
import type { AgentState } from "../palette.js";
import type { AgentCard, IdleStrip } from "../models.js";

/**
 * The live AGENTS builder (Phase 10 plan 10-09; LAYOUT-07, D-05, D-07, D-08).
 *
 *   - The Phase 9 -> 10 seam: this turns the roster (useRoster's display rows
 *     and conflicts) into the `AgentCard` / `IdleStrip` view-models that
 *     draw/agents.ts already draws. The draw never reads sessions.
 *   - D-05: cards follow session start order, oldest first, as a FIRST-SEEN
 *     stable order. A plain `start_time` sort is not enough: the SessionStart
 *     hook rewrites `start_time` on every startup / resume / clear / compact,
 *     so a sorted grid would move a card to the end after `/compact`
 *     (RESEARCH Pitfall 2). `stableOrder` keeps a seq per session id: known
 *     ids keep theirs, new ids are appended in start order, vanished ids are
 *     dropped. The caller (PanelApp) holds the map in a ref across renders.
 *     `src/aggregate.ts` keeps its own most-recently-active order for legacy.
 *   - D-07: the model label falls back transcript model -> session.json model
 *     -> null (`cardModel`).
 *   - D-08: a session is a card while it is asking, waiting, running or in a
 *     subagent (the same pre-gated booleans as the header chips), otherwise an
 *     idle strip. Cards and strips share one order and the id never changes,
 *     so a selection survives a card becoming a strip and back.
 *   - Ended (grace) display rows are excluded, as in the header.
 *
 * Strings stay RAW here except the name, which `labelLead` already makes
 * display-safe; every draw passes each field through nameText / plainText
 * (T-10-20). Pure: `now` is injected, no React, no I/O, never throws.
 */

/** U+2014, the uptime of a session whose start time does not parse. */
const DASH = "—";

function startMs(r: { start_time: string }): number {
  const t = Date.parse(r.start_time);
  return Number.isFinite(t) ? t : 0;
}

function byStart(
  a: { session_id: string; start_time: string },
  b: { session_id: string; start_time: string },
): number {
  return startMs(a) - startMs(b) || (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0);
}

/** The first-seen order: existing seqs kept, new ids appended by start time, gone ids dropped (D-05). */
export function stableOrder(
  prev: ReadonlyMap<string, number>,
  rows: readonly { session_id: string; start_time: string }[],
): Map<string, number> {
  const next = new Map<string, number>();
  let seq = 0;
  for (const v of prev.values()) if (Number.isFinite(v)) seq = Math.max(seq, v + 1);
  const live = new Set(rows.map((r) => r.session_id));
  for (const [id, s] of prev) if (live.has(id)) next.set(id, s);
  const fresh = rows.filter((r) => !next.has(r.session_id)).sort(byStart);
  for (const r of fresh) if (!next.has(r.session_id)) next.set(r.session_id, seq++);
  return next;
}

/** The card state for a row, or null when it is an idle strip (D-08). */
export function cardState(row: SessionRow): AgentState | null {
  if (row.asking === true) return "asking";
  if (row.attention === true) return "waiting";
  if (row.running === true) return "running";
  if (row.subagent === true) return "subagent";
  return null;
}

function len(a: unknown): number {
  return Array.isArray(a) ? a.length : 0;
}

/** An age from the first parseable ISO time, or the dash. */
function ageOf(now: number, ...times: Array<string | undefined>): string {
  for (const t of times) {
    if (typeof t !== "string") continue;
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return fmtAge(ms, now);
  }
  return DASH;
}

export interface AgentsBuild {
  agents: AgentCard[];
  idle: IdleStrip[];
  /** The live rows by session id, for the go-to and detail-strip lookups. */
  byId: Map<string, SessionRow>;
}

export function buildAgents(i: {
  display: readonly DisplayRow[];
  conflicts: readonly Conflict[];
  branches: ReadonlyMap<string, string>;
  order: ReadonlyMap<string, number>;
  now: number;
}): AgentsBuild {
  const rows = i.display.filter((d) => !d.ended).map((d) => d.row);
  const byId = new Map<string, SessionRow>();
  for (const r of rows) byId.set(r.session_id, r);

  // known seqs first; ids missing from the order after them, by start time
  const sorted = [...byId.values()].sort((a, b) => {
    const sa = i.order.get(a.session_id);
    const sb = i.order.get(b.session_id);
    if (sa !== undefined && sb !== undefined) return sa - sb;
    if (sa !== undefined) return -1;
    if (sb !== undefined) return 1;
    return byStart(a, b);
  });

  const conflictCount = new Map<string, number>();
  for (const c of i.conflicts) {
    const ids = new Set((c.sessions ?? []).map((s) => s.session_id));
    for (const id of ids) conflictCount.set(id, (conflictCount.get(id) ?? 0) + 1);
  }

  const agents: AgentCard[] = [];
  const idle: IdleStrip[] = [];
  for (const r of sorted) {
    const name = labelLead({ title: r.title, folder: r.folder });
    const state = cardState(r);
    if (state === null) {
      idle.push({ id: r.session_id, name, ago: ageOf(i.now, r.last_seen, r.last_active, r.start_time) });
      continue;
    }
    const start = Date.parse(r.start_time);
    const attn = typeof r.attention_ts === "string" ? Date.parse(r.attention_ts) : NaN;
    const conflicts = conflictCount.get(r.session_id) ?? 0;
    const subs = r.subagent_count;
    agents.push({
      id: r.session_id,
      name,
      dir: r.folder,
      branch: liveBranch(r, i.branches),
      uptime: Number.isFinite(start) ? fmtUptime(start, i.now) : DASH,
      model: cardModel(r),
      prompt: typeof r.last_prompt === "string" ? r.last_prompt : null,
      state,
      waitFor: state === "waiting" && Number.isFinite(attn) ? fmtAge(attn, i.now) : null,
      subagents: typeof subs === "number" && Number.isFinite(subs) ? subs : 0,
      conflicts,
      writes: len(r.files),
      reads: len(r.reads),
      inConflict: conflicts > 0,
    });
  }
  return { agents, idle, byId };
}
