import { describe, expect, it } from "vitest";
import { lineText, lineWidth, type Line } from "../screen.js";
import { cellWidth, graphemes } from "../text.js";
import { initialUi, type UiState } from "../uiState.js";
import { SAMPLE, SAMPLE_HEADER } from "../sample.js";
import { PALETTE } from "../palette.js";
import { geometry } from "../geometry.js";
import type { DetailModel, PanesModel } from "../models.js";
import { drawTooSmall } from "./tooSmall.js";
import { drawShell, drawShellFrame, EMPTY_SCROLL, type SampleFlags, type ScrollState, type ShellInput } from "./shell.js";

// UI-SPEC "Primary frame - 175x55, busy, focus AGENTS (P9 sample shell)",
// all 37 lines copied verbatim (trailing blanks trimmed).
const FRAME = [
  " ◆ CSM   8 agents   1 asking   1 waiting   1 conflict                                                                                                                 22:18:58",
  "",
  "▐AGENTS▌ sample  ───────────────────────────────────────────────────────────── 5 active · 3 idle  │   PHASES   SESSIONS   sample  ───────────────────────────────────────── [r]",
  "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  │",
  "│ ? csm p8 plan                               │  │ ◉ api refactor                              │  │   Scale & Insights v2.1",
  "│   CSM · main · 3h51m                        │  │   csm-demo · feat/api · 12m                 │  │   mvp-dash · project 2/2",
  "│   opus 4.7                                  │  │   sonnet 4.6                                │  │   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  2/12",
  "│   › plan phase 9 from the design file and…  │  │   › collapse the cart endpoints into one …  │  │",
  "│ ASKING                                   ◦3 │  │ WAITING 4m                            ✎1 ◦1 │  │    ●  31    auth flow",
  "└─────────────────────────────────────────────┘  └─────────────────────────────────────────────┘  │    │",
  "                                                                                                  │    ●  32    billing sync",
  "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  │    │",
  "│ ▶ checkout screen                           │  │ ▶ landing copy                              │  │    ◉  33    ci pipeline monitoring",
  "│   csm-demo · main · 6m                      │  │   site · main · 22m                         │  │    │        3/7 plan  ━━━━━━━",
  "│   opus 4.7                                  │  │   haiku 4.5                                 │  │    │",
  "│   › move the coupon field into the cart s…  │  │   › rewrite the hero headline as two shor…  │  │    ○  34    v2.0 gate closure",
  "│ RUNNING ⠏                          !1 ✎2 ◦2 │  │ RUNNING ⠹                                ✎1 │  │    │",
  "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀  └─────────────────────────────────────────────┘  │    ○  35    production platform on outplane",
  "                                                                                                  │    ⋮  7 more phases",
  "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  │",
  "│ ↻ dashboard research                        │    ● project requirements                   5h    │",
  "│   mvp-dash · main · 53h                     │  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  │",
  "│   opus 4.7                                  │    ● gm country names                      34h    │",
  "│   › compare the three competitor dashboar…  │  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  │",
  "│ SUBAGENT ×2                        !1 ✎1 ◦2 │    ● csm file read write                   53h    │",
  "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀                                                   │",
  "                                                                                                  │",
  " FILES  sample  ─────────────────────────────────────────────────────────────────────── 14 files  │   PORTS  sample  ─────────────────────────────────────────────────────────",
  "▌ ! dashboard research ✕ checkout screen   src/server.js                                          │",
  "  ■ dashboard research    src/lib/metrics.ts                                                   │  │    :27036  steam_osx   ⇡ exposed",
  "                          src/pages/Overview.tsx                                               │  │    :3000   bun",
  "    ┄┄ back to top ┄┄                                                                          │  │      ↳ checkout screen",
  "  ■ csm p8 plan           .planning/ROADMAP.md                                                 ┃  │    :5173   vite",
  "                          .planning/phase-8.md                                                 ┃  │      ↳ dashboard research",
  "                          .planning/phase-9.md                                                 ┃  │    +5 others",
  "",
  " ✎ written   read   ! conflict                                                                         tab focus   ←↑↓→ select agent   space pause files   r sessions   q quit",
];

function input(over: Partial<ShellInput> = {}): ShellInput {
  return {
    rows: 55,
    cols: 175,
    ui: initialUi,
    tick: 3,
    step: 11,
    header: SAMPLE_HEADER,
    panes: SAMPLE,
    keysOff: false,
    flash: null,
    sample: true,
    ...over,
  };
}

const ui = (o: Partial<UiState>): UiState => ({ ...initialUi, ...o });
const texts = (ls: Line[]): string[] => ls.map((l) => lineText(l));

/** The cells [x, x + n) of a plain line (wide graphemes count 2). */
function cut(s: string, x: number, n: number): string {
  let out = "";
  let cx = 0;
  for (const g of graphemes(s)) {
    const w = cellWidth(g);
    if (cx >= x && cx + w <= x + n) out += g;
    cx += w;
  }
  return out;
}

/** The grapheme whose cell starts at x, or "" when x is blank/past the end. */
function cellAt(s: string, x: number): string {
  let cx = 0;
  for (const g of graphemes(s)) {
    if (cx === x) return g;
    cx += cellWidth(g);
    if (cx > x) return "";
  }
  return "";
}

function rowOf(t: string[], pred: (s: string) => boolean, from = 0): number {
  for (let i = from; i < t.length; i++) if (pred(t[i] as string)) return i;
  return -1;
}

