import React from "react";
import { Box, useApp, useInput, useStdin, useWindowSize } from "ink";
import { useRoster } from "./hooks/useRoster.js";
import { useUpdateCheck } from "./hooks/useUpdateCheck.js";
import { useUiTick, UI_TICK_MS } from "./hooks/useUiTick.js";
import { useResizeRepaint } from "./hooks/useResizeRepaint.js";
import { useBranches } from "./hooks/useBranches.js";
import { usePorts } from "./hooks/usePorts.js";
import { usePhases } from "./hooks/usePhases.js";
import { useResume } from "./hooks/useResume.js";
import { headerFromRoster } from "./ui/headerModel.js";
import {
  effectiveUi,
  flashVisible,
  initialUi,
  selectionExpired,
  uiReducer,
  type Action,
  type UiState,
} from "./ui/uiState.js";
import { contextOf, isIntent, resolve, type HintContext, type Intent, type KeyInput } from "./ui/keymap.js";
import { drawShellFrame, EMPTY_SCROLL, type SampleFlags, type ScrollState } from "./ui/draw/shell.js";
import { tickerRows } from "./ui/draw/files.js";
import { visiblePortEntries } from "./ui/draw/ports.js";
import { ScreenView } from "./ui/ScreenView.js";
import { buildAgents, stableOrder } from "./ui/build/agents.js";
import { buildDetail } from "./ui/build/detail.js";
import { buildFiles } from "./ui/build/files.js";
import { buildProjects, buildSessions, currentPhaseNumber } from "./ui/build/right.js";
import { buildPorts } from "./ui/build/ports.js";
import { cycleId, gridItems, moveGrid, moveList, pageGrid } from "./ui/nav.js";
import { geometry } from "./ui/geometry.js";
import { defaultGotoDeps, runGoto, type GotoDeps } from "./actions/goto.js";
import type { SessionRow } from "../aggregate.js";
import type {
  AgentCard,
  DetailModel,
  FileConflict,
  FileGroup,
  Flash,
  IdleStrip,
  PanesModel,
  PortEntry,
  Project,
  SessionEntry,
} from "./ui/models.js";

