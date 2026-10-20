/**
 * v2 security copies (Phase 9, plan 09-09; RESEARCH Pitfall 5 / Pitfall 6).
 *
 * Every shipped sanitize / no-ESC / 24-grapheme protection is copied here onto
 * the v2 draw functions BEFORE plans 09-10 / 09-11 move any legacy code, so the
 * protections survive when Phases 10-11 delete the `legacy-layout:` tests
 * (T-09-12). Each copy keeps the legacy PAYLOAD and its POSITIVE assertion
 * verbatim (Ink 8 already strips ESC, so a negative-only assertion would pass
 * even without sanitize); only the render target is adapted. Each also gets a
 * Seg-level "no C0/C1 code point" check. Fields v2 does not render get an
 * explicit absence test. Every test name starts with its threat ID.
 *
 * Threat checklist:
 *
 * | #  | Threat ID (legacy source)                        | v2 target                                   | Kind    |
 * |----|--------------------------------------------------|---------------------------------------------|---------|
 * | 1  | T-1-02 (sanitize.test.ts, all 6 cases)           | oneLine / plainText / Screen.put + a sweep  | copy    |
 * |    |                                                  | of every dynamic field (card, FILES,        |         |
 * |    |                                                  | PHASES, SESSIONS, PORTS, header, footer)    |         |
 * | 2  | T-03.1-05 (Card.test 226-235)                    | drawFilesPane read path                     | copy    |
 * | 3  | port-command sanitize (Card.test 1067-1073)      | drawPortsPane proc                          | copy    |
 * | 4  | T-04.2-05 (Card.test 1344-1354)                  | drawPhases project + phase name             | copy    |
 * | 5  | NAME-02 H4 (Card.test 1624-1630)                 | drawCard name cap                           | copy    |
 * | 6  | NAME-02 H5 (Card.test 1632-1636)                 | drawCard name controls -> space             | copy    |
 * | 7  | NAME-02 B2 (Card.test 1685-1700)                 | drawFilesPane conflict name cap             | copy    |
 * | 8  | NAME_CAP / truncateLabel (label.test 33-60)      | nameText                                    | copy    |
 * | 9  | T-08-18 P8 (Card.test 1901-1915)                 | drawSessions at width 40, CJK names         | copy    |
 * | 10 | T-08-01 P9 (Card.test 1917-1935)                 | drawSessions name + status                  | copy    |
 * | 11 | T-04-05 intent (Card.test 408-413)               | not rendered in P9 (D-09; detail strip P10) | absence |
 * | 12 | T-04.3-02 skill/subagent (Card.test 485-493)     | skill not rendered; SUBAGENT xN numeric     | absence |
 * | 13 | T-BR-02 target_branch (Card.test 532-539)        | not rendered; current branch positive copy  | absence |
 * | 14 | 260927-8ge tty (Card.test 991-1000)              | tty not rendered in PORTS                   | absence |
 * | 15 | 261017-sbh OSC-8 link + osc8 (Card.test 86-93,   | v2 draws no hyperlink                       | absence |
 * |    | 1970-1999)                                       |                                             |         |
 * | 16 | Pitfall 5 SGR payload (new)                      | card prompt, Seg + ScreenView/renderCapture | new     |
 * | 17 | Pitfall 5 Seg-level (new)                        | drawShell over the hostile fixture          | new     |
 * | 18 | Pitfall 6 width spoofing (new)                   | emoji/CJK/ZWJ/combining/RLO names           | new     |
 * | 19 | Ink path (new)                                   | ScreenView + renderCapture of the shell     | new     |
 *
 * Every control character is built with String.fromCharCode / fromCodePoint
 * so this source stays free of literal control bytes.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import React from "react";
import { Screen, lineText, lineWidth, type Line } from "./screen.js";
import { cellWidth, graphemes, isControlCp, nameText, oneLine, plainText } from "./text.js";
import { NAME_CAP, truncateLabel } from "../../label.js";
import { initialUi, type UiState } from "./uiState.js";
import { SAMPLE, SAMPLE_HEADER } from "./sample.js";
import type { AgentCard, FileGroup, HeaderModel, PanesModel, PortEntry } from "./models.js";
import { drawCard } from "./draw/agents.js";
import { drawFilesPane } from "./draw/files.js";
import { drawPhases } from "./draw/phases.js";
import { drawSessions } from "./draw/sessions.js";
import { drawPortsPane } from "./draw/ports.js";
import { drawHeader } from "./draw/header.js";
import { drawFooter } from "./draw/footer.js";
import { drawShell, type ShellInput } from "./draw/shell.js";
import { ScreenView } from "./ScreenView.js";
import { renderCapture, frameLines } from "./test-harness.js";

// --- helpers (ESC + stripAnsi copied verbatim from Card.test.tsx 54-61) ------

const ESC = String.fromCharCode(27); // 0x1B

/** Strip SGR/ANSI escape sequences so raw glyph + column positions can be
 * asserted. The box border uses `│` (U+2502), NOT the ASCII `|` (0x7C) our file
 * lines use as the name|dir separator, so `indexOf("|")` locates the separator. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");
}

const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b);
const DEL = String.fromCharCode(0x7f);
const C1 = String.fromCharCode(0x85);
const NBSP = String.fromCharCode(0x00a0);
const E = String.fromCodePoint(0x2026);
const RLO = String.fromCodePoint(0x202e);
const TIMES = String.fromCodePoint(0x00d7);
const INTENT_MARK = String.fromCodePoint(0x00bb);
const SKILL_GEAR = String.fromCodePoint(0x2699);
const NOT_EQUAL = String.fromCodePoint(0x2260);

/** The legacy one-field payload. */
const EVIL = "ev" + ESC + "il";

