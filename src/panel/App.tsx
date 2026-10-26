import React from "react";
import { Box, Text, useWindowSize, useInput, useStdin } from "ink";
import type { SessionRow } from "../aggregate.js";
import { sanitize } from "../sanitize.js";
import { labelLead } from "../label.js";
import {
  SessionCard,
  CompactRow,
  ConflictBand,
  PortsPane,
  PhasesPane,
  SessionsPane,
  FAZLAR_TOGGLE_HINT,
  SUBAGENT_COLOR,
} from "./Card.js";
import { RESUME_VISIBLE_ROWS } from "../sessions.js";
import { liveBranch } from "../branch.js";
import { clampOffset, cycleIndex, FAZLAR_VISIBLE_ROWS } from "../phases.js";
import { updateLabel, updateLabelFits } from "../update.js";
import { useRoster } from "./hooks/useRoster.js";
import { usePorts } from "./hooks/usePorts.js";
import { useBranches } from "./hooks/useBranches.js";
import { useUpdateCheck } from "./hooks/useUpdateCheck.js";
import { usePhases } from "./hooks/usePhases.js";
import { useResume } from "./hooks/useResume.js";

/** The title-row brand; also the width budget input for the update label. */
const BRAND = "◆ Concurrent Session Monitor";

/** Which pane the RIGHT bottom slot shows (Phase 8, D-14): `r` flips it on a TTY. */
type RightPane = "fazlar" | "oturumlar";

/**
 * Estimated vertical cost of one full `SessionCard` (round border top+bottom,
 * one header line, one file/"no files" line, plus the marginBottom). Used only
 * as a threshold to decide when the roster no longer fits and must collapse to
 * one-line `CompactRow`s (D-13) — a deliberate over-estimate so the switch trips
 * a little early rather than letting cards overflow the alternate screen.
 */
const CARD_LINES = 4;

/**
 * Vertical lines the borderless header box occupies: two content rows (the
 * title/clock line and the summary line) + its `marginBottom`. There is no
 * round border, so no top/bottom border rows are counted. Reserved from the
 * terminal height so the overflow-to-compact switch (D-13) still accounts for
 * the header's real height — it feeds `capacity = termRows - HEADER_LINES`.
 */
const HEADER_LINES = 3;

/**
 * Vertical lines the bottom two-column ports/extras shell reserves from the
 * roster capacity (Pitfall 4). Bounds the LEFT `PortsPane` — at most `PORTS_CAP`
 * (6) port rows + their group headings + the `marginTop` gap — so the ports
 * region can never grow enough to push the roster off the alternate screen.
 * Subtracted from `capacity` alongside `HEADER_LINES` so the overflow-to-compact
 * switch (D-13) accounts for the shell's real height.
 */
const PORTS_LINES = 10;

/** First 8 chars of the session id (D-05), sanitized (WR-04). */
function shortId(session_id: string): string {
  return sanitize(String(session_id).slice(0, 8));
}

/**
 * Live wall-clock stamp `YYYY-MM-DD HH:MM:SS` (local time) for the header band.
 * Recomputed on every render; since the ~750ms poll re-renders App each tick,
 * the clock advances on its own with no dedicated timer — this is what gives the
 * panel its "live" feel.
 */
