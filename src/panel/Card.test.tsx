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
import { osc8, SessionCard, CompactRow, dotColor, ConflictBand, PortsPane } from "./Card.js";
import { renderToString } from "ink";
import type { SessionRow } from "../aggregate.js";
import type { Conflict } from "../conflicts.js";
import type { ScannedPort } from "../ports.js";

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
    // 9 ports all in the user bucket -> PORTS_CAP (6) rows + a `+3 more` summary
    const ports = Array.from({ length: 9 }, (_, i) =>
      makePort({ pid: 999, ancestryPids: [999], port: 3000 + i, command: `svc${i}` }),
    );
    const out = stripAnsi(renderToString(<PortsPane ports={ports} rows={[]} />));
    expect(out).toContain("+3 more"); // 9 total - cap of 6 = 3
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
});