/** The first control code point found in any Seg, or null. */
function controlIn(lines: Line[]): string | null {
  for (const l of lines) {
    for (const s of l) {
      for (const ch of s.text) {
        const cp = ch.codePointAt(0) ?? 0;
        if (isControlCp(cp)) return `U+${cp.toString(16)} in ${JSON.stringify(s.text)}`;
      }
    }
  }
  return null;
}

const texts = (lines: Line[]): string[] => lines.map((l) => lineText(l));
const joined = (lines: Line[]): string => texts(lines).join("\n");
const segText = (lines: Line[]): string => lines.map((l) => l.map((s) => s.text).join("")).join("\n");

function screen(w = 200, h = 40): Screen {
  return new Screen(w, h);
}

const WAITING_CARD: AgentCard = SAMPLE.agents[1]!;

function card(over: Partial<AgentCard>, w = 60): Line[] {
  const scr = screen(w, 8);
  drawCard(scr, 0, 0, { ...WAITING_CARD, ...over }, { tick: 0, index: 0, selected: false, dimmed: false });
  return scr.toLines();
}

function files(m: { conflicts?: PanesModel["conflicts"]; groups?: FileGroup[] }, w = 96): Line[] {
  const scr = screen(w, 12);
  drawFilesPane(scr, { x: 0, y: 0, w, h: 10 }, {
    conflicts: m.conflicts ?? [],
    groups: m.groups ?? [],
    paused: false,
    step: 0,
    sample: false,
  });
  return scr.toLines();
}

function group(path: string, kind: "write" | "read" = "read", name = "group"): FileGroup {
  return { agentId: "a1", name, state: "running", files: [{ path, kind }] };
}

function phases(project: PanesModel["projects"][number], w = 74): Line[] {
  const scr = screen(w, 30);
  drawPhases(scr, { x: 0, y: 0, w, h: 25 }, { projects: [project], projectIndex: 0, focused: false, cursor: null });
  return scr.toLines();
}

function sessions(m: { sessions: PanesModel["sessions"]; status?: PanesModel["sessionStatus"] }, w = 74): {
  lines: Line[];
  rows: number;
} {
  const scr = screen(w, 20);
  const rows = drawSessions(scr, { x: 0, y: 0, w, h: 15 }, {
    sessions: m.sessions,
    focused: true,
    cursorId: m.sessions[0]?.id ?? null,
    status: m.status ?? null,
    scanning: false,
  });
  return { lines: scr.toLines(), rows };
}

function ports(list: PortEntry[], w = 74): Line[] {
  const scr = screen(w, 20);
  drawPortsPane(scr, { x: 0, y: 0, w, h: 18 }, { ports: list, focused: true, cursorKey: list[0]?.key ?? null, sample: false });
  return scr.toLines();
}

function port(over: Partial<PortEntry>): PortEntry {
  return { key: "k1", port: 3000, proc: "bun", pid: 4242, exposed: false, owner: null, ...over };
}