/**
 * The v2 panel root behind `CSM_UI=v2` (Phase 9, plan 09-12). Plan 09-13 wires
 * it into Root; until then nothing in the bundle imports it.
 *
 *   - D-20: the header is LIVE (the shared useRoster / useUpdateCheck hooks:
 *     real agent count, asking / waiting / conflict chips, clock, update
 *     notice), while every pane draws the SAMPLE fixture under the ` sample `
 *     chip. Phase 10 replaces SAMPLE pane by pane.
 *   - KEYS-01: exactly one input dispatcher, `V2Keyboard` (one useInput). It
 *     routes every key through the keymap table into the pure uiReducer and
 *     never uses Ink's focus manager.
 *   - D-21 / 04.2 D-08: on a non-TTY stdin the keyboard child is never
 *     mounted (no raw mode, no handler); the shell still renders and the
 *     footer shows `⌨ keys off — started without a TTY`.
 *   - D-24: `q` calls Ink's own `useApp().exit()`, the same handleExit path as
 *     Ctrl+C (raw mode off, cursor shown, waitUntilExit resolves), so entry.ts
 *     runs unregisterPanel and cleanupWarpTabConfig after waitUntilExit
 *     exactly as for Ctrl+C. Components never call process.exit.
 *   - Motion: one animation clock (useUiTick) drives the spinners and the
 *     FILES ticker; it runs only while something animates.
 *   - RESEARCH Open Question 3: `incrementalRendering` is NOT enabled up
 *     front; plan 09-15 enables it for v2 only if the live Warp check shows
 *     flicker.
 *   - Phase 9 PanelApp never opens a URL, kills a process, copies to the
 *     clipboard or launches anything: every P10–P12 key resolves to a noop.
 *
 * Phase 10 plan 10-08 (KEYS-01..03, D-09, D-12, D-23, LAYOUT-02):
 *   - One intent dispatcher behind the single V2Keyboard (`onKey`): every key
 *     first records `keyAt(now())`, then resolves against
 *     `effectiveUi(uiRef.current, view ids)`, so a vanished selection never
 *     routes as `agentsSelected` (Pitfall 4). `quit` exits, an intent goes to
 *     `onIntent(intent, ctx)` (per-context cases filled by later plans; all
 *     no-ops here, so SAMPLE panes never trigger anything, T-10-19), every
 *     other action goes to the reducer.
 *   - `viewRef` holds the per-render view facts the dispatcher reads (the
 *     drawn agent ids for now); `scrollRef` holds the ScrollState returned by
 *     drawShellFrame and feeds it back on the next draw (sticky windows, no
 *     state, no extra render).
 *   - The footer flash slot shows a flash for FLASH_MS (2500 ms) on the
 *     injected clock; an agent selection drops after SELECTION_IDLE_MS (15 s)
 *     without a key. The UI tick runs while either is pending, so both expire
 *     on time without a key press.
 *   - The draw and the footer hints use `effectiveUi`, so a selection that no
 *     longer resolves never shows `⏎ go to pane` (KEYS-03).
 *
 * Phase 10 plan 10-09 (LAYOUT-07, KEYS-02, D-05, D-06, D-08, D-16):
 *   - The AGENTS pane is LIVE: `buildAgents` turns the roster into cards and
 *     idle strips in the first-seen start order kept in `orderRef`
 *     (`stableOrder`), so a re-sorted readAll or a `/compact` never moves a
 *     card under the cursor (T-10-21). Its ` sample ` chip is gone; the other
 *     panes keep SAMPLE until their plans.
 *   - `move` / `page` intents in AGENTS select by identity over the cards and
 *     strips (nav.ts moveGrid / pageGrid); Enter (go-to) is wired by 10-10.
 *   - A selection whose session leaves the roster is cleared (fails closed).
 *
 * Phase 10 plan 10-10 (GOTO-01, GOTO-04, GOTO-05, D-09, D-12, D-13):
 *   - Enter on a selected card or idle strip runs the ONE go-to action
 *     (`./actions/goto.js` runGoto): an Enter-time liveness and ancestry
 *     probe, the strict URL check, then `open` with an args array. Its
 *     result is a footer flash (`focusing <name>` or one plain reason).
 *   - One go-to at a time (`gotoInFlight`); the probes are async, so the
 *     render path never waits on them. A flash after unmount is dropped.
 *   - The selection keeps the normal 15 s idle rule after a go-to (D-09).
 *   - Tests inject `gotoDeps`; production builds `defaultGotoDeps()` once.
 *
 * Phase 10 plan 10-11 (LAYOUT-07, 09 D-12, D-06, D-11, D-17):
 *   - While a card or idle strip is selected (the effective selection, so a
 *     vanished one never shows), `panes.detail` is built from its live row by
 *     `buildDetail`: intent, live branch, the ports it owns (the cached
 *     `usePorts` scan joined through `attribute(livePidMap)`), uptime, model
 *     and the full last prompt. The shell draws it between the grid and
 *     FILES. It carries no go-to reachability marker (D-11).
 *   - usePorts is the slow second timer (lsof/ps off the render path); the
 *     PORTS pane itself still draws SAMPLE until 10-15.
 *
 * Phase 10 plan 10-12 (LAYOUT-07, LAYOUT-03, LAYOUT-02, D-23):
 *   - The FILES pane is LIVE: `buildFiles` turns the roster's conflicts and
 *     each live session's writes and reads into conflict rows and groups, in
 *     the same stable order as the grid (`orderRef`). Its ` sample ` chip is
 *     gone.
 *   - While a card or idle strip is selected (the effective selection, as for
 *     the detail strip) FILES narrows to it (`panes.filesNarrowed`): its
 *     group and conflicts only, the ticker stopped. Esc or the 15 s idle drop
 *     clears the selection and every session shows again.
 *
 * Phase 10 plan 10-14 (KEYS-05, KEYS-02, KEYS-03, LAYOUT-02, D-16, D-23):
 *   - The right column is LIVE through the hooks LegacyApp shares (D-23):
 *     PHASES from `usePhases` (the focus set + cached progress, built by
 *     `buildProjects`), SESSIONS from `useResume` (its rows, cursor and
 *     copy/open status, built by `buildSessions`). Their ` sample ` chips are
 *     gone.
 *   - KEYS-05: the shown project is chosen by its root. `←`/`→` on PHASES cycle
 *     the roots (wrapping) into `setProject`; Tab only moves focus. Before any
 *     `←`/`→` the last shown root is kept (`shownRootRef`), so a re-ordered
 *     focus set never swaps the project on screen.
 *   - KEYS-02: the PHASES cursor is a phase number (`setPhaseCursor`); `↑`/`↓`
 *     move it by one phase and PgUp/PgDn by the drawn window. A project change
 *     clears it, so the cursor falls back to the current phase.
 *   - SESSIONS: `↑`/`↓` and PgUp/PgDn move the hook's id cursor, Enter copies
 *     the resume line and `o` opens a new window. Both go only through
 *     `useResume` (every Phase 8 guard: claim-before-await, enterSeq, registry
 *     re-check, launch.ts cwd validation; T-10-34); PanelApp imports no
 *     launcher. Switching the right tab clears the copy/open status (legacy
 *     onToggle parity).
 *
 * Phase 10 plan 10-15 (KEYS-02, KEYS-03, LAYOUT-01, LAYOUT-02, D-23):
 *   - PORTS is LIVE: `buildPorts` joins the cached `usePorts` scan with the
 *     live rows (owner names through livePidMap / attribute). Its ` sample `
 *     chip is gone, so every v2 pane now runs on live data.
 *   - KEYS-02: the PORTS cursor is a portKey (`setPortCursor`). `↑`/`↓` move it
 *     by one shown port and PgUp/PgDn by the drawn window; a null cursor
 *     starts from the first shown port (where the draw puts `❯`).
 *   - Fail closed (RESEARCH open question 4; T-10-37): when a scan no longer
 *     lists the selected port, PanelApp leaves the stale key alone. It is not
 *     cleared (that would put `❯` on the first port) nor moved to the nearest
 *     port, so no `❯` is drawn; the next arrow goes through `moveList`, whose
 *     unknown-current rule selects the first shown port. Phase 11 acts on the
 *     port under the cursor, so it must never jump on its own.
 *   - Enter on a port stays the Phase 11 noop; PanelApp imports no scanner or
 *     kill backend (T-10-39), and the footer hides `⏎ actions` (KEYS-03).
 *
 * Phase 10 plan 10-16 (D-23, LAYOUT-01..04):
 *   - PanelApp no longer imports the sample fixture: `panes` is a PanesModel
 *     built field by field from the live builders, and every sample flag is
 *     false. sample.ts stays a test fixture. live-sweep.test.ts proves the
 *     same builders at realistic volume.
 */
