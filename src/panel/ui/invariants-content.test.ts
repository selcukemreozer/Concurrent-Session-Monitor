/**
 * v2 shell CONTENT invariants (Phase 10, plan 10-01; D-19, 09-REVIEW IN-04).
 *
 * `invariants.test.ts` asserts what a frame's SIZE is (line count, widths, the
 * brand, one inverse title). This file is its content companion: it asserts
 * what a frame SHOWS, so a pane can never hide items without saying so. It is
 * a separate file because `invariants.test.ts` already runs close to vitest's
 * 60 s worker RPC window (09-16 deviation).
 *
 *   - WR-01 / IN-04(i): in the AGENTS region, drawn cards + idle strips plus
 *     the `↑ N more` / `↓ N more` counts equal the model's agents + idle.
 *   - WR-02: at split widths with 16-18 rows the AGENTS pane draws at least
 *     one card before the FILES ticker gets more than its minimum.
 *   - WR-08: with PORTS focused, drawn ports plus the arrow-row counts equal
 *     the port count (every port is drawn, or a `↓ N more` row says so).
 *   - WR-09 / IN-04(ii): with PHASES focused on a project that has phases,
 *     the tab body shows a phase marker (● ◉ ○) or an arrow row.
 *   - WR-07: drawShell with NaN / Infinity / negative sizes terminates within
 *     1 s and returns the too-small screen for the geometry-normalized size.
 *   - WR-04 (10-02): an unfocused PHASES window that draws fewer phases than
 *     the project has always draws a `⋮ N earlier/more phases` row.
 *   - WR-06 (10-02): at pane widths 1, 7, 30 and 46 (narrower than a card
 *     and than every Phase 9 rect) and heights 0..20, no pane draw (AGENTS,
 *     FILES, PHASES, SESSIONS, PORTS, the right column) writes a cell outside
 *     its rect.
 *   - WR-05 (10-02): PORTS drawn ports + `↑/↓ N more` + `+N others` equal the
 *     port count (focused and unfocused), and an unfocused pane that draws any
 *     port draws the exposed one; FILES conflict rows + `+N more conflicts`
 *     equal the conflict count.
 *   - S2 (10-03, LAYOUT-04): at 100-164 columns the PHASES|SESSIONS tabs row
 *     and the PORTS title share the band's first line, the `│` divider is at
 *     band.divX on the band rows only, the gutter is empty, and the focused
 *     band pane draws its inverse title. The WR-04/05/08/09 sweeps above read
 *     the band halves through `regions()`.
 *   - detail (10-11, LAYOUT-07, LAYOUT-03): with a selection and its detail
 *     strip, every frame fits, the FILES title and its conflict row are drawn,
 *     the focused bottom pane keeps its inverse title and its WR-08 / WR-09
 *     content, and with AGENTS focused at 24+ rows the strip's pill row is
 *     drawn.
 *
 * Later plans of Phase 10 append to this file.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Screen, lineText, type Line } from "./screen.js";
import { cellWidth, graphemes } from "./text.js";
import { geometry } from "./geometry.js";
import { FOCUS_ORDER, initialUi, type UiState } from "./uiState.js";
import { SAMPLE, SAMPLE_HEADER } from "./sample.js";
import type { AgentCard, DetailModel, IdleStrip, PanesModel, PortEntry, Rect } from "./models.js";
import { drawShell } from "./draw/shell.js";
import { drawAgentsPane } from "./draw/agents.js";
import { drawFilesPane } from "./draw/files.js";
import { drawPhases } from "./draw/phases.js";
import { drawSessions } from "./draw/sessions.js";
import { drawPortsPane } from "./draw/ports.js";
import { drawRightColumn } from "./draw/right.js";
import { drawTooSmall } from "./draw/tooSmall.js";

// One macrotask per case, as in invariants.test.ts (09-16): the cases are
// synchronous and long, and the worker must answer vitest's RPC in between.
beforeEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

// --- fixtures ---------------------------------------------------------------

/** SAMPLE with 12 agents, 9 idle strips and 20 ports (4 owned, 2 exposed). SAMPLE is never mutated. */
function many(): PanesModel {
  const agents: AgentCard[] = Array.from({ length: 12 }, (_, i) => {
    const a = SAMPLE.agents[i % SAMPLE.agents.length]!;
    return { ...a, id: `agent-${i}`, name: `${a.name} ${i}` };
  });
  const idle: IdleStrip[] = Array.from({ length: 9 }, (_, i) => {
    const s = SAMPLE.idle[i % SAMPLE.idle.length]!;
    return { ...s, id: `idle-${i}`, name: `${s.name} ${i}` };
  });
  const ports: PortEntry[] = Array.from({ length: 20 }, (_, i) => {
    const p = SAMPLE.ports[i % SAMPLE.ports.length]!;
    const port = 4000 + i;
    return {
      ...p,
      key: String(port),
      port,
      owner: i < 4 ? `owner ${i}` : null,
      exposed: i === 4 || i === 5,
    };
  });
  return { ...SAMPLE, agents, idle, ports };
}

