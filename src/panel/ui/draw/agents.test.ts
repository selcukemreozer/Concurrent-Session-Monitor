import { describe, it, expect } from "vitest";
import { Screen, type Line } from "../screen.js";
import { cellWidth, graphemes } from "../text.js";
import { SAMPLE } from "../sample.js";
import type { AgentCard, IdleStrip } from "../models.js";
import { drawCard, drawIdleStrip, drawAgentsPane } from "./agents.js";

// Phase 9 plan 09-07 Task 1: the session card (D-09, D-11, D-12 look), the
// idle strip (D-10) and the AGENTS grid with whole-card-row clipping (D-08),
// reproduced cell-exactly from the approved 175x55 frame (UI-SPEC 238-280).

interface Cell {
  ch: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

/** One entry per terminal cell (a wide grapheme's tail is a "" cell). */
function cells(line: Line): Cell[] {
  const out: Cell[] = [];
  for (const s of line) {
    for (const g of graphemes(s.text)) {
      const c: Cell = { ch: g };
      if (s.fg !== undefined) c.fg = s.fg;
      if (s.bg !== undefined) c.bg = s.bg;
      if (s.bold) c.bold = true;
      out.push(c);
      for (let i = 1; i < cellWidth(g); i++) out.push({ ch: "" });
    }
  }
  return out;
}

const rowOf = (scr: Screen, y: number): Line => scr.toLines()[y] ?? [];
const cellAt = (scr: Screen, x: number, y: number): Cell => cells(rowOf(scr, y))[x] ?? { ch: " " };

/** Row y as text, cut to cells [from, to) and right-trimmed. */
function text(scr: Screen, y: number, from = 0, to = scr.cols): string {
  return cells(rowOf(scr, y))
    .slice(from, to)
    .map((c) => c.ch)
    .join("")
    .replace(/ +$/, "");
}

/** Cut a fixture string to cells [from, to) and right-trim. */
function cut(s: string, from: number, to: number): string {
  return Array.from(s).slice(from, to).join("").replace(/ +$/, "");
}

const OPTS = { tick: 3, index: 0, selected: false, dimmed: false };

function card(c: AgentCard, o: Partial<typeof OPTS> = {}): Screen {
  const scr = new Screen(47, 7);
  drawCard(scr, 0, 0, c, { ...OPTS, ...o });
  return scr;
}

const A = SAMPLE.agents;
const PLAN = A[0] as AgentCard;
const API = A[1] as AgentCard;
const CHECKOUT = A[2] as AgentCard;
const LANDING = A[3] as AgentCard;
const RESEARCH = A[4] as AgentCard;

const RED = "#F0545A";
const DIM2 = "#5c5a54";
const EDGE = "#3a3936";
const ASK_BG = "#241822";
const RUNNING = "#5FD47A";

// UI-SPEC primary frame rows 2..25 (the AGENTS pane), copied verbatim.
const FRAME_AGENTS = [
  "▐AGENTS▌ sample  ───────────────────────────────────────────────────────────── 5 active · 3 idle  │   PHASES",
  "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  │",
  "│ ? csm p8 plan                               │  │ ◉ api refactor                              │  │",
  "│   CSM · main · 3h51m                        │  │   csm-demo · feat/api · 12m                 │  │",
  "│   opus 4.7                                  │  │   sonnet 4.6                                │  │",
  "│   › plan phase 9 from the design file and…  │  │   › collapse the cart endpoints into one …  │  │",
  "│ ASKING                                   ◦3 │  │ WAITING 4m                            ✎1 ◦1 │  │",
  "└─────────────────────────────────────────────┘  └─────────────────────────────────────────────┘  │",
  "                                                                                                  │",
  "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  │",
  "│ ▶ checkout screen                           │  │ ▶ landing copy                              │  │",
  "│   csm-demo · main · 6m                      │  │   site · main · 22m                         │  │",
  "│   opus 4.7                                  │  │   haiku 4.5                                 │  │",
  "│   › move the coupon field into the cart s…  │  │   › rewrite the hero headline as two shor…  │  │",
  "│ RUNNING ⠏                          !1 ✎2 ◦2 │  │ RUNNING ⠹                                ✎1 │  │",
  "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀  └─────────────────────────────────────────────┘  │",
  "                                                                                                  │",
  "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  │",
  "│ ↻ dashboard research                        │    ● project requirements                   5h    │",
  "│   mvp-dash · main · 53h                     │  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  │",
  "│   opus 4.7                                  │    ● gm country names                      34h    │",
  "│   › compare the three competitor dashboar…  │  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  │",
  "│ SUBAGENT ×2                        !1 ✎1 ◦2 │    ● csm file read write                   53h    │",
  "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀                                                   │",
];

const PANE = {
  agents: SAMPLE.agents,
  idle: SAMPLE.idle,
  focused: true,
  sample: true,
  cardCols: 2,
  tick: 3,
  selectedId: null,
  firstRow: 0,
};

describe("drawCard: the checkout card (running, in conflict)", () => {
  const scr = card(CHECKOUT, { index: 2 });

  it("draws the 7 contract rows", () => {
    expect(text(scr, 0)).toBe("▄".repeat(47));
    expect(text(scr, 1)).toBe("│ ▶ checkout screen                           │");
    expect(text(scr, 2)).toBe("│   csm-demo · main · 6m                      │");
    expect(text(scr, 3)).toBe("│   opus 4.7                                  │");
    expect(text(scr, 4)).toBe("│   › move the coupon field into the cart s…  │");
    expect(text(scr, 5)).toBe("│ RUNNING ⠏                          !1 ✎2 ◦2 │");
    expect(text(scr, 6)).toBe("▀".repeat(47));
  });

  it("colors the edges by state and conflict", () => {
    for (let x = 0; x < 47; x++) {
      expect(cellAt(scr, x, 0).fg).toBe(RUNNING);
      expect(cellAt(scr, x, 6).fg).toBe(RED);
    }
  });

  it("styles the STATE label and the counts", () => {
    expect(cellAt(scr, 2, 5)).toMatchObject({ ch: "R", fg: RUNNING, bold: true });
    expect(cellAt(scr, 37, 5)).toMatchObject({ ch: "!", fg: RED, bold: true });
    expect(cellAt(scr, 38, 5)).toMatchObject({ ch: "1", fg: RED, bold: true });
    expect(cellAt(scr, 40, 5)).toMatchObject({ ch: "✎", fg: "#d6d3cb" });
    expect(cellAt(scr, 43, 5)).toMatchObject({ ch: "◦", fg: "#6FA8FF" });
    expect(cellAt(scr, 44, 5)).toMatchObject({ ch: "2", fg: "#6FA8FF" });
    expect(cellAt(scr, 45, 5).ch).toBe(" ");
    expect(cellAt(scr, 46, 5).ch).toBe("│");
  });

  it("styles icon, name, meta, model and prompt", () => {
    expect(cellAt(scr, 2, 1)).toMatchObject({ ch: "▶", fg: RUNNING, bold: true });
    expect(cellAt(scr, 4, 1)).toMatchObject({ ch: "c", fg: "#f5f3ec", bold: true });
    expect(cellAt(scr, 4, 2)).toMatchObject({ ch: "c", fg: "#85827a" });
    expect(cellAt(scr, 4, 3)).toMatchObject({ ch: "o", fg: "#d6d3cb" });
    expect(cellAt(scr, 4, 4)).toMatchObject({ ch: "›", fg: "#85827a" });
    expect(cellAt(scr, 6, 4)).toMatchObject({ ch: "m", fg: "#d6d3cb" });
    expect(cellAt(scr, 43, 4).ch).toBe("…");
    expect(cellAt(scr, 0, 1)).toMatchObject({ ch: "│", fg: EDGE });
  });
});

describe("drawCard: the asking card", () => {
  const scr = card(PLAN);

  it("shows the last prompt, never a question", () => {
    expect(text(scr, 1)).toContain("? csm p8 plan");
    expect(text(scr, 4)).toContain("› plan phase 9 from the design file and…");
  });

  it("labels ASKING with the read count on the right", () => {
    expect(text(scr, 5).startsWith("│ ASKING")).toBe(true);
    expect(text(scr, 5).endsWith("◦3 │")).toBe(true);
    expect(cellAt(scr, 2, 5)).toMatchObject({ fg: "#E86AD9", bold: true });
  });

  it("closes with the light edge-colored bottom", () => {
    expect(text(scr, 6)).toBe("└" + "─".repeat(45) + "┘");
    for (let x = 0; x < 47; x++) expect(cellAt(scr, x, 6).fg).toBe(EDGE);
  });

  it("tints every interior cell x1..x45 on rows 1-5", () => {
    for (let y = 1; y <= 5; y++) {
      for (let x = 1; x <= 45; x++) expect(cellAt(scr, x, y).bg).toBe(ASK_BG);
      expect(cellAt(scr, 0, y).bg).toBeUndefined();
      expect(cellAt(scr, 46, y).bg).toBeUndefined();
    }
  });
});

describe("drawCard: other states and missing data", () => {
  it("labels WAITING with the wait time", () => {
    expect(text(card(API), 5).startsWith("│ WAITING 4m")).toBe(true);
  });

  it("labels SUBAGENT with the subagent count", () => {
    expect(text(card(RESEARCH), 5).startsWith("│ SUBAGENT ×2")).toBe(true);
  });

  it("shows an em dash for a missing prompt and model", () => {
    const scr = card({ ...LANDING, prompt: null, model: null });
    expect(text(scr, 4)).toBe("│   › —                                       │");
    expect(text(scr, 3)).toBe("│   —                                         │");
  });

  it("omits zero counts", () => {
    const row = text(card(LANDING), 5);
    expect(row.endsWith(" ✎1 │")).toBe(true);
    expect(row).not.toContain("!0");
    expect(row).not.toContain("◦0");
    const none = text(card({ ...LANDING, writes: 0 }), 5);
    expect(none).not.toMatch(/[!✎◦]/);
  });

  it("truncates the branch first in the meta line", () => {
    const scr = card({ ...CHECKOUT, branch: "feature/" + "x".repeat(60) });
    const meta = text(scr, 2, 4, 45);
    expect(meta.startsWith("csm-demo · feature/")).toBe(true);
    expect(meta.endsWith("… · 6m")).toBe(true);
    expect(cellWidth(meta)).toBeLessThanOrEqual(41);
  });

  it("IN-02 keeps the uptime and start-truncates a long dir", () => {
    const scr = card({ ...CHECKOUT, dir: "a-very-long-project-directory-name-here", uptime: "3h 51m" });
    const meta = text(scr, 2, 4, 45);
    expect(meta.endsWith(" · 3h 51m")).toBe(true);
    expect(meta.startsWith("…")).toBe(true);
    expect(meta).toContain("name-here");
    expect(cellWidth(meta)).toBeLessThanOrEqual(41);
  });

  it("IN-02 keeps the uptime with a long dir and a long branch", () => {
    const scr = card({ ...CHECKOUT, dir: "d".repeat(60), branch: "b".repeat(60), uptime: "53h" });
    const meta = text(scr, 2, 4, 45);
    expect(meta.endsWith(" · 53h")).toBe(true);
    expect(cellWidth(meta)).toBeLessThanOrEqual(41);
  });

  it("keeps a long name inside 41 cells", () => {
    const scr = card({ ...CHECKOUT, name: "Logitech MK295 Mac tutukluluk sorunu ve daha fazlasi" });
    expect(text(scr, 1, 4, 45)).toContain("…");
    expect(cellAt(scr, 46, 1).ch).toBe("│");
  });
});

describe("drawCard: spinner", () => {
  it("changes only the spinner cell with the tick", () => {
    const a = card(CHECKOUT, { index: 2, tick: 3 });
    const b = card(CHECKOUT, { index: 2, tick: 4 });
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 47; x++) {
        if (y === 5 && x === 10) continue;
        expect(cellAt(b, x, y)).toEqual(cellAt(a, x, y));
      }
    }
    expect(cellAt(a, 10, 5).ch).toBe("⠏");
    expect(cellAt(b, 10, 5).ch).toBe("⠋");
  });