function fmtClock(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * The live cross-session panel (PANEL-01, PANEL-03, PANEL-05).
 *
 * Data acquisition lives in shared hooks under `./hooks/` (Phase 9 plan 09-10,
 * strangler step S1), so LegacyApp and the v2 PanelApp read the same sources:
 * `useRoster` (the synchronous `readAll()` seed plus the ~750ms full re-read
 * through the grace-then-prune `reconcile` reducer), `usePorts` and
 * `useBranches` (the slower, overlap-guarded scans, once on mount then at their
 * env-gated cadences), and `useUpdateCheck`. All of them run on the shared
 * `usePoll` interval (or startUpdateCheck's own timers) and stop on unmount, so
 * the process exits cleanly.
 *
 * The FAZLAR phase scan and the OTURUMLAR resume picker live in the shared
 * `usePhases` (focus by Tab index here) and `useResume` (visible while the right
 * slot shows OTURUMLAR) hooks (Phase 10 plan 10-05, D-23), moved verbatim with
 * their closed race guards (the component-lifetime `mounted` refs, the D-19
 * visible-period generations, the D-16 launch holds and the T-08-11
 * stale-closure refs). App keeps the pane state, the Tab focus index, the FAZLAR
 * scroll offset and the only keyboard handler (`PanelKeyboard`).
 *
 * useRoster's `seen` Map (session_id -> { row, endedAt? }) drives D-05/D-06/D-08:
 * a dead or vanished session renders dim-grey as "ended" for the grace, then
 * `pruneSession(id)` runs exactly once (SC-3). A summary header reports live/idle
 * counts and a Phase-3 conflicts placeholder (D-15). When the roster would
 * overflow the terminal height, every row collapses to a one-line `CompactRow`
 * (D-13) via Ink's built-in `useWindowSize`.
 *
 * The RIGHT bottom slot holds the interactive FAZLAR pane (PANEL-07/08/09): a
 * SECOND, slower env-gated scan (`usePhases`, `phaseScanMs`) resolves
 * `.planning/` roots OFF the render tick and spawns `scanProgress` for the
 * focused project, while a TTY-guarded `useInput`
 * (`isActive: isRawModeSupported`) drives Tab/Shift+Tab project cycling and
 * arrow/PageUp/PageDown FAZLAR scrolling. Raw mode is entered ONLY when a TTY is
 * present, so Ink's default `exitOnCtrlC` cleanly unmounts the alt-screen on
 * Ctrl+C, reconciled with the launcher's idempotent SIGINT/SIGTERM handlers
 * (D-07); on a non-TTY the handler is inert and the pane degrades to static
 * (D-08). The render tick itself does ZERO filesystem IO — `buildFocusSet` is a
 * pure derivation over the pre-resolved `planningRoots` set.
 *
 * Phase 8 (RESUME-04): on a TTY `r` flips the right slot between FAZLAR (the
 * default) and OTURUMLAR, the resumable-sessions picker (D-14); each pane shows
 * a dim toggle hint, and on a non-TTY the slot stays FAZLAR with no hint. The
 * OTURUMLAR list comes from useResume's visibility-gated scan (D-19): one
 * immediate session discovery when the pane opens, then a `resumeScanMs()` interval
 * that is cleared as soon as FAZLAR returns or App unmounts. The scan is async,
 * overlap-guarded and never part of the 750ms poll; its last-good rows stay
 * cached across toggles. The cursor is kept as a session id (D-17), Enter copies
 * and `o` opens the selected session through launch.ts (D-15, D-16).
 *
 * D-16 launch hold (review CR-01, 08-07): `o` claims the session id
 * synchronously, before anything is awaited (launch-hold.ts). A held id is
 * treated as live, so a second `o` (or Enter) on it copies and warns and never
 * starts a second `claude --resume` on the same transcript. Right before
 * launching, `o` also re-checks liveness from fresh sources (the CC registry
 * plus the current CSM store ids), because the scanned `live` flag can be one
 * scan interval old. Held rows render `· live` at once through an applyHolds
 * overlay (D-11). Only the claiming press's failed launch, or a later scan
 * (confirmation, or one started LAUNCH_HOLD_MS after the claim), releases a hold.
 */
/**
 * The panel keyboard handler (PANEL-09, Phase 8 D-15), isolated into its own
 * component so `useInput` — which enters raw mode and takes over
 * `process.stdin` — is invoked ONLY when App mounts it, i.e. on a TTY (D-08).
 * Tab/Shift+Tab cycle the focused project; arrows move by one row and
 * PageUp/PageDown by a full window (FAZLAR scroll or the OTURUMLAR cursor);
 * Enter copies and `o` opens the selected OTURUMLAR session; `r` toggles the
 * right pane (D-14). `r` / `o` are ignored with Ctrl or Meta held. No other key
 * is bound — j/k/x/y/n/Esc stay free (quick task 260927-8ge) — and Ctrl+C is
 * left to Ink's default `exitOnCtrlC` (04.2 D-07, locked). Renders nothing.
 */
function PanelKeyboard({
  onCycle,
  onScroll,
  onToggle,
  onEnter,
  onOpen,
}: {
  onCycle: (dir: 1 | -1) => void;
  onScroll: (dir: 1 | -1, page: boolean) => void;
  onToggle: () => void;
  onEnter: () => void;
  onOpen: () => void;
}) {
  useInput((input, key) => {
    if (key.tab) onCycle(key.shift ? -1 : 1);
    else if (key.upArrow) onScroll(-1, false);
    else if (key.downArrow) onScroll(1, false);
    else if (key.pageUp) onScroll(-1, true);
    else if (key.pageDown) onScroll(1, true);
    else if (key.return) onEnter();
    else if (!key.ctrl && !key.meta && input === "r") onToggle();
    else if (!key.ctrl && !key.meta && input === "o") onOpen();
  });
  return null;
}

export function App() {
  const state = useRoster();

  // Live (non-grace) rows feed the PortsPane attribution join so ownership stays
  // fresh against the 750ms liveness — a grace-ghost never claims a port. The ref
  // lets the slow scans (useBranches, the phase and resume scans) read the
  // freshest live rows without re-arming every 750ms render (avoids stale
  // closures, Pattern 1). Declared before useBranches, which reads it.
  const liveRows = state.display.filter((d) => !d.ended).map((d) => d.row);
  const liveRowsRef = React.useRef(liveRows);
  liveRowsRef.current = liveRows;

  const ports = usePorts();
  const branches = useBranches(liveRowsRef);
  const updateTo = useUpdateCheck();

  const { rows: termRows, columns: termCols } = useWindowSize();
  const capacity = Math.max(1, termRows - HEADER_LINES - PORTS_LINES);
  const compact = state.display.length * CARD_LINES > capacity;

  // ── FAZLAR (RIGHT pane) state ──────────────────────────────────────────────
  // The phase-progress scan (cached per-root Progress, the async-resolved
  // planningRoots set, the overlap guard and the gsd-tools shim) lives in the
  // shared usePhases hook (Phase 10 plan 10-05, D-23). App keeps the Tab focus
  // index and the FAZLAR scroll offset; the hook resolves the focus by index.
  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const [scrollOffset, setScrollOffset] = React.useState(0);
  const ph = usePhases(liveRowsRef, focusedIndex);
  const { focusSet, idx, focusProgress, totalPhases } = ph;

  // Reset the FAZLAR scroll window to the top whenever the focused project
  // changes (D-04) — a fresh project always starts at its first phase.
  React.useEffect(() => {
    setScrollOffset(0);
  }, [idx]);

  // ── OTURUMLAR (RIGHT pane, Phase 8) state ──────────────────────────────────
  // Which pane the right slot shows (FAZLAR by default, D-14). The resume picker
  // itself (the visibility-gated scan with its generations and overlap guard,
  // the id-based cursor and offset, the D-16 launch holds, the flash timer, the
  // Enter sequence counter and the claim-before-await on `o`) lives in the
  // shared useResume hook (Phase 10 plan 10-05, D-23). rightPaneRef is updated
  // synchronously on `r`, so quick successive keys see the new pane before
  // React re-renders (T-08-11).
  const [rightPane, setRightPane] = React.useState<RightPane>("fazlar");
  const rightPaneRef = React.useRef(rightPane);
  rightPaneRef.current = rightPane;
  const resume = useResume(liveRowsRef, rightPane === "oturumlar");

  // Raw-mode is entered ONLY on a TTY (D-08, Pitfall 1). Rather than call
  // `useInput` with `{isActive:false}` on a non-TTY — which still makes Ink
  // reference/handle `process.stdin` and perturbs render/timer scheduling in a
  // piped run — the keyboard handler lives in a child (`PanelKeyboard`) that is
  // mounted ONLY when `isRawModeSupported`. On a non-TTY the child never mounts,
  // so `useInput` is never called and the panel degrades to a pure, inert render
  // that always shows FAZLAR (OTURUMLAR is unreachable and never scanned).
  const { isRawModeSupported } = useStdin();

  const onToggle = () => {
    const next: RightPane = rightPaneRef.current === "fazlar" ? "oturumlar" : "fazlar";
    rightPaneRef.current = next;
    setRightPane(next);
    resume.clearStatus();
  };
  // Tab cycles the FAZLAR project; it is a no-op while OTURUMLAR is visible.
  const onCycle = (dir: 1 | -1) => {
    if (rightPaneRef.current !== "fazlar") return;
    setFocusedIndex((i) => cycleIndex(i, focusSet.length, dir));
  };
  const onScroll = (dir: 1 | -1, page: boolean) => {
    if (rightPaneRef.current === "fazlar") {
      const delta = dir * (page ? FAZLAR_VISIBLE_ROWS : 1);
      setScrollOffset((o) => clampOffset(o + delta, totalPhases, FAZLAR_VISIBLE_ROWS));
      return;
    }
    // OTURUMLAR: move the cursor by one row (arrows) or one window (PgUp/PgDn).
    resume.move(dir * (page ? RESUME_VISIBLE_ROWS : 1));
  };
  // Enter copies and `o` opens the selected OTURUMLAR session (D-15, D-16);
  // both act only while OTURUMLAR is the visible pane.
  const onEnter = () => {
    if (rightPaneRef.current !== "oturumlar") return;
    resume.enter();
  };
  const onOpen = () => {
    if (rightPaneRef.current !== "oturumlar") return;
    resume.open();
  };

  const nConf = state.conflicts.length;
  const summaryLead = sanitize(`${state.live} live · ${state.idle} idle · `);
  const conflictLabel = sanitize(`${nConf} conflicts`);
  // "N waiting" / "N asking" needs-you counters (ATTN-03 D-01; 260926-vfm D-04):
  // count ONLY non-ended display rows (Pitfall 5) — an ended/grey row in its
  // prune grace must never inflate the count nor resurrect a pruned session.
  // Consumes the pre-gated d.row.asking / d.row.attention booleans; no
  // window/newer-than re-check here. Asking wins, so a row carrying both flags
  // is counted exactly once, under asking (the reader already guarantees this).
  const nAsking = state.display.filter((d) => !d.ended && d.row.asking).length;
  const nWaiting = state.display.filter(
    (d) => !d.ended && d.row.attention && !d.row.asking,
  ).length;
  const waitingLabel = sanitize(`${nWaiting} waiting`);
  const askingLabel = sanitize(`${nAsking} asking`);
  // "N subagent" counter (260927-73b D-05): same rules — non-ended display rows
  // only, consuming the pre-gated d.row.subagent (already false whenever asking
  // or waiting holds). Counts rows, not background agents.
  const nSubagent = state.display.filter((d) => !d.ended && d.row.subagent).length;
  const subagentLabel = sanitize(`${nSubagent} subagent`);
  const clock = sanitize(fmtClock(Date.now()));
  // Update label (261014-e2u): shown left of the clock only when brand + label +
  // " · " + clock fit on the one title line; otherwise dropped, never wrapped.
  const updLabel = updateLabel(updateTo);
  const showUpdate = updLabel !== null && updateLabelFits(termCols, BRAND, updLabel, clock);
  // OTURUMLAR display rows: held ids read as live at once (D-11, D-16); the
  // hook applies the launch-hold overlay. Cursor, scroll and selection stay on
  // the raw scan rows; the ids are identical.
  const shownRows = resume.rows;

  // Merge the live-derived branch into each roster row (D-LB-03): App overrides
  // the `branch` field so SessionCard's `s.branch` display AND its 260914-507
  // target-mismatch flag (which compares target_branch vs s.branch) both operate
  // on the LIVE checkout automatically — Card.tsx is intentionally unchanged. Falls
  // back to the session-start snapshot until/unless the scan resolves (liveBranch).
  // Identity-preserving: an unchanged branch returns the same row reference. NOTE:
  // PortsPane/ConflictBand stay on the snapshot row — live-branch merge is scoped
  // to the roster display here and out of scope for those panes.
  const withLiveBranch = (row: SessionRow): SessionRow => {
    const b = liveBranch(row, branches);
    return b === row.branch ? row : { ...row, branch: b };
  };

  return (
    <Box flexDirection="column">
      {isRawModeSupported ? (
        <PanelKeyboard
          onCycle={onCycle}
          onScroll={onScroll}
          onToggle={onToggle}
          onEnter={onEnter}
          onOpen={onOpen}
        />
      ) : null}
      <Box
        flexDirection="column"
        paddingX={1}
        marginBottom={1}
        width={termCols}
      >
        <Box justifyContent="space-between">
          <Text bold color="green">
            {BRAND}
          </Text>
          {showUpdate ? (
            <Text dimColor>
              <Text bold dimColor>
                {updLabel}
              </Text>
              {" · "}
              {clock}
            </Text>
          ) : (
            <Text dimColor>{clock}</Text>
          )}
        </Box>
        <Text>
          {summaryLead}
          <Text color={nConf > 0 ? "red" : undefined} bold={nConf > 0}>
            {conflictLabel}
          </Text>
          {" · "}
          <Text color={nWaiting > 0 ? "yellowBright" : undefined} bold={nWaiting > 0}>
            {waitingLabel}
          </Text>
          {" · "}
          <Text color={nAsking > 0 ? "magenta" : undefined} bold={nAsking > 0}>
            {askingLabel}
          </Text>
          {" · "}
          <Text color={nSubagent > 0 ? SUBAGENT_COLOR : undefined} bold={nSubagent > 0}>
            {subagentLabel}
          </Text>
        </Text>
      </Box>
      <ConflictBand conflicts={state.conflicts} />
      {state.display.map((d) =>
        d.ended ? (
          <Text key={d.id} dimColor color="grey">
            {/* NAME-02 / D-08: the fading row keeps the native name (labelLead:
                sanitized, 24-grapheme cap) so it never flips to the folder; an
                unnamed row keeps the folder lead, no (unnamed). */}
            {`● ${labelLead(d.row)} · ${shortId(d.id)} · ended`}
          </Text>
        ) : compact ? (
          <CompactRow key={d.id} s={withLiveBranch(d.row)} />
        ) : (
          <SessionCard key={d.id} s={withLiveBranch(d.row)} />
        ),
      )}
      <Box flexDirection="row" width={termCols} marginTop={1}>
        <Box flexDirection="column" flexBasis="50%" flexGrow={1} flexShrink={1} paddingX={1}>
          <PortsPane ports={ports} rows={liveRows} />
        </Box>
        <Box flexDirection="column" flexBasis="50%" flexGrow={1} flexShrink={1} paddingX={1}>
          {/* RIGHT — FAZLAR (the Tab-focused project's GSD phase progress, 04.2)
              by default; `r` swaps in OTURUMLAR, the resume picker (D-14). */}
          {rightPane === "oturumlar" ? (
            <SessionsPane
              rows={shownRows}
              cursorId={resume.selId}
              scrollOffset={resume.offset}
              status={resume.status?.text ?? null}
              now={Date.now()}
            />
          ) : (
            <PhasesPane
              focus={focusSet.length ? focusSet[idx] : null}
              index={idx}
              count={focusSet.length}
              progress={focusProgress}
              scrollOffset={scrollOffset}
              interactive={isRawModeSupported}
              paneHint={isRawModeSupported ? FAZLAR_TOGGLE_HINT : null}
            />
          )}
        </Box>
      </Box>
    </Box>
  );
}