const FIXTURES: ReadonlyArray<readonly [string, PanesModel]> = [
  ["sample", SAMPLE],
  ["many", many()],
];

// 19, 21 and 23 added by 10-01: 80x21 with PORTS focused sat exactly on the
// old PORTS floor (one port row, no indicator).
const ROWS = [16, 17, 18, 19, 20, 21, 22, 23, 24, 30];
const COLS = [60, 80, 96, 99, 100, 120, 164, 165, 175, 213, 214, 284];
const SPLIT_COLS = [165, 175, 213, 214, 284];
/** [rows, cols] */
const SIZES: ReadonlyArray<readonly [number, number]> = ROWS.flatMap((r) => COLS.map((c) => [r, c] as const));
const TABS = ["phases", "sessions"] as const;

// --- helpers (same style as invariants.test.ts; not imported from it) ------

function frame(rows: number, cols: number, ui: UiState, panes: PanesModel): Line[] {
  return drawShell({
    rows,
    cols,
    ui,
    tick: 0,
    step: 0,
    header: SAMPLE_HEADER,
    panes,
    keysOff: false,
    flash: null,
    sample: true,
  });
}

function text(lines: Line[]): string[] {
  return lines.map((l) => lineText(l));
}

/** One string per terminal cell (a wide grapheme fills its cell, then "" for the rest). */
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

/** The text of cells [x0, x1) on every line. */
function columns(lines: Line[], x0: number, x1: number): string[] {
  return lines.map((l) => cells(l).slice(x0, x1).join(""));
}

/** Sum of the N in every `↑ N more` / `↓ N more` row. */
function arrowCount(rows: readonly string[]): number {
  let n = 0;
  for (const s of rows) {
    for (const m of s.matchAll(/[↑↓] (\d+) more/g)) n += Number(m[1]);
  }
  return n;
}

/**
 * The S2 band's first row (10-03): the first line from row 2 whose left half
 * holds the PHASES|SESSIONS tabs, or -1 when the frame is not S2 or the band
 * is not drawn (a collapsed bottom pane).
 */
function bandTop(lines: Line[], rows: number, cols: number): number {
  const band = geometry(cols, rows).band;
  if (band === null) return -1;
  const half = columns(lines, 0, band.leftW);
  return half.findIndex((s, y) => y >= 2 && /PHASES/.test(s) && /SESSIONS/.test(s));
}

/**
 * Per frame: the AGENTS + FILES text (`left`), the PHASES|SESSIONS text
 * (`tabs`) and the PORTS text (`right`). Split: the left column and the right
 * column. S1: every region is the full width. S2 (10-03): the full width
 * above the band; on the band rows `tabs` is the left half [0, leftW) and
 * `right` the right half [rightX, cols).
 */
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

const FILES_TITLE = /^ FILES\b/;
const PORTS_TITLE = /^[ ▐]PORTS\b/;
const CARD_TOP = /▄{47}|┏/g;
const PHASE_MARKER = /[●◉○]|[↑↓] \d+ more/;

function focusName(ui: UiState): string {
  return `focus ${ui.focus}, tab ${ui.rightTab}`;
}