  it("offsets the frame by 3 per card index", () => {
    expect(cellAt(card(LANDING, { index: 3, tick: 3 }), 10, 5).ch).toBe("⠹");
    expect(cellAt(card(LANDING, { index: 3, tick: 1 }), 10, 5).ch).toBe("⠋");
  });
});

describe("drawCard: selected (heavy frame)", () => {
  const plain = card(CHECKOUT, { index: 2 });
  const sel = card(CHECKOUT, { index: 2, selected: true });

  it("draws the heavy frame in the state color", () => {
    expect(text(sel, 0)).toBe("┏" + "━".repeat(45) + "┓");
    for (let x = 0; x < 47; x++) expect(cellAt(sel, x, 0).fg).toBe(RUNNING);
    for (let y = 1; y <= 5; y++) {
      expect(cellAt(sel, 0, y)).toMatchObject({ ch: "┃", fg: RUNNING });
      expect(cellAt(sel, 46, y)).toMatchObject({ ch: "┃", fg: RUNNING });
    }
  });

  it("draws a red heavy bottom when in conflict", () => {
    expect(text(sel, 6)).toBe("┗" + "━".repeat(45) + "┛");
    for (let x = 0; x < 47; x++) expect(cellAt(sel, x, 6).fg).toBe(RED);
  });

  it("draws the heavy bottom in the state color otherwise", () => {
    const s = card(LANDING, { index: 3, selected: true });
    expect(text(s, 6)).toBe("┗" + "━".repeat(45) + "┛");
    for (let x = 0; x < 47; x++) expect(cellAt(s, x, 6).fg).toBe(RUNNING);
  });

  it("keeps the interior text and styles unchanged", () => {
    for (let y = 1; y <= 5; y++) {
      for (let x = 1; x <= 45; x++) expect(cellAt(sel, x, y)).toEqual(cellAt(plain, x, y));
    }
  });
});

