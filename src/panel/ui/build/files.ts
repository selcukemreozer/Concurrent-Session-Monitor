import type { SessionRow } from "../../../aggregate.js";
import type { Conflict } from "../../../conflicts.js";
import type { DisplayRow } from "../../hooks/useRoster.js";
import { labelLead } from "../../../label.js";
import type { FileConflict, FileEntry, FileGroup } from "../models.js";
import { cardState } from "./agents.js";

/**
 * The live FILES builder (Phase 10 plan 10-12; LAYOUT-03, LAYOUT-07,
 * LAYOUT-02, D-23).
 *
 *   - Conflict rows come from the roster's conflicts, in the roster's order
 *     (most-recently-active file first) and with the roster's session order
 *     inside each conflict (most-recently-touched first). draw/files.ts keeps
 *     them on top and never scrolls them away (LAYOUT-03).
 *   - RESEARCH open question 3 (3+ sessions on one file), resolved here: `a` is
 *     the first session, `b` the second, and `more` counts the rest. Nothing is
 *     glued onto the raw `b` string: the draw adds ` +N` inside the 21-cell
 *     name column so name truncation can never cut the count.
 *   - Groups: one per live session that has files, in the stable grid order
 *     (the PanelApp `orderRef` map; ids missing from it go last), writes then
 *     reads. Paths are shown relative to the session's own cwd when they lie
 *     under it (`displayPath`, string logic only).
 *   - Narrowing (LAYOUT-07): when `selectedId` is a live row id, only that
 *     session's group and the conflicts it is part of are returned and
 *     `narrowed` is true. A null, unknown or ended id shows everything.
 *   - D-05 scope: the aggregate / `/csm-status` order is untouched; this only
 *     orders the v2 FILES pane.
 *
 * Strings stay RAW except names, which `labelLead` makes display-safe; the
 * draw passes every name through nameText and every path through pathText
 * (T-10-30). Pure: no React, no I/O, never throws.
 */

/** `filePath` relative to `cwd` when it lies under it (the prefix must end at a separator), else raw. */
export function displayPath(filePath: string, cwd: string | undefined): string {
  if (typeof filePath !== "string") return "";
  if (typeof cwd !== "string" || cwd === "") return filePath;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (base === "/" || !filePath.startsWith(base)) return filePath;
  const rest = filePath.slice(base.length);
  return rest === "" ? filePath : rest;
}

export interface FilesBuild {
  conflicts: FileConflict[];
  groups: FileGroup[];
  narrowed: boolean;
}

function list(a: unknown): { file_path: string }[] {
  if (!Array.isArray(a)) return [];
  return a.filter((f): f is { file_path: string } => !!f && typeof f.file_path === "string");
}

function toConflict(c: Conflict): FileConflict | null {
  const ss = Array.isArray(c.sessions) ? c.sessions : [];
  if (ss.length < 2) return null;
  const s0 = ss[0]!;
  const s1 = ss[1]!;
  const out: FileConflict = {
    a: labelLead({ title: s0.title, folder: s0.folder }),
    b: labelLead({ title: s1.title, folder: s1.folder }),
    path: c.realpath,
  };
  if (ss.length > 2) out.more = ss.length - 2;
  return out;
}

export function buildFiles(i: {
  display: readonly DisplayRow[];
  conflicts: readonly Conflict[];
  order: ReadonlyMap<string, number>;
  selectedId: string | null;
}): FilesBuild {
  const rows: SessionRow[] = i.display.filter((d) => !d.ended).map((d) => d.row);
  const live = new Set(rows.map((r) => r.session_id));
  const sel = i.selectedId !== null && live.has(i.selectedId) ? i.selectedId : null;
  const narrowed = sel !== null;

  const conflicts: FileConflict[] = [];
  for (const c of i.conflicts) {
    if (narrowed && !(c.sessions ?? []).some((s) => s.session_id === sel)) continue;
    const fc = toConflict(c);
    if (fc) conflicts.push(fc);
  }

  // known seqs first, in seq order; the rest after them in display order
  const idx = new Map(rows.map((r, k) => [r.session_id, k]));
  const sorted = [...rows].sort((a, b) => {
    const sa = i.order.get(a.session_id);
    const sb = i.order.get(b.session_id);
    if (sa !== undefined && sb !== undefined) return sa - sb;
    if (sa !== undefined) return -1;
    if (sb !== undefined) return 1;
    return (idx.get(a.session_id) ?? 0) - (idx.get(b.session_id) ?? 0);
  });

  const groups: FileGroup[] = [];
  for (const r of sorted) {
    if (narrowed && r.session_id !== sel) continue;
    const files: FileEntry[] = [
      ...list(r.files).map((f) => ({ path: displayPath(f.file_path, r.cwd), kind: "write" as const })),
      ...list(r.reads).map((f) => ({ path: displayPath(f.file_path, r.cwd), kind: "read" as const })),
    ];
    if (files.length === 0) continue;
    groups.push({
      agentId: r.session_id,
      name: labelLead({ title: r.title, folder: r.folder }),
      state: cardState(r) ?? "idle",
      files,
    });
  }

  return { conflicts, groups, narrowed };
}