describe("drawShell: the approved 175x55 frame (LAYOUT-06, D-01/D-02/D-28)", () => {
  const lines = drawShell(input());
  const t = texts(lines);

  // WR-05 (Phase 10 plan 10-02, D-19): rows 29-33 of the right column list
  // the exposed port first, so the red security marker is the last to drop.
  it("WR-05 returns exactly the 37 frame lines (exposed port first in PORTS)", () => {
    expect(FRAME).toHaveLength(37);
    expect(lines).toHaveLength(37);
    expect(t.map((s) => s.trimEnd())).toEqual(FRAME);
  });

  it("draws the divider in the edge color at x98 on rows 2..34", () => {
    for (let y = 2; y <= 34; y++) expect(cellAt(t[y] as string, 98)).toBe("│");
    expect(cellAt(t[35] as string, 98)).toBe("");
    let x = 0;
    for (const s of lines[10] as Line) {
      if (x === 98) expect(s.fg).toBe(PALETTE.edge);
      x += cellWidth(s.text);
    }
  });

  it("puts the footer at end + 2 with a blank spacer above", () => {
    expect(t[35]).toBe("");
    expect(t[36]).toContain("q quit");
  });

  it("highlights AGENTS as the focused pane", () => {
    expect(t[2]).toContain("▐AGENTS▌");
    expect(t[2]).not.toContain("▐PHASES▌");
  });
});

describe("drawShell: focus follows the UI state (KEYS-01)", () => {
  it("moves the inverse title to the PHASES tab with focus on the right column", () => {
    const t = texts(drawShell(input({ ui: ui({ focus: "right" }) })));
    expect(t[2]).toContain("▐PHASES▌");
    expect(t[2]).not.toContain("▐AGENTS▌");
    expect(t[t.length - 1]).toContain("↑↓ browse phases");
  });

  it("moves it to PORTS and lists all 8 ports with pid", () => {
    const t = texts(drawShell(input({ ui: ui({ focus: "ports" }) })));
    const p = rowOf(t, (s) => s.includes("▐PORTS▌"));
    expect(p).toBeGreaterThan(2);
    expect(t[2]).not.toContain("▐AGENTS▌");
    const body = t.slice(p + 1, t.length - 1);
    for (const port of SAMPLE.ports) {
      expect(body.some((s) => s.includes(`:${port.port}`) && s.includes(`pid ${port.pid}`))).toBe(true);
    }
    expect(body.filter((s) => s.includes("pid ")).length).toBe(8);
    expect(t[t.length - 1]).toContain("↑↓ browse ports");
  });

  it("shows SESSIONS as the active tab and flips the r hint", () => {
    const lines = drawShell(input({ ui: ui({ rightTab: "sessions" }) }));
    const t = texts(lines);
    const segs = lines[2] as Line;
    const ses = segs.find((s) => s.text === " SESSIONS ");
    const pha = segs.find((s) => s.text === " PHASES ");
    expect(ses?.bg).toBe(PALETTE.idle);
    expect(pha?.bg).toBeUndefined();
    expect(t[t.length - 1]).toContain("r phases");
  });
});

describe("drawShell: pause and keys off (D-15, KEYS-06)", () => {
  it("shows the paused FILES title and the resume hint", () => {
    const t = texts(drawShell(input({ ui: ui({ filesPaused: true }) })));
    expect(t[27]).toContain("paused · 14 files");
    expect(t[t.length - 1]).toContain("space resume files");
  });

  it("puts the keys-off notice on the footer line without an extra line", () => {
    const on = drawShell(input());
    const off = texts(drawShell(input({ keysOff: true })));
    expect(off).toHaveLength(on.length);
    expect(off[off.length - 1]).toContain("⌨ keys off — started without a TTY");
    expect(off.some((s) => s.includes("tab focus"))).toBe(false);
  });

  it("draws a flash on the footer line", () => {
    const t = texts(drawShell(input({ flash: { text: "copied", ok: true } })));
    expect(t[t.length - 1]).toContain("copied");
  });
});