export interface PanelAppProps {
  tickMs?: number;
  now?: () => number;
  /** Tests only: merged over `initialUi` once at mount. */
  initialUi?: Partial<UiState>;
  /** Tests only: observes every intent the dispatcher routes, with its context. */
  intentSpy?: (intent: Intent, ctx: HintContext) => void;
  /** Tests only: the go-to probes and opener (production: defaultGotoDeps()). */
  gotoDeps?: GotoDeps;
}

/** The view facts the dispatcher resolves keys against (10-08; later plans add ports, phases, sessions). */
interface ViewFacts {
  /** Every selectable AGENTS id: cards + idle strips. */
  agentIds: ReadonlySet<string>;
  /** The card ids and strip ids in drawn order (10-09). */
  cardIds: readonly string[];
  stripIds: readonly string[];
  /** The grid's card columns at this size (10-09). */
  cols: number;
  /** The live rows by session id (10-09; go-to and detail lookups). */
  byId: ReadonlyMap<string, SessionRow>;
  /** The raw card / strip names by session id (10-10; the go-to flash). */
  nameById: ReadonlyMap<string, string>;
  /** The shown project's phase numbers in timeline order (10-14). */
  phaseNumbers: readonly string[];
  /** The shown project's current phase number (the default PHASES cursor; 10-14). */
  currentPhase: string | null;
  /** The project roots in focus-set order (10-14, KEYS-05). */
  roots: readonly string[];
  /** The index of the shown project in `roots` (10-14). */
  projectIdx: number;
  /** The focused PORTS list's portKeys in drawn order (10-15, KEYS-02). */
  portKeys: readonly string[];
}

