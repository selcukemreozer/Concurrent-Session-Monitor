/**
 * v2 live-shaped sweep (Phase 10, plan 10-16; LAYOUT-01..04, LAYOUT-07, D-23).
 *
 * `invariants.test.ts` and `invariants-content.test.ts` prove the shell on the
 * SAMPLE fixture (and a few hand-grown copies of it). This file proves the
 * same promises on data shaped like a busy day, built through the REAL live
 * builders PanelApp uses, never SAMPLE panes:
 *
 *   - 72 display rows: 25 cards (asking / waiting / running / subagent), 45
 *     idle strips and 2 ended grace ghosts (never drawn, never counted);
 *     ~210 written / read paths and 8 shared paths, so `detectConflicts`
 *     finds 8 conflicts (one with a third session, `+1`);
 *   - 60 scanned ports (owned through the ancestry join, exposed, others);
 *   - 3 projects with 30 phases each; 60 resume rows.
 *
 * Builders: buildAgents / stableOrder, buildDetail, buildFiles, buildProjects,
 * buildSessions, buildPorts, headerFromRoster. Every frame goes through
 * drawShellFrame with every sample flag false and its ScrollState fed back.
 *
 * For rows × cols × focus × tab × selection (none, a card, an idle strip):
 *   - ≤ rows lines, each ≤ cols cells, `◆ CSM` and the asking / waiting /
 *     conflict chips on line 0, no ` sample ` chip anywhere (D-23);
 *   - when rows − 4 ≥ 2: the FILES title and at least one conflict row;
 *   - AGENTS drawn cards + strips + `↑/↓ N more` = cards + strips;
 *   - a focused PORTS / SESSIONS / PHASES pane draws its cursor row or an
 *     `↑/↓ N more` indicator;
 *   - three frames with the same inputs and the fed-back scroll are equal.
 *
 * The data is fixed (no randomness at run time). Helpers are local copies in
 * the style of invariants-content.test.ts, not imports from it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionRow } from "../../aggregate.js";
import { detectConflicts } from "../../conflicts.js";
import type { ScannedPort } from "../../ports.js";
import type { FocusEntry, Phase, Progress } from "../../phases.js";
import type { ResumeRow } from "../../sessions.js";
import type { DisplayRow, Reconciled } from "../hooks/useRoster.js";
import { lineText, type Line } from "./screen.js";
import { cellWidth, graphemes } from "./text.js";
import { geometry } from "./geometry.js";
import { FOCUS_ORDER, initialUi, type UiState } from "./uiState.js";
import type { PanesModel } from "./models.js";
import { drawShellFrame, type SampleFlags, type ScrollState } from "./draw/shell.js";
import { headerFromRoster } from "./headerModel.js";
import { buildAgents, stableOrder } from "./build/agents.js";
import { buildDetail } from "./build/detail.js";
import { buildFiles } from "./build/files.js";
import { buildProjects, buildSessions } from "./build/right.js";
import { buildPorts } from "./build/ports.js";

// One macrotask per case (as invariants-content.test.ts): the cases are
// synchronous and long, and the worker must answer vitest's RPC in between.
beforeEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

// --- the live-shaped roster (fixed data) ------------------------------------

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();
const pad = (n: number): string => String(n).padStart(2, "0");

const N_ROWS = 70;
const N_CARDS = 25;
const N_CONFLICTS = 8;
const PROJECTS = ["checkout", "dashboard", "csm"] as const;
const STATES = ["asking", "waiting", "running", "subagent", "running"] as const;
const MODELS = ["claude-opus-4-7", "claude-sonnet-4-5", "claude-haiku-4-5"];

const idOf = (i: number): string => `sess-${pad(i)}`;
const cwdOf = (i: number): string => `/csm-sweep/${PROJECTS[i % 3]}`;
const pidOf = (i: number): number => 10_000 + i;

/** Shared path j is written by card 3j and idle strip 25+j (and row 40 for j = 0). */
function sharedWriters(j: number): number[] {
  return j === 0 ? [0, N_CARDS, 40] : [3 * j, N_CARDS + j];
}

