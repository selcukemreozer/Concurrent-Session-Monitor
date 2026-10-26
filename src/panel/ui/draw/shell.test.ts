import { describe, expect, it } from "vitest";
import { lineText, lineWidth, type Line } from "../screen.js";
import { cellWidth, graphemes } from "../text.js";
import { initialUi, type UiState } from "../uiState.js";
import { SAMPLE, SAMPLE_HEADER } from "../sample.js";
import { PALETTE } from "../palette.js";
import { drawTooSmall } from "./tooSmall.js";
import { drawShell, type ShellInput } from "./shell.js";

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
      for (const x of [57, 58, 60, 61]) expect(cellAt(t[y] as string, x)).toBe("");
    }
    // the PORTS half shows the exposed port beside the PHASES body
    expect(t.slice(tabs).some((s) => /:27036 .*⇡ exposed/.test(cut(s, 62, 58)))).toBe(true);
    expect(t.slice(tabs).some((s) => /◉ {2}33/.test(cut(s, 0, 57)))).toBe(true);
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