describe("drawCard: dimmed (another card is selected)", () => {
  const scr = card(CHECKOUT, { index: 2, dimmed: true });

  it("dims borders and text to dim2 and the top edge to edge", () => {
    for (let x = 0; x < 47; x++) expect(cellAt(scr, x, 0).fg).toBe(EDGE);
    for (let y = 1; y <= 5; y++) {
      expect(cellAt(scr, 0, y).fg).toBe(DIM2);
      expect(cellAt(scr, 46, y).fg).toBe(DIM2);
    }
    expect(cellAt(scr, 4, 1).fg).toBe(DIM2);
    expect(cellAt(scr, 4, 2).fg).toBe(DIM2);
    expect(cellAt(scr, 4, 3).fg).toBe(DIM2);
    expect(cellAt(scr, 4, 4).fg).toBe(DIM2);
    expect(cellAt(scr, 6, 4).fg).toBe(DIM2);
    expect(cellAt(scr, 2, 5).fg).toBe(DIM2);
    expect(cellAt(scr, 40, 5).fg).toBe(DIM2);
    expect(cellAt(scr, 43, 5).fg).toBe(DIM2);
  });

  it("keeps the state icon in its state color", () => {
    expect(cellAt(scr, 2, 1)).toMatchObject({ ch: "▶", fg: RUNNING });
  });

  it("never dims red: the conflict edge and !N stay #F0545A", () => {
    for (let x = 0; x < 47; x++) expect(cellAt(scr, x, 6)).toMatchObject({ ch: "▀", fg: RED });
    expect(cellAt(scr, 37, 5)).toMatchObject({ ch: "!", fg: RED, bold: true });
    expect(cellAt(scr, 38, 5)).toMatchObject({ ch: "1", fg: RED });
  });

  it("drops the asking tint and dims the light bottom", () => {
    const a = card(PLAN, { dimmed: true });
    for (let y = 1; y <= 5; y++) {
      for (let x = 0; x < 47; x++) expect(cellAt(a, x, y).bg).not.toBe(ASK_BG);
    }
    for (let x = 0; x < 47; x++) expect(cellAt(a, x, 6).fg).toBe(DIM2);
    expect(cellAt(a, 2, 1)).toMatchObject({ ch: "?", fg: "#E86AD9" });
  });
});