function makeRow(i: number): SessionRow {
  const state = i < N_CARDS ? STATES[i % STATES.length] : null;
  const cwd = cwdOf(i);
  const touch = (k: number): string => iso(NOW - (i * 7 + k) * 1000);
  const files = [0, 1].map((k) => ({ file_path: `${cwd}/src/s${pad(i)}/write-${k}.ts`, ts: touch(k) }));
  for (let j = 0; j < N_CONFLICTS; j++) {
    if (sharedWriters(j).includes(i)) files.push({ file_path: `/csm-sweep/shared/c${j}.ts`, ts: touch(2 + j) });
  }
  const reads = [{ file_path: `${cwd}/docs/s${pad(i)}/read.md`, ts: touch(9) }];
  return {
    schema_version: 1,
    session_id: idOf(i),
    folder: PROJECTS[i % 3],
    cwd,
    branch: i % 4 === 0 ? "main" : `feat/s${pad(i)}`,
    model: MODELS[i % MODELS.length],
    start_time: iso(NOW - (N_ROWS - i) * 600_000),
    title: `task ${pad(i)} ${PROJECTS[i % 3]} work`,
    pid: pidOf(i),
    files,
    reads,
    last_active: touch(0),
    last_seen: iso(NOW - i * 30_000),
    alive: true,
    readyToPrune: false,
    dotState: state === null ? "idle" : "active",
    asking: state === "asking",
    attention: state === "waiting",
    attention_ts: state === "waiting" ? iso(NOW - 90_000) : undefined,
    running: state === "running",
    subagent: state === "subagent",
    subagent_count: state === "subagent" ? 2 : 0,
    intent: i % 2 === 0 ? `ship the ${PROJECTS[i % 3]} change ${i}` : undefined,
    last_prompt: Array.from({ length: 30 }, (_, w) => `word${w}`).join(" "),
  } as SessionRow;
}

const LIVE_ROWS: SessionRow[] = Array.from({ length: N_ROWS }, (_, i) => makeRow(i));
/** Two grace ghosts (ended): drawn nowhere, counted nowhere. */
const GHOSTS: SessionRow[] = [makeRow(70), makeRow(71)].map((r) => ({ ...r, alive: false }));
const DISPLAY: DisplayRow[] = [
  ...LIVE_ROWS.map((row) => ({ id: row.session_id, row, ended: false })),
  ...GHOSTS.map((row) => ({ id: row.session_id, row, ended: true })),
];
const CONFLICTS = detectConflicts(LIVE_ROWS, NOW);
const ROSTER: Reconciled = {
  display: DISPLAY,
  live: N_ROWS,
  idle: N_ROWS - N_CARDS,
  conflicts: CONFLICTS,
};
const BRANCHES: ReadonlyMap<string, string> = new Map(LIVE_ROWS.map((r) => [r.session_id, r.branch]));
const ORDER = stableOrder(new Map(), LIVE_ROWS);

/** 60 listeners: 20 owned by a card's pid chain, 6 exposed, the rest others. */
const SCANNED: ScannedPort[] = Array.from({ length: 60 }, (_, i) => {
  const pid = 50_000 + i;
  const owned = i < 20;
  return {
    port: 3000 + i * 7,
    pid,
    command: ["node", "vite", "bun", "python3", "postgres"][i % 5]!,
    exposed: i % 10 === 3,
    ancestryPids: owned ? [pid, pidOf(i % N_CARDS)] : [pid, 1_000 + i],
    origin: i % 2 === 0 ? "warp" : "other",
  };
});