describe("drawShell: breakpoints (D-27)", () => {
  it("W3 at 220x55: three card columns and the divider at x147", () => {
    const t = texts(drawShell(input({ cols: 220 })));
    const edge = "▄".repeat(47);
    for (const x of [0, 49, 98]) expect(cut(t[3] as string, x, 47)).toBe(edge);
    for (let y = 2; y < t.length - 2; y++) expect(cellAt(t[y] as string, 147)).toBe("│");
    for (const s of t) expect(cellWidth(s)).toBeLessThanOrEqual(220);
  });

  // S2 logic change (Phase 10 plan 10-03, LAYOUT-04): 120 columns is S2, so
  // PHASES|SESSIONS and PORTS now sit side by side in a band under FILES
  // (Phase 9 drew every width below 165 as the S1 full-width stack).
  it("S2 band at 120x40: AGENTS -> FILES -> PHASES|SESSIONS beside PORTS", () => {
    const lines = drawShell(input({ cols: 120, rows: 40 }));
    const t = texts(lines);
    expect(lines.length).toBeLessThanOrEqual(40);
    // full-width AGENTS with 2 card columns
    expect(cellWidth(t[2] as string)).toBe(120);
    const edge = "▄".repeat(47);
    expect(cut(t[3] as string, 0, 47)).toBe(edge);
    expect(cut(t[3] as string, 49, 47)).toBe(edge);
    expect(cut(t[3] as string, 98, 1)).toBe("");
    // band: leftW 57, divX 59, rightX 62
    const files = rowOf(t, (s) => s.startsWith(" FILES "));
    const tabs = rowOf(t, (s) => /PHASES/.test(cut(s, 0, 57)) && /SESSIONS/.test(cut(s, 0, 57)));
    expect(files).toBeGreaterThan(9);
    expect(tabs).toBeGreaterThan(files);
    expect(cut(t[tabs] as string, 0, 57).trimEnd().endsWith("[r]")).toBe(true);
    expect(cut(t[tabs] as string, 62, 58)).toMatch(/^ PORTS /);
    expect(cellAt(t[tabs] as string, 59)).toBe("│");
    // the divider runs on the band rows only: band rows .. the row above the footer spacer
    for (let y = tabs; y <= t.length - 3; y++) expect(cellAt(t[y] as string, 59), `row ${y}`).toBe("│");
    expect(cellAt(t[t.length - 2] as string, 59)).toBe("");
    for (let y = files; y < tabs; y++) expect(cellAt(t[y] as string, 59)).not.toBe("│");
    // no row of the band draws anything else in the gutter
    for (let y = tabs; y < t.length - 1; y++) {
      for (const x of [57, 58, 60, 61]) expect(cellAt(t[y] as string, x).trim()).toBe("");
    }
    // the PORTS half shows the exposed port beside the PHASES body (both
    // unfocused at the band's 5-row minimum: the grid grows first)
    expect(cut(t[tabs + 2] as string, 0, 57).trimEnd()).toBe(" Scale & Insights v2.1");
    expect(cut(t[tabs + 2] as string, 62, 58)).toMatch(/:27036 .*⇡ exposed/);
    expect(t[t.length - 1]).toContain("q quit");
    for (const s of t) expect(cellWidth(s)).toBeLessThanOrEqual(120);
  });

  it.each([
    [16, 100],
    [20, 120],
    [24, 164],
  ])("S2 %i rows x %i cols: the focused band pane draws its inverse title", (rows, cols) => {
    const leftW = Math.floor((cols - 5) / 2);
    for (const focus of ["right", "ports"] as const) {
      for (const rightTab of ["phases", "sessions"] as const) {
        const t = texts(drawShell(input({ cols, rows, ui: ui({ focus, rightTab }) })));
        expect(t.length).toBeLessThanOrEqual(rows);
        const tabs = rowOf(t, (s) => /PHASES/.test(cut(s, 0, leftW)) && /SESSIONS/.test(cut(s, 0, leftW)));
        expect(tabs, `${focus} ${rightTab}`).toBeGreaterThan(1);
        const ports = cut(t[tabs] as string, leftW + 5, cols);
        if (focus === "ports") expect(ports.startsWith("▐PORTS▌")).toBe(true);
        else expect(cut(t[tabs] as string, 0, leftW)).toContain(rightTab === "phases" ? "▐PHASES▌" : "▐SESSIONS▌");
      }
    }
  });

  const measure = (rows: number, focus: UiState["focus"]) => {
    const lines = drawShell(input({ cols: 80, rows, ui: ui({ focus }) }));
    const t = texts(lines);
    const files = rowOf(t, (s) => s.startsWith(" FILES "));
    const tabs = rowOf(t, (s) => s.includes("[r]"));
    const ports = rowOf(t, (s) => s.includes("PORTS"), tabs + 1);
    return {
      t,
      files,
      tabs,
      // drawn PHASES body rows (tabs, spacer, body..., spacer, PORTS title)
      body: ports - tabs - 3,
      // the right column's footprint: tabs row .. the row above the footer spacer
      right: t.length - 2 - tabs,
      n: lines.length,
      w: Math.max(...lines.map((l) => lineWidth(l))),
    };
  };

  it("expands the focused bottom pane at 80x24 (rows from the ticker and the grid; WR-01 ↓ row)", () => {
    const rest = measure(24, "agents");
    const foc = measure(24, "right");
    // WR-01: the grid now reserves its ↓ N more row, which takes one row from
    // the 10-row expanded minimum; 9 is the PHASES focusedFloor (WR-09)
    expect(foc.right).toBeGreaterThanOrEqual(9);
    expect(foc.right).toBeGreaterThan(rest.right);
    // taken from the FILES ticker (down to 0: title + conflict row only) ...
    expect(foc.tabs - foc.files).toBe(2);
    expect(rest.tabs - rest.files).toBeGreaterThan(2);
    // ... while the grid keeps its one card row and says what it hides
    expect(foc.t[9]).toContain("└");
    expect(foc.t[10]).toContain("↓ 7 more");
    expect(foc.t.some((s) => s.includes("▐PHASES▌"))).toBe(true);
    for (const m of [rest, foc]) {
      expect(m.n).toBeLessThanOrEqual(24);
      expect(m.w).toBeLessThanOrEqual(80);
      expect(m.t[0]).toContain("◆ CSM");
    }
  });

  it("gives the focused PHASES body at least 4 drawn rows once a phase row fits (80x30)", () => {
    const rest = measure(30, "agents");
    const foc = measure(30, "right");
    expect(foc.body).toBeGreaterThanOrEqual(4);
    expect(foc.body).toBeGreaterThan(rest.body);
    expect(foc.n).toBeLessThanOrEqual(30);
    expect(foc.w).toBeLessThanOrEqual(80);
  });

  it("draws the too-small screen below 60x16", () => {
    for (const [cols, rows] of [
      [59, 20],
      [175, 15],
    ] as const) {
      const lines = drawShell(input({ cols, rows }));
      expect(lines).toEqual(drawTooSmall(cols, rows, SAMPLE_HEADER));
      expect(lineText(lines[2] as Line)).toContain("terminal too small");
    }
  });
});

