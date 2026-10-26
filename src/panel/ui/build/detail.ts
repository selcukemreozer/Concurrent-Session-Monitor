import type { SessionRow } from "../../../aggregate.js";
import { attribute, livePidMap, type ScannedPort } from "../../../ports.js";
import { labelLead } from "../../../label.js";
import { liveBranch } from "../../../branch.js";
import { fmtUptime } from "../../../liveness.js";
import { cardModel } from "../model-name.js";
import { cardState } from "./agents.js";
import type { DetailModel } from "../models.js";

/**
 * The selection detail-strip builder (Phase 10 plan 10-11; LAYOUT-07, 09
 * D-12, D-06, D-17).
 *
 *   - Turns the selected live row (a card or an idle strip, D-06) plus the
 *     scanned ports into the `DetailModel` draw/detail.ts draws: name
 *     (labelLead, as on the card), state (`cardState`, else `"idle"`), uptime,
 *     model (the D-07 chain), intent, live branch, owned ports and the full
 *     last prompt.
 *   - T-10-29: a port is owned only through the existing ancestry join,
 *     `attribute(p, livePidMap(liveRows))`, so a dead / pruned / reused pid
 *     never claims a port and another session's port is never shown here.
 *     Owned ports are sorted by port number; a port number listed twice (an
 *     IPv4 + IPv6 listener pair) is shown once.
 *
 * Strings stay RAW (the draw sanitizes every field, T-10-28). Pure: `now` is
 * injected, no React, no I/O.
 */

/** U+2014, the uptime of a session whose start time does not parse. */
const DASH = "—";

export function buildDetail(i: {
  row: SessionRow;
  branches: ReadonlyMap<string, string>;
  ports: readonly ScannedPort[];
  liveRows: readonly SessionRow[];
  now: number;
}): DetailModel {
  const r = i.row;
  const start = Date.parse(r.start_time);
  const live = livePidMap([...i.liveRows]);
  const seen = new Set<number>();
  const ports: { port: number; proc: string }[] = [];
  for (const p of [...i.ports].sort((a, b) => a.port - b.port)) {
    if (seen.has(p.port)) continue;
    if (attribute(p, live)?.session_id !== r.session_id) continue;
    seen.add(p.port);
    ports.push({ port: p.port, proc: p.command });
  }
  return {
    id: r.session_id,
    name: labelLead({ title: r.title, folder: r.folder }),
    state: cardState(r) ?? "idle",
    uptime: Number.isFinite(start) ? fmtUptime(start, i.now) : DASH,
    model: cardModel(r),
    intent: typeof r.intent === "string" && r.intent !== "" ? r.intent : null,
    branch: liveBranch(r, i.branches),
    ports,
    prompt: typeof r.last_prompt === "string" && r.last_prompt !== "" ? r.last_prompt : null,
  };
}