// --- WR-01 / IN-04(i): AGENTS never hides items silently -------------------

describe("v2 content: AGENTS drawn items + indicators = model (WR-01)", () => {
  it.each(SIZES)("WR-01 %i rows x %i cols: hidden cards or strips imply a ↓ N more row", (rows, cols) => {
    for (const [name, panes] of FIXTURES) {
      for (const focus of FOCUS_ORDER) {
        for (const rightTab of TABS) {
          const ui: UiState = { ...initialUi, focus, rightTab };
          const lines = frame(rows, cols, ui, panes);
          const { left } = regions(lines, rows, cols);
          const footer = left.length - 1;
          let filesY = left.findIndex((s, y) => y > 2 && FILES_TITLE.test(s));
          if (filesY < 0) filesY = footer;
          const region = left.slice(3, filesY);
          // one ▄ run per card or idle strip, one ┏ per selected card
          const drawn = region.reduce((n, s) => n + (s.match(CARD_TOP) ?? []).length, 0);
          const total = panes.agents.length + panes.idle.length;
          expect(drawn + arrowCount(region), `${name}, ${focusName(ui)}: drawn ${drawn}`).toBe(total);
        }
      }
    }
  });
});

// --- WR-02: split frames draw a card row before growing the FILES ticker ----

const SPLIT_SHORT: ReadonlyArray<readonly [number, number]> = [16, 17, 18].flatMap((r) =>
  SPLIT_COLS.map((c) => [r, c] as const),
);

describe("v2 content: split AGENTS keeps one card row (WR-02)", () => {
  it.each(SPLIT_SHORT)("WR-02 %i rows x %i cols: at least one card top is drawn", (rows, cols) => {
    for (const [name, panes] of FIXTURES) {
      for (const rightTab of TABS) {
        const ui: UiState = { ...initialUi, focus: "agents", rightTab };
        const lines = frame(rows, cols, ui, panes);
        const { left } = regions(lines, rows, cols);
        let filesY = left.findIndex((s, y) => y > 2 && FILES_TITLE.test(s));
        if (filesY < 0) filesY = left.length - 1;
        const drawn = left.slice(3, filesY).reduce((n, s) => n + (s.match(CARD_TOP) ?? []).length, 0);
        expect(drawn, `${name}, ${focusName(ui)}`).toBeGreaterThan(0);
      }
    }
  });
});

// --- WR-08: a focused PORTS pane shows every port or says how many are hidden

describe("v2 content: focused PORTS drawn + indicators = ports (WR-08)", () => {
  it.each(SIZES)("WR-08 %i rows x %i cols: every port is drawn or counted by ↑/↓ N more", (rows, cols) => {
    for (const [name, panes] of FIXTURES) {
      for (const rightTab of TABS) {
        const ui: UiState = { ...initialUi, focus: "ports", rightTab };
        const lines = frame(rows, cols, ui, panes);
        const { right } = regions(lines, rows, cols);
        const footer = right.length - 1;
        const portsY = right.findIndex((s, y) => y >= 2 && y < footer && PORTS_TITLE.test(s));
        expect(portsY, `${name}, ${focusName(ui)}: PORTS title`).toBeGreaterThan(0);
        const region = right.slice(portsY + 1, footer);
        const drawn = region.filter((s) => /(^|\s):\d+/.test(s)).length;
        expect(drawn + arrowCount(region), `${name}, ${focusName(ui)}: drawn ${drawn}`).toBe(panes.ports.length);
      }
    }
  });
});

// --- WR-09 / IN-04(ii): a focused PHASES pane shows a phase row --------------