describe("drawShell: footer position and height", () => {
  it("always ends with the footer and never exceeds rows", () => {
    for (const [cols, rows] of [
      [175, 55],
      [175, 30],
      [175, 16],
      [80, 24],
      [60, 16],
      [220, 55],
    ] as const) {
      const t = texts(drawShell(input({ cols, rows })));
      expect(t.length).toBeLessThanOrEqual(rows);
      expect(t[t.length - 1]).toContain("written");
    }
  });

  it("does not stretch to fill a tall window", () => {
    const tall = drawShell(input({ cols: 300, rows: 80 }));
    const mid = drawShell(input({ cols: 300, rows: 55 }));
    expect(tall.length).toBe(mid.length);
    expect(tall.length).toBeLessThan(80);
  });
});

describe("drawShell: a focused bottom pane always shows (09-16, KEYS-01)", () => {
  it("60x16 with PORTS focused: AGENTS collapses to its title + ↓ 8 more, FILES stays, PORTS shows its cursor row", () => {
    const lines = drawShell(input({ cols: 60, rows: 16, ui: ui({ focus: "ports" }) }));
    const t = texts(lines);
    expect(lines.length).toBeLessThanOrEqual(16);
    expect(t[2]).toContain(" AGENTS ");
    expect(t[2]).not.toContain("▐AGENTS▌");
    expect(t[3]).toContain("↓ 8 more");
    expect((t[4] as string).startsWith(" FILES ")).toBe(true);
    expect(t[5]).toContain("dashboard research");
    const p = rowOf(t, (s) => s.includes("▐PORTS▌"));
    expect(p).toBeGreaterThan(5);
    expect(t[p + 2]).toContain("❯ :3000");
    expect(t[t.length - 1]).toContain("↑↓ browse ports");
  });

  it("60x16 with PHASES focused: the first phase body row shows under the tab title", () => {
    const t = texts(drawShell(input({ cols: 60, rows: 16, ui: ui({ focus: "right" }) })));
    const y = rowOf(t, (s) => s.includes("▐PHASES▌"));
    expect(y).toBeGreaterThan(2);
    expect(t[y + 2]).toContain(SAMPLE.projects[SAMPLE.projectIndex]!.name);
    expect(t[3]).toContain("↓ 8 more");
  });

  // WR-01 / WR-08: 20 and 21 rows left this list. The grid's ↓ row (WR-01) and
  // the PORTS ↓ row in focusedFloor (WR-08) no longer fit beside a card row
  // there, so the grid collapses (see the WR-01 / WR-08 case below).
  it.each([22, 23, 24])("80x%i with PORTS focused: the card row and FILES do not yield, PORTS shows its cursor row", (rows) => {
    const foc = texts(drawShell(input({ cols: 80, rows, ui: ui({ focus: "ports" }) })));
    const rest = texts(drawShell(input({ cols: 80, rows, ui: ui({ focus: "agents" }) })));
    expect(foc.slice(3, 12)).toEqual(rest.slice(3, 12));
    const p = rowOf(foc, (s) => s.includes("▐PORTS▌"));
    expect(p).toBeGreaterThan(11);
    expect(foc.slice(p + 1).some((s) => s.includes("❯ :3000"))).toBe(true);
  });
});

// --- Phase 10 plan 10-01 (D-19): WR-01, WR-02, WR-07 ------------------------

describe("drawShell: a clipped grid always says what it hides (WR-01)", () => {
  it("WR-01 80x24 default focus: one card row and ↓ 7 more above FILES", () => {
    const t = texts(drawShell(input({ cols: 80, rows: 24 })));
    expect(t[3]).toContain("▄".repeat(47));
    expect(t[9]).toContain("└");
    expect(t[10]).toBe("  ↓ 7 more");
    expect((t[11] as string).startsWith(" FILES ")).toBe(true);
  });

  it.each([20, 21])("WR-01 / WR-08 80x%i with PORTS focused: the grid collapses to ↓ 8 more and PORTS gets its ↓ row", (rows) => {
    const t = texts(drawShell(input({ cols: 80, rows, ui: ui({ focus: "ports" }) })));
    expect(t[3]).toBe("  ↓ 8 more");
    const p = rowOf(t, (s) => s.includes("▐PORTS▌"));
    const list = t.slice(p + 1, t.length - 1);
    expect(list.some((s) => s.includes("❯ :3000"))).toBe(true);
    expect(list.some((s) => /↓ \d+ more/.test(s))).toBe(true);
  });

  it("WR-01 175x55 keeps the approved grid: all 5 cards and 3 strips, no ↓ row", () => {
    const t = texts(drawShell(input()));
    // the left column (LW 96) only: the right column has its own "7 more phases" row
    expect(t.slice(2, 27).some((s) => cut(s, 0, 96).includes("more"))).toBe(false);
  });
});

describe("drawShell: split frames serve a card row before the FILES ticker (WR-02)", () => {
  it.each([165, 175, 214])("WR-02 %ix16: a card row, its ↓ row, FILES title + conflict + a ticker row", (cols) => {
    const t = texts(drawShell(input({ cols, rows: 16 })));
    expect(cut(t[3] as string, 0, 47)).toBe("▄".repeat(47));
    expect(cut(t[10] as string, 0, 12)).toMatch(/^ {2}↓ \d+ more/);
    expect((t[11] as string).startsWith(" FILES ")).toBe(true);
    expect(t[12]).toContain("src/server.js");
    expect(cut(t[13] as string, 0, 30).trim()).not.toBe("");
    expect(t.length).toBeLessThanOrEqual(16);
  });
});