function phase(prefix: string, n: number, current: number): Phase {
  return {
    number: pad(n),
    name: `${prefix}-phase-${pad(n)}`,
    plans: 3,
    summaries: n < current ? 3 : n === current ? 1 : 0,
    status: n < current ? "Complete" : n === current ? "In Progress" : "Pending",
  };
}
const FOCUS_SET: FocusEntry[] = PROJECTS.map((name) => ({ root: `/csm-sweep/${name}`, name }));
const PROGRESS: ReadonlyMap<string, Progress> = new Map(
  FOCUS_SET.map((f, p) => [
    f.root,
    {
      milestone_name: `${f.name} milestone`,
      milestone_version: `v${p + 1}.0`,
      percent: 40,
      phases: Array.from({ length: 30 }, (_, n) => phase(f.name, n + 1, 10 + p * 7)),
    },
  ]),
);

const RESUME: ResumeRow[] = Array.from({ length: 60 }, (_, i) => ({
  id: `resume-${pad(i)}`,
  label: `resume session ${pad(i)}`,
  labelKind: "name",
  folder: PROJECTS[i % 3],
  cwd: cwdOf(i),
  slug: `-csm-sweep-${PROJECTS[i % 3]}`,
  mtimeMs: NOW - i * 3_600_000,
  live: i % 9 === 0,
}));

// --- the panes, built exactly as PanelApp builds them -----------------------

const AG = buildAgents({ display: DISPLAY, conflicts: CONFLICTS, branches: BRANCHES, order: ORDER, now: NOW });
const PORTS = buildPorts(SCANNED, LIVE_ROWS);
const PROJECT_LIST = buildProjects(FOCUS_SET, PROGRESS);
const SESSIONS = buildSessions(RESUME, (r) => r.live, NOW);
const HEADER = headerFromRoster(ROSTER, null, NOW);

/** The selections swept: none, a card in conflict 1, an idle strip in conflict 1. */
const SELECTIONS: ReadonlyArray<readonly [string, string | null]> = [
  ["none", null],
  ["card", idOf(3)],
  ["strip", idOf(N_CARDS + 1)],
];

function panesFor(selectedId: string | null): PanesModel {
  const selRow = selectedId === null ? undefined : AG.byId.get(selectedId);
  const files = buildFiles({ display: DISPLAY, conflicts: CONFLICTS, order: ORDER, selectedId });
  return {
    agents: AG.agents,
    idle: AG.idle,
    detail:
      selRow === undefined
        ? null
        : buildDetail({ row: selRow, branches: BRANCHES, ports: SCANNED, liveRows: LIVE_ROWS, now: NOW }),
    conflicts: files.conflicts,
    groups: files.groups,
    filesNarrowed: files.narrowed,
    projects: PROJECT_LIST,
    projectIndex: 1,
    sessions: SESSIONS,
    sessionStatus: null,
    sessionCursor: SESSIONS[37]!.id,
    sessionsScanning: false,
    ports: PORTS,
  };
}
const PANES = new Map(SELECTIONS.map(([, id]) => [id, panesFor(id)] as const));

const LIVE: SampleFlags = { agents: false, files: false, phases: false, sessions: false, ports: false };

function draw(rows: number, cols: number, ui: UiState, panes: PanesModel, scroll?: ScrollState) {
  return drawShellFrame({
    rows,
    cols,
    ui,
    tick: 0,
    step: 0,
    header: HEADER,
    panes,
    keysOff: false,
    flash: null,
    sample: LIVE,
    scroll,
  });
}

// --- helpers (local copies in the style of invariants-content.test.ts) ------

/** One string per terminal cell (a wide grapheme fills its cell, then ""). */
function cells(line: Line): string[] {
  const out: string[] = [];
  for (const seg of line) {
    for (const g of graphemes(seg.text)) {
      const w = cellWidth(g);
      if (w <= 0) continue;
      out.push(g);
      for (let i = 1; i < w; i++) out.push("");
    }
  }
  return out;
}

