import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { numEnv } from "./env.js";
import type { SessionRow } from "./aggregate.js";

/**
 * The reader-side, passive GSD phase-progress scanner + its pure helpers
 * (PANEL-08). A sibling to src/ports.ts, and just as passive and non-fatal by
 * construction: any subprocess or fs failure resolves to null / an empty set and
 * NEVER throws. This module touches no hook, no writer, no capture path — it only
 * spawns the read-only `gsd-tools query progress` shim and derives render data.
 *
 * Security boundary (T-04.2-01..04): scanProgress spawns via execFile with an
 * args ARRAY (no shell) under a bounded timeout + maxBuffer; resolveGsdTools
 * resolves the shim from an ordered list of ABSOLUTE candidate paths (never a
 * bare, attacker-plantable PATH name); every failure returns null and never
 * surfaces raw stderr or resolved paths to the caller.
 *
 * The render path is fs-free: buildFocusSet is PURE and consumes a pre-resolved
 * planningRoots set; the only `.planning/` existence probe lives in the async
 * resolvePlanningRoots, designed to run off the render tick on the phase-scan
 * cadence.
 */

const pexec = promisify(execFile);

/** One phase row from `gsd-tools query progress` (status is an opaque string). */
export interface Phase {
  number: string;
  name: string;
  plans: number;
  summaries: number;
  status: string;
}

/** The milestone-level progress snapshot the FAZLAR pane renders. */
export interface Progress {
  milestone_name: string;
  milestone_version: string;
  percent: number;
  phases: Phase[];
}

/** One switchable focused project: its root (--cwd target) + display name. */
export interface FocusEntry {
  root: string;
  name: string;
}

/**
 * Shared FAZLAR window size: the pane renders up to 15 phase rows before the
 * height-bounded scroll window kicks in — most roadmaps (8–15 phases) then show
 * in full, while larger roadmaps still window + show the ▲/▼ indicator. Imported
 * by PhasesPane (Plan 02) and App.tsx clamp math (Plan 03), which scale by
 * reference.
 */
export const FAZLAR_VISIBLE_ROWS = 15;

/**
 * The phase-scan cadence (config-adjustable via `CSM_PHASE_SCAN_MS`), read lazily
 * so tests can flip the env per-case. Deliberately slower than the port scan —
 * roadmap progress changes far less often than listening sockets do.
 */
export function phaseScanMs(): number {
  return numEnv("CSM_PHASE_SCAN_MS", 4000);
}

/**
 * Parse `gsd-tools query progress` stdout into a typed Progress, or null for
 * torn / empty / non-JSON output (self-heals on the next scan). A parsed object
 * without a `phases` array is rejected; milestone_name/version are coerced to
 * String and percent to a Number (0 on NaN).
 */
export function parseProgress(stdout: string): Progress | null {
  try {
    const o = JSON.parse(stdout);
    if (!Array.isArray(o?.phases)) return null;
    return {
      milestone_name: String(o.milestone_name ?? ""),
      milestone_version: String(o.milestone_version ?? ""),
      percent: Number(o.percent) || 0,
      phases: o.phases as Phase[],
    };
  } catch {
    return null; // torn/partial output self-heals next scan
  }
}

/** Opaque status strings shared with Card.tsx's private phaseComplete predicate. */
const COMPLETED_STATUS = "Complete";
const PENDING_STATUS = "Pending";

/**
 * Normalize a phase number for cross-source dedup: strip leading zeros PER
 * dot-segment while keeping at least one digit, so the zero-padded `query
 * progress` numbers ("01", "04.1") and the mixed `roadmap.analyze` numbers
 * ("1", "04.1", "5") compare as equals. "01"→"1", "04.1"→"4.1", "03.1"→"3.1",
 * "5"→"5"; idempotent on already-normalized input. Uses a per-segment regex (NOT
 * Number() coercion, which corrupts multi-segment numbers and non-numeric parts).
 */
export function normalizePhaseNumber(n: string): string {
  return String(n)
    .split(".")
    .map((seg) => seg.replace(/^0+(?=\d)/, ""))
    .join(".");
}