describe("drawShell: non-finite sizes (WR-07)", () => {
  it.each([
    [Number.NaN, 80],
    [24, Number.NaN],
    [Number.POSITIVE_INFINITY, 80],
    [24, Number.POSITIVE_INFINITY],
    [-5, 80],
    [24, -1],
  ])("WR-07 rows %s x cols %s: the too-small screen at the normalized size", (rows, cols) => {
    const n = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);
    const lines = drawShell(input({ rows, cols }));
    expect(lines).toEqual(drawTooSmall(n(cols), n(rows), SAMPLE_HEADER));
    expect(lines.length).toBeLessThanOrEqual(n(rows));
    for (const l of lines) expect(lineWidth(l)).toBeLessThanOrEqual(n(cols));
  });

  it("WR-07 a fractional size truncates and keeps the header on line 0", () => {
    const lines = drawShell(input({ rows: 15.9, cols: 80.5 }));
    expect(lineText(lines[0] as Line)).toContain("◆ CSM");
    expect(lineText(lines[3] as Line)).toBe(" now 80×15 · needs 60×16");
  });
});

// --- Phase 10 plan 10-08: sticky windows (Pattern 3) and per-pane chips (Pattern 4)

const gridAt = (offset: number): ScrollState => ({ ...EMPTY_SCROLL, grid: { offset, visible: 0 } });
const NO_WIN = { offset: 0, visible: 0 };

describe("drawShellFrame: ScrollState feedback (10-08, LAYOUT-02, Pattern 3)", () => {
  it("returns the drawShell lines and the grid window it drew (175x55: 3 card rows from 0)", () => {
    const f = drawShellFrame(input());
    expect(f.lines).toEqual(drawShell(input()));
    // 10-13: the right column's windows are reported too (unfocused PHASES: 5 phases drawn,
    // SESSIONS not on screen, unfocused PORTS: 3 ports from the top)
    expect(f.scroll).toEqual({
      grid: { offset: 0, visible: 3 },
      phases: { offset: 0, visible: 5 },
      sessions: NO_WIN,
      ports: { offset: 0, visible: 3 },
    });
  });

  it("draws ↑ N more under the AGENTS title for a fed-back offset and keeps it (80x40)", () => {
    const f = drawShellFrame(input({ cols: 80, rows: 40, scroll: gridAt(1) }));
    const t = texts(f.lines);
    expect(t[2]).toContain("AGENTS");
    expect(t[3]).toBe("  ↑ 1 more");
    expect(t[5]).toContain("api refactor");
    expect(f.scroll.grid).toEqual({ offset: 1, visible: 1 });
  });

  it("is sticky: feeding the returned scroll back gives the same frame", () => {
    const a = drawShellFrame(input({ cols: 80, rows: 40, scroll: gridAt(1) }));
    const b = drawShellFrame(input({ cols: 80, rows: 40, scroll: a.scroll }));
    expect(b.lines).toEqual(a.lines);
    expect(b.scroll).toEqual(a.scroll);
  });

  it("clamps an offset past the end and returns the clamped value (Pitfall 20)", () => {
    const f = drawShellFrame(input({ cols: 80, rows: 40, scroll: gridAt(99) }));
    expect(f.scroll.grid).toEqual({ offset: 4, visible: 2 });
    expect(texts(f.lines)[3]).toBe("  ↑ 4 more");
  });

  it("drops the offset to 0 when the whole grid fits after a resize (175x55)", () => {
    const f = drawShellFrame(input({ scroll: gridAt(1) }));
    expect(f.scroll.grid.offset).toBe(0);
    expect(f.lines).toEqual(drawShell(input()));
  });

  it("returns EMPTY_SCROLL for the too-small screen", () => {
    expect(drawShellFrame(input({ cols: 50, rows: 10, scroll: gridAt(3) })).scroll).toEqual(EMPTY_SCROLL);
  });
});

describe("drawShellFrame: per-pane sample chips (10-08, D-23, Pattern 4)", () => {
  const mixed: SampleFlags = { agents: false, files: true, phases: true, sessions: false, ports: true };

  it("drops only the panes whose flag is false (phases tab active)", () => {
    const t = texts(drawShell(input({ sample: mixed })));
    expect(cut(t[2] as string, 0, 96)).toContain("AGENTS");
    expect(cut(t[2] as string, 0, 96)).not.toContain("sample");
    expect(cut(t[2] as string, 98, 77)).toContain("sample");
    const files = rowOf(t, (s) => s.startsWith(" FILES "));
    expect(cut(t[files] as string, 0, 96)).toContain("sample");
    expect(cut(t[files] as string, 98, 77)).toMatch(/PORTS\s+sample/);
  });

  it("shows the tabs chip only while the ACTIVE tab is sample (sessions tab → no chip)", () => {
    const t = texts(drawShell(input({ sample: mixed, ui: ui({ rightTab: "sessions" }) })));
    expect(cut(t[2] as string, 98, 77)).toContain("SESSIONS");
    expect(cut(t[2] as string, 98, 77)).not.toContain("sample");
    const files = rowOf(t, (s) => s.startsWith(" FILES "));
    expect(cut(t[files] as string, 98, 77)).toMatch(/PORTS\s+sample/);
  });

  it.each([true, false])("sample: %s equals the all-%s flags record", (b) => {
    const all: SampleFlags = { agents: b, files: b, phases: b, sessions: b, ports: b };
    for (const [cols, rows] of [[175, 55], [120, 40], [80, 24]] as const) {
      expect(drawShell(input({ cols, rows, sample: all }))).toEqual(drawShell(input({ cols, rows, sample: b })));
    }
  });

  it("all flags false: no chip anywhere (S2 band too)", () => {
    const none: SampleFlags = { agents: false, files: false, phases: false, sessions: false, ports: false };
    for (const [cols, rows] of [[175, 55], [120, 40]] as const) {
      expect(texts(drawShell(input({ cols, rows, sample: none }))).some((s) => s.includes("sample"))).toBe(false);
    }
  });
});