describe("drawCard: no legacy lines (D-09)", () => {
  const banned = [0xbb, 0x2699, 0x2260].map((cp) => String.fromCodePoint(cp));

  it("never draws the intent marker, the skill gear or the branch-mismatch sign", () => {
    for (const [i, c] of A.entries()) {
      for (const o of [{}, { selected: true }, { dimmed: true }]) {
        const scr = card(c, { index: i, ...o });
        for (let y = 0; y < 7; y++) {
          for (const b of banned) expect(text(scr, y)).not.toContain(b);
        }
      }
    }
  });
});

describe("drawIdleStrip", () => {
  const strip = (s: IdleStrip, dimmed = false): Screen => {
    const scr = new Screen(47, 2);
    drawIdleStrip(scr, 0, 0, s, { dimmed });
    return scr;
  };
  const scr = strip({ id: "x", name: "project requirements", ago: "5h" });

  it("draws the idle-colored top edge", () => {
    expect(text(scr, 0)).toBe("▄".repeat(47));
    for (let x = 0; x < 47; x++) expect(cellAt(scr, x, 0).fg).toBe("#4a4945");
  });

  it("draws the dot, the name and the right-aligned ago", () => {
    expect(text(scr, 1)).toBe("  ● project requirements".padEnd(43) + "5h");
    expect(cellAt(scr, 2, 1)).toMatchObject({ ch: "●", fg: DIM2 });
    expect(cellAt(scr, 4, 1)).toMatchObject({ ch: "p", fg: "#85827a" });
    expect(cellAt(scr, 43, 1)).toMatchObject({ ch: "5", fg: DIM2 });
    expect(cellAt(scr, 44, 1)).toMatchObject({ ch: "h", fg: DIM2 });
  });

  it("caps a long name at 24 graphemes (NAME-02)", () => {
    const s = strip({ id: "x", name: "n".repeat(60), ago: "34h" });
    expect(text(s, 1)).toBe(("  ● " + "n".repeat(24) + "…").padEnd(42) + "34h");
  });

  it("truncates a wide name by cells before the ago text", () => {
    // 30 two-cell ideographs: label cap 24, then the 47 - 8 - 3 = 36 cell budget
    // keeps 17 (34 cells) + the ellipsis at x38; ago sits at x42..x44.
    const s = strip({ id: "x", name: String.fromCodePoint(0x6f22).repeat(30), ago: "34h" });
    const row = text(s, 1);
    expect(cellAt(s, 38, 1).ch).toBe("…");
    for (const x of [39, 40, 41]) expect(cellAt(s, x, 1).ch).toBe(" ");
    expect(row.endsWith("…   34h")).toBe(true);
    expect(cellWidth(row)).toBe(45);
  });

  it("dims the name and the edge when dimmed", () => {
    const d = strip({ id: "x", name: "project requirements", ago: "5h" }, true);
    expect(cellAt(d, 0, 0).fg).toBe(EDGE);
    expect(cellAt(d, 4, 1).fg).toBe(DIM2);
  });
});