/**
 * The single reused completion predicate mirroring Card.tsx's private
 * phaseComplete: a phase is complete when its status is exactly the completed
 * status string, OR it has at least one plan and every plan has a summary. Reused
 * by mergeRoadmapPhases for the merged-percent math. (Card.tsx keeps its own
 * identical private copy — do NOT modify it.)
 */
export function phaseIsComplete(p: { status: string; plans: number; summaries: number }): boolean {
  return p.status === COMPLETED_STATUS || (p.plans > 0 && p.summaries >= p.plans);
}

/**
 * PURE, non-throwing merge of `roadmap.analyze` stdout into a dir-based Progress:
 * append any roadmap phase whose NORMALIZED number is absent from progress as a
 * neutral Pending row at the END (never reorder/mutate the existing rows), and
 * recompute percent over the merged list ONLY when >= 1 pending row is appended.
 * Any parse failure, a missing phases[] array, or nothing-to-append returns
 * `progress` UNCHANGED (original percent preserved) — the caller then renders the
 * dir-based table verbatim (T-04.2-04, self-heals next scan).
 */
export function mergeRoadmapPhases(progress: Progress, roadmapStdout: string): Progress {
  let parsed: unknown;
  try {
    parsed = JSON.parse(roadmapStdout);
  } catch {
    return progress; // non-JSON → unchanged
  }
  const roadmapPhases = (parsed as { phases?: unknown })?.phases;
  if (!Array.isArray(roadmapPhases)) return progress; // no phases[] → unchanged

  // Membership set of normalized progress numbers; grows as we append so two
  // roadmap entries normalizing to the same absent number cannot both append.
  const seen = new Set<string>(progress.phases.map((p) => normalizePhaseNumber(p.number)));
  const collected: Phase[] = [];
  for (const rp of roadmapPhases as Array<Record<string, unknown>>) {
    const norm = normalizePhaseNumber(String(rp.number));
    if (seen.has(norm)) continue;
    seen.add(norm);
    collected.push({
      number: String(rp.number),
      name: String(rp.name ?? ""),
      plans: Number(rp.plan_count) || 0,
      summaries: Number(rp.summary_count) || 0,
      status: PENDING_STATUS,
    });
  }

  if (collected.length === 0) return progress; // nothing absent → unchanged percent

  const merged = [...progress.phases, ...collected];
  const completed = merged.filter(phaseIsComplete).length;
  const total = merged.length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : progress.percent;
  return { ...progress, phases: merged, percent };
}

/**
 * Resolve the (not-on-PATH) `gsd-tools.cjs` shim from a controlled candidate
 * list (T-04.2-02). Honors the `CSM_GSD_TOOLS` absolute-path override first, then
 * prefers RUNTIME_DIR → cwd/.claude → $HOME/.claude, returning the first that
 * exists on disk. Returns null when none resolve — the caller then renders
 * "no roadmap". NEVER trusts a bare PATH name (attacker-plantable).
 */