// --- Phase 10 plan 10-11: the selection detail strip (LAYOUT-07, LAYOUT-03) ---

describe("drawShell: the selection detail strip (10-11, LAYOUT-07, UI-SPEC priority 3)", () => {
  const LONG = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  /** SAMPLE with `n` active cards (ids extended) and optionally no idle strips. */
  const panesN = (n: number, idle = false): PanesModel => ({
    ...SAMPLE,
    agents: Array.from({ length: n }, (_, i) => ({ ...SAMPLE.agents[i % SAMPLE.agents.length]!, id: `a${i}`, name: `agent ${i}` })),
    idle: idle ? SAMPLE.idle : [],
  });
  const detailFor = (id: string, name: string): DetailModel => ({
    id,
    name,
    state: "running",
    uptime: "6m",
    model: "opus 4.7",
    intent: "checkout screen",
    branch: "main",
    ports: [{ port: 3000, proc: "bun" }],
    prompt: LONG,
  });
  const withDetail = (p: PanesModel, i = 1): PanesModel => ({ ...p, detail: detailFor(p.agents[i]!.id, p.agents[i]!.name) });
  const sel = (p: PanesModel, o: Partial<UiState> = {}, i = 1): UiState => ui({ selectedAgentId: p.agents[i]!.id, ...o });
  /** Card rows drawn in the first card column (a `▄` × 47 or `┏` top at x 0). */
  const cardRows = (t: string[]): number => t.filter((s) => /^(▄{47}|┏)/.test(s)).length;
  const pillRow = (t: string[], name: string): number => rowOf(t, (s) => s.startsWith(`▐${name}▌`));

  it("175x55 with 10 active sessions: 5 card rows without a selection, 4 + the strip with one", () => {
    for (const idle of [false, true]) {
      const p = panesN(10, idle);
      const plain = texts(drawShell(input({ panes: p })));
      expect(cardRows(plain), `idle ${idle}`).toBe(5);
      expect(plain.some((s) => s.includes("▐agent 1▌"))).toBe(false);

      const t = texts(drawShell(input({ panes: withDetail(p), ui: sel(p) })));
      expect(t.length).toBeLessThanOrEqual(55);
      expect(cardRows(t), `idle ${idle}`).toBe(4);
      const y = pillRow(t, "agent 1");
      expect(y).toBeGreaterThan(2);
      expect(t[y]).toContain("RUNNING · 6m · opus 4.7 ─");
      expect(t[y + 1]).toMatch(/^ {2}» checkout screen {4}⎇ main {4}:3000 bun/);
      expect(t[y + 2]).toMatch(/^ {2}› word0 /);
      expect(cut(t[y + 3] as string, 0, 96).trimEnd()).toMatch(/^ {4}word\d+ .*…$/);
      expect(cut(t[y + 4] as string, 0, 96).trim()).toBe("");
      expect(t[y + 5]!.startsWith(" FILES ")).toBe(true);
      // the strip sits under the grid: no card row below it
      expect(t.slice(y).some((s) => /^(▄{47}|┏)/.test(s))).toBe(false);
    }
  });

  it("284x67 with a selection: the strip is in the left column only; the right column above FILES is unchanged", () => {
    const geo = geometry(284, 67);
    const divX = geo.divX as number;
    const plainLines = texts(drawShell(input({ cols: 284, rows: 67 })));
    const t = texts(drawShell(input({ cols: 284, rows: 67, panes: withDetail(SAMPLE, 2), ui: sel(SAMPLE, {}, 2) })));
    const y = pillRow(t, SAMPLE.agents[2]!.name);
    expect(y).toBeGreaterThan(2);
    for (let r = y; r < y + 4; r++) {
      // the divider is intact and nothing of the strip reaches the gutter
      expect(cellAt(t[r] as string, divX), `row ${r} divider`).toBe("│");
      expect(cut(t[r] as string, geo.LW, divX - geo.LW).trim(), `row ${r} gutter`).toBe("");
    }
    // the rule runs to the left column's edge and stops there
    expect(cut(t[y] as string, geo.LW - 1, 1)).toBe("─");
    const filesPlain = rowOf(plainLines, (s) => s.startsWith(" FILES "));
    const files = rowOf(t, (s) => s.startsWith(" FILES "));
    expect(files).toBe(y + 5);
    // the right column above the FILES row is unchanged
    for (let r = 2; r < Math.min(filesPlain, files); r++) {
      expect(cut(t[r] as string, geo.RX, 284 - geo.RX), `right row ${r}`).toBe(cut(plainLines[r] as string, geo.RX, 284 - geo.RX));
    }
    // PORTS still lines up with FILES (D-02)
    expect(cut(t[files] as string, geo.RX, 284 - geo.RX)).toMatch(/^ ?PORTS/);
  });

  it.each([
    [24, 80],
    [16, 60],
    [16, 80],
    [20, 120],
    [16, 165],
  ])("under pressure %ix%i (focus AGENTS): pill + a prompt row before the grid's card row; FILES title + conflict stay", (rows, cols) => {
    const t = texts(drawShell(input({ rows, cols, panes: withDetail(SAMPLE), ui: sel(SAMPLE) })));
    expect(t.length).toBeLessThanOrEqual(rows);
    for (const s of t) expect(cellWidth(s)).toBeLessThanOrEqual(cols);
    const y = pillRow(t, SAMPLE.agents[1]!.name);
    expect(y, t.join("\n")).toBeGreaterThan(2);
    expect(t[y + 1]).toContain("» ");
    expect(t[y + 2]).toContain("› ");
    const files = rowOf(t, (s) => s.startsWith(" FILES "));
    expect(files).toBeGreaterThan(y + 2);
    expect(t[files + 1]).toMatch(/^▌ !/);
    // a grid that lost its card row still says what it hides (WR-01)
    if (!t.slice(2, y).some((s) => /^(▄{47}|┏)/.test(s))) {
      expect(t.slice(2, y).some((s) => /↓ \d+ more/.test(s))).toBe(true);
    }
  });

  it("80x24 (focus AGENTS): the selected card row and the strip both fit", () => {
    const t = texts(drawShell(input({ rows: 24, cols: 80, panes: withDetail(SAMPLE), ui: sel(SAMPLE) })));
    const y = pillRow(t, SAMPLE.agents[1]!.name);
    expect(t.slice(2, y).some((s) => s.startsWith("┏"))).toBe(true);
  });

  it.each([16, 20, 22, 24, 30])("stacked 80x%i / S2 120x%i with PORTS or PHASES focused: the focused pane is as without the strip", (rows) => {
    for (const cols of [60, 80, 120]) {
      for (const focus of ["right", "ports"] as const) {
        const u = sel(SAMPLE, { focus });
        const plain = texts(drawShell(input({ rows, cols, ui: u })));
        const t = texts(drawShell(input({ rows, cols, ui: u, panes: withDetail(SAMPLE) })));
        expect(t.length).toBeLessThanOrEqual(rows);
        const top = (ls: string[]) => rowOf(ls, (s) => /PHASES/.test(s) && /SESSIONS/.test(s), 3);
        const a = top(plain);
        const b = top(t);
        expect(b, `${cols}x${rows} ${focus}`).toBeGreaterThan(0);
        // the focused bottom pane keeps every row it had (the strip yields first)
        expect(t.slice(b, t.length - 2), `${cols}x${rows} ${focus}`).toEqual(plain.slice(a, plain.length - 2));
        if (focus === "ports") expect(t.some((s) => s.includes("▐PORTS▌"))).toBe(true);
        else expect(t[b]).toContain("▐PHASES▌");
      }
    }
  });

  it("no detail, or a selection that is not the detail's id: frames are as before 10-11", () => {
    for (const [cols, rows] of [[175, 55], [284, 67], [120, 40], [80, 24], [60, 16]] as const) {
      for (const u of [initialUi, sel(SAMPLE, {}, 2), sel(SAMPLE, { focus: "ports" }, 3)]) {
        const base = drawShellFrame(input({ cols, rows, ui: u }));
        expect(drawShellFrame(input({ cols, rows, ui: u, panes: { ...SAMPLE, detail: null } }))).toEqual(base);
        if (u.selectedAgentId !== SAMPLE.agents[1]!.id) {
          expect(drawShellFrame(input({ cols, rows, ui: u, panes: withDetail(SAMPLE) }))).toEqual(base);
        }
      }
    }
  });
});