describe("drawAgentsPane: frame fidelity (175x55, rows 2..25)", () => {
  const scr = new Screen(175, 40);
  const res = drawAgentsPane(scr, { x: 0, y: 2, w: 96, h: 24 }, PANE);

  it("reproduces the approved frame's left column exactly", () => {
    for (let i = 0; i < FRAME_AGENTS.length; i++) {
      expect(text(scr, 2 + i, 0, 96)).toBe(cut(FRAME_AGENTS[i] as string, 0, 96));
    }
  });

  it("returns 24 rows with nothing hidden", () => {
    expect(res).toEqual({ rows: 24, moreBelow: 0, firstRow: 0, visibleRows: 3 });
  });

  it("draws nothing outside the rect", () => {
    for (let y = 0; y < 40; y++) expect(text(scr, y, 96)).toBe("");
    expect(text(scr, 26)).toBe("");
    expect(text(scr, 1)).toBe("");
  });
});

describe("drawAgentsPane: clipping by whole card rows (D-08)", () => {
  it("shows one card row and ↓ N more counting hidden cards and strips", () => {
    const scr = new Screen(175, 40);
    const res = drawAgentsPane(scr, { x: 0, y: 2, w: 96, h: 9 }, PANE);
    expect(res).toEqual({ rows: 9, moreBelow: 6, firstRow: 0, visibleRows: 1 });
    expect(text(scr, 10)).toBe("  ↓ 6 more");
    expect(cellAt(scr, 2, 10).fg).toBe("#85827a");
    expect(text(scr, 3, 0, 96)).toBe(cut(FRAME_AGENTS[1] as string, 0, 96));
    for (let y = 11; y < 40; y++) expect(text(scr, y)).toBe("");
  });

  it("shows ↑ N more under the title when scrolled", () => {
    const scr = new Screen(175, 40);
    const res = drawAgentsPane(scr, { x: 0, y: 2, w: 96, h: 17 }, { ...PANE, firstRow: 1 });
    expect(text(scr, 3)).toBe("  ↑ 2 more");
    expect(cellAt(scr, 2, 3).fg).toBe("#85827a");
    expect(text(scr, 4, 0, 96)).toBe(cut(FRAME_AGENTS[9] as string, 0, 96));
    expect(text(scr, 5, 0, 96)).toBe(cut(FRAME_AGENTS[10] as string, 0, 96));
    expect(res).toEqual({ rows: 17, moreBelow: 0, firstRow: 1, visibleRows: 2 });
  });

  it("shows both indicators when scrolled into the middle", () => {
    const many = [...SAMPLE.agents, ...SAMPLE.agents].map((a, i) => ({ ...a, id: `${a.id}-${i}` }));
    const scr = new Screen(175, 60);
    const res = drawAgentsPane(scr, { x: 0, y: 0, w: 96, h: 18 }, { ...PANE, agents: many, firstRow: 1 });
    // 10 cards + 1 idle slot (3 strips) = 6 card rows; rows 1-2 visible,
    // 4 cards + 3 strips hidden below.
    expect(text(scr, 1)).toBe("  ↑ 2 more");
    expect(res.moreBelow).toBe(7);
    expect(text(scr, 1 + 1 + 15)).toBe("  ↓ 7 more");
    expect(res.rows).toBe(18);
  });

  it("keeps every row inside the rect width", () => {
    for (const h of [8, 9, 12, 17, 24, 40]) {
      for (const cardCols of [1, 2, 3]) {
        const scr = new Screen(175, 60);
        const res = drawAgentsPane(scr, { x: 0, y: 0, w: 96, h }, { ...PANE, cardCols });
        expect(res.rows).toBeLessThanOrEqual(h);
        for (let y = 0; y < 60; y++) expect(text(scr, y, 96)).toBe("");
      }
    }
  });

  it("never draws below the rect at any height (09-09 rect clip)", () => {
    for (let h = 1; h <= 30; h++) {
      for (const firstRow of [0, 1]) {
        const scr = new Screen(175, 60);
        const res = drawAgentsPane(scr, { x: 0, y: 5, w: 96, h }, { ...PANE, firstRow });
        expect(res.rows).toBeLessThanOrEqual(h);
        for (let y = 5 + h; y < 60; y++) expect(text(scr, y)).toBe("");
      }
    }
  });

  it("draws one card row without the down row when only 8 rows fit", () => {
    const scr = new Screen(175, 40);
    const res = drawAgentsPane(scr, { x: 0, y: 2, w: 96, h: 8 }, PANE);
    expect(res).toEqual({ rows: 8, moreBelow: 6, firstRow: 0, visibleRows: 1 });
    expect(text(scr, 3, 0, 96)).toBe(cut(FRAME_AGENTS[1] as string, 0, 96));
    for (let y = 10; y < 40; y++) expect(text(scr, y)).toBe("");
  });

  it("draws only the down row when no card row fits", () => {
    const scr = new Screen(175, 40);
    const res = drawAgentsPane(scr, { x: 0, y: 2, w: 96, h: 5 }, PANE);
    expect(res).toEqual({ rows: 2, moreBelow: 8, firstRow: 0, visibleRows: 0 });
    expect(text(scr, 3)).toBe("  ↓ 8 more");
    for (let y = 4; y < 40; y++) expect(text(scr, y)).toBe("");
  });
});