function columns(lines: Line[], x0: number, x1: number): string[] {
  return lines.map((l) => cells(l).slice(x0, x1).join(""));
}

function arrowCount(rows: readonly string[]): number {
  let n = 0;
  for (const s of rows) for (const m of s.matchAll(/[↑↓] (\d+) more/g)) n += Number(m[1]);
  return n;
}

function bandTop(lines: Line[], rows: number, cols: number): number {
  const band = geometry(cols, rows).band;
  if (band === null) return -1;
  const half = columns(lines, 0, band.leftW);
  return half.findIndex((s, y) => y >= 2 && /PHASES/.test(s) && /SESSIONS/.test(s));
}

/** AGENTS + FILES (`left`), PHASES|SESSIONS (`tabs`) and PORTS (`right`) per layout. */
function regions(lines: Line[], rows: number, cols: number): { left: string[]; tabs: string[]; right: string[] } {
  const g = geometry(cols, rows);
  if (g.split) {
    const right = columns(lines, g.RX, g.cols);
    return { left: columns(lines, 0, g.LW), tabs: right, right };
  }
  const all = columns(lines, 0, g.cols);
  const top = bandTop(lines, rows, cols);
  if (g.band === null || top < 0) return { left: all, tabs: all, right: all };
  const half = (x0: number, x1: number): string[] => {
    const cut = columns(lines, x0, x1);
    return all.map((s, y) => (y >= top ? cut[y]! : s));
  };
  return { left: all, tabs: half(0, g.band.leftW), right: half(g.band.rightX, g.cols) };
}

/** The rows strictly between the first `top` line (from row 2) and `stop` (or the footer). */
function between(rs: string[], top: RegExp, stop: RegExp | null): string[] {
  const footer = rs.length - 1;
  const y0 = rs.findIndex((s, y) => y >= 2 && y < footer && top.test(s));
  if (y0 < 0) return [];
  let y1 = stop === null ? -1 : rs.findIndex((s, y) => y > y0 && y < footer && stop.test(s));
  if (y1 < 0) y1 = footer;
  return rs.slice(y0 + 1, y1);
}

const FILES_TITLE = /^ FILES\b/;
const PORTS_TITLE = /^[ ▐]PORTS\b/;
const TABS_ROW = /PHASES.*SESSIONS/;
const CARD_TOP = /▄{47}|┏/g;
const ARROW = /[↑↓] \d+ more/;

// --- the sweep ----------------------------------------------------------------

const ROWS = [16, 20, 24, 30, 40, 55, 67];
const COLS = [60, 80, 99, 100, 120, 164, 165, 175, 214, 284];
const SIZES: ReadonlyArray<readonly [number, number]> = ROWS.flatMap((r) => COLS.map((c) => [r, c] as const));
const TABS = ["phases", "sessions"] as const;

