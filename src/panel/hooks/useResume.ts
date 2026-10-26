import React from "react";
import type { SessionRow } from "../../aggregate.js";
import {
  discoverSessions,
  resumeScanMs,
  reconcileSelection,
  followOffset,
  RESUME_LIST_N,
  RESUME_VISIBLE_ROWS,
  readLiveRegistry,
  registryDirs,
  resumeExtras,
  type ResumeRow,
} from "../../sessions.js";
import { copyResume, openResume, type LaunchResult } from "../launch.js";
import {
  claimLaunch,
  settleLaunch,
  settleHolds,
  applyHolds,
  type LaunchHolds,
} from "../launch-hold.js";

/** How long a SUCCESSFUL copy/open result stays in the OTURUMLAR pane (D-15).
 * A failure message stays until the next action instead. */
const RESUME_FLASH_MS = 3000;

/** What the OTURUMLAR / SESSIONS pane reads from, and does through, the resume picker. */
export interface ResumeState {
  /**
   * The cached last-good resume rows with the D-16 launch holds overlaid (a held
   * id reads as live at once, D-11), or null until the first scan resolves. The
   * ids are those of the raw scan rows, so the cursor and offset apply as is.
   */
  rows: ResumeRow[] | null;
  /** The cursor, kept as a session id (D-17). */
  selId: string | null;
  /** The list scroll offset; it follows the cursor. */
  offset: number;
  /** The copy/open result line; `ok` mirrors the LaunchResult (D-15). */
  status: { text: string; ok: boolean } | null;
  /** A row is live when the last scan said so OR this panel holds it (D-16). */
  isLive(row: ResumeRow): boolean;
  /** Move the cursor by `delta` rows, clamped to the list; clears the status. */
  move(delta: number): void;
  /** Copy the selected row's resume line (Enter, D-15). */
  enter(): void;
  /** Open the selected row in a new terminal window or tab (`o`, D-15/D-16). */
  open(): void;
  /** Clear the result line and its flash timer. */
  clearStatus(): void;
}

/**
 * The resumable-sessions picker behind OTURUMLAR (Phase 8, RESUME-04) and the
 * v2 SESSIONS pane, moved verbatim out of App.tsx (Phase 10 plan 10-05, D-23).
 *
 * The list comes from a visibility-gated scan (D-19): one immediate
 * `discoverSessions` call when `visible` turns true, then a `resumeScanMs()`
 * interval that is cleared as soon as `visible` turns false or the caller
 * unmounts. The scan is async, overlap-guarded and never part of the 750ms
 * poll; its last-good rows stay cached across visibility changes. The cursor is
 * kept as a session id (D-17); `enter` copies and `open` opens the selected
 * session through launch.ts (D-15, D-16).
 *
 * D-16 launch hold (review CR-01, 08-07): `open` claims the session id
 * synchronously, before anything is awaited (launch-hold.ts). A held id is
 * treated as live, so a second `open` (or `enter`) on it copies and warns and
 * never starts a second `claude --resume` on the same transcript. Right before
 * launching, `open` also re-checks liveness from fresh sources (the CC registry
 * plus the current CSM store ids), because the scanned `live` flag can be one
 * scan interval old. Held rows read `live` at once through the applyHolds
 * overlay on `rows` (D-11). Only the claiming press's failed launch, or a later
 * scan (confirmation, or one started LAUNCH_HOLD_MS after the claim), releases
 * a hold.
 *
 * This hook never reads keys: the caller's keyboard component (LegacyApp's
 * PanelKeyboard, v2's V2Keyboard) stays the only input handler and calls
 * `move` / `enter` / `open` / `clearStatus`.
 */