describe("drawAgentsPane: narrower than a card (Phase 10 plan 10-02, WR-06)", () => {
  /** Cells drawn outside `r`, as "x,y". */
  function outside(scr: Screen, r: { x: number; y: number; w: number; h: number }): string[] {
    const out: string[] = [];
    scr.toLines().forEach((l, y) => {
      let x = 0;
      for (const seg of l) {
        for (const g of graphemes(seg.text)) {
          const inside = y >= r.y && y < r.y + r.h && x >= r.x && x < r.x + r.w;
          if (!inside && (g !== " " || seg.bg !== undefined)) out.push(`${x},${y}`);
          x += cellWidth(g);
        }
      }
    });
    return out;
  }

  it("WR-06 w=46: only the title and ↓ 8 more, no card cells, nothing outside r", () => {
    const scr = new Screen(60, 30);
    const r = { x: 3, y: 2, w: 46, h: 20 };
    const res = drawAgentsPane(scr, r, PANE);
    expect(text(scr, 2, 3, 49).startsWith("▐AGENTS▌")).toBe(true);
    expect(text(scr, 3, 3, 49)).toBe("  ↓ 8 more");
    for (let y = 4; y < 30; y++) expect(text(scr, y)).toBe("");
    expect(outside(scr, r)).toEqual([]);
    expect(res).toEqual({ rows: 2, moreBelow: 8, firstRow: 0, visibleRows: 0 });
  });

  it("WR-06 w=46, h=1: the title only", () => {
    const scr = new Screen(60, 30);
    const r = { x: 3, y: 2, w: 46, h: 1 };
    const res = drawAgentsPane(scr, r, PANE);
    expect(res.rows).toBe(1);
    expect(outside(scr, r)).toEqual([]);
  });

  it("WR-06 w=47: one card column as before", () => {
    const scr = new Screen(60, 30);
    const r = { x: 0, y: 2, w: 47, h: 9 };
    drawAgentsPane(scr, r, PANE);
    expect(text(scr, 3, 0, 47)).toMatch(/^▄{47}$/);
    expect(text(scr, 10)).toBe("  ↓ 7 more");
    expect(outside(scr, r)).toEqual([]);
  });

  it.each([1, 2, 5, 7, 30])("WR-06 w=%i: nothing outside r", (w) => {
    for (const h of [0, 1, 2, 3, 9, 20]) {
      const scr = new Screen(60, 30);
      const r = { x: 3, y: 2, w, h };
      drawAgentsPane(scr, r, PANE);
      expect(outside(scr, r), `h=${h}`).toEqual([]);
    }
  });
});

