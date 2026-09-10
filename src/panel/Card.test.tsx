import { describe, it, expect } from "vitest";

// RED (wave 01-04): Card.tsx exports the SessionCard component and the osc8 helper.
// RED (wave 02-04): Card.tsx also exports CompactRow and the pure dotColor helper,
// and SessionCard now renders a 3-state dot + compact uptime + best-effort model.
// RED (wave 03-02): Card.tsx also exports the ConflictBand component (PANEL-04) —
// an always-on `⚠` band naming the shared file + every involved session
// (folder·branch·shortid joined by ↔), null when empty, `+X more` past the cap.
// RED (wave 04.1-02): Card.tsx also exports the PortsPane component (PORT-05) —
// the LEFT PORTLAR pane grouping each scanned port under its owning session's
// folder·branch·shortid heading (user bucket last), a magenta/bold `⇅ exposed`
// badge vs dim `local`, intent-enriched headings, PORTS_CAP `+N more`, and a
// `no listening ports` empty state — every field routed through sanitize().
// RED (wave 04.2-02): Card.tsx also exports the PhasesPane component (PANEL-07) —
// the RIGHT FAZLAR pane rendering the focused project's Progress as a milestone
// summary line + a height-bounded scroll window of Phase·Name·Plans·Summaries·
// Status rows with a ▸ current-phase marker + dim-completed styling, a scroll
// indicator, and the D-03 empty states (`no GSD projects` / `no roadmap`) — every
// field routed through sanitize(), reserved palette avoided.
import { osc8, SessionCard, CompactRow, dotColor, ConflictBand, PortsPane, PhasesPane } from "./Card.js";
import { renderToString } from "ink";
import chalk from "chalk";
import type { SessionRow } from "../aggregate.js";
import type { Conflict } from "../conflicts.js";
import type { ScannedPort } from "../ports.js";
import type { Progress, Phase, FocusEntry } from "../phases.js";

const ESC = String.fromCharCode(27); // 0x1B

/** Strip SGR/ANSI escape sequences so raw glyph + column positions can be
 * asserted. The box border uses `│` (U+2502), NOT the ASCII `|` (0x7C) our file
 * lines use as the name|dir separator, so `indexOf("|")` locates the separator. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");
}

/** Minimal SessionRow fixture builder for render assertions. */
function makeRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    schema_version: 1,
    session_id: "abcdef0123456789",
    folder: "my-project",
    branch: "main",
    model: "claude-opus-4",
    start_time: new Date().toISOString(),
    files: [],
    alive: true,
    readyToPrune: false,
    dotState: "active",
    ...over,
  } as SessionRow;
}

describe("osc8 (D-06 clickable Warp go-to-pane hyperlink)", () => {
  it("wraps a url + label in an OSC-8 hyperlink escape sequence", () => {
    const out = osc8("warp://session/abc", "go to pane");
    // opening params: ESC ] 8 ; ; <url>
    expect(out).toContain(ESC + "]8;;warp://session/abc");
    expect(out).toContain("go to pane");
    expect(out.startsWith(ESC)).toBe(true);
  });

  it("sanitizes its url/label inputs so untrusted control bytes cannot inject", () => {
    const out = osc8("warp://x" + ESC + "evil", "lab" + ESC + "el");
    // the ESC embedded in the inputs is stripped; only the wrapper framing remains
    expect(out).toContain("warp://xevil");
    expect(out).toContain("label");
  });
});

describe("SessionCard (D-09 bordered card)", () => {
  it("is a renderable component export", () => {
    expect(typeof SessionCard).toBe("function");
  });
});

describe("dotColor (D-11/D-12 steady 3-state dot mapping)", () => {
  it("maps active->green, idle->yellow, stale->grey", () => {
    expect(dotColor("active")).toBe("green");
    expect(dotColor("idle")).toBe("yellow");
    expect(dotColor("stale")).toBe("grey");
  });
});

describe("SessionCard dot + uptime + model (D-09/D-10/D-11/D-12)", () => {
  it("renders the filled-circle dot glyph for each dotState", () => {
    for (const state of ["active", "idle", "stale"] as const) {
      const out = renderToString(<SessionCard s={makeRow({ dotState: state })} />);
      expect(out).toContain("●");
    }
  });

  it("renders compact uptime at the 2h14m / 42m / 45s boundaries", () => {
    const now = Date.now();
    const twoH = renderToString(
      <SessionCard s={makeRow({ start_time: new Date(now - (2 * 3600e3 + 14 * 60e3 + 500)).toISOString() })} />,
    );
    expect(twoH).toContain("2h 14m");

    const fortyTwo = renderToString(
      <SessionCard s={makeRow({ start_time: new Date(now - (42 * 60e3 + 500)).toISOString() })} />,
    );
    expect(fortyTwo).toContain("42m");

    const fortyFive = renderToString(
      <SessionCard s={makeRow({ start_time: new Date(now - (45e3 + 500)).toISOString() })} />,
    );
    expect(fortyFive).toContain("45s");
  });

  it("renders the model when present", () => {
    const out = renderToString(<SessionCard s={makeRow({ model: "claude-opus-4" })} />);
    expect(out).toContain("claude-opus-4");
  });

  it("falls back to a dash for the 'unknown' model sentinel, never the literal null", () => {
    const out = renderToString(<SessionCard s={makeRow({ model: "unknown" })} />);
    expect(out).not.toContain("null");
    expect(out).toContain("—");
  });

  it("falls back to a dash for an empty model, never the literal null", () => {
    const out = renderToString(<SessionCard s={makeRow({ model: "" })} />);
    expect(out).not.toContain("null");
    expect(out).toContain("—");
  });
});