describe("v2 content: focused PHASES shows a phase marker or arrow row (WR-09)", () => {
  it.each(SIZES)("WR-09 %i rows x %i cols: a ● ◉ ○ marker or ↑/↓ N more row in the body", (rows, cols) => {
    for (const [name, panes] of FIXTURES) {
      const project = panes.projects[panes.projectIndex];
      expect(project?.phases.length, `${name}: the fixture project has phases`).toBeGreaterThan(0);
      const ui: UiState = { ...initialUi, focus: "right", rightTab: "phases" };
      const lines = frame(rows, cols, ui, panes);
      const { tabs: right } = regions(lines, rows, cols);
      const footer = right.length - 1;
      const tabsY = right.findIndex((s, y) => y >= 2 && /PHASES/.test(s) && /SESSIONS/.test(s));
      expect(tabsY, `${name}: tabs row`).toBeGreaterThan(0);
      let portsY = right.findIndex((s, y) => y > tabsY && y < footer && PORTS_TITLE.test(s));
      if (portsY < 0) portsY = footer;
      const body = right.slice(tabsY + 1, portsY);
      expect(
        body.some((s) => PHASE_MARKER.test(s)),
        `${name}: body rows ${JSON.stringify(body)}`,
      ).toBe(true);
    }
  });
});

// --- WR-04: an unfocused PHASES window never hides phases without a ⋮ row ---

/** Sum of the N in every `⋮  N earlier phases` / `⋮  N more phases` row. */
function moreCount(rows: readonly string[]): number {
  let n = 0;
  for (const s of rows) {
    for (const m of s.matchAll(/⋮ {2}(\d+) (?:earlier|more) phases?/g)) n += Number(m[1]);
  }
  return n;
}

describe("v2 content: unfocused PHASES hidden phases imply a ⋮ row (WR-04)", () => {
  it.each(SIZES)("WR-04 %i rows x %i cols: hidden phases imply a ⋮ row", (rows, cols) => {
    for (const [name, panes] of FIXTURES) {
      const total = panes.projects[panes.projectIndex]?.phases.length ?? 0;
      for (const focus of ["agents", "ports"] as const) {
        const ui: UiState = { ...initialUi, focus, rightTab: "phases" };
        const lines = frame(rows, cols, ui, panes);
        const { tabs: right } = regions(lines, rows, cols);
        const footer = right.length - 1;
        const tabsY = right.findIndex((s, y) => y >= 2 && /PHASES/.test(s) && /SESSIONS/.test(s));
        // a short stacked frame focused on AGENTS collapses the right column
        if (tabsY < 0) continue;
        let portsY = right.findIndex((s, y) => y > tabsY && y < footer && PORTS_TITLE.test(s));
        if (portsY < 0) portsY = footer;
        const body = right.slice(tabsY + 1, portsY);
        const drawn = body.filter((s) => /^\s*[●◉○] /.test(s)).length;
        const counted = moreCount(body);
        // only frames whose body reaches the timeline (past the 4 header rows)
        if (drawn + counted === 0) continue;
        const msg = `${name}, ${focusName(ui)}: body ${JSON.stringify(body)}`;
        // hidden phases always come with a ⋮ row (a 2-row window keeps the
        // current phase and `N more phases`; 3+ rows count every hidden phase)
        if (drawn < total) expect(counted, msg).toBeGreaterThan(0);
        expect(drawn + counted, msg).toBeLessThanOrEqual(total);
      }
    }
  });
});

// --- WR-05: PORTS (unfocused and focused) and FILES conflicts ----------------

/** SAMPLE with 5 file conflicts (the FILES pane shows at most 3 conflict rows). */
function conflicts5(): PanesModel {
  const conflicts = Array.from({ length: 5 }, (_, i) => ({ a: `left ${i}`, b: `right ${i}`, path: `src/c${i}.ts` }));
  return { ...SAMPLE, conflicts };
}

const PORT_FIXTURES: ReadonlyArray<readonly [string, PanesModel]> = [...FIXTURES, ["conflicts5", conflicts5()]];

