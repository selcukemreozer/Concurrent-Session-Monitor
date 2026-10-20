/**
 * The legacy (1.6.x) row models (Phase 9, plan 09-11; strangler S2).
 *
 *   - These pure helpers moved verbatim out of Card.tsx. Their values, strings
 *     and bodies are unchanged (D-23), including the Turkish PORTLAR headings.
 *   - Card.tsx re-exports every public symbol here, so existing imports keep
 *     working.
 *   - Phase 10's live ports pane may reuse the grouping helpers.
 */
import { sanitize } from "../../sanitize.js";
import { labelLead } from "../../label.js";
import type { SessionRow } from "../../aggregate.js";
import { livePidMap, attribute, type ScannedPort, type KillSignal } from "../../ports.js";
import { INTENT_GLYPH } from "./glyphs.js";

/**
 * Pure map from the computed liveness state to a steady dot color (D-11/D-12).
 * active -> green, idle -> yellow, stale -> grey. No blink, no animation; the
 * compute layer (aggregate.ts) already folded the SC-4 phantom guard into
 * `dotState`, so this is presentation-only.
 */
export function dotColor(dotState: SessionRow["dotState"]): "green" | "yellow" | "grey" {
  switch (dotState) {
    case "active":
      return "green";
    case "idle":
      return "yellow";
    default:
      return "grey";
  }
}

/**
 * Max port rows the PORTLAR pane renders before collapsing the remainder into a
 * single dim `+N more` (mirrors CONFLICT_CAP). Bounds the pane's height
 * regardless of how many listeners the machine has (D-06 shows all ports).
 */
export const PORTS_CAP = 12;

/** Heading for unattributed listeners started from a Warp terminal (260927-8ge D-01). */
export const WARP_HEADING = "Warp'ta başlattın";

/** Heading for every other unattributed listener (260927-8ge D-01). */
export const OTHER_HEADING = "Diğer";

/** One PORTLAR group: a heading and its ports in render order. */
export interface PortGroup {
  key: string;
  heading: string;
  ports: ScannedPort[];
}

/** The armed kill confirmation (260927-8ge D-05). */
export interface PortConfirm {
  port: number;
  pid: number;
  command: string;
  signal: KillSignal;
}

/**
 * Build a port-group heading reusing the `folder · branch · shortid` identity
 * convention (Card.tsx label()/shortId): each of the three parts is sanitized
 * SEPARATELY (empty branch collapses to the `—` dash), then — ONLY when a
 * non-empty intent is set — the sanitized intent is appended behind the same
 * `»` INTENT_GLYPH the card uses (D-04). When intent is absent the heading ends
 * at the shortId with NO trailing marker/placeholder (mirrors Card.tsx:143-150).
 *
 * Session label (NAME-02, D-08): the optional `title` makes the lead segment
 * labelLead({ title, folder }), so a named session's heading reads
 * `<name> · branch · shortid` (sanitized, 24-grapheme cap, D-09) while an
 * unnamed one keeps the exact folder heading, with no `(unnamed)` (D-07).
 */
function portHeading(
  folder: string,
  branch: string,
  session_id: string,
  intent?: string,
  title?: string,
): string {
  const b = sanitize(branch) || "—";
  const id = sanitize(String(session_id).slice(0, 8));
  const base = `${labelLead({ title, folder })} · ${b} · ${id}`;
  return typeof intent === "string" && intent.length > 0
    ? `${base} ${INTENT_GLYPH} ${sanitize(intent)}`
    : base;
}

/**
 * The single PORTLAR grouping implementation (260927-8ge D-01), shared by
 * PortsPane and App's cursor target resolution. Session groups come first
 * (render-time `livePidMap` + `attribute` join, stable insertion order, keyed by
 * session_id, intent-enriched heading), then unattributed ports split by origin:
 * `WARP_HEADING` for `origin === "warp"`, `OTHER_HEADING` for the rest. Empty
 * groups are omitted.
 */
export function groupPorts(ports: ScannedPort[], rows: SessionRow[]): PortGroup[] {
  const live = livePidMap(rows);
  const sessionGroups = new Map<string, PortGroup>();
  const warp: ScannedPort[] = [];
  const other: ScannedPort[] = [];
  for (const p of ports) {
    const row = attribute(p, live);
    if (row === null) {
      (p.origin === "warp" ? warp : other).push(p);
      continue;
    }
    let g = sessionGroups.get(row.session_id);
    if (!g) {
      g = {
        key: row.session_id,
        heading: portHeading(row.folder, row.branch, row.session_id, row.intent, row.title),
        ports: [],
      };
      sessionGroups.set(row.session_id, g);
    }
    g.ports.push(p);
  }
  const groups: PortGroup[] = [...sessionGroups.values()];
  if (warp.length > 0) groups.push({ key: " warp", heading: WARP_HEADING, ports: warp });
  if (other.length > 0) groups.push({ key: " other", heading: OTHER_HEADING, ports: other });
  return groups;
}

/** Flatten groups in order, stopping at PORTS_CAP — exactly the rows PortsPane shows. */
export function visiblePorts(groups: PortGroup[]): ScannedPort[] {
  const out: ScannedPort[] = [];
  for (const g of groups) {
    for (const p of g.ports) {
      if (out.length >= PORTS_CAP) return out;
      out.push(p);
    }
  }
  return out;
}

/**
 * Move the PORTLAR cursor (260927-8ge D-04): an empty list → null; a hidden
 * cursor (null) is revealed on row 0 by the first j or k; otherwise clamp into
 * 0..len-1.
 */
export function movePortCursor(cur: number | null, delta: 1 | -1, len: number): number | null {
  if (len <= 0) return null;
  if (cur === null) return 0;
  return Math.min(len - 1, Math.max(0, cur + delta));
}

/** The armed-kill prompt text; port, command and pid each sanitized (T-8ge-01). */
export function confirmPrompt(c: PortConfirm): string {
  const head = c.signal === "SIGKILL" ? "kill SIGKILL :" : "kill :";
  return `${head}${sanitize(String(c.port))} ${sanitize(c.command)} (pid ${sanitize(String(c.pid))})? y/n`;
}