describe("v2 live-shaped data (10-16)", () => {
  it("the fixture is live-shaped: 25 cards, 45 strips, 8 conflicts, 60 ports, 3×30 phases, 60 sessions", () => {
    expect(AG.agents).toHaveLength(N_CARDS);
    expect(AG.idle).toHaveLength(N_ROWS - N_CARDS);
    expect(CONFLICTS).toHaveLength(N_CONFLICTS);
    expect(PORTS).toHaveLength(60);
    expect(PORTS.filter((p) => p.owner !== null)).toHaveLength(20);
    expect(PORTS.filter((p) => p.exposed)).toHaveLength(6);
    expect(PROJECT_LIST.map((p) => p.phases.length)).toEqual([30, 30, 30]);
    expect(SESSIONS).toHaveLength(60);
    const paths = new Set(LIVE_ROWS.flatMap((r) => [...r.files, ...r.reads].map((f) => f.file_path)));
    expect(paths.size).toBeGreaterThanOrEqual(200);
    expect(HEADER).toMatchObject({ agents: N_ROWS, asking: 5, waiting: 5, conflicts: N_CONFLICTS });
    // both swept selections sit in a conflict, so a narrowed FILES still has one
    for (const [name, id] of SELECTIONS) {
      if (id === null) continue;
      const p = PANES.get(id)!;
      expect(p.filesNarrowed, name).toBe(true);
      expect(p.conflicts.length, name).toBeGreaterThan(0);
      expect(p.detail?.id, name).toBe(id);
    }
  });

  it.each(SIZES)("live %i rows x %i cols: fits, header, FILES conflict, AGENTS counts, focused cursor, stable", (rows, cols) => {
    for (const [selName, selectedId] of SELECTIONS) {
      const panes = PANES.get(selectedId)!;
      for (const focus of FOCUS_ORDER) {
        for (const rightTab of TABS) {
          const ui: UiState = {
            ...initialUi,
            focus,
            rightTab,
            selectedAgentId: selectedId,
            phaseCursor: "17",
            portCursor: PORTS[45]!.key,
          };
          const msg = `${selName}, focus ${focus}, tab ${rightTab}`;

          // three frames, the scroll fed back: same inputs, same frame
          const f1 = draw(rows, cols, ui, panes);
          const f2 = draw(rows, cols, ui, panes, f1.scroll);
          const f3 = draw(rows, cols, ui, panes, f2.scroll);
          const t2 = f2.lines.map(lineText);
          expect(f3.lines.map(lineText), `${msg}: frame 3 = frame 2`).toEqual(t2);
          expect(f3.scroll, `${msg}: scroll settles`).toEqual(f2.scroll);
          const lines = f3.lines;
          const text = lines.map(lineText);

          // size, header, no sample chip
          expect(lines.length, msg).toBeLessThanOrEqual(rows);
          for (const l of lines) expect(cells(l).length, msg).toBeLessThanOrEqual(cols);
          expect(text[0], `${msg}: brand`).toContain("◆ CSM");
          expect(text[0], `${msg}: asking chip`).toContain(" 5 asking ");
          expect(text[0], `${msg}: waiting chip`).toContain(" 5 waiting ");
          expect(text[0], `${msg}: conflict chip`).toContain(` ${N_CONFLICTS} conflicts `);
          for (const s of text) expect(s, `${msg}: sample chip`).not.toContain(" sample ");

          const { left, tabs, right } = regions(lines, rows, cols);
          const footer = left.length - 1;

          // LAYOUT-03: the FILES title and a conflict row never yield
          const filesY = left.findIndex((s, y) => y > 2 && FILES_TITLE.test(s));
          if (rows - 4 >= 2) {
            expect(filesY, `${msg}: FILES title`).toBeGreaterThan(1);
            expect(left[filesY + 1], `${msg}: conflict row`).toMatch(/^▌ !/);
          }

          // WR-01: every card and strip is drawn or counted
          const region = left.slice(3, filesY < 0 ? footer : filesY);
          const drawn = region.reduce((n, s) => n + (s.match(CARD_TOP) ?? []).length, 0);
          expect(drawn + arrowCount(region), `${msg}: AGENTS drawn ${drawn}`).toBe(AG.agents.length + AG.idle.length);

          // the focused list draws its cursor row or an indicator
          if (focus === "ports") {
            const body = between(right, PORTS_TITLE, null);
            const ok = body.some((s) => /^❯ :\d+/.test(s) || ARROW.test(s));
            expect(ok, `${msg}: PORTS ${JSON.stringify(body)}`).toBe(true);
          }
          if (focus === "right") {
            const body = between(tabs, TABS_ROW, PORTS_TITLE);
            const cursor = rightTab === "sessions" ? /^▸ / : /^❯ [●◉○] /;
            const ok = body.some((s) => cursor.test(s) || ARROW.test(s));
            expect(ok, `${msg}: ${rightTab} ${JSON.stringify(body)}`).toBe(true);
          }
        }
      }
    }
  });
});