describe("v2 content: PORTS drawn + ↑/↓ N + others N = ports, exposed last to drop (WR-05)", () => {
  it.each(SIZES)("WR-05 %i rows x %i cols: no PORTS frame hides a port silently", (rows, cols) => {
    for (const [name, panes] of PORT_FIXTURES) {
      const hasExposed = panes.ports.some((p) => p.exposed);
      for (const focus of FOCUS_ORDER) {
        const ui: UiState = { ...initialUi, focus, rightTab: "phases" };
        const lines = frame(rows, cols, ui, panes);
        const { right } = regions(lines, rows, cols);
        const footer = right.length - 1;
        const portsY = right.findIndex((s, y) => y >= 2 && y < footer && PORTS_TITLE.test(s));
        if (portsY < 0) continue;
        const region = right.slice(portsY + 1, footer);
        // a PORTS pane with no row below its title (h < 3) has nothing to count
        if (region.every((s) => s.trim() === "")) continue;
        const drawn = region.filter((s) => /(^|\s):\d+/.test(s)).length;
        const others = region.reduce((n, s) => n + Number(/\+(\d+) others/.exec(s)?.[1] ?? 0), 0);
        const msg = `${name}, ${focusName(ui)}: ${JSON.stringify(region)}`;
        expect(drawn + arrowCount(region) + others, msg).toBe(panes.ports.length);
        if (focus !== "ports" && drawn > 0 && hasExposed) {
          expect(region.some((s) => /:\d+.*⇡ exposed/.test(s)), msg).toBe(true);
        }
      }
    }
  });
});

describe("v2 content: FILES drawn conflicts + N = conflicts (WR-05)", () => {
  const panes = conflicts5();
  it.each(SIZES)("WR-05 %i rows x %i cols: conflict rows + the +N more conflicts N = 5", (rows, cols) => {
    for (const focus of FOCUS_ORDER) {
      const ui: UiState = { ...initialUi, focus, rightTab: "phases" };
      const lines = frame(rows, cols, ui, panes);
      const { left } = regions(lines, rows, cols);
      const filesY = left.findIndex((s, y) => y > 2 && FILES_TITLE.test(s));
      if (filesY < 0) continue;
      let drawn = 0;
      let more = 0;
      for (let y = filesY + 1; y < left.length && /^▌ ! /.test(left[y]!); y++) {
        const m = /\+(\d+) more conflicts/.exec(left[y]!);
        if (m) more += Number(m[1]);
        else drawn++;
      }
      if (drawn + more === 0) continue;
      expect(drawn + more, `${focusName(ui)}: drawn ${drawn}, more ${more}`).toBe(5);
    }
  });
});

// --- WR-06: narrow rects stay inside their rects ----------------------------

/** Cells drawn outside `r` on a Screen, as "x,y" (same logic as invariants.test.ts). */
function outside(scr: Screen, r: Rect): string[] {
  const out: string[] = [];
  scr.toLines().forEach((l, y) => {
    let x = 0;
    for (const s of l) {
      for (const g of graphemes(s.text)) {
        const w = cellWidth(g);
        const inside = y >= r.y && y < r.y + r.h && x >= r.x && x < r.x + r.w;
        if (!inside && (g !== " " || s.bg !== undefined)) out.push(`${x},${y}`);
        x += w;
      }
    }
  });
  return out;
}