/**
 * Each flag turns false when its pane goes live (D-23); AGENTS from 10-09,
 * FILES from 10-12, PHASES and SESSIONS from 10-14, PORTS from 10-15: every
 * pane is live.
 */
const SAMPLE_FLAGS: SampleFlags = { agents: false, files: false, phases: false, sessions: false, ports: false };

/** A redraw key over every drawn PORTS field (10-15). */
function portsKey(ports: readonly PortEntry[]): string {
  return ports
    .map((p) => [p.key, p.port, p.proc, p.pid, p.exposed ? 1 : 0, p.owner ?? "\u0000"].join("\u001f"))
    .join("\u001e");
}

/** A redraw key over every drawn PHASES field (10-14). */
function phasesKey(projects: readonly Project[], idx: number): string {
  const p = projects.map((x) =>
    [
      x.root ?? "",
      x.name,
      x.dir,
      x.phases.map((e) => [e.number, e.name, e.status, e.plansDone ?? "", e.plansTotal ?? ""].join("\u001f")).join("\u001e"),
    ].join("\u001d"),
  );
  return `${idx}\u001b${p.join("\u001a")}`;
}

/** A redraw key over every drawn SESSIONS field (10-14). */
function sessionsKey(
  sessions: readonly SessionEntry[],
  status: Flash | null,
  cursor: string | null,
  scanning: boolean,
): string {
  const s = sessions.map((x) => [x.id, x.name, x.ago, x.live ? 1 : 0].join("\u001f"));
  const st = status === null ? "" : `${status.ok ? 1 : 0}|${status.text}`;
  return [s.join("\u001e"), st, cursor ?? "", scanning ? 1 : 0].join("\u001d");
}

/** A redraw key over every drawn detail-strip field (10-11). */
function detailKey(d: DetailModel | null): string {
  if (d === null) return "";
  return [
    d.id,
    d.name,
    d.state,
    d.uptime,
    d.model ?? "",
    d.intent ?? "",
    d.branch,
    d.ports.map((p) => `${p.port}:${p.proc}`).join(","),
    d.prompt ?? "",
  ].join("\u001f");
}

/** A redraw key over every drawn FILES field (10-12). */
function filesKey(conflicts: readonly FileConflict[], groups: readonly FileGroup[], narrowed: boolean): string {
  const c = conflicts.map((x) => [x.a, x.b, x.more ?? 0, x.path].join("\u001f"));
  const g = groups.map((x) =>
    [x.agentId, x.name, x.state, x.files.map((f) => `${f.kind[0]}${f.path}`).join("\u001f")].join("\u001f"),
  );
  return `${narrowed ? 1 : 0}\u001d${c.join("\u001e")}\u001d${g.join("\u001e")}`;
}

/** A redraw key over every drawn card / strip field, so a live change redraws. */
function agentsKey(agents: readonly AgentCard[], idle: readonly IdleStrip[]): string {
  const c = agents.map((a) =>
    [
      a.id,
      a.state,
      a.name,
      a.dir,
      a.branch,
      a.uptime,
      a.model ?? "",
      a.prompt ?? "",
      a.waitFor ?? "",
      a.subagents,
      a.conflicts,
      a.writes,
      a.reads,
      a.inConflict ? 1 : 0,
    ].join("\u001f"),
  );
  const i = idle.map((s) => [s.id, s.name, s.ago].join("\u001f"));
  return `${c.join("\u001e")}\u001d${i.join("\u001e")}`;
}