function shellInput(over: Partial<ShellInput> = {}): ShellInput {
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

/** SAMPLE with `p` injected into every dynamic string field (ids kept for cursors). */
function hostilePanes(p: string): PanesModel {
  return {
    ...SAMPLE,
    agents: SAMPLE.agents.map((a) => ({
      ...a,
      name: p,
      dir: p,
      branch: p,
      uptime: p,
      model: p,
      prompt: p,
      waitFor: a.waitFor === null ? null : p,
    })),
    idle: SAMPLE.idle.map((s) => ({ ...s, name: p, ago: p })),
    conflicts: SAMPLE.conflicts.map(() => ({ a: p, b: p, path: p })),
    groups: SAMPLE.groups.map((g) => ({ ...g, name: p, files: g.files.map((f) => ({ ...f, path: p + f.path })) })),
    projects: SAMPLE.projects.map((pr) => ({
      ...pr,
      name: p,
      dir: p,
      phases: pr.phases.map((ph) => ({ ...ph, number: p, name: p })),
    })),
    sessions: SAMPLE.sessions.map((s) => ({ ...s, name: p, ago: p })),
    sessionStatus: { text: p, ok: false },
    ports: SAMPLE.ports.map((x) => ({ ...x, proc: p, owner: x.owner === null ? null : p })),
  };
}

function hostileHeader(p: string): HeaderModel {
  return { ...SAMPLE_HEADER, clock: p, update: p };
}

const UI_STATES: UiState[] = [
  initialUi,
  { ...initialUi, focus: "right" },
  { ...initialUi, focus: "ports" },
  { ...initialUi, rightTab: "sessions", focus: "right" },
  { ...initialUi, filesPaused: true },
  { ...initialUi, selectedAgentId: SAMPLE.agents[2]!.id },
];

/** Every Phase 9 shell frame over a hostile fixture, at several sizes and states. */
function hostileFrames(p: string, extra?: (m: PanesModel) => PanesModel): Line[][] {
  const panes = extra ? extra(hostilePanes(p)) : hostilePanes(p);
  const out: Line[][] = [];
  for (const [rows, cols] of [
    [55, 175],
    [24, 80],
    [40, 120],
    [55, 220],
  ] as const) {
    for (const ui of UI_STATES) {
      out.push(
        drawShell(
          shellInput({ rows, cols, ui, panes, header: hostileHeader(p), flash: { text: p, ok: false } }),
        ),
      );
    }
  }
  return out;
}

// --- 1. T-1-02 -----------------------------------------------------------------

describe("T-1-02 render-boundary control-char strip (sanitize.test.ts copies)", () => {
  it("T-1-02 leaves clean printable text intact", () => {
    expect(oneLine("safe")).toBe("safe");
    expect(oneLine("src/panel/App.tsx")).toBe("src/panel/App.tsx");
    expect(plainText("src/panel/App.tsx", 80)).toBe("src/panel/App.tsx");
  });

  it("T-1-02 removes an ESC (0x1B) byte so an ANSI sequence cannot spoof the panel", () => {
    const bad = "a" + ESC + "[31mX";
    const out = oneLine(bad);
    expect(out).not.toContain(ESC);
    expect(out).toBe("a[31mX");
  });

  it("T-1-02 strips the full C0 range 0x00-0x1F (ASCII whitespace collapses to one space)", () => {
    for (let c = 0x00; c <= 0x1f; c++) {
      const ws = c >= 0x09 && c <= 0x0d;
      expect(oneLine("x" + String.fromCharCode(c) + "y")).toBe(ws ? "x y" : "xy");
      // Screen.put is the second line of defence: the raw control never reaches a Seg
      const scr = screen(10, 1);
      scr.put(0, 0, "x" + String.fromCharCode(c) + "y");
      expect(lineText(scr.toLines()[0] as Line)).toBe("xy");
      expect(controlIn(scr.toLines())).toBeNull();
    }
  });

  it("T-1-02 strips the C1 range 0x80-0x9F", () => {
    for (let c = 0x80; c <= 0x9f; c++) {
      expect(oneLine("x" + String.fromCharCode(c) + "y")).toBe("xy");
      const scr = screen(10, 1);
      scr.put(0, 0, "x" + String.fromCharCode(c) + "y");
      expect(lineText(scr.toLines()[0] as Line)).toBe("xy");
    }
  });

  it("T-1-02 keeps printable characters at/above 0xA0 (accented latin, greek, symbols)", () => {
    expect(oneLine("café")).toBe("café");
    expect(oneLine("Ω branch")).toBe("Ω branch");
    expect(oneLine("a" + NBSP + "b")).toBe("a" + NBSP + "b"); // NBSP (0xA0) is not a control char
  });

  it("T-1-02 coerces non-string input to a string without throwing", () => {
    expect(oneLine(undefined)).toBe("undefined");
    expect(oneLine(42)).toBe("42");
    expect(oneLine(null)).toBe("null");
  });

  describe("T-1-02 field sweep: one ESC injection per dynamic field, positive text kept", () => {
    const fields: Array<keyof AgentCard> = ["dir", "branch", "uptime", "model", "prompt", "waitFor"];
    for (const f of fields) {
      it(`T-1-02 card ${f}`, () => {
        const lines = card({ [f]: EVIL } as Partial<AgentCard>);
        expect(joined(lines)).toContain("evil");
        expect(controlIn(lines)).toBeNull();
      });
    }

    it("T-1-02 card name (NAME-02: control -> space)", () => {
      const lines = card({ name: EVIL });
      expect(texts(lines)[1]).toContain("ev il");
      expect(controlIn(lines)).toBeNull();
    });

    it("T-1-02 file path", () => {
      const lines = files({ groups: [group("src/" + EVIL + ".ts", "write")] });
      expect(joined(lines)).toContain("src/evil.ts");
      expect(controlIn(lines)).toBeNull();
    });

    it("T-1-02 conflict names and path", () => {
      const lines = files({ conflicts: [{ a: EVIL, b: "x" + EVIL, path: "src/" + EVIL + ".js" }] });
      const row = texts(lines)[1] as string;
      expect(row).toContain("ev il");
      expect(row).toContain("xev il");
      expect(row).toContain("src/evil.js");
      expect(controlIn(lines)).toBeNull();
    });

    it("T-1-02 project name, phase number and phase name", () => {
      const lines = phases({
        name: "pro" + EVIL,
        dir: "d" + EVIL,
        phases: [{ number: "3" + ESC + "3", name: EVIL, status: "current", plansDone: 1, plansTotal: 2 }],
      });
      const out = joined(lines);
      expect(out).toContain("proevil");
      expect(out).toContain("devil");
      expect(out).toContain("33");
      expect(out).toContain("evil");
      expect(controlIn(lines)).toBeNull();
    });

    it("T-1-02 session name and status", () => {
      const { lines } = sessions({
        sessions: [{ id: "s1", name: EVIL, ago: "1h", live: true }],
        status: { text: "st" + EVIL, ok: false },
      });
      const out = joined(lines);
      expect(out).toContain("evil");
      expect(out).toContain("stevil");
      expect(controlIn(lines)).toBeNull();
    });

    it("T-1-02 port proc and owner", () => {
      const lines = ports([port({ proc: EVIL, owner: "own" + EVIL })]);
      const out = joined(lines);
      expect(out).toContain("evil");
      expect(out).toContain("ownev il");
      expect(controlIn(lines)).toBeNull();
    });

    it("T-1-02 header update notice", () => {
      const scr = screen(175, 1);
      drawHeader(scr, 175, { ...SAMPLE_HEADER, update: "update " + EVIL });
      expect(joined(scr.toLines())).toContain("update evil");
      expect(controlIn(scr.toLines())).toBeNull();
    });

    it("T-1-02 footer flash", () => {
      const scr = screen(175, 1);
      drawFooter(scr, 0, 175, { hints: [], keysOff: false, flash: { text: "copied " + EVIL, ok: true } });
      expect(joined(scr.toLines())).toContain("copied evil");
      expect(controlIn(scr.toLines())).toBeNull();
    });
  });
});

// --- 2-4. FILES / PORTS / PHASES ESC copies ------------------------------------

describe("T-03.1-05 / port-command / T-04.2-05 ESC copies", () => {
  it("T-03.1-05 sanitizes an ESC byte embedded in a read file_path before render", () => {
    const lines = files({ groups: [group("/repo/ev" + ESC + "il.ts", "read")] });
    const out = joined(lines);
    expect(out).toContain("evil.ts"); // ESC stripped, basename intact
    expect(out).toContain("/repo"); // directory portion
    const readLine = out.split("\n").find((l) => l.includes("evil.ts")) ?? "";
    expect(readLine).not.toContain(ESC);
    expect(controlIn(lines)).toBeNull();
  });

  it("port-command sanitize: an injected control byte in a port command before render", () => {
    const lines = ports([port({ proc: "ev" + ESC + "il", port: 3000 })]);
    const out = joined(lines);
    expect(out).toContain("evil"); // ESC stripped, name intact
    const line = out.split("\n").find((l) => l.includes("evil")) ?? "";
    expect(line).not.toContain(ESC);
    expect(controlIn(lines)).toBeNull();
  });

  it("T-04.2-05 sanitizes control bytes in the project name and a phase name before render", () => {
    const lines = phases({
      name: "mile" + ESC + "[2Jstone",
      dir: "CSM",
      phases: [{ number: "01", name: "ev" + ESC + "il", status: "pending", plansDone: 0, plansTotal: 0 }],
    });
    const out = segText(lines);
    expect(out).not.toContain(ESC); // the C0 control byte is stripped everywhere
    expect(out).toContain("evil"); // the printable remainder survives
    expect(out).toContain("mile[2Jstone");
    expect(controlIn(lines)).toBeNull();
  });
});

// --- 5-8. NAME-02 -----------------------------------------------------------------

describe("NAME-02 name pipeline copies (H4 / H5 / B2 / NAME_CAP)", () => {
  it("H4: a long name is capped at 24 graphemes plus an ellipsis", () => {
    const out = stripAnsi(joined(card({ name: "Logitech MK295 Mac tutukluluk sorunu" })));
    expect(out).toContain("Logitech MK295 Mac tutuk" + E);
    expect(out).not.toContain("tutukluluk");
  });

  it("H5: control bytes in the name become a space before render (WR-02)", () => {
    const lines = card({ name: "ev" + ESC + "[2Jil" });
    const raw = segText(lines);
    expect(raw).not.toContain(ESC + "[2J");
    expect(texts(lines)[1]).toContain("ev [2Jil");
    expect(controlIn(lines)).toBeNull();
  });

  it("B2: a long conflict name is capped at 24 graphemes plus an ellipsis (then width-cut)", () => {
    const long = "Logitech MK295 Mac tutukluluk sorunu";
    // the cap itself, before the FILES 21-cell width cut
    expect(nameText(long, 200)).toBe("Logitech MK295 Mac tutuk" + E);
    const lines = files({ conflicts: [{ a: long, b: "folderB", path: "src/x.ts" }] }, 200);
    const row = texts(lines)[1] as string;
    expect(row).toContain("Logitech MK295 Mac t" + E);
    // the 25th grapheme ("l" of tutukluluk) is never shown
    expect(row).not.toContain("tutukl");
  });

  it("NAME_CAP is 24 (D-09)", () => {
    expect(NAME_CAP).toBe(24);
  });

  it("NAME_CAP: a string of exactly 24 graphemes is unchanged", () => {
    const s = "abcdefghijklmnopqrstuvwx";
    expect(s.length).toBe(24);
    expect(nameText(s, 100)).toBe(s);
    expect(truncateLabel(s)).toBe(s);
  });

  it("NAME_CAP: a 25-grapheme string is capped to 24 plus the ellipsis", () => {
    expect(nameText("abcdefghijklmnopqrstuvwxy", 100)).toBe("abcdefghijklmnopqrstuvwx" + E);
  });

  it("NAME_CAP: the lockstep fixture 'Logitech MK295 Mac tutukluluk sorunu'", () => {
    expect(nameText("Logitech MK295 Mac tutukluluk sorunu", 100)).toBe("Logitech MK295 Mac tutuk" + E);
  });
});

// --- 9-10. SESSIONS ----------------------------------------------------------------

describe("T-08-18 / T-08-01 SESSIONS copies", () => {
  it("T-08-18 P8: a wide label never wraps; each row stays one line at 40 columns", () => {
    const wide = "漢".repeat(14) + E;
    const { lines, rows } = sessions(
      {
        sessions: [
          { id: "r1", name: wide, ago: "3d", live: false },
          { id: "r2", name: wide, ago: "4d", live: false },
        ],
      },
      40,
    );
    for (const l of lines) expect(lineWidth(l)).toBeLessThanOrEqual(40);
    const used = texts(lines).filter((l) => l.trim().length > 0);
    expect(used.length).toBe(2); // 2 entries, no wrapped continuation lines
    expect(rows).toBe(2);
  });

  it("T-08-01 P9: control bytes in name and status never reach the terminal", () => {
    const { lines } = sessions({
      sessions: [{ id: "s1", name: "ev" + ESC + "[2J" + CSI + "il", ago: "1h", live: true }],
      status: { text: "st" + ESC + "]0;x" + BEL + "atus", ok: false },
    });
    for (const l of lines) {
      for (const s of l) {
        for (const ch of s.text) {
          const cp = ch.codePointAt(0) ?? 0;
          expect(cp < 0x20 || (cp >= 0x80 && cp <= 0x9f)).toBe(false);
        }
      }
    }
    const raw = segText(lines);
    expect(raw).toContain("ev[2Jil");
    expect(raw).toContain("st]0;xatus");
  });
});

// --- 11-15. absence tests ------------------------------------------------------------

describe("absence: fields v2 does not render in Phase 9", () => {
  it("T-04-05 intent: AgentCard has no intent field and the shell never draws the intent marker", () => {
    // P10 converts this to a positive copy against the detail strip.
    expectTypeOf<AgentCard>().not.toHaveProperty("intent");
    expect(Object.keys(SAMPLE.agents[0]!)).not.toContain("intent");
    const withIntent = (m: PanesModel): PanesModel => ({
      ...m,
      agents: m.agents.map((a) => ({ ...a, intent: "hack" + ESC + "ed" }) as AgentCard),
    });
    for (const f of hostileFrames("hack" + ESC + "ed", withIntent)) {
      expect(joined(f)).not.toContain(INTENT_MARK);
      expect(controlIn(f)).toBeNull();
    }
  });

  it("T-04.3-02 skill/subagent: no skill gear, and the SUBAGENT label is numeric only", () => {
    expectTypeOf<AgentCard>().not.toHaveProperty("skill");
    const withSkill = (m: PanesModel): PanesModel => ({
      ...m,
      agents: m.agents.map(
        (a) => ({ ...a, skill: "gsd" + ESC + "quick", skill_subagent: "gsd" + ESC + "exec" }) as AgentCard,
      ),
    });
    for (const f of hostileFrames("x", withSkill)) {
      const out = joined(f);
      expect(out).not.toContain(SKILL_GEAR);
      expect(out).not.toContain("gsdquick");
      expect(out).not.toContain("gsdexec");
    }
    const frame = joined(drawShell(shellInput()));
    expect(frame).toMatch(new RegExp("SUBAGENT " + TIMES + "\\d+"));
    // a hostile subagent count still renders as a number
    const lines = card({ state: "subagent", subagents: Number.NaN });
    expect(texts(lines)[5]).toMatch(new RegExp("SUBAGENT " + TIMES + "\\d+"));
  });

  it("T-BR-02 target_branch: not rendered; the current branch keeps its positive copy", () => {
    expectTypeOf<AgentCard>().not.toHaveProperty("target_branch");
    expectTypeOf<AgentCard>().not.toHaveProperty("targetBranch");
    const withTarget = (m: PanesModel): PanesModel => ({
      ...m,
      agents: m.agents.map((a) => ({ ...a, target_branch: "feat" + ESC + "ure" }) as AgentCard),
    });
    for (const f of hostileFrames("x", withTarget)) {
      const out = joined(f);
      expect(out).not.toContain(NOT_EQUAL);
      expect(out).not.toContain("feature");
    }
    const lines = card({ branch: "feat" + ESC + "ure" });
    expect(joined(lines)).toContain("feature"); // ESC stripped, name intact
    const line = joined(lines).split("\n").find((l) => l.includes("feature")) ?? "";
    expect(line).not.toContain(ESC);
  });

  it("260927-8ge tty: PortEntry has no tty field and no PORTS row shows a tty", () => {
    expectTypeOf<PortEntry>().not.toHaveProperty("tty");
    const list = [
      { ...port({ key: "a", pid: 555, port: 4000 }), tty: "ttys013" },
      { ...port({ key: "b", pid: 556, port: 4001 }), tty: "tty" + ESC + "s9" },
    ] as unknown as PortEntry[];
    const out = joined(ports(list));
    expect(out).toContain(":4000");
    expect(out).toContain("pid 555");
    expect(out).not.toContain("tty");
    const shellPorts = (m: PanesModel): PanesModel => ({
      ...m,
      ports: m.ports.map((p) => ({ ...p, tty: "ttys013" }) as PortEntry),
    });
    for (const f of hostileFrames("x", shellPorts)) expect(joined(f)).not.toContain("tty");
  });

  it("261017-sbh OSC-8: no Seg across the hostile shell carries ESC or the ]8; introducer", () => {
    const withLink = (m: PanesModel): PanesModel => ({
      ...m,
      agents: m.agents.map(
        (a) => ({ ...a, warp: { focus_url: "warp://x" + ESC + "evil" } }) as unknown as AgentCard,
      ),
    });
    for (const f of hostileFrames(EVIL + C1 + DEL, withLink)) {
      const raw = segText(f);
      expect(raw).not.toContain(ESC);
      expect(raw).not.toContain("]8;");
      expect(raw).not.toContain("warp://");
      // the card's legacy `go to pane` link label is never drawn in a pane row
      // (the footer's `⏎ go to pane` key hint for a selected card is keymap text)
      expect(segText(f.slice(0, -1))).not.toContain("go to pane");
    }
  });
});

// --- 16-19. new Pitfall 5 / 6 tests -----------------------------------------------

describe("Pitfall 5 / Pitfall 6 (new)", () => {
  it("SGR payload: a card prompt x ESC [31m y draws as the visible text x[31my", () => {
    const lines = card({ prompt: "x" + ESC + "[31my" });
    expect(segText(lines)).toContain("x[31my");
    expect(controlIn(lines)).toBeNull();
    const { lastFrame, inst } = renderCapture(<ScreenView lines={lines} />, { columns: 80, rows: 10 });
    expect(frameLines(lastFrame()).join("\n")).toContain("x[31my");
    inst.unmount();
  });

  it("Seg-level: drawShell over the hostile fixture never yields a control code point (175x55, 80x24)", () => {
    const p = EVIL + C1 + DEL;
    for (const [rows, cols] of [
      [55, 175],
      [24, 80],
    ] as const) {
      for (const ui of UI_STATES) {
        const lines = drawShell(
          shellInput({
            rows,
            cols,
            ui,
            panes: hostilePanes(p),
            header: hostileHeader(p),
            flash: { text: p, ok: true },
          }),
        );
        expect(controlIn(lines)).toBeNull();
        expect(joined(lines)).toContain("evil");
      }
    }
  });

  it("width spoofing: emoji / CJK / ZWJ / combining / RLO names keep every line within cols", () => {
    const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    const mix = RLO + ["漢", String.fromCodePoint(0x1f600), FAMILY, "e" + String.fromCodePoint(0x0301)]
      .join("")
      .repeat(8);
    expect(cellWidth(mix)).toBeGreaterThan(24);
    for (const [rows, cols] of [
      [55, 175],
      [24, 80],
      [40, 120],
    ] as const) {
      for (const ui of UI_STATES) {
        const lines = drawShell(shellInput({ rows, cols, ui, panes: hostilePanes(mix) }));
        for (const l of lines) expect(lineWidth(l)).toBeLessThanOrEqual(cols);
        expect(lines.length).toBeLessThanOrEqual(rows);
        expect(segText(lines)).not.toContain(RLO);
        // a ZWJ family is never split into its parts
        for (const l of lines) {
          for (const s of l) for (const g of graphemes(s.text)) if (g.includes("‍")) expect(g).toBe(FAMILY);
        }
      }
    }
  });

  it("Ink path: the hostile shell through ScreenView keeps the positive strings", () => {
    const panes: PanesModel = {
      ...SAMPLE,
      agents: SAMPLE.agents.map((a, i) =>
        i === 0 ? { ...a, prompt: "x" + ESC + "[31my" } : i === 1 ? { ...a, name: "ev" + ESC + "[2Jil" } : a,
      ),
      // 3000 is an owned port, so it is drawn while PORTS is unfocused
      ports: SAMPLE.ports.map((p) => (p.port === 3000 ? { ...p, proc: EVIL } : p)),
    };
    const lines = drawShell(shellInput({ panes }));
    const { lastFrame, inst } = renderCapture(<ScreenView lines={lines} />, { columns: 175, rows: 55 });
    const frame = frameLines(lastFrame()).join("\n");
    expect(frame).toContain("evil");
    expect(frame).toContain("ev [2Jil");
    expect(frame).toContain("x[31my");
    expect(stripAnsi(lastFrame())).not.toContain(ESC + "[2J");
    inst.unmount();
  });
});