describe("CompactRow (D-13 one-line overflow row)", () => {
  it("is a renderable component export", () => {
    expect(typeof CompactRow).toBe("function");
  });

  it("renders one line containing shortId + model + uptime + active-file count", () => {
    const now = Date.now();
    const s = makeRow({
      session_id: "deadbeef0000ffff",
      model: "claude-sonnet-4",
      start_time: new Date(now - (42 * 60e3 + 500)).toISOString(),
      files: [
        { file_path: "a.ts", ts: new Date(now).toISOString() },
        { file_path: "b.ts", ts: new Date(now).toISOString() },
      ],
      dotState: "idle",
    });
    const out = renderToString(<CompactRow s={s} />);
    expect(out).toContain("deadbeef"); // first 8 chars of session_id
    expect(out).toContain("claude-sonnet-4");
    expect(out).toContain("42m");
    expect(out).toContain("2f"); // active-file count with 'f' suffix
    expect(out).toContain("●"); // the same steady dot glyph
    // one visual line: no interior newline in the rendered content
    expect(out.trim().split("\n").length).toBe(1);
  });

  it("falls back to a dash for the 'unknown' model and empty branch", () => {
    const out = renderToString(
      <CompactRow s={makeRow({ model: "unknown", branch: "" })} />,
    );
    expect(out).not.toContain("null");
    expect(out).toContain("—");
  });
});

describe("SessionCard read lines (PANEL-06 D-08/D-09/D-10)", () => {
  const now = () => new Date().toISOString();

  it("renders each read path as `◇ basename | dir` — dir only, never the full path (D-08)", () => {
    const out = renderToString(
      <SessionCard s={makeRow({ reads: [{ file_path: "/repo/r.ts", ts: now() }] })} />,
    );
    expect(out).toContain("◇");
    expect(out).toContain("r.ts"); // basename
    expect(out).toContain("/repo"); // directory portion only
    expect(out).not.toContain("/repo/r.ts"); // never the contiguous full path
  });

  it("renders reads distinct from writes: no read glyph on the write line (D-08)", () => {
    const out = renderToString(
      <SessionCard
        s={makeRow({
          files: [{ file_path: "/repo/w.ts", ts: now() }],
          reads: [{ file_path: "/repo/r.ts", ts: now() }],
        })}
      />,
    );
    expect(out).toContain("w.ts");
    expect(out).toContain("r.ts");
    expect(out).toContain("/repo"); // dir shown for both
    expect(out).not.toContain("/repo/w.ts");
    expect(out).not.toContain("/repo/r.ts");
    // locate lines by basename; the write line carries no read glyph, the read does
    const writeLine = out.split("\n").find((l) => l.includes("w.ts")) ?? "";
    const readLine = out.split("\n").find((l) => l.includes("r.ts")) ?? "";
    expect(writeLine).not.toContain("◇");
    expect(readLine).toContain("◇");
  });

  it("sanitizes an ESC byte embedded in a read file_path before render (T-03.1-05)", () => {
    const out = renderToString(
      <SessionCard s={makeRow({ reads: [{ file_path: "/repo/ev" + ESC + "il.ts", ts: now() }] })} />,
    );
    expect(out).toContain("evil.ts"); // ESC stripped, basename intact
    expect(out).toContain("/repo"); // directory portion
    expect(out).not.toContain("/repo/evil.ts"); // rendered as basename | dir
    const readLine = out.split("\n").find((l) => l.includes("evil.ts")) ?? "";
    expect(readLine).not.toContain(ESC);
  });

  it("renders a write file as `basename | directory` — dir only, not the full path (T-3td-01)", () => {
    const out = renderToString(
      <SessionCard s={makeRow({ files: [{ file_path: "/src/index.ts", ts: now() }] })} />,
    );
    expect(out).toContain("index.ts");
    expect(out).toContain("/src");
    expect(out).toContain("|"); // the ASCII name|dir separator
    expect(out).not.toContain("/src/index.ts");
    const writeLine = out.split("\n").find((l) => l.includes("index.ts")) ?? "";
    expect(writeLine).not.toContain("◇"); // writes carry no read glyph
  });

  it("renders a read file as `◇ basename | directory` — read glyph kept, dir split off", () => {
    const out = renderToString(
      <SessionCard s={makeRow({ reads: [{ file_path: "/lib/util.ts", ts: now() }] })} />,
    );
    expect(out).toContain("◇ util.ts"); // read glyph + basename
    expect(out).toContain("/lib"); // directory portion only
    expect(out).toContain("|"); // ASCII name|dir separator
    expect(out).not.toContain("/lib/util.ts"); // never the contiguous full path
  });

  it("aligns the `|` column across short + long write basenames and a read line", () => {
    const out = stripAnsi(
      renderToString(
        <SessionCard
          s={makeRow({
            files: [
              { file_path: "/a/x.ts", ts: now() },
              { file_path: "/some/dir/longname.ts", ts: now() },
            ],
            reads: [{ file_path: "/lib/util.ts", ts: now() }],
          })}
        />,
      ),
    );
    const pipeLines = out.split("\n").filter((l) => l.includes("|"));
    expect(pipeLines.length).toBe(3); // two writes + one read all carry a separator
    const cols = pipeLines.map((l) => l.indexOf("|"));
    expect(new Set(cols).size).toBe(1); // every `|` shares the same column
  });

  it("renders a bare filename (no directory) with no separator", () => {
    const out = renderToString(
      <SessionCard s={makeRow({ files: [{ file_path: "bare.ts", ts: now() }] })} />,
    );
    expect(out).toContain("bare.ts");
    const line = out.split("\n").find((l) => l.includes("bare.ts")) ?? "";
    expect(line).not.toContain("|"); // no dir -> no separator
  });

  it("renders no read glyph when there are no reads (D-08)", () => {
    const out = renderToString(<SessionCard s={makeRow({ reads: [] })} />);
    expect(out).not.toContain("◇");
  });

  it("CompactRow stays card-free: write count Nf only, no ◇, no read counter (D-10)", () => {
    const s = makeRow({
      files: [
        { file_path: "/repo/a.ts", ts: now() },
        { file_path: "/repo/b.ts", ts: now() },
      ],
      reads: [
        { file_path: "/repo/r1.ts", ts: now() },
        { file_path: "/repo/r2.ts", ts: now() },
      ],
    });
    const out = renderToString(<CompactRow s={s} />);
    expect(out).toContain("2f"); // two writes -> 2f
    expect(out).not.toContain("◇"); // reads are card-only, never in the compact row
    expect(out).not.toContain("2r"); // no read counter
  });
});