// Phase 10 plan 10-12 Task 2: the narrowed FILES flag passes through filesModel
// to both the measure and the draw pass (LAYOUT-07).
describe("drawShell: narrowed FILES pass-through (10-12)", () => {
  it("draws the narrowed title and the ↓ N more row when panes.filesNarrowed is set", () => {
    const panes: PanesModel = { ...SAMPLE, filesNarrowed: true };
    const t = texts(drawShell(input({ panes })));
    const files = rowOf(t, (s) => s.startsWith(" FILES "));
    expect(files).toBeGreaterThan(0);
    expect(t[files]).toContain(" FILES  sample  · 14 · esc: all ─");
    expect(t[files]).not.toContain("14 files");
    expect(t.slice(files + 1, files + 9).some((s) => /^ {4}↓ \d+ more/.test(s))).toBe(true);
    // the same height as the unnarrowed frame: the measure saw the same model
    expect(t).toHaveLength(drawShell(input()).length);
  });

  it("draws the unnarrowed FILES title without the flag", () => {
    const t = texts(drawShell(input()));
    expect(t.some((s) => s.includes("esc: all"))).toBe(false);
  });
});

// Phase 10 plan 10-13 (LAYOUT-02, KEYS-02, Pattern 3): identity cursors and
// sticky PHASES / SESSIONS / PORTS windows through the shell.
describe("drawShellFrame: identity cursors and sticky list windows (10-13)", () => {
  const P = SAMPLE.projects[1]!.phases;
  const SESS30 = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, name: `session ${i}`, ago: `${i}m`, live: false }));
  const SIZES: ReadonlyArray<readonly [string, number, number]> = [
    ["split", 175, 24],
    ["S2", 120, 30],
    ["S1", 80, 34],
  ];

  /** The cells a frame's right column (split) or whole width (S1/S2) shows. */
  function rightText(lines: Line[], cols: number, rows: number): string[] {
    const g = geometry(cols, rows);
    return texts(lines).map((s) => (g.split ? cut(s, g.RX, g.RW) : s));
  }

  it.each(SIZES)("%s %ix%i: the PHASES ❯ follows ui.phaseCursor by number and its window is sticky", (_m, cols, rows) => {
    const at = (num: string, scroll?: ScrollState) =>
      drawShellFrame(input({ cols, rows, ui: ui({ focus: "right", rightTab: "phases", phaseCursor: num }), scroll }));
    const a = at(P[9]!.number);
    const cur = rightText(a.lines, cols, rows).filter((s) => s.includes("❯"));
    expect(cur).toHaveLength(1);
    expect(cur[0]).toContain("dashboard redesign");
    expect(a.scroll.phases.offset).toBeGreaterThan(0);
    expect(a.scroll.phases.visible).toBeGreaterThan(0);
    // the same cursor with the window fed back: it does not move
    expect(at(P[9]!.number, a.scroll).scroll.phases).toEqual(a.scroll.phases);
    // one phase up: the window stays while the cursor keeps its 1-phase top margin
    const b = at(P[8]!.number, a.scroll);
    if (8 >= a.scroll.phases.offset + 1) expect(b.scroll.phases.offset).toBe(a.scroll.phases.offset);
    else expect(b.scroll.phases.offset).toBeLessThan(a.scroll.phases.offset);
    expect(rightText(b.lines, cols, rows).find((s) => s.includes("❯"))).toContain("prompt weighting heuristic");
  });

  it("an unknown ui.phaseCursor falls back to the current phase", () => {
    const f = drawShellFrame(input({ ui: ui({ focus: "right", rightTab: "phases", phaseCursor: "99" }) }));
    const cur = rightText(f.lines, 175, 55).filter((s) => s.includes("❯"));
    expect(cur).toHaveLength(1);
    expect(cur[0]).toContain("ci pipeline monitoring");
  });

  it.each(SIZES)("%s %ix%i: the SESSIONS ▸ follows panes.sessionCursor by id; the window is sticky", (_m, cols, rows) => {
    const at = (id: string, scroll?: ScrollState) =>
      drawShellFrame(
        input({
          cols,
          rows,
          ui: ui({ focus: "right", rightTab: "sessions" }),
          panes: { ...SAMPLE, sessions: SESS30, sessionCursor: id },
          scroll,
        }),
      );
    const a = at("s25");
    const cur = rightText(a.lines, cols, rows).filter((s) => s.includes("▸"));
    expect(cur).toHaveLength(1);
    expect(cur[0]).toContain("session 25");
    expect(a.scroll.sessions.offset).toBeGreaterThan(0);
    const b = at("s24", a.scroll);
    expect(b.scroll.sessions.offset).toBe(a.scroll.sessions.offset);
    expect(rightText(b.lines, cols, rows).find((s) => s.includes("▸"))).toContain("session 24");
  });

  it("panes.sessionCursor absent keeps the first-session cursor; null draws none", () => {
    const tab = ui({ focus: "right", rightTab: "sessions" });
    const a = rightText(drawShellFrame(input({ ui: tab })).lines, 175, 55).filter((s) => s.includes("▸"));
    expect(a).toHaveLength(1);
    expect(a[0]).toContain(SAMPLE.sessions[0]!.name);
    const b = drawShellFrame(input({ ui: tab, panes: { ...SAMPLE, sessionCursor: null } }));
    expect(rightText(b.lines, 175, 55).some((s) => s.includes("▸"))).toBe(false);
  });

  it("panes.sessionsScanning draws scanning… for an empty list", () => {
    const f = drawShellFrame(
      input({ ui: ui({ rightTab: "sessions" }), panes: { ...SAMPLE, sessions: [], sessionsScanning: true } }),
    );
    expect(rightText(f.lines, 175, 55).some((s) => s.includes("scanning…"))).toBe(true);
  });

  it.each(SIZES)("%s %ix%i: ui.portCursor present / null / absent (fails closed, open question 4)", (_m, cols, rows) => {
    const at = (portCursor: string | null) =>
      rightText(drawShellFrame(input({ cols, rows, ui: ui({ focus: "ports", portCursor }) })).lines, cols, rows).filter(
        (s) => s.includes("❯"),
      );
    const present = at("5173");
    expect(present).toHaveLength(1);
    expect(present[0]).toMatch(/❯ :5173 /);
    const first = at(null);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(new RegExp(`❯ :${SAMPLE.ports[0]!.port} `));
    expect(at("gone")).toHaveLength(0);
  });

  it.each(SIZES)("%s %ix%i: the PORTS window is sticky", (_m, cols, rows) => {
    const ports = Array.from({ length: 20 }, (_, i) => ({
      key: `k${i}`,
      port: 4000 + i,
      proc: "node",
      pid: 100 + i,
      exposed: false,
      owner: null,
    }));
    const at = (key: string, scroll?: ScrollState) =>
      drawShellFrame(input({ cols, rows, ui: ui({ focus: "ports", portCursor: key }), panes: { ...SAMPLE, ports }, scroll }));
    const a = at("k18");
    expect(rightText(a.lines, cols, rows).find((s) => s.includes("❯"))).toMatch(/❯ :4018 /);
    expect(a.scroll.ports.offset).toBeGreaterThan(0);
    const b = at("k17", a.scroll);
    expect(b.scroll.ports.offset).toBe(a.scroll.ports.offset);
    expect(rightText(b.lines, cols, rows).find((s) => s.includes("❯"))).toMatch(/❯ :4017 /);
  });

  it("no cursors: feeding the reported scroll back draws the same frames", () => {
    for (const [, cols, rows] of [...SIZES, ["primary", 175, 55] as const]) {
      for (const focus of ["agents", "right", "ports"] as const) {
        for (const rightTab of ["phases", "sessions"] as const) {
          const base = input({ cols, rows, ui: ui({ focus, rightTab }) });
          const a = drawShellFrame(base);
          const b = drawShellFrame({ ...base, scroll: a.scroll });
          expect(b.lines).toEqual(a.lines);
          expect(b.lines).toEqual(drawShell(base));
          expect(b.scroll).toEqual(a.scroll);
        }
      }
    }
  });
});
