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
  "  ■ dashboard research    src/lib/metrics.ts                                                   │  │    :3000   bun",
  "                          src/pages/Overview.tsx                                               │  │      ↳ checkout screen",
  "    ┄┄ back to top ┄┄                                                                          │  │    :5173   vite",
  "  ■ csm p8 plan           .planning/ROADMAP.md                                                 ┃  │      ↳ dashboard research",
  "                          .planning/phase-8.md                                                 ┃  │    :27036  steam_osx   ⇡ exposed",
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

  it("returns exactly the 37 frame lines", () => {
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

  it("stacks AGENTS -> FILES -> PHASES|SESSIONS -> PORTS at 120x40", () => {
    const lines = drawShell(input({ cols: 120, rows: 40 }));
    const t = texts(lines);
    expect(lines.length).toBeLessThanOrEqual(40);
    // full-width AGENTS with 2 card columns
    expect(cellWidth(t[2] as string)).toBe(120);
    const edge = "▄".repeat(47);
    expect(cut(t[3] as string, 0, 47)).toBe(edge);
    expect(cut(t[3] as string, 49, 47)).toBe(edge);
    expect(cut(t[3] as string, 98, 1)).toBe("");
    // no divider column
    for (let x = 0; x < 120; x++) {
      const all = t.slice(2, t.length - 2).every((s) => cellAt(s, x) === "│");
      expect(all).toBe(false);
    }
    const files = rowOf(t, (s) => s.startsWith(" FILES "));
    const tabs = rowOf(t, (s) => s.includes("PHASES") && s.includes("SESSIONS") && s.includes("[r]"));
    const ports = rowOf(t, (s) => s.startsWith(" PORTS "));
    expect(files).toBeGreaterThan(9);
    expect(tabs).toBeGreaterThan(files);
    expect(ports).toBeGreaterThan(tabs);
    expect(t[t.length - 1]).toContain("q quit");
    for (const s of t) expect(cellWidth(s)).toBeLessThanOrEqual(120);
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

  it("expands the focused bottom pane at 80x24 (rows from the ticker and the grid)", () => {
    const rest = measure(24, "agents");
    const foc = measure(24, "right");
    // the 10-row expanded minimum: tabs + spacer + 4 body rows + spacer + PORTS 3
    expect(foc.right).toBeGreaterThanOrEqual(10);
    expect(foc.right).toBeGreaterThan(rest.right);
    // taken from the FILES ticker (down to 0: title + conflict row only) ...
    expect(foc.tabs - foc.files).toBe(2);
    expect(rest.tabs - rest.files).toBeGreaterThan(2);
    // ... while the grid keeps its one card row
    expect(foc.t[9]).toContain("└");
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