describe("SessionCard intent line (PANEL-02 D-10/D-11/D-12)", () => {
  const now = () => new Date().toISOString();
  const INTENT_GLYPH = "»"; // U+00BB, the card-only intent marker

  it("renders the sanitized intent text above the write and read file lists (D-10)", () => {
    const out = stripAnsi(
      renderToString(
        <SessionCard
          s={makeRow({
            intent: "refactor Card",
            files: [{ file_path: "/repo/w.ts", ts: now() }],
            reads: [{ file_path: "/repo/r.ts", ts: now() }],
          })}
        />,
      ),
    );
    expect(out).toContain("refactor Card");
    const lines = out.split("\n");
    const intentIdx = lines.findIndex((l) => l.includes("refactor Card"));
    const writeIdx = lines.findIndex((l) => l.includes("w.ts"));
    const readIdx = lines.findIndex((l) => l.includes("r.ts"));
    expect(intentIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(readIdx).toBeGreaterThanOrEqual(0);
    // D-10: intent sits above BOTH the write and read file lines
    expect(intentIdx).toBeLessThan(writeIdx);
    expect(intentIdx).toBeLessThan(readIdx);
  });

  it("falls back to a dim recent-activity indicator from the newest write when no intent (D-11)", () => {
    const out = stripAnsi(
      renderToString(
        <SessionCard
          s={makeRow({
            files: [
              { file_path: "/repo/Old.tsx", ts: new Date(Date.now() - 60_000).toISOString() },
              { file_path: "/repo/Card.tsx", ts: now() },
            ],
          })}
        />,
      ),
    );
    // the newest write basename appears in a distinct `~ `-marked recent line
    expect(out).toContain("~ Card.tsx");
    // no intent glyph is rendered when there is no intent
    expect(out).not.toContain(INTENT_GLYPH);
    // the recent-activity line is never blank
    const line = out.split("\n").find((l) => l.includes("~ Card.tsx")) ?? "";
    expect(line.trim().length).toBeGreaterThan(0);
  });

  it("renders a non-blank dim idle indicator when there is no intent and no files (D-11)", () => {
    const out = stripAnsi(
      renderToString(<SessionCard s={makeRow({ intent: undefined, files: [] })} />),
    );
    expect(out).not.toContain(INTENT_GLYPH);
    // never a blank line: a `(idle)` indicator is shown instead
    expect(out).toContain("(idle)");
  });

  it("sanitizes an ESC byte embedded in the intent before render (T-04-05)", () => {
    const out = renderToString(<SessionCard s={makeRow({ intent: "hack" + ESC + "ed" })} />);
    expect(out).toContain("hacked"); // ESC stripped, text intact
    const line = out.split("\n").find((l) => l.includes("hacked")) ?? "";
    expect(line).not.toContain(ESC);
  });

  it("CompactRow stays intent-free: no intent text, no intent glyph (D-12)", () => {
    const out = renderToString(<CompactRow s={makeRow({ intent: "secret task" })} />);
    expect(out).not.toContain("secret task");
    expect(out).not.toContain(INTENT_GLYPH);
  });
});

describe("SessionCard skill line (SKILL-04/SKILL-02, D-02/D-03/D-04)", () => {
  const now = () => new Date().toISOString();
  const SKILL_GLYPH = "⚙"; // U+2699 — the card-only skill marker

  it("renders a main-loop skill as `⚙ <skill>` with no `›` separator and never 'undefined' (SKILL-04/D-03)", () => {
    const out = stripAnsi(renderToString(<SessionCard s={makeRow({ skill: "gsd-quick" })} />));
    expect(out).toContain(SKILL_GLYPH);
    expect(out).toContain("gsd-quick");
    const line = out.split("\n").find((l) => l.includes(SKILL_GLYPH)) ?? "";
    expect(line).not.toContain("›"); // no subagent separator for a main-loop skill
    expect(line).not.toContain("undefined"); // never the literal 'undefined'
  });

  it("renders a subagent-sourced skill as `<subagent> › <skill>` (SKILL-02/D-03)", () => {
    const out = stripAnsi(
      renderToString(<SessionCard s={makeRow({ skill: "claude-api", skill_subagent: "gsd-executor" })} />),
    );
    expect(out).toContain("gsd-executor › claude-api"); // U+203A `›` surrounded by single spaces
  });

  it("places the skill line below the intent » line and above both file lists (D-04)", () => {
    const out = stripAnsi(
      renderToString(
        <SessionCard
          s={makeRow({
            intent: "refactor Card",
            skill: "gsd-quick",
            files: [{ file_path: "/repo/w.ts", ts: now() }],
            reads: [{ file_path: "/repo/r.ts", ts: now() }],
          })}
        />,
      ),
    );
    const lines = out.split("\n");
    const intentIdx = lines.findIndex((l) => l.includes("refactor Card"));
    const skillIdx = lines.findIndex((l) => l.includes("gsd-quick"));
    const writeIdx = lines.findIndex((l) => l.includes("w.ts"));
    const readIdx = lines.findIndex((l) => l.includes("r.ts"));
    expect(intentIdx).toBeGreaterThanOrEqual(0);
    expect(skillIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(skillIdx).toBeGreaterThan(intentIdx); // below the intent line
    expect(skillIdx).toBeLessThan(writeIdx); // above the write list
    expect(skillIdx).toBeLessThan(readIdx); // above the read list
  });

  it("omits the skill line entirely when no skill is in-window, keeping the card non-blank (D-02/D-11)", () => {
    const idle = stripAnsi(renderToString(<SessionCard s={makeRow({ skill: undefined, files: [] })} />));
    expect(idle).not.toContain(SKILL_GLYPH); // no skill glyph
    expect(idle).toContain("(idle)"); // the existing idle fallback still fills the card

    const recent = stripAnsi(
      renderToString(
        <SessionCard
          s={makeRow({ intent: undefined, skill: undefined, files: [{ file_path: "/repo/Card.tsx", ts: now() }] })}
        />,
      ),
    );
    expect(recent).not.toContain(SKILL_GLYPH);
    expect(recent).toContain("~ Card.tsx"); // recent-file fallback still shown
  });

  it("sanitizes an ESC byte embedded in the skill and subagent before render (T-04.3-02)", () => {
    const out = renderToString(
      <SessionCard s={makeRow({ skill: "gsd" + ESC + "quick", skill_subagent: "gsd" + ESC + "exec" })} />,
    );
    expect(out).toContain("gsdquick"); // ESC stripped from the skill name
    expect(out).toContain("gsdexec"); // ESC stripped from the subagent label
    const line = out.split("\n").find((l) => l.includes("gsdquick")) ?? "";
    expect(line).not.toContain(ESC);
  });

  it("CompactRow stays skill-free: no ⚙, no skill name, no subagent (D-04/D-12)", () => {
    const out = renderToString(
      <CompactRow s={makeRow({ skill: "gsd-quick", skill_subagent: "gsd-executor" })} />,
    );
    expect(out).not.toContain(SKILL_GLYPH);
    expect(out).not.toContain("gsd-quick");
    expect(out).not.toContain("gsd-executor");
  });
});

/** Minimal Conflict fixture builder for band render assertions. */
function makeConflict(over: Partial<Conflict> = {}): Conflict {
  return {
    realpath: "/abs/path/shared.ts",
    sessions: [
      { session_id: "abcdef0123", folder: "folderA", branch: "main", lastTouch: 2 },
      { session_id: "1234567890", folder: "folderB", branch: "dev", lastTouch: 1 },
    ],
    lastActive: 2,
    ...over,
  };
}

describe("ConflictBand (PANEL-04 D-06/D-07/D-09/D-10/D-11)", () => {
  it("renders nothing (no ⚠) when there are no conflicts (D-07 empty state)", () => {
    const out = renderToString(<ConflictBand conflicts={[]} />);
    expect(out).not.toContain("⚠");
    expect(out.trim()).toBe("");
  });

  it("names the file basename, the ⚠ glyph, and both folder·branch·shortid labels joined by ↔", () => {
    const out = renderToString(<ConflictBand conflicts={[makeConflict()]} />);
    expect(out).toContain("⚠");
    expect(out).toContain("shared.ts"); // basename only, never the full realpath
    expect(out).not.toContain("/abs/path/shared.ts");
    expect(out).toContain("folderA");
    expect(out).toContain("folderB");
    expect(out).toContain("abcdef01"); // first 8 chars of the session id
    expect(out).toContain("12345678");
    expect(out).toContain("↔"); // labels joined by the swap glyph
  });

  it("falls back to a dash for a session with an empty branch (Card convention)", () => {
    const out = renderToString(
      <ConflictBand
        conflicts={[
          makeConflict({
            sessions: [
              { session_id: "aaaaaaaa", folder: "folderA", branch: "", lastTouch: 2 },
              { session_id: "bbbbbbbb", folder: "folderB", branch: "dev", lastTouch: 1 },
            ],
          }),
        ]}
      />,
    );
    expect(out).toContain("—");
  });

  it("caps at CONFLICT_CAP lines and appends a `+X more` summary past the cap (D-11)", () => {
    const many: Conflict[] = Array.from({ length: 8 }, (_, i) =>
      makeConflict({ realpath: `/abs/file-${i}.ts`, lastActive: 8 - i }),
    );
    const out = renderToString(<ConflictBand conflicts={many} />);
    expect(out).toContain("+3 more"); // 8 total - cap of 5 = 3
    // only the first 5 files render as ⚠ lines
    expect(out).toContain("file-0.ts");
    expect(out).toContain("file-4.ts");
    expect(out).not.toContain("file-5.ts");
  });
});

/** Minimal ScannedPort fixture builder for PortsPane render assertions. */
function makePort(over: Partial<ScannedPort> = {}): ScannedPort {
  return {
    port: 3000,
    pid: 111,
    command: "node",
    exposed: false,
    ancestryPids: [111],
    ...over,
  };
}

describe("PortsPane (PORT-05 port pane render)", () => {
  const INTENT_GLYPH = "»"; // U+00BB — the heading intent marker (reused from the card)

  it("groups a port under its owning session's folder·branch·shortid heading (port attribution)", () => {
    const row = makeRow({ session_id: "abcdef0123456789", folder: "proj-a", branch: "main", pid: 111 });
    const p = makePort({ pid: 111, ancestryPids: [222, 111], port: 3000, command: "vite" });
    const out = stripAnsi(renderToString(<PortsPane ports={[p]} rows={[row]} />));
    // heading identity: folder · branch · first-8 shortid
    expect(out).toContain("proj-a");
    expect(out).toContain("main");
    expect(out).toContain("abcdef01");
    // the port row itself
    expect(out).toContain("3000");
    expect(out).toContain("vite");
  });

  it("renders unattributed ports under a final 'Sen (kullanici)' user group placed last (port user bucket)", () => {
    const row = makeRow({ session_id: "abcdef0123456789", folder: "proj-a", branch: "main", pid: 111 });
    const owned = makePort({ pid: 111, ancestryPids: [111], port: 3000, command: "vite" });
    const orphan = makePort({ pid: 999, ancestryPids: [999], port: 8080, command: "python" });
    const out = stripAnsi(renderToString(<PortsPane ports={[owned, orphan]} rows={[row]} />));
    expect(out).toContain("Sen (kullanici)");
    const lines = out.split("\n");
    const sessionIdx = lines.findIndex((l) => l.includes("proj-a"));
    const userIdx = lines.findIndex((l) => l.includes("Sen (kullanici)"));
    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(sessionIdx); // user group renders LAST
  });

  it("marks an exposed port with the ⇅ glyph and the word exposed (port badge)", () => {
    const p = makePort({ exposed: true, port: 5000, command: "node" });
    const out = stripAnsi(renderToString(<PortsPane ports={[p]} rows={[]} />));
    expect(out).toContain("⇅");
    expect(out).toContain("exposed");
  });

  it("marks a local-only port with 'local' and no ⇅ glyph (port badge)", () => {
    const p = makePort({ exposed: false, port: 5000, command: "node" });
    const out = stripAnsi(renderToString(<PortsPane ports={[p]} rows={[]} />));
    expect(out).toContain("local");
    expect(out).not.toContain("⇅");
  });

  it("appends the session intent to the group heading when set (port intent heading)", () => {
    const row = makeRow({ pid: 111, folder: "proj-a", intent: "building auth" });
    const p = makePort({ pid: 111, ancestryPids: [111] });
    const out = stripAnsi(renderToString(<PortsPane ports={[p]} rows={[row]} />));
    expect(out).toContain("building auth");
    expect(out).toContain(INTENT_GLYPH); // intent marker present when intent is set
  });

  it("shows no trailing intent marker on the heading when the session has no intent (port intent heading)", () => {
    const row = makeRow({ pid: 111, folder: "proj-a", intent: undefined });
    const p = makePort({ pid: 111, ancestryPids: [111] });
    const out = stripAnsi(renderToString(<PortsPane ports={[p]} rows={[row]} />));
    expect(out).not.toContain(INTENT_GLYPH); // no placeholder marker when intent absent
  });

  it("sanitizes an injected control byte in a port command before render (port sanitize)", () => {
    const p = makePort({ command: "ev" + ESC + "il", port: 3000 });
    const out = renderToString(<PortsPane ports={[p]} rows={[]} />);
    expect(out).toContain("evil"); // ESC stripped, name intact
    const line = out.split("\n").find((l) => l.includes("evil")) ?? "";
    expect(line).not.toContain(ESC);
  });

  it("caps at PORTS_CAP rows and appends a `+N more` line past the cap (port cap)", () => {
    // 15 ports all in the user bucket -> PORTS_CAP (12) rows + a `+3 more` summary
    const ports = Array.from({ length: 15 }, (_, i) =>
      makePort({ pid: 999, ancestryPids: [999], port: 3000 + i, command: `svc${i}` }),
    );
    const out = stripAnsi(renderToString(<PortsPane ports={ports} rows={[]} />));
    expect(out).toContain("+3 more"); // 15 total - cap of 12 = 3
    expect(out).toContain("svc11"); // the 12th row (index 11) IS shown under the cap
    expect(out).not.toContain("svc12"); // the 13th row (index 12) is collapsed past the cap
  });

  it("renders the dim 'no listening ports' empty state when there are zero ports (port empty)", () => {
    const out = stripAnsi(renderToString(<PortsPane ports={[]} rows={[]} />));
    expect(out).toContain("no listening ports");
  });

  it("renders the exact approved row format with a trailing dim pid segment (port pid suffix)", () => {
    const p = makePort({ port: 43117, command: "node", exposed: true, pid: 31235 });
    const out = stripAnsi(renderToString(<PortsPane ports={[p]} rows={[]} />));
    const line = out.split("\n").find((l) => l.includes("43117")) ?? "";
    // approved final format: port · command · badge · pid <pid>
    expect(line).toContain("43117 · node · ⇅ exposed · pid 31235");
  });

  it("renders each row's own pid across groups (port pid per row)", () => {
    const row = makeRow({ session_id: "abcdef0123456789", folder: "proj-a", branch: "main", pid: 111 });
    const owned = makePort({ pid: 111, ancestryPids: [111], port: 3000, command: "vite" });
    const orphan = makePort({ pid: 777, ancestryPids: [777], port: 8080, command: "python" });
    const out = stripAnsi(renderToString(<PortsPane ports={[owned, orphan]} rows={[row]} />));
    const ownedLine = out.split("\n").find((l) => l.includes("3000")) ?? "";
    const orphanLine = out.split("\n").find((l) => l.includes("8080")) ?? "";
    expect(ownedLine).toContain("pid 111");
    expect(orphanLine).toContain("pid 777");
  });

  it("places the pid segment AFTER the local badge (port pid after badge)", () => {
    const p = makePort({ port: 5000, command: "node", exposed: false, pid: 42 });
    const out = stripAnsi(renderToString(<PortsPane ports={[p]} rows={[]} />));
    const line = out.split("\n").find((l) => l.includes("5000")) ?? "";
    expect(line).toContain("local · pid 42");
  });

  it("aligns the ` · ` middots across port rows of differing port/command/badge widths", () => {
    // Three user-bucket ports (rows=[]) chosen so port, command, AND badge widths
    // all differ — the only thing that can line the middots up is per-column
    // padEnd padding computed across the full ports array.
    const ports = [
      makePort({ port: 80, command: "a", exposed: true, pid: 111 }), // badge "⇅ exposed" (9)
      makePort({ port: 43117, command: "longcommand", exposed: false, pid: 111 }), // badge "local" (5)
      makePort({ port: 3000, command: "srv", exposed: false, pid: 111 }),
    ];
    const out = stripAnsi(renderToString(<PortsPane ports={ports} rows={[]} />));

    // Every column index of the middot "·" in a line.
    const dotCols = (line: string): number[] => {
      const cols: number[] = [];
      let from = 0;
      for (;;) {
        const idx = line.indexOf("·", from);
        if (idx === -1) break;
        cols.push(idx);
        from = idx + 1;
      }
      return cols;
    };

    // Keep only PORT-info lines (each has a "pid " segment) — excludes the
    // `Sen (kullanici)` heading (no middots) and any `+N more`.
    const portLines = out.split("\n").filter((l) => l.includes("pid "));
    expect(portLines.length).toBe(3);
    for (const l of portLines) {
      expect(dotCols(l).length).toBe(3); // port·command, command·badge, badge·pid
    }
    // All three rows share the IDENTICAL middot-index array → the ` · `
    // separators stack vertically like the FAZLAR pane.
    expect(new Set(portLines.map((l) => JSON.stringify(dotCols(l)))).size).toBe(1);
  });

  it("keeps the exposed badge magenta+bold and the local badge dim after padding", () => {
    // The non-TTY runner defaults chalk.level to 0 (SGR stripped); force level 1
    // for this render only so the badge colors are actually emitted, restore in
    // finally (mirrors the FAZLAR green test).
    const prevLevel = chalk.level;
    chalk.level = 1;
    let raw: string;
    try {
      raw = renderToString(
        <PortsPane
          ports={[
            makePort({ command: "node", port: 5000, exposed: true, pid: 42 }),
            makePort({ command: "srv", port: 80, exposed: false, pid: 43 }),
          ]}
          rows={[]}
        />,
      );
    } finally {
      chalk.level = prevLevel;
    }
    const rawLines = raw.split("\n");
    const exposedLine = rawLines.find((l) => stripAnsi(l).includes("exposed")) ?? "";
    const localLine = rawLines.find((l) => stripAnsi(l).includes("local")) ?? "";

    // Exposed badge keeps magenta + bold.
    expect(exposedLine).toContain(ESC + "[35m"); // magenta
    expect(exposedLine).toContain(ESC + "[1m"); // bold
    // Local badge keeps dim.
    expect(localLine).toContain(ESC + "[2m"); // dim
    // Padding sits OUTSIDE the colored badge — the `· pid` separator survives.
    expect(stripAnsi(exposedLine)).toContain("· pid ");
    expect(stripAnsi(localLine)).toContain("· pid ");
  });
});

/** Minimal Phase fixture builder for PhasesPane render assertions. */
function makePhase(over: Partial<Phase> = {}): Phase {
  return { number: "01", name: "setup", plans: 1, summaries: 1, status: "Complete", ...over };
}

/** Minimal Progress fixture: milestone `milestone v1.0`, 2 of 3 phases Complete, 67%. */
function makeProgress(over: Partial<Progress> = {}): Progress {
  return {
    milestone_name: "milestone",
    milestone_version: "v1.0",
    percent: 67,
    phases: [
      makePhase({ number: "01", name: "alpha", plans: 2, summaries: 2, status: "Complete" }),
      makePhase({ number: "02", name: "beta", plans: 3, summaries: 3, status: "Complete" }),
      makePhase({ number: "03", name: "gamma", plans: 2, summaries: 0, status: "Pending" }),
    ],
    ...over,
  };
}

/** Minimal FocusEntry fixture (a focused project root + display name). */
function makeFocus(over: Partial<FocusEntry> = {}): FocusEntry {
  return { root: "/repo/proj", name: "proj", ...over };
}

describe("PhasesPane (PANEL-07 FAZLAR phase table)", () => {
  const CURRENT = "▸"; // U+25B8 — the in-progress marker
  // Reserved foreground SGR params MINUS green `[32m`: red/yellow/blue/magenta/
  // cyan/grey. Green is a user-directed relaxation of T-04.2-05b — completed
  // FAZLAR rows are INTENTIONALLY green, so it is excluded from this deny-list.
  const OTHER_RESERVED_SGR = ["[31m", "[33m", "[34m", "[35m", "[36m", "[90m"];

  it("renders a milestone summary line with the name, X/Y phases and Z% (D-05)", () => {
    const out = stripAnsi(
      renderToString(
        <PhasesPane focus={makeFocus()} index={0} count={1} progress={makeProgress()} scrollOffset={0} interactive={true} />,
      ),
    );
    const first = out.split("\n").find((l) => l.trim().length > 0) ?? "";
    expect(first).toContain("milestone"); // milestone name
    expect(first).toContain("2/3"); // 2 of 3 phases Complete
    expect(first).toContain("67%"); // percent
  });

  it("marks the first non-Complete phase with ▸ and leaves the leading Complete phase unmarked (D-05)", () => {
    const progress = makeProgress({
      phases: [
        makePhase({ number: "01", name: "alpha", status: "Complete", plans: 1, summaries: 1 }),
        makePhase({ number: "02", name: "beta", status: "Pending", plans: 0, summaries: 0 }),
        makePhase({ number: "03", name: "gamma", status: "Pending", plans: 0, summaries: 0 }),
      ],
    });
    const out = stripAnsi(
      renderToString(<PhasesPane focus={makeFocus()} index={0} count={1} progress={progress} scrollOffset={0} interactive={true} />),
    );
    const lines = out.split("\n");
    const alpha = lines.find((l) => l.includes("alpha")) ?? "";
    const beta = lines.find((l) => l.includes("beta")) ?? "";
    expect(beta).toContain(CURRENT); // first Pending phase is current
    expect(alpha).not.toContain(CURRENT); // leading Complete phase is not
  });

  it("renders all five columns per phase: number, name, plans, summaries, status", () => {
    const progress = makeProgress({
      phases: [makePhase({ number: "07", name: "widgets", plans: 4, summaries: 2, status: "Active" })],
    });
    const out = stripAnsi(
      renderToString(<PhasesPane focus={makeFocus()} index={0} count={1} progress={progress} scrollOffset={0} interactive={true} />),
    );
    const row = out.split("\n").find((l) => l.includes("widgets")) ?? "";
    expect(row).toContain("07"); // number
    expect(row).toContain("widgets"); // name
    expect(row).toContain("4"); // plans
    expect(row).toContain("2"); // summaries
    expect(row).toContain("Active"); // status (opaque string, rendered neutrally)
  });

  it("shows a dim 'no GSD projects' line when no project is focused (D-03 empty A)", () => {
    const out = stripAnsi(
      renderToString(<PhasesPane focus={null} index={0} count={0} progress={null} scrollOffset={0} interactive={true} />),
    );
    expect(out).toContain("no GSD projects");
    expect(out).not.toContain("milestone"); // no table when unfocused
  });

  it("shows a dim 'no roadmap' line when the focused project has null progress (D-03 empty B)", () => {
    const out = stripAnsi(
      renderToString(<PhasesPane focus={makeFocus()} index={0} count={1} progress={null} scrollOffset={0} interactive={true} />),
    );
    expect(out).toContain("no roadmap");
  });

  it("shows 'no roadmap' when the focused project has an empty phases array (D-03 empty B)", () => {
    const out = stripAnsi(
      renderToString(
        <PhasesPane focus={makeFocus()} index={0} count={1} progress={makeProgress({ phases: [] })} scrollOffset={0} interactive={true} />,
      ),
    );
    expect(out).toContain("no roadmap");
  });

  it("renders only the visible window at offset 0 and signals more below (D-04)", () => {
    const phases = Array.from({ length: 20 }, (_, i) =>
      makePhase({ number: String(i).padStart(2, "0"), name: `phase-${i}`, status: "Pending", plans: 0, summaries: 0 }),
    );
    const out = stripAnsi(
      renderToString(<PhasesPane focus={makeFocus()} index={0} count={1} progress={makeProgress({ phases })} scrollOffset={0} interactive={true} />),
    );
    expect(out).toContain("phase-0");
    expect(out).toContain("phase-14"); // 15th row = FAZLAR_VISIBLE_ROWS
    expect(out).not.toContain("phase-15"); // beyond the window
    expect(out).toContain("▼"); // more-below indicator
  });

  it("shows the tail slice and signals more above when scrolled to the end (D-04)", () => {
    const phases = Array.from({ length: 20 }, (_, i) =>
      makePhase({ number: String(i).padStart(2, "0"), name: `phase-${i}`, status: "Pending", plans: 0, summaries: 0 }),
    );
    const out = stripAnsi(
      renderToString(<PhasesPane focus={makeFocus()} index={0} count={1} progress={makeProgress({ phases })} scrollOffset={5} interactive={true} />),
    );
    expect(out).toContain("phase-19"); // last phase visible in the tail slice
    expect(out).not.toContain("phase-0"); // scrolled past the head
    expect(out).toContain("▲"); // more-above indicator
  });

  it("hides the Tab hint and Project i/N indicator when non-interactive, still rendering the table (D-08)", () => {
    const out = stripAnsi(
      renderToString(<PhasesPane focus={makeFocus()} index={0} count={3} progress={makeProgress()} scrollOffset={0} interactive={false} />),
    );
    expect(out).not.toContain("Tab: switch");
    expect(out).not.toContain("Project");
    expect(out).toContain("alpha"); // the focused table still renders statically
  });

  it("shows a dim non-TTY keyboard-off notice when non-interactive, still rendering the table (PANEL-07 D-08 relaxation)", () => {
    const out = stripAnsi(
      renderToString(<PhasesPane focus={makeFocus()} index={0} count={3} progress={makeProgress()} scrollOffset={0} interactive={false} />),
    );
    expect(out).toContain("keys off"); // the non-TTY notice renders
    expect(out).toContain("without a TTY"); // ...and explains why keys are inert
    expect(out).toContain("alpha"); // the focused table still renders statically
    expect(out).not.toContain("Tab: switch"); // notice must not reintroduce the interactive hint
    expect(out).not.toContain("Project"); // ...nor the Project i/N indicator
  });

  it("shows the Tab hint and Project i/N indicator when interactive (D-08)", () => {
    const out = stripAnsi(
      renderToString(<PhasesPane focus={makeFocus()} index={0} count={3} progress={makeProgress()} scrollOffset={0} interactive={true} />),
    );
    expect(out).toContain("Tab: switch");
    expect(out).toContain("Project 1/3");
    expect(out).toContain("proj"); // focused project name in the indicator
    expect(out).not.toContain("keys off"); // no-leak guard: the non-TTY notice must not appear on the TTY path
  });

  it("sanitizes control bytes in the milestone name and a phase name before render (T-04.2-05)", () => {
    const progress = makeProgress({
      milestone_name: "mile" + ESC + "[2Jstone",
      phases: [makePhase({ number: "01", name: "ev" + ESC + "il", status: "Pending", plans: 0, summaries: 0 })],
    });
    const out = renderToString(
      <PhasesPane focus={makeFocus()} index={0} count={1} progress={progress} scrollOffset={0} interactive={true} />,
    );
    expect(out).not.toContain(ESC); // the C0 control byte is stripped everywhere
    expect(out).toContain("evil"); // the printable remainder survives
  });

  it("colors completed rows green, keeps the current row bold (not green), pending neutral, and avoids every OTHER reserved color (relaxed T-04.2-05b)", () => {
    const progress = makeProgress({
      phases: [
        makePhase({ number: "01", name: "alpha", status: "Complete", plans: 1, summaries: 1 }),
        makePhase({ number: "02", name: "beta", status: "Pending", plans: 0, summaries: 0 }),
        makePhase({ number: "03", name: "gamma", status: "Pending", plans: 0, summaries: 0 }),
      ],
    });
    // Force a basic color level for this render only: the non-TTY test runner
    // defaults chalk to level 0 (all SGR stripped), so green/bold would never be
    // emitted. Scoped here so the T-04.2-05 sanitize test keeps its no-color
    // default (which asserts the raw output contains no ESC at all).
    const prevLevel = chalk.level;
    chalk.level = 1;
    let raw: string;
    try {
      raw = renderToString(
        <PhasesPane focus={makeFocus()} index={0} count={1} progress={progress} scrollOffset={0} interactive={true} />,
      );
    } finally {
      chalk.level = prevLevel;
    }
    const rawLines = raw.split("\n");
    const alpha = rawLines.find((l) => stripAnsi(l).includes("alpha")) ?? "";
    const beta = rawLines.find((l) => stripAnsi(l).includes("beta")) ?? "";
    const gamma = rawLines.find((l) => stripAnsi(l).includes("gamma")) ?? "";

    // Completed (alpha) → green.
    expect(alpha).toContain(ESC + "[32m");
    // Current (beta, first non-complete) → bold, never green.
    expect(beta).toContain(ESC + "[1m");
    expect(beta).not.toContain(ESC + "[32m");
    // Pending non-current (gamma) → neutral (no green, no bold).
    expect(gamma).not.toContain(ESC + "[32m");
    expect(gamma).not.toContain(ESC + "[1m");

    // Every OTHER reserved color stays off (T-04.2-05b preserved minus green).
    for (const code of OTHER_RESERVED_SGR) {
      expect(raw).not.toContain(ESC + code);
    }
  });

  it("aligns the status column across rows regardless of phase-name length", () => {
    const progress = makeProgress({
      phases: [
        makePhase({ number: "01", name: "x", status: "Sdone", plans: 1, summaries: 1 }),
        makePhase({ number: "02", name: "yylongername", status: "Spending", plans: 0, summaries: 0 }),
      ],
    });
    const out = stripAnsi(
      renderToString(<PhasesPane focus={makeFocus()} index={0} count={1} progress={progress} scrollOffset={0} interactive={true} />),
    );
    const lines = out.split("\n");
    const lineA = lines.find((l) => l.includes("Sdone")) ?? "";
    const lineB = lines.find((l) => l.includes("Spending")) ?? "";
    // The status column begins at the same horizontal offset on both rows.
    expect(lineA.indexOf("Sdone")).toBe(lineB.indexOf("Spending"));
  });

  it("truncates an overlong phase name with a single … (U+2026)", () => {
    const progress = makeProgress({
      phases: [makePhase({ number: "01", name: "verylongphasenamethatgoeswaybeyondthecap", status: "Pending", plans: 0, summaries: 0 })],
    });
    const out = stripAnsi(
      renderToString(<PhasesPane focus={makeFocus()} index={0} count={1} progress={progress} scrollOffset={0} interactive={true} />),
    );
    expect(out).toContain("…"); // U+2026
    expect(out).toContain("verylong"); // a known prefix survives
    expect(out).not.toContain("verylongphasenamethatgoeswaybeyondthecap"); // never the full 40-char name
  });

  it("shows a full-length GSD phase name (up to the 36-char cap) without truncation", () => {
    const progress = makeProgress({
      phases: [makePhase({ number: "01", name: "cross session conflict detection", status: "Pending", plans: 0, summaries: 0 })],
    });
    const out = stripAnsi(
      renderToString(<PhasesPane focus={makeFocus()} index={0} count={1} progress={progress} scrollOffset={0} interactive={true} />),
    );
    // A real 32-char GSD phase name that WAS truncated under the old cap of 18.
    expect(out).toContain("cross session conflict detection"); // full name survives at cap 36
    expect(out).not.toContain("…"); // no truncation glyph
  });

  it("clamps nameWidth at the 36-char cap: a 36-char name renders in full, a 37-char name truncates", () => {
    // Render A — a 36-char name renders in full (truncated under the old cap of 18).
    const outA = stripAnsi(
      renderToString(
        <PhasesPane
          focus={makeFocus()}
          index={0}
          count={1}
          progress={makeProgress({ phases: [makePhase({ number: "01", name: "a".repeat(36), status: "Pending", plans: 0, summaries: 0 })] })}
          scrollOffset={0}
          interactive={true}
        />,
      ),
    );
    expect(outA).toContain("a".repeat(36)); // exactly the cap → full
    expect(outA).not.toContain("…");

    // Render B — a 37-char name truncates to 35 chars + … (nameWidth clamps at 36).
    const outB = stripAnsi(
      renderToString(
        <PhasesPane
          focus={makeFocus()}
          index={0}
          count={1}
          progress={makeProgress({ phases: [makePhase({ number: "01", name: "a".repeat(37), status: "Pending", plans: 0, summaries: 0 })] })}
          scrollOffset={0}
          interactive={true}
        />,
      ),
    );
    expect(outB).toContain("…"); // U+2026
    expect(outB).not.toContain("a".repeat(37)); // never the full 37-char name
  });
});