describe("drawAgentsPane: selection look", () => {
  it("draws the selected card heavy and dims the rest", () => {
    const scr = new Screen(175, 40);
    drawAgentsPane(scr, { x: 0, y: 2, w: 96, h: 24 }, { ...PANE, selectedId: CHECKOUT.id });
    expect(cellAt(scr, 0, 11)).toMatchObject({ ch: "┏", fg: RUNNING });
    expect(cellAt(scr, 0, 3).fg).toBe(EDGE);
    expect(cellAt(scr, 4, 4).fg).toBe(DIM2);
    expect(cellAt(scr, 53, 20).fg).toBe(DIM2);
  });
});

describe("drawAgentsPane: calm mode and empty", () => {
  const idle8: IdleStrip[] = Array.from({ length: 8 }, (_, i) => ({ id: `i${i}`, name: `idle ${i}`, ago: `${i + 1}h` }));

  it("fills strips column by column, 3 per column", () => {
    const scr = new Screen(175, 40);
    drawAgentsPane(scr, { x: 0, y: 2, w: 96, h: 24 }, { ...PANE, agents: [], idle: idle8 });
    expect(text(scr, 2, 0, 96).endsWith(" 8 idle")).toBe(true);
    expect(text(scr, 2, 0, 96)).not.toContain("active");
    // slot 0 (x0): strips 0..2 at rows 3/5/7; slot 1 (x49): strips 3..5.
    expect(text(scr, 4, 0, 47)).toBe("  ● idle 0".padEnd(43) + "1h");
    expect(text(scr, 6, 0, 47)).toContain("● idle 1");
    expect(text(scr, 8, 0, 47)).toContain("● idle 2");
    expect(text(scr, 4, 49, 96)).toContain("● idle 3");
    expect(text(scr, 8, 49, 96)).toContain("● idle 5");
    // slot 2 wraps to the next card row (x0, row 11).
    expect(text(scr, 12, 0, 47)).toContain("● idle 6");
    expect(text(scr, 14, 0, 47)).toContain("● idle 7");
  });

  it("shows the empty state with 0 active", () => {
    const scr = new Screen(175, 40);
    const res = drawAgentsPane(scr, { x: 0, y: 2, w: 96, h: 24 }, { ...PANE, agents: [], idle: [] });
    expect(text(scr, 2, 0, 96).endsWith(" 0 active")).toBe(true);
    expect(text(scr, 3)).toBe("  no Claude Code sessions");
    expect(cellAt(scr, 2, 3).fg).toBe("#85827a");
    expect(text(scr, 4)).toBe("  start claude in any project folder; it appears here within a second");
    expect(cellAt(scr, 2, 4).fg).toBe(DIM2);
    expect(res).toEqual({ rows: 3, moreBelow: 0, firstRow: 0, visibleRows: 0 });
  });
});