export function resolveGsdTools(cwd: string = process.cwd()): string | null {
  const override = process.env.CSM_GSD_TOOLS;
  if (override && existsSync(override)) return override;

  const rel = path.join("gsd-core", "bin", "gsd-tools.cjs");
  const candidates: string[] = [];
  if (process.env.RUNTIME_DIR) candidates.push(path.join(process.env.RUNTIME_DIR, rel));
  candidates.push(path.join(cwd, ".claude", rel));
  candidates.push(path.join(os.homedir(), ".claude", rel));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Spawn `node <gsdTools> query progress --cwd <root>` passively and non-fatally,
 * then ADDITIVELY spawn `query roadmap.analyze` under the IDENTICAL guard and
 * merge any roadmap-only (no-directory) phase in as a Pending row.
 *
 * Contract:
 *  - execFile with cmd "node" + an args ARRAY (no shell) — T-04.2-01.
 *  - a per-call `{ timeout, maxBuffer }` guard — T-04.2-03.
 *  - the primary `progress` rejection (ENOENT / timeout / non-zero exit) resolves
 *    null — T-04.2-04; a null parse also early-returns null (no merge attempted).
 *  - the secondary `roadmap.analyze` spawn reuses the same execFile-array + bounded
 *    `{ timeout: 1500, maxBuffer: 1<<20 }` guard; ANY of its failures (reject /
 *    non-JSON / missing phases[]) is swallowed and the dir-based progress is
 *    returned UNCHANGED so the panel keeps the directory table (self-heals next
 *    scan) — T-04.2-04.
 *  - stderr / resolved paths are never surfaced; only a typed Progress or null.
 */
export async function scanProgress(root: string, gsdTools: string): Promise<Progress | null> {
  let progress: Progress | null;
  try {
    const { stdout } = await pexec("node", [gsdTools, "query", "progress", "--cwd", root], {
      timeout: 1500,
      maxBuffer: 1 << 20,
    });
    progress = parseProgress(stdout);
  } catch {
    return null; // ENOENT / timeout / non-zero → "no roadmap", never a crash
  }
  if (progress === null) return null; // torn/non-JSON primary → unchanged early-return

  try {
    const { stdout } = await pexec(
      "node",
      [gsdTools, "query", "roadmap.analyze", "--cwd", root],
      { timeout: 1500, maxBuffer: 1 << 20 },
    );
    return mergeRoadmapPhases(progress, stdout);
  } catch {
    return progress; // roadmap.analyze failure is non-fatal → dir-based table unchanged
  }
}

/**
 * Derive the switchable focused-project set from live sessions — PURE, with NO
 * filesystem IO (do NOT add existsSync/statSync here; that is the render path).
 *
 * Iterates rows in readAll order (most-recently-active first, aggregate.ts:392),
 * skipping any row that is not alive or has no string cwd, deduping by cwd, and
 * keeping only roots present in the pre-resolved `planningRoots` set (D-01). Input
 * order is preserved, so the first entry is the D-02 default focus.
 */
export function buildFocusSet(
  rows: SessionRow[],
  planningRoots: ReadonlySet<string>,
): FocusEntry[] {
  const seen = new Set<string>();
  const out: FocusEntry[] = [];
  for (const r of rows) {
    if (!r.alive || typeof r.cwd !== "string") continue; // live only (D-01)
    const root = r.cwd;
    if (seen.has(root)) continue; // dedup by root
    if (!planningRoots.has(root)) continue; // D-01: must contain .planning/
    seen.add(root);
    out.push({ root, name: r.folder });
  }
  return out;
}

/**
 * Resolve which live-with-cwd roots contain a `.planning/` dir — the ONLY place
 * `.planning/` existence is probed (D-01). Async and non-fatal per root: an
 * `access` rejection omits that root and never throws. Designed to run OFF the
 * render tick on the phase-scan cadence; buildFocusSet then consumes its result.
 */
export async function resolvePlanningRoots(rows: SessionRow[]): Promise<Set<string>> {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.alive || typeof r.cwd !== "string") continue;
    if (seen.has(r.cwd)) continue;
    seen.add(r.cwd);
    roots.push(r.cwd);
  }

  const out = new Set<string>();
  await Promise.all(
    roots.map(async (root) => {
      try {
        await access(path.join(root, ".planning"));
        out.add(root);
      } catch {
        // non-fatal: a root without .planning/ (or an unreadable one) is omitted
      }
    }),
  );
  return out;
}

/**
 * Clamp a proposed FAZLAR scroll offset to [0, total - visible] (D-04). When the
 * content fits (total <= visible) the max collapses to 0, so the offset pins to
 * the top.
 */
export function clampOffset(next: number, total: number, visible: number): number {
  return Math.min(Math.max(0, total - visible), Math.max(0, next));
}

/**
 * Wrap a focus index forward (+1) or back (-1) across `n` entries (D-06 Tab
 * cycle). An empty set (n === 0) pins to 0.
 */
export function cycleIndex(i: number, n: number, dir: 1 | -1): number {
  return n === 0 ? 0 : (i + dir + n) % n;
}