describe("v2 content: narrow pane rects stay inside their rects (WR-06)", () => {
  const NARROW = [1, 7, 30, 46];
  const HEIGHTS = Array.from({ length: 21 }, (_, i) => i);
  const UIS: readonly UiState[] = [
    initialUi,
    { ...initialUi, focus: "right" },
    { ...initialUi, focus: "ports" },
    { ...initialUi, rightTab: "sessions" },
    { ...initialUi, focus: "right", rightTab: "sessions" },
  ];
  /** A screen 3 cells/rows larger than the rect on every side. */
  const scratch = (r: Rect): Screen => new Screen(r.x + r.w + 3, r.y + r.h + 3);

  it.each(NARROW)("WR-06 width %i: every pane draw at heights 0..20 writes nothing outside its rect", (w) => {
    for (const [name, panes] of FIXTURES) {
      for (const h of HEIGHTS) {
        const r: Rect = { x: 3, y: 3, w, h };
        const at = `${name}, h=${h}`;
        for (const cardCols of [1, 2, 3]) {
          for (const firstRow of [0, 1]) {
            const scr = scratch(r);
            const res = drawAgentsPane(scr, r, {
              agents: panes.agents,
              idle: panes.idle,
              focused: true,
              sample: true,
              cardCols,
              tick: 1,
              selectedId: null,
              firstRow,
            });
            expect(outside(scr, r), `${at}: AGENTS cols ${cardCols} first ${firstRow}`).toEqual([]);
            expect(res.rows).toBeLessThanOrEqual(h);
          }
        }
        for (const conflicts of [panes.conflicts, conflicts5().conflicts]) {
          const scr = scratch(r);
          drawFilesPane(scr, r, { conflicts, groups: panes.groups, paused: false, step: 7, sample: true });
          expect(outside(scr, r), `${at}: FILES`).toEqual([]);
        }
        for (const focused of [false, true]) {
          for (let pi = 0; pi < panes.projects.length; pi++) {
            const scr = scratch(r);
            drawPhases(scr, r, { projects: panes.projects, projectIndex: pi, focused, cursor: null });
            expect(outside(scr, r), `${at}: PHASES focused ${focused} project ${pi}`).toEqual([]);
          }
          let scr = scratch(r);
          drawSessions(scr, r, {
            sessions: panes.sessions,
            focused,
            cursorId: panes.sessions[0]?.id ?? null,
            status: null,
            scanning: false,
          });
          expect(outside(scr, r), `${at}: SESSIONS focused ${focused}`).toEqual([]);
          scr = scratch(r);
          drawPortsPane(scr, r, {
            ports: panes.ports,
            focused,
            cursorKey: focused ? (panes.ports[0]?.key ?? null) : null,
            sample: true,
          });
          expect(outside(scr, r), `${at}: PORTS focused ${focused}`).toEqual([]);
        }
        for (const ui of UIS) {
          const scr = scratch(r);
          const res = drawRightColumn(scr, r, {
            ui,
            projects: panes.projects,
            projectIndex: panes.projectIndex,
            sessions: panes.sessions,
            sessionStatus: panes.sessionStatus,
            ports: panes.ports,
            sample: true,
            portsMinY: r.y + Math.floor(h / 2),
          });
          expect(outside(scr, r), `${at}: right column ${focusName(ui)}`).toEqual([]);
          if (h > 0) expect(res.end).toBeLessThanOrEqual(r.y + h - 1);
        }
      }
    }
  });
});

// --- WR-07: non-finite and negative sizes ----------------------------------

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Run drawShell at (rows, cols) in a child process with a small heap, so the
 * pre-fix unbounded Screen (Infinity cells) fails this case instead of taking
 * the vitest worker down. The child times the call itself; process start-up
 * is not part of the 1 s bound.
 */
function shellInChild(rows: number, cols: number): { status: number | null; ms: number; lines: string[] } {
  const num = (n: number): string => (Number.isNaN(n) ? "NaN" : n === Infinity ? "Infinity" : String(n));
  const mod = (p: string): string => JSON.stringify(path.join(REPO, p));
  const script = [
    `const { drawShell } = await import(${mod("src/panel/ui/draw/shell.ts")});`,
    `const { SAMPLE, SAMPLE_HEADER } = await import(${mod("src/panel/ui/sample.ts")});`,
    `const { initialUi } = await import(${mod("src/panel/ui/uiState.ts")});`,
    `const { lineText } = await import(${mod("src/panel/ui/screen.ts")});`,
    `const t0 = performance.now();`,
    `const lines = drawShell({ rows: ${num(rows)}, cols: ${num(cols)}, ui: initialUi, tick: 0, step: 0,`,
    `  header: SAMPLE_HEADER, panes: SAMPLE, keysOff: false, flash: null, sample: true });`,
    `const ms = performance.now() - t0;`,
    `process.stdout.write(JSON.stringify({ ms, lines: lines.map(lineText) }));`,
  ].join("\n");
  const r = spawnSync(
    process.execPath,
    ["--max-old-space-size=96", "--import", "tsx", "--input-type=module", "-e", script],
    { cwd: REPO, encoding: "utf8", timeout: 25_000, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } },
  );
  if (r.status !== 0) return { status: r.status, ms: Infinity, lines: [] };
  const out = JSON.parse(r.stdout) as { ms: number; lines: string[] };
  return { status: r.status, ms: out.ms, lines: out.lines };
}