/** Rows the FILES ticker shows before it starts scrolling. */
const TICKER_VISIBLE = 6;

export function PanelApp(props: PanelAppProps = {}): React.ReactElement {
  const tickMs = props.tickMs ?? UI_TICK_MS;
  const now = props.now ?? Date.now;

  const roster = useRoster();
  const updateTo = useUpdateCheck();
  const { rows, columns } = useWindowSize();
  // LAYOUT-05 / D-01: on every resize, an absolute clear + repaint through
  // Ink at once and again 150 ms after the last event. useWindowSize already
  // re-renders the shell at the new size; this only resets Ink's frame
  // bookkeeping so no ghost header survives Warp's reflow. v2 only (D-04).
  useResizeRepaint();
  const { isRawModeSupported } = useStdin();
  const { exit } = useApp();

  // The ref is assigned before the state so quick successive keys each see the
  // previous key's effect (the T-08-11 stale-closure pattern).
  const [start] = React.useState<UiState>(() => ({ ...initialUi, ...props.initialUi }));
  const uiRef = React.useRef<UiState>(start);
  const [ui, setUi] = React.useState<UiState>(start);
  const apply = React.useCallback((action: Action) => {
    const next = uiReducer(uiRef.current, action);
    if (next === uiRef.current) return;
    uiRef.current = next;
    setUi(next);
  }, []);

  // 10-09: the live AGENTS pane. liveRowsRef lets the slow branch scan read
  // the freshest live rows without re-arming (the App.tsx pattern).
  const liveRows = roster.display.filter((d) => !d.ended).map((d) => d.row);
  const liveRowsRef = React.useRef<SessionRow[]>(liveRows);
  liveRowsRef.current = liveRows;
  const branches = useBranches(liveRowsRef);
  // 10-11: the cached last-good port scan, for the detail strip's owned ports
  // and (10-15) the live PORTS pane
  const scanned = usePorts();
  // D-05: the first-seen start order survives re-sorts and compacts (Pitfall 2)
  const orderRef = React.useRef<Map<string, number>>(new Map());
  orderRef.current = stableOrder(orderRef.current, liveRows);
  const ag = buildAgents({
    display: roster.display,
    conflicts: roster.conflicts,
    branches,
    order: orderRef.current,
    now: now(),
  });
  // 10-11 (D-12, D-06): the detail strip of the live selection (a card or a strip)
  const selRow = ui.selectedAgentId === null ? undefined : ag.byId.get(ui.selectedAgentId);
  const detail: DetailModel | null =
    selRow === undefined ? null : buildDetail({ row: selRow, branches, ports: scanned, liveRows, now: now() });
  // 10-12 (LAYOUT-07): FILES, narrowed to the same live selection as the strip
  const files = buildFiles({
    display: roster.display,
    conflicts: roster.conflicts,
    order: orderRef.current,
    selectedId: selRow === undefined ? null : selRow.session_id,
  });
  // 10-14 (D-23, KEYS-05): PHASES from the shared phase scan, the project by
  // root. Until ←/→ picks a root, the last shown root is kept, so a re-ordered
  // focus set never swaps the project on screen (an unknown root falls back to
  // the first project inside usePhases).
  const shownRootRef = React.useRef<string | null>(null);
  const ph = usePhases(liveRowsRef, ui.projectRoot ?? shownRootRef.current ?? "");
  shownRootRef.current = ph.focusRoot;
  const projects = buildProjects(ph.focusSet, ph.progress);
  // 10-14 (D-23): SESSIONS from the shared resume picker; its scan runs only
  // while the SESSIONS tab is shown (08 D-19).
  const resume = useResume(liveRowsRef, ui.rightTab === "sessions");
  const sessions = buildSessions(resume.rows, resume.isLive, now());
  const sessionsScanning = resume.rows === null;
  // 10-15 (D-23, KEYS-02): PORTS from the same scan, identity-keyed by portKey
  const ports = buildPorts(scanned, liveRows);
  // 10-16 (D-23): every field comes from a live builder; SAMPLE stays a test fixture
  const panes: PanesModel = {
    agents: ag.agents,
    idle: ag.idle,
    detail,
    conflicts: files.conflicts,
    groups: files.groups,
    filesNarrowed: files.narrowed,
    projects,
    projectIndex: ph.idx,
    sessions,
    sessionStatus: resume.status,
    sessionCursor: resume.selId,
    sessionsScanning,
    ports,
  };
  const panesKey = [
    agentsKey(ag.agents, ag.idle),
    detailKey(detail),
    filesKey(files.conflicts, files.groups, files.narrowed),
    phasesKey(projects, ph.idx),
    sessionsKey(sessions, resume.status, resume.selId, sessionsScanning),
    portsKey(ports),
  ].join("\u001c");

  // Legacy onToggle parity (08 D-15): switching the right tab clears the
  // copy/open status line.
  const clearResumeStatus = resume.clearStatus;
  React.useEffect(() => {
    clearResumeStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.rightTab]);

  // the live FILES ticker scrolls only when unnarrowed and longer than its window
  const animating =
    ag.agents.some((a) => a.state === "running") ||
    (!files.narrowed && tickerRows(files.groups).length > TICKER_VISIBLE);
  const flash = flashVisible(ui, now());
  // D-09 / D-12: the clock also runs while a flash is up or a selection may expire
  const { tick, step } = useUiTick({
    active: animating || flash !== null || ui.selectedAgentId !== null,
    paused: ui.filesPaused,
    tickMs,
  });

  // D-09: a selection idle for SELECTION_IDLE_MS is dropped (no special case for go-to)
  React.useEffect(() => {
    if (selectionExpired(uiRef.current, now())) apply({ t: "clearSelection" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ui.selectedAgentId, ui.lastKeyAt]);

  // The view facts of the panes drawn this render (live cards + idle strips).
  const cardIds = ag.agents.map((a) => a.id);
  const stripIds = ag.idle.map((s) => s.id);
  const viewRef = React.useRef<ViewFacts>({
    agentIds: new Set(),
    cardIds: [],
    stripIds: [],
    cols: 1,
    byId: new Map(),
    nameById: new Map(),
    phaseNumbers: [],
    currentPhase: null,
    roots: [],
    projectIdx: 0,
    portKeys: [],
  });
  const shownProject = projects[ph.idx];
  viewRef.current = {
    agentIds: new Set([...cardIds, ...stripIds]),
    cardIds,
    stripIds,
    cols: Math.max(1, geometry(columns, rows).cardCols),
    byId: ag.byId,
    nameById: new Map([...ag.agents, ...ag.idle].map((x) => [x.id, x.name] as const)),
    phaseNumbers: shownProject === undefined ? [] : shownProject.phases.map((e) => e.number),
    currentPhase: currentPhaseNumber(shownProject),
    roots: ph.focusSet.map((f) => f.root),
    projectIdx: ph.idx,
    portKeys: visiblePortEntries(ports, true).shown.map((p) => p.key),
  };
  const scrollRef = React.useRef<ScrollState>(EMPTY_SCROLL);
  const uiForDraw = effectiveUi(ui, viewRef.current.agentIds);

  // Pitfall 4 / T-10-21: a selection whose session left the roster is cleared
  // (fails closed); effectiveUi keeps the draw and the footer honest until then.
  const selectionLive = ui.selectedAgentId === null || viewRef.current.agentIds.has(ui.selectedAgentId);
  React.useEffect(() => {
    if (!selectionLive) apply({ t: "clearSelection" });
  }, [selectionLive, apply]);

  const header = headerFromRoster(roster, updateTo, now());
  const headerKey = [
    header.agents,
    header.asking,
    header.waiting,
    header.conflicts,
    header.clock,
    header.update ?? "",
  ].join("|");

  const flashKey = flash === null ? "" : `${flash.ok ? 1 : 0}|${flash.text}`;
  const sc = scrollRef.current;
  const scrollKey = [sc.grid, sc.phases, sc.sessions, sc.ports].map((w) => w.offset).join("|");

  const frame = React.useMemo(
    () =>
      drawShellFrame({
        rows,
        cols: columns,
        ui: uiForDraw,
        tick,
        step,
        header,
        panes,
        keysOff: !isRawModeSupported,
        flash,
        sample: SAMPLE_FLAGS,
        scroll: scrollRef.current,
      }),
    // `header` is keyed by its fields (headerKey), the flash by its visible
    // text (flashKey), the live AGENTS cards and strips by their fields
    // (panesKey) and the fed-back windows by their offsets (scrollKey): a
    // fresh object with the same values never re-draws the frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, columns, ui, uiForDraw.selectedAgentId, tick, step, isRawModeSupported, headerKey, flashKey, scrollKey, panesKey],
  );
  // Pattern 3: the windows drawn are fed back on the next draw (a ref: no state, no extra render)
  scrollRef.current = frame.scroll;

  // 10-10: the go-to deps (created once), the in-flight guard and the mounted flag
  const defaultDepsRef = React.useRef<GotoDeps | null>(null);
  if (props.gotoDeps === undefined && defaultDepsRef.current === null) defaultDepsRef.current = defaultGotoDeps();
  const gotoDeps: GotoDeps = props.gotoDeps ?? (defaultDepsRef.current as GotoDeps);
  const gotoInFlight = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The dispatcher's per-context intent handlers, reassigned every render so
  // they read the latest view-model. A handler is added only by the plan that
  // makes its pane live (T-10-19): AGENTS from 10-09, PHASES and SESSIONS
  // from 10-14, PORTS browse from 10-15; the rest are no-ops.
  const intentSpy = props.intentSpy;
  const intentRef = React.useRef<(intent: Intent, ctx: HintContext) => void>(() => undefined);
  intentRef.current = (intent: Intent, ctx: HintContext): void => {
    intentSpy?.(intent, ctx);
    switch (ctx) {
      case "agents":
      case "agentsSelected": {
        // KEYS-02 / D-16: select by identity over the freshest cards + strips
        const v = viewRef.current;
        if (intent.t === "goto") {
          const sel = uiRef.current.selectedAgentId;
          const row = sel === null ? undefined : v.byId.get(sel);
          // RESEARCH Q1 row 1: a selection that no longer resolves fails closed, no flash
          if (sel === null || row === undefined) {
            apply({ t: "clearSelection" });
            return;
          }
          if (gotoInFlight.current) return; // one go-to at a time (T-10-26)
          gotoInFlight.current = true;
          void runGoto(
            {
              name: v.nameById.get(sel) ?? row.folder,
              pid: row.pid,
              pid_started: row.pid_started,
              warp: row.warp,
              ended: false,
            },
            gotoDeps,
          )
            .then((r) => {
              if (mounted.current) apply({ t: "flash", text: r.text, ok: r.ok, at: now() });
            })
            .catch(() => undefined)
            .finally(() => {
              gotoInFlight.current = false;
            });
          // D-09: no special selection handling after a go-to
          return;
        }
        const items = gridItems(v.cardIds, v.stripIds);
        const cur = uiRef.current.selectedAgentId;
        let id: string | null = null;
        if (intent.t === "move") id = moveGrid(items, v.cols, cur, intent.dir);
        else if (intent.t === "page") {
          id = pageGrid(items, v.cols, cur, Math.max(1, scrollRef.current.grid.visible), intent.dir);
        }
        if (id !== null && id !== cur) apply({ t: "select", id });
        return;
      }
      case "phases": {
        // KEYS-05: the project by root, wrapping; the reducer clears the phase cursor
        const v = viewRef.current;
        if (intent.t === "project") {
          // the current root: a just-picked root (quick successive keys, T-08-11)
          // when it is still in the set, else the project on screen
          const picked = uiRef.current.projectRoot;
          const cur = picked !== null && v.roots.includes(picked) ? picked : (v.roots[v.projectIdx] ?? null);
          const root = cycleId(v.roots, cur, intent.dir);
          if (root !== null) apply({ t: "setProject", root });
          return;
        }
        // KEYS-02 / D-16: the phase cursor by number; a cursor that is not in
        // the shown project starts from the current phase
        let delta = 0;
        if (intent.t === "move" && (intent.dir === "up" || intent.dir === "down")) delta = intent.dir === "up" ? -1 : 1;
        else if (intent.t === "page") delta = intent.dir * Math.max(1, scrollRef.current.phases.visible);
        if (delta === 0) return;
        const at = uiRef.current.phaseCursor;
        const from = at !== null && v.phaseNumbers.includes(at) ? at : v.currentPhase;
        const n = moveList(v.phaseNumbers, from, delta);
        if (n !== null) apply({ t: "setPhaseCursor", n });
        return;
      }
      case "sessions": {
        // 08 D-14..D-19 through the shared hook only (T-10-34): the id cursor,
        // copy (Enter) and open (`o`) with every Phase 8 guard. The context is
        // derived from uiRef, so the SESSIONS tab is showing in the state.
        if (uiRef.current.rightTab !== "sessions") return;
        if (intent.t === "move" && (intent.dir === "up" || intent.dir === "down")) {
          resume.move(intent.dir === "up" ? -1 : 1);
        } else if (intent.t === "page") {
          resume.move(intent.dir * Math.max(1, scrollRef.current.sessions.visible));
        } else if (intent.t === "copy") {
          resume.enter();
        } else if (intent.t === "open") {
          resume.open();
        }
        return;
      }
      case "ports": {
        // KEYS-02 / D-16: the port cursor by portKey over the focused list. A
        // null cursor starts from the first shown port (the drawn `❯`); a key
        // that left the scan is unknown to moveList, which picks the first
        // shown port (fail closed, T-10-37). Enter is the Phase 11 noop and
        // never reaches here (T-10-39).
        const keys = viewRef.current.portKeys;
        let delta = 0;
        if (intent.t === "move" && (intent.dir === "up" || intent.dir === "down")) delta = intent.dir === "up" ? -1 : 1;
        else if (intent.t === "page") delta = intent.dir * Math.max(1, scrollRef.current.ports.visible);
        if (delta === 0) return;
        const cur = uiRef.current.portCursor ?? keys[0] ?? null;
        const key = moveList(keys, cur, delta);
        if (key !== null) apply({ t: "setPortCursor", key });
        return;
      }
      case "menu":
      case "confirm":
      case "confirmKill":
      case "edit":
        return;
    }
  };

  // The single dispatcher (KEYS-01): keyAt first, then resolve against effectiveUi.
  const onKeyRef = React.useRef<(input: string, key: KeyInput) => void>(() => undefined);
  onKeyRef.current = (input: string, key: KeyInput): void => {
    const t = now();
    // D-09: an already-expired selection is dropped before this key counts
    if (selectionExpired(uiRef.current, t)) apply({ t: "clearSelection" });
    apply({ t: "keyAt", at: t });
    const eff = effectiveUi(uiRef.current, viewRef.current.agentIds);
    // Pitfall 4: a selection that no longer resolves fails closed in the state too
    if (eff !== uiRef.current) apply({ t: "clearSelection" });
    const action = resolve(input, key, eff);
    if (action === null) return;
    if (isIntent(action)) {
      intentRef.current(action, contextOf(eff));
      return;
    }
    if (action.t === "quit") {
      exit();
      return;
    }
    apply(action);
  };

  return (
    <Box flexDirection="column">
      {isRawModeSupported ? <V2Keyboard onKeyRef={onKeyRef} /> : null}
      <ScreenView lines={frame.lines} />
    </Box>
  );
}

/**
 * The ONLY input handler in v2 (KEYS-01). Every key goes to PanelApp's single
 * dispatcher (`onKeyRef`, reassigned each render so it sees the latest view).
 * Mounted only on a TTY (see PanelApp).
 */
function V2Keyboard({
  onKeyRef,
}: {
  onKeyRef: React.RefObject<(input: string, key: KeyInput) => void>;
}): null {
  useInput((input, key) => {
    onKeyRef.current(input, key);
  });
  return null;
}
