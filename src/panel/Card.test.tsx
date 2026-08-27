import { describe, it, expect } from "vitest";

// RED (wave 01-04): Card.tsx exports the SessionCard component and the osc8 helper.
// RED (wave 02-04): Card.tsx also exports CompactRow and the pure dotColor helper,
// and SessionCard now renders a 3-state dot + compact uptime + best-effort model.
import { osc8, SessionCard, CompactRow, dotColor } from "./Card.js";
import { renderToString } from "ink";
import type { SessionRow } from "../aggregate.js";

const ESC = String.fromCharCode(27); // 0x1B

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