/** The geometry() normalization: a non-finite or negative size is 0. */
function norm(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

describe("v2 content: drawShell with non-finite sizes (WR-07)", () => {
  /** [rows, cols] */
  const BAD: ReadonlyArray<readonly [number, number]> = [
    [NaN, 80],
    [24, NaN],
    [Infinity, 80],
    [24, Infinity],
    [-5, 80],
  ];

  it.each(BAD)(
    "WR-07 %s rows x %s cols: terminates within 1 s with the normalized too-small screen",
    (rows, cols) => {
      const r = shellInChild(rows, cols);
      expect(r.status, "the child exits cleanly (no hang, no out-of-memory)").toBe(0);
      expect(r.ms).toBeLessThan(1000);
      // geometry() maps each bad size to 0, so the frame is the too-small screen
      // for that normalized size: no more lines than rows, no wider than cols.
      expect(r.lines).toEqual(text(drawTooSmall(norm(cols), norm(rows), SAMPLE_HEADER)));
      expect(r.lines.length).toBeLessThanOrEqual(norm(rows));
    },
    30_000,
  );

  it.each([
    [15.7, 80.9],
    [24.2, 59.99],
  ])("WR-07 %s rows x %s cols: fractional sizes truncate and keep the header on line 0", (rows, cols) => {
    const lines = text(frame(rows, cols, initialUi, SAMPLE));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("◆ CSM");
    expect(lines).toEqual(text(drawTooSmall(norm(cols), norm(rows), SAMPLE_HEADER)));
  });
});

// --- S2 (10-03, LAYOUT-04): the side-by-side bottom band ---------------------

const S2_SIZES: ReadonlyArray<readonly [number, number]> = ROWS.flatMap((r) =>
  [100, 120, 164].map((c) => [r, c] as const),
);

describe("v2 content: S2 band (LAYOUT-04)", () => {
  it.each(S2_SIZES)("S2 %i rows x %i cols: tabs row and PORTS title share a line, divider on band rows only", (rows, cols) => {
    const band = geometry(cols, rows).band!;
    expect(band).not.toBeNull();
    for (const [name, panes] of PORT_FIXTURES) {
      for (const focus of FOCUS_ORDER) {
        for (const rightTab of TABS) {
          const ui: UiState = { ...initialUi, focus, rightTab };
          const lines = frame(rows, cols, ui, panes);
          const all = text(lines);
          const msg = `${name}, ${focusName(ui)}`;
          const top = bandTop(lines, rows, cols);
          // only a short frame focused on AGENTS may collapse the band
          if (top < 0) {
            expect(focus, `${msg}: band missing`).toBe("agents");
            expect(all.some((s) => PORTS_TITLE.test(s.trimStart()) || /PORTS/.test(s)), msg).toBe(false);
            continue;
          }
          const { tabs, right } = regions(lines, rows, cols);
          expect(right[top], `${msg}: PORTS title on the tabs row`).toMatch(PORTS_TITLE);
          expect(tabs[top]!.trimEnd().endsWith("[r]"), `${msg}: [r] in the left half`).toBe(true);
          // FILES is above the band
          const filesY = all.findIndex((s, y) => y > 2 && FILES_TITLE.test(s));
          expect(filesY, msg).toBeGreaterThan(0);
          expect(filesY, msg).toBeLessThan(top);
          // band rows: top .. the row above the footer spacer
          const footer = lines.length - 1;
          const gutter = columns(lines, band.leftW, band.rightX);
          for (let y = top; y <= footer - 2; y++) {
            // a blank right half is trimmed from the line, so pad back to the 5 gutter cells
            expect(gutter[y]!.padEnd(5), `${msg}: gutter row ${y}`).toBe("  │  ");
          }
          expect(gutter[footer - 1]!.trim(), `${msg}: spacer row`).toBe("");
          // the focused band pane draws its inverse title
          if (focus === "ports") expect(right[top]!.startsWith("▐PORTS▌"), msg).toBe(true);
          if (focus === "right") {
            expect(tabs[top], msg).toContain(rightTab === "phases" ? "▐PHASES▌" : "▐SESSIONS▌");
          }
          // never more lines than rows, never wider than cols
          expect(lines.length, msg).toBeLessThanOrEqual(rows);
          for (const l of lines) expect(cells(l).length, msg).toBeLessThanOrEqual(cols);
        }
      }
    }
  });
});

// --- 10-11: the selection detail strip never starves FILES or the focused pane

/** The fixture with its third card selected and a detail strip for it. */
function detailed(p: PanesModel): { panes: PanesModel; id: string; name: string } {
  const a = p.agents[2]!;
  const detail: DetailModel = {
    id: a.id,
    name: a.name,
    state: a.state,
    uptime: a.uptime,
    model: a.model,
    intent: "checkout screen",
    branch: a.branch,
    ports: [{ port: 3000, proc: "bun" }],
    prompt: Array.from({ length: 50 }, (_, i) => `word${i}`).join(" "),
  };
  return { panes: { ...p, detail }, id: a.id, name: a.name };
}

describe("v2 content: the selection detail strip (10-11, LAYOUT-07, LAYOUT-03)", () => {
  it.each(SIZES)("detail %i rows x %i cols: fits, FILES title + conflict stay, the focused pane keeps its content", (rows, cols) => {
    for (const [name, base] of FIXTURES) {
      const { panes, id, name: agentName } = detailed(base);
      for (const focus of FOCUS_ORDER) {
        for (const rightTab of TABS) {
          const ui: UiState = { ...initialUi, focus, rightTab, selectedAgentId: id };
          const msg = `${name}, ${focusName(ui)}`;
          const lines = frame(rows, cols, ui, panes);
          expect(lines.length, msg).toBeLessThanOrEqual(rows);
          for (const l of lines) expect(cells(l).length, msg).toBeLessThanOrEqual(cols);
          const { left, tabs, right } = regions(lines, rows, cols);
          // LAYOUT-03: the FILES title and its conflict row never yield
          const filesY = left.findIndex((s, y) => y >= 2 && FILES_TITLE.test(s));
          expect(filesY, `${msg}: FILES title`).toBeGreaterThan(1);
          expect(left[filesY + 1], `${msg}: conflict row`).toMatch(/^▌ !/);
          const footer = lines.length - 1;
          // the strip's pill row with AGENTS focused (always above FILES)
          const pill = left.findIndex((s) => s.startsWith(`▐${agentName}▌`));
          if (focus === "agents" && rows >= 24) expect(pill, `${msg}: pill row`).toBeGreaterThan(1);
          if (pill >= 0) expect(pill, msg).toBeLessThan(filesY);
          if (focus === "ports") {
            // WR-08 with the strip open
            const portsY = right.findIndex((s, y) => y >= 2 && y < footer && PORTS_TITLE.test(s));
            expect(portsY, `${msg}: PORTS title`).toBeGreaterThan(0);
            expect(right[portsY]!.startsWith("▐PORTS▌"), msg).toBe(true);
            const region = right.slice(portsY + 1, footer);
            const drawn = region.filter((s) => /(^|\s):\d+/.test(s)).length;
            expect(drawn + arrowCount(region), `${msg}: drawn ${drawn}`).toBe(panes.ports.length);
          }
          if (focus === "right") {
            const tabsY = tabs.findIndex((s, y) => y >= 2 && /PHASES/.test(s) && /SESSIONS/.test(s));
            expect(tabsY, `${msg}: tabs row`).toBeGreaterThan(0);
            expect(tabs[tabsY], msg).toContain(rightTab === "phases" ? "▐PHASES▌" : "▐SESSIONS▌");
            if (rightTab === "phases") {
              // WR-09 with the strip open
              let portsY = tabs.findIndex((s, y) => y > tabsY && y < footer && PORTS_TITLE.test(s));
              if (portsY < 0) portsY = footer;
              const body = tabs.slice(tabsY + 1, portsY);
              expect(body.some((s) => PHASE_MARKER.test(s)), `${msg}: body ${JSON.stringify(body)}`).toBe(true);
            }
          }
        }
      }
    }
  });
});