describe("drawAgentsPane: reports its window (10-08, Pattern 3)", () => {
  it("returns the clamped first card row and the card rows drawn", () => {
    const many = [...SAMPLE.agents, ...SAMPLE.agents].map((a, i) => ({ ...a, id: `${a.id}-${i}` }));
    const scr = new Screen(175, 60);
    const res = drawAgentsPane(scr, { x: 0, y: 0, w: 96, h: 18 }, { ...PANE, agents: many, firstRow: 1 });
    expect(res.firstRow).toBe(1);
    expect(res.visibleRows).toBe(2);
  });

  it("clamps an offset past the end to the last start that fills the rect", () => {
    const many = [...SAMPLE.agents, ...SAMPLE.agents].map((a, i) => ({ ...a, id: `${a.id}-${i}` }));
    const scr = new Screen(175, 60);
    // 6 card rows; h 18 holds the up row + 2 card rows, so the last start is 4
    const res = drawAgentsPane(scr, { x: 0, y: 0, w: 96, h: 18 }, { ...PANE, agents: many, firstRow: 99 });
    expect(res).toMatchObject({ firstRow: 4, visibleRows: 2, moreBelow: 0 });
    expect(text(scr, 1)).toBe("  ↑ 9 more");
  });

  it("clamps the offset to 0 when the whole grid fits", () => {
    const scr = new Screen(175, 40);
    const res = drawAgentsPane(scr, { x: 0, y: 2, w: 96, h: 24 }, { ...PANE, firstRow: 2 });
    expect(res).toEqual({ rows: 24, moreBelow: 0, firstRow: 0, visibleRows: 3 });
    expect(text(scr, 3, 0, 96)).toBe(cut(FRAME_AGENTS[1] as string, 0, 96));
  });
});