export function useResume(liveRowsRef: React.RefObject<SessionRow[]>, visible: boolean): ResumeState {
  // ── OTURUMLAR (RIGHT pane, Phase 8) state ──────────────────────────────────
  // The cached last-good resume rows (null until the first scan resolves), the
  // cursor kept as a session id (D-17), the list scroll offset and the copy/open
  // result line. Which pane is visible stays with the caller (`visible`).
  const [resumeRows, setResumeRows] = React.useState<ResumeRow[] | null>(null);
  const [selId, setSelId] = React.useState<string | null>(null);
  const [resumeOffset, setResumeOffset] = React.useState(0);
  const [resumeStatus, setResumeStatus] = React.useState<{ text: string; ok: boolean } | null>(null);

  // Component-lifetime "mounted" flag so a late scan or launch result is dropped
  // only on a REAL unmount — NOT when the reconciler re-runs the (visibility-
  // keyed) scan effect or dev-double-invokes passive effects. A per-effect
  // `let alive` closure would be flipped false by that teardown and silently
  // swallow the first scan; this `[]`-scoped ref settles back true after any
  // remount, so the async result reaches the live component's stable setters.
  const mounted = React.useRef(false);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Overlap guard for the resume scan, plus refs holding the latest values so the
  // key handlers never act on a stale list (T-08-11) and quick successive keys
  // see each other's effect before React re-renders.
  const scanningResume = React.useRef(false);
  // Generation of the current OTURUMLAR visible period (D-19) and the tick of
  // the live scan effect, so a discarded scan can kick a fresh one at once.
  const resumeScanGen = React.useRef(0);
  const resumeTickRef = React.useRef<(() => void) | null>(null);
  const visibleRef = React.useRef(visible);
  visibleRef.current = visible;
  const resumeRowsRef = React.useRef(resumeRows);
  resumeRowsRef.current = resumeRows;
  const selIdRef = React.useRef(selId);
  selIdRef.current = selId;
  // Last known index of the selected row; only updated while the id is still
  // in the list, so reconcileSelection can fall back to the nearest row when
  // the selected session drops out (D-17).
  const selIdxRef = React.useRef(0);
  if (resumeRows !== null && selId !== null) {
    const i = resumeRows.findIndex((r) => r.id === selId);
    if (i >= 0) selIdxRef.current = i;
  }
  const resumeOffsetRef = React.useRef(resumeOffset);
  resumeOffsetRef.current = resumeOffset;
  // D-16 launch holds (launch-hold.ts): ids this panel is launching or has just
  // launched, keyed by session id, plus the per-press token counter. Kept in
  // refs so quick successive keys see each other's claim before React
  // re-renders; holdVersion only forces a re-render after a hold changes.
  const launchHolds = React.useRef<LaunchHolds>(new Map());
  const holdToken = React.useRef(0);
  const [, setHoldVersion] = React.useState(0);
  const bumpHolds = () => {
    if (mounted.current) setHoldVersion((v) => v + 1);
  };
  const flashTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = null;
    },
    [],
  );

  // Visibility-gated resume scan (D-19, RESUME-04): runs ONLY while OTURUMLAR is
  // visible — one immediate tick when `r` opens it, then a slow resumeScanMs()
  // interval; switching back to FAZLAR (or unmounting) clears the interval. It
  // is async and never part of the 750ms poll (T-08-12). liveIds are the
  // non-ended store rows' session ids, so a CSM-tracked live session is marked
  // live even without a registry entry (D-11); launch holds are never fed in.
  // A rejected scan keeps the last-good rows; rows are not reset on hide, so
  // reopening shows the cached list while the next scan runs.
  //
  // D-19 overlap rules (review WR-03, 08-07):
  // - The in-flight scan owns the overlap guard: only its own `finally` clears
  //   scanningResume, never the effect cleanup, so a quick r,r,r (show, hide,
  //   show) can never run two discoverSessions calls at once.
  // - Each visible period has a generation; the cleanup bumps it on hide or
  //   unmount. A scan's rows apply only when its generation is still current
  //   and the caller is mounted, so an older scan never overwrites fresher rows.
  // - When a discarded scan ends while OTURUMLAR is visible again, a fresh scan
  //   starts at once instead of waiting a full interval.
  // - Launch holds (D-16) are settled only from applied scans, using the time
  //   the scan started.
  React.useEffect(() => {
    if (!visible) return undefined;
    const gen = ++resumeScanGen.current;
    const tick = () => {
      if (scanningResume.current) return; // prior scan still running — no overlap
      scanningResume.current = true;
      const startedAt = Date.now();
      // liveIds come from the store only, never from launch holds: settleHolds
      // reads the scan's live flag as the confirmation that releases a hold.
      discoverSessions({
        n: RESUME_LIST_N,
        liveIds: new Set((liveRowsRef.current ?? []).map((r) => r.session_id)),
      })
        .then((rows) => {
          if (!mounted.current || gen !== resumeScanGen.current) return; // stale scan
          if (settleHolds(launchHolds.current, rows, startedAt)) bumpHolds();
          setResumeRows(rows);
        })
        .catch(() => {
          /* non-fatal: keep the last-good rows */
        })
        .finally(() => {
          scanningResume.current = false;
          // A discarded scan blocked the reopened pane's first tick: run it now.
          if (gen !== resumeScanGen.current && mounted.current) resumeTickRef.current?.();
        });
    };
    resumeTickRef.current = tick;
    tick();
    const t = setInterval(tick, resumeScanMs());
    return () => {
      clearInterval(t);
      // Discard results of scans started in this visible period from now on.
      // scanningResume is deliberately left alone: only the scan's finally
      // releases it.
      resumeScanGen.current += 1;
      if (resumeTickRef.current === tick) resumeTickRef.current = null;
    };
  }, [visible]);

  // Keep the cursor on the same session id when a scan reorders or drops rows,
  // falling back to the nearest row; the scroll offset follows the cursor (D-17).
  React.useEffect(() => {
    if (resumeRows === null) return;
    const r = reconcileSelection(resumeRows, selIdRef.current, selIdxRef.current);
    selIdRef.current = r.selId;
    if (r.idx >= 0) selIdxRef.current = r.idx;
    const off = followOffset(Math.max(0, r.idx), resumeOffsetRef.current, resumeRows.length, RESUME_VISIBLE_ROWS);
    resumeOffsetRef.current = off;
    setSelId(r.selId);
    setResumeOffset(off);
  }, [resumeRows]);

  const clearStatus = () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = null;
    setResumeStatus(null);
  };
  // Show a copy/open result in the pane: a success clears after RESUME_FLASH_MS,
  // a failure stays until the next action (D-15).
  const showResult = (r: LaunchResult) => {
    if (!mounted.current) return;
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = null;
    setResumeStatus({ text: r.message, ok: r.ok });
    if (r.ok) {
      flashTimer.current = setTimeout(() => {
        flashTimer.current = null;
        if (mounted.current) setResumeStatus(null);
      }, RESUME_FLASH_MS);
    }
  };
  // The selected OTURUMLAR row, read from the refs (never a stale closure).
  const selectedRow = (): ResumeRow | null => {
    if (!visibleRef.current) return null;
    const rows = resumeRowsRef.current;
    const id = selIdRef.current;
    if (rows === null || id === null) return null;
    return rows.find((r) => r.id === id) ?? null;
  };
  // A row counts as live when the last scan said so OR this panel holds it
  // (launching or just launched, D-16).
  const isLive = (row: ResumeRow): boolean => row.live || launchHolds.current.has(row.id);
  // quick-261014-fq8: bumped by every Enter and every `o`, so a still-pending
  // Enter whose extras resolve after a newer press never touches the clipboard.
  const enterSeq = React.useRef(0);

  // Move the cursor by `delta` rows: the caller passes one row (arrows) or one
  // window (PgUp/PgDn) times the direction.
  const move = (delta: number) => {
    const rows = resumeRowsRef.current;
    if (rows === null || rows.length === 0) return;
    const found = rows.findIndex((r) => r.id === selIdRef.current);
    const cur = found >= 0 ? found : Math.min(rows.length - 1, Math.max(0, selIdxRef.current));
    const next = Math.min(rows.length - 1, Math.max(0, cur + delta));
    const id = rows[next]!.id;
    const off = followOffset(next, resumeOffsetRef.current, rows.length, RESUME_VISIBLE_ROWS);
    selIdRef.current = id;
    selIdxRef.current = next;
    resumeOffsetRef.current = off;
    setSelId(id);
    setResumeOffset(off);
    clearStatus();
  };
  // Enter: copy the resume line for the selected row (D-15). The row's cwd is
  // passed so launch.ts can build the session-cwd form (D-10 REVISED), and the
  // live flag (scan OR launch hold, taken at press time) so launch.ts warns on
  // a live session (D-16). quick-261014-fq8: resumeExtras first resolves, on
  // demand, the session's unique safe `/rename` name (the line then resumes
  // by name) and whether it last ran in bypassPermissions (the line then ends
  // with --dangerously-skip-permissions and the status warns). A rejection
  // counts as no name and no bypass. A newer Enter or an `o` press supersedes
  // this one: its copy is dropped, so it can never overwrite the clipboard.
  const enter = () => {
    const row = selectedRow();
    if (row === null) return;
    const live = isLive(row);
    const seq = ++enterSeq.current;
    resumeExtras({ id: row.id, slug: row.slug, cwd: row.cwd })
      .catch(() => ({ bypass: false }) as { name?: string; bypass: boolean })
      .then((extras) => {
        if (seq !== enterSeq.current) return undefined;
        return copyResume({ id: row.id, cwd: row.cwd, live, name: extras.name, bypass: extras.bypass === true }).then(
          showResult,
        );
      })
      .catch(() => {});
  };
  // `o`: open the selected session in a new terminal window/tab. A live row is
  // never opened — launch.ts copies and warns instead (D-16, T-08-09). To keep
  // a double `o`, or an `o` during a pending launch, from starting a second
  // process (review CR-01), the id is claimed synchronously BEFORE anything is
  // awaited; a held id is treated as live. Liveness is then re-checked from
  // fresh sources (CC registry + current store ids), since the scanned flag can
  // be one scan interval old. Only this press's own failed launch (token-
  // checked) releases the claim; a success stays held until a scan settles it.
  const open = () => {
    const row = selectedRow();
    if (row === null) return;
    enterSeq.current++; // quick-261014-fq8: an `o` press drops a pending Enter
    // `row` is a const snapshot of an immutable scan row, so a later cursor
    // move cannot change what this in-flight press launches (T-08-11).
    const id = row.id;
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = null;
    setResumeStatus({ text: "opening…", ok: false });
    if (isLive(row)) {
      // Live or held: copy and warn only; no claim, and the result never
      // touches the holds.
      openResume({ id, cwd: row.cwd, live: true }).then(showResult, () => {});
      return;
    }
    const token = ++holdToken.current;
    claimLaunch(launchHolds.current, id, Date.now(), token);
    bumpHolds(); // the row shows `· live` at once (D-11)
    readLiveRegistry(registryDirs())
      .catch(() => new Set<string>())
      .then((registry) => {
        const fresh = new Set(registry);
        for (const r of liveRowsRef.current ?? []) fresh.add(r.session_id);
        return openResume({ id, cwd: row.cwd, live: fresh.has(id) });
      })
      .then(
        (r) => {
          settleLaunch(launchHolds.current, id, token, r.ok);
          bumpHolds();
          showResult(r);
        },
        () => {
          settleLaunch(launchHolds.current, id, token, false);
          bumpHolds();
        },
      );
  };

  // OTURUMLAR display rows: held ids read as live at once (D-11, D-16). Cursor,
  // scroll and selection stay on the RAW resumeRows; the ids are identical.
  const rows = applyHolds(resumeRows, launchHolds.current);

  return {
    rows,
    selId,
    offset: resumeOffset,
    status: resumeStatus,
    isLive,
    move,
    enter,
    open,
    clearStatus,
  };
}
