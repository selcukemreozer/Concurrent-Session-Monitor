import React from "react";
import type { SessionRow } from "../../aggregate.js";
import {
  scanProgress,
  phaseScanMs,
  resolveGsdTools,
  resolvePlanningRoots,
  buildFocusSet,
  type FocusEntry,
  type Progress,
} from "../../phases.js";

/** What the FAZLAR / PHASES pane reads from the shared phase-progress scan. */
export interface PhasesState {
  /** The switchable projects: live rows whose cwd contains `.planning/` (D-01). */
  focusSet: FocusEntry[];
  /** The clamped index of the focused project inside `focusSet` (0 when empty). */
  idx: number;
  /** The focused project's root, or null when no project qualifies. */
  focusRoot: string | null;
  /** The cached progress of the focused project, or null until its scan lands. */
  focusProgress: Progress | null;
  /** Number of phases in `focusProgress` (0 when there is none). */
  totalPhases: number;
  /** Every cached per-root progress (last-good, kept across focus changes). */
  progress: ReadonlyMap<string, Progress>;
}

/**
 * Resolve the focus argument to an index inside `fs`. A number is the legacy
 * Tab index, taken modulo the set size (unchanged 04.2 behavior). A string is a
 * project root (v2, KEYS-05 identity): its position in the set, or 0 when that
 * root is not (or no longer) in the set.
 */
function focusIndex(fs: readonly FocusEntry[], focus: number | string): number {
  if (!fs.length) return 0;
  if (typeof focus === "number") return focus % fs.length;
  const i = fs.findIndex((e) => e.root === focus);
  return i >= 0 ? i : 0;
}

/**
 * The phase-progress scan behind FAZLAR (PANEL-07/08) and the v2 PHASES pane,
 * moved verbatim out of App.tsx (Phase 10 plan 10-05, D-23) so LegacyApp and
 * PanelApp read one data layer.
 *
 * `focus` is either the legacy Tab index (LegacyApp keeps `focusedIndex` and the
 * FAZLAR scroll offset itself) or a project root string (v2 picks the project by
 * identity, KEYS-05). The render path is pure and fs-free: `buildFocusSet` over
 * the pre-resolved `planningRoots`. The slow scan runs off the render tick at
 * `phaseScanMs()` cadence and re-runs when `focus` changes. This hook never
 * reads keys; the caller's keyboard component stays the only input handler.
 */
export function usePhases(
  liveRowsRef: React.RefObject<SessionRow[]>,
  focus: number | string,
): PhasesState {
  // ── FAZLAR (RIGHT pane) state ──────────────────────────────────────────────
  // Cached per-root Progress + the async-resolved planningRoots set (the ONLY
  // place `.planning/` existence is probed, off the render tick). The Tab focus
  // index and the FAZLAR scroll offset stay with the caller. `scanningPhases` is
  // the overlap guard; `shimRef` caches the resolved gsd-tools shim (resolved
  // once).
  const [progress, setProgress] = React.useState<Map<string, Progress>>(() => new Map());
  const [planningRoots, setPlanningRoots] = React.useState<Set<string>>(() => new Set());
  const scanningPhases = React.useRef(false);
  const shimRef = React.useRef<string | null | undefined>(undefined);
  if (shimRef.current === undefined) shimRef.current = resolveGsdTools();

  // Component-lifetime "mounted" flag so a late scan resolve is dropped only on a
  // REAL unmount — NOT when the reconciler re-runs the (focus-keyed) scan effect
  // or dev-double-invokes passive effects. A per-effect `let alive` closure would
  // be flipped false by that teardown and silently swallow the first scan; this
  // `[]`-scoped ref settles back true after any remount, so the async result
  // reaches the live component's stable state setters.
  const mounted = React.useRef(false);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // PURE, fs-free render-path derivation (D-01): the switchable focus set is just
  // buildFocusSet over the pre-resolved planningRoots — NO existsSync/statSync on
  // the Ink render tick. idx is the clamped focus; focusRoot the current root.
  // The caller assigns liveRowsRef.current during its render, before this call.
  const focusSet = buildFocusSet(liveRowsRef.current ?? [], planningRoots);
  const idx = focusIndex(focusSet, focus);
  const focusRoot = focusSet.length ? focusSet[idx]!.root : null;
  const focusProgress = focusRoot ? progress.get(focusRoot) ?? null : null;
  const totalPhases = focusProgress ? focusProgress.phases.length : 0;

  // Ref so the slow phase-scan interval reads the freshest focus without
  // re-arming every 750ms render (avoids stale closures, Pattern 1).
  const focusRef = React.useRef(focus);
  focusRef.current = focus;

  // SECOND, slower scan timer (PANEL-08) — a sibling of the port-scan effect,
  // NEVER inside the 750ms poll. Each non-overlapping tick FIRST resolves the
  // `.planning/` roots off the render tick (setPlanningRoots), THEN — using the
  // just-resolved roots so a fresh focus is scanned immediately — spawns
  // scanProgress for the focused project and caches it under its root. Always
  // non-fatal; re-runs on a focus change (dep on focus) so Tab surfaces the
  // newly-focused project's progress promptly. Cleared on unmount.
  React.useEffect(() => {
    const tick = () => {
      if (scanningPhases.current) return; // prior scan still running — no overlap
      scanningPhases.current = true;
      resolvePlanningRoots(liveRowsRef.current ?? [])
        .then((roots) => {
          if (!mounted.current) return undefined;
          setPlanningRoots(roots);
          const fs = buildFocusSet(liveRowsRef.current ?? [], roots);
          const i = focusIndex(fs, focusRef.current);
          const root = fs.length ? fs[i]!.root : null;
          const shim = shimRef.current;
          if (shim && root) {
            return scanProgress(root, shim).then((p) => {
              if (mounted.current && p) setProgress((prev) => new Map(prev).set(root, p));
            });
          }
          return undefined;
        })
        .catch(() => {
          /* non-fatal: a scan/probe failure just leaves the last-good cache */
        })
        .finally(() => {
          scanningPhases.current = false;
        });
    };
    tick(); // run once on mount so planningRoots populates near-immediately
    const t = setInterval(tick, phaseScanMs());
    return () => {
      // Release the overlap guard on teardown so a re-armed effect (focus change
      // or dev re-invoke) is never dead-locked by an in-flight scan's stale flag.
      scanningPhases.current = false;
      clearInterval(t);
    };
  }, [focus]);

  return { focusSet, idx, focusRoot, focusProgress, totalPhases, progress };
}
