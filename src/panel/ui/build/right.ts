import { phaseIsComplete, type FocusEntry, type Progress } from "../../../phases.js";
import { fmtAge, type ResumeRow } from "../../../sessions.js";
import type { PhaseEntry, Project, SessionEntry } from "../models.js";

/**
 * The live PHASES / SESSIONS builders (Phase 10 plan 10-14; D-23, KEYS-05).
 *
 *   - D-23: v2 reads the same data layer as the legacy panel. The projects come
 *     from the shared `usePhases` hook (focus set + cached per-root progress),
 *     the sessions from the shared `useResume` hook (rows + its `isLive`, which
 *     overlays the Phase 8 launch holds).
 *   - KEYS-05: a project's identity is its root. Every Project carries `root`
 *     so PanelApp cycles projects by root and a re-ordered scan never jumps to
 *     another project.
 *   - Naming mirrors 1.6.x (Card.tsx PhasesPane): the milestone name plus its
 *     version when present; the folder name (the FocusEntry name) when the
 *     project has no scan yet or no milestone name. `dir` is always the folder
 *     name. An unscanned project has no phases (drawn as `no roadmap`).
 *   - Phase status uses the shared `phaseIsComplete` predicate: complete phases
 *     are done, the first open phase is current, the rest pending.
 *   - Pure: no React, no clock (the caller passes `now`), no fs. Strings stay
 *     RAW; drawPhases / drawSessions make them cell-safe (T-10-36).
 */

/** The phases of one progress snapshot as PHASES timeline entries. */
export function phaseEntries(progress: Progress): PhaseEntry[] {
  let currentSeen = false;
  return progress.phases.map((p) => {
    const plans = Number(p.plans) || 0;
    const summaries = Number(p.summaries) || 0;
    let status: PhaseEntry["status"];
    if (phaseIsComplete({ status: p.status, plans, summaries })) status = "done";
    else if (!currentSeen) {
      status = "current";
      currentSeen = true;
    } else status = "pending";
    return {
      number: String(p.number),
      name: String(p.name),
      status,
      plansDone: summaries,
      plansTotal: plans > 0 ? plans : null,
    };
  });
}

/** The 1.6.x project title: milestone name + version, else the folder name. */
function projectName(focus: FocusEntry, progress: Progress | undefined): string {
  if (progress === undefined) return focus.name;
  const name = String(progress.milestone_name ?? "").trim();
  if (name === "") return focus.name;
  const version = String(progress.milestone_version ?? "").trim();
  return version === "" ? name : `${name} ${version}`;
}

/** One Project per focus-set entry, in focus-set order, keyed by root. */
export function buildProjects(
  focusSet: readonly FocusEntry[],
  progress: ReadonlyMap<string, Progress>,
): Project[] {
  return focusSet.map((f) => {
    const p = progress.get(f.root);
    return {
      root: f.root,
      name: projectName(f, p),
      dir: f.name,
      phases: p === undefined ? [] : phaseEntries(p),
    };
  });
}

/**
 * The phase the PHASES cursor rests on by default: the current phase, the last
 * phase when every phase is done, or null when the project has none.
 */
export function currentPhaseNumber(project: Pick<Project, "phases"> | undefined): string | null {
  if (project === undefined || project.phases.length === 0) return null;
  const cur = project.phases.find((p) => p.status === "current");
  return (cur ?? project.phases[project.phases.length - 1]!).number;
}

/** The resume rows as SESSIONS entries, in row order; null rows (first scan pending) → []. */
export function buildSessions(
  rows: readonly ResumeRow[] | null,
  isLive: (row: ResumeRow) => boolean,
  now: number,
): SessionEntry[] {
  if (rows === null) return [];
  return rows.map((r) => ({ id: r.id, name: r.label, ago: fmtAge(r.mtimeMs, now), live: isLive(r) }));
}
