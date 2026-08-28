import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink";
import { Writable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionRow } from "../aggregate.js";

// RED (wave 01-04): App.tsx is the ~750ms poll + full re-read panel (PANEL-05).
// readAll (01-02) is the store reader the poll calls; mock it so the test asserts
// the poll WIRING, not the store.
vi.mock("../aggregate.js", () => ({ readAll: vi.fn(() => []) }));
// RED (wave 02-05): the App owns the grace-then-prune lifecycle (D-05/D-06/D-08)
// and calls prune.ts pruneSession exactly once after the grace. Mock it so the
// test asserts the WIRING, not the filesystem rm.
vi.mock("../prune.js", () => ({ pruneSession: vi.fn() }));
import { readAll } from "../aggregate.js";
import { pruneSession } from "../prune.js";
import { App } from "./App.js";

/** A non-TTY sink so Ink renders without touching the real terminal. */
function fakeStdout(rows = 24, columns = 80): NodeJS.WriteStream {
  const out = new Writable({ write(_c, _e, cb) { cb(); } }) as unknown as NodeJS.WriteStream;
  (out as unknown as { columns: number }).columns = columns;
  (out as unknown as { rows: number }).rows = rows;
  return out;
}

/**
 * Render the App into a captured buffer. `debug:true` makes Ink unthrottled and
 * writes the full frame synchronously to the injected stdout (verified against
 * ink 7.1.1 `onRender` debug branch), so the returned `frame()` is the rendered
 * text — no async flush needed. `useWindowSize` reads the injected stdout's
 * rows/columns, so passing a small `rows` drives the height-overflow switch.
 */
function renderCapture(rows = 24, columns = 80) {
  let buf = "";
  const out = new Writable({ write(c, _e, cb) { buf += c.toString(); cb(); } }) as unknown as NodeJS.WriteStream;
  (out as unknown as { columns: number }).columns = columns;
  (out as unknown as { rows: number }).rows = rows;
  const inst = render(React.createElement(App), {
    stdout: out,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return { inst, frame: () => buf };
}

/** A minimal-but-complete SessionRow for render/lifecycle assertions. */
function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    schema_version: 1,
    session_id: "sess-0001",
    folder: "proj",
    branch: "main",
    model: "claude",
    start_time: new Date().toISOString(),
    files: [],
    alive: true,
    readyToPrune: false,
    dotState: "active",
    ...overrides,
  } as SessionRow;
}

describe("App poll loop (PANEL-05 live refresh, Pitfall 4 full re-read)", () => {
  beforeEach(() => {
    (readAll as unknown as { mockClear: () => void }).mockClear();
    (readAll as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads on mount, arms a ~750ms interval that full-re-reads, and clears it on unmount", () => {
    const setSpy = vi.spyOn(global, "setInterval");
    const clearSpy = vi.spyOn(global, "clearInterval");

    const { unmount } = render(React.createElement(App), {
      stdout: fakeStdout(),
      patchConsole: false,
      exitOnCtrlC: false,
    });

    // Seeded from readAll() on mount (useState initializer).
    expect(readAll).toHaveBeenCalled();

    // The effect armed a poll near 750ms whose callback does a full re-read.
    const poll = setSpy.mock.calls.find((c) => c[1] === 750 && typeof c[0] === "function");
    expect(poll, "expected a setInterval(fn, 750) poll").toBeTruthy();

    (readAll as unknown as { mockClear: () => void }).mockClear();
    (poll![0] as () => void)();
    expect(readAll).toHaveBeenCalledTimes(1); // full re-read on each tick

    unmount();
    expect(clearSpy).toHaveBeenCalled(); // cleanup clears the interval
  });

  it("exports App as a renderable component", () => {
    expect(typeof App).toBe("function");
  });
});

describe("App grace-then-prune lifecycle (D-05/D-06/D-08, SC-3/SC-4)", () => {
  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (pruneSession as unknown as { mockReset: () => void }).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("prunes a vanished session exactly once after the grace, and not before", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const id = "vanish-1";
    // Present on mount, then it vanishes (clean SessionEnd) on every later tick.
    vi.mocked(readAll).mockReturnValueOnce([makeRow({ session_id: id })]).mockReturnValue([]);

    const { unmount } = render(React.createElement(App), {
      stdout: fakeStdout(),
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });

    // Mount: the row is present + alive, so no grace, no prune.
    expect(pruneSession).not.toHaveBeenCalled();

    // One tick later the row has vanished — grace starts, but has not elapsed.
    vi.advanceTimersByTime(750);
    expect(pruneSession).not.toHaveBeenCalled();

    // Advance well past the grace: prune fires exactly once for the id.
    vi.advanceTimersByTime(5000);
    expect(pruneSession).toHaveBeenCalledTimes(1);
    expect(pruneSession).toHaveBeenCalledWith(id);

    unmount();
  });

  it("never prunes a session that stays alive", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown })
      .mockReturnValue([makeRow({ session_id: "live-1", alive: true, readyToPrune: false, dotState: "active" })]);

    const { unmount } = render(React.createElement(App), {
      stdout: fakeStdout(),
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });

    vi.advanceTimersByTime(10000);
    expect(pruneSession).not.toHaveBeenCalled();
    unmount();
  });

  it("renders a dead/readyToPrune row as a dim-grey 'ended' state during the grace", () => {
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown })
      .mockReturnValue([makeRow({ session_id: "dead-1", folder: "dyingproj", alive: false, readyToPrune: true, dotState: "stale" })]);

    const { inst, frame } = renderCapture();
    expect(frame()).toContain("ended");
    inst.unmount();
  });
});

describe("App summary header (D-15)", () => {
  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (pruneSession as unknown as { mockReset: () => void }).mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("reports live + idle counts with a 0 conflicts placeholder", () => {
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue([
      makeRow({ session_id: "a", alive: true, dotState: "active" }),
      makeRow({ session_id: "b", alive: true, dotState: "idle" }),
    ]);

    const { inst, frame } = renderCapture();
    const out = frame();
    expect(out).toContain("2 live");
    expect(out).toContain("1 idle");
    expect(out).toContain("0 conflicts");
    inst.unmount();
  });
});

describe("App conflict surface (PANEL-04 SC-1/SC-3, D-06/D-07)", () => {
  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (pruneSession as unknown as { mockReset: () => void }).mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  /** Two live sessions whose windows both hold the same absolute (non-existent)
   * path — resolveRealpath degrades a missing file to its lexical absolute, so
   * both fold to the same realpath and raise one conflict. */
  function overlappingRows(): SessionRow[] {
    const ts = new Date().toISOString();
    return [
      makeRow({ session_id: "a", folder: "projA", branch: "main", files: [{ file_path: "/abs/shared.ts", ts }] }),
      makeRow({ session_id: "b", folder: "projB", branch: "dev", files: [{ file_path: "/abs/shared.ts", ts }] }),
    ];
  }

  it("renders a real `1 conflicts` counter + the ⚠ band naming the file and both sessions", () => {
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue(overlappingRows());
    const { inst, frame } = renderCapture();
    const out = frame();
    expect(out).toContain("1 conflicts");
    expect(out).toContain("⚠");
    expect(out).toContain("shared.ts");
    expect(out).toContain("projA");
    expect(out).toContain("projB");
    inst.unmount();
  });

  it("omits the ⚠ band and shows `0 conflicts` when no path overlaps (D-07)", () => {
    const ts = new Date().toISOString();
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue([
      makeRow({ session_id: "a", folder: "projA", files: [{ file_path: "/abs/a.ts", ts }] }),
      makeRow({ session_id: "b", folder: "projB", files: [{ file_path: "/abs/b.ts", ts }] }),
    ]);
    const { inst, frame } = renderCapture();
    const out = frame();
    expect(out).toContain("0 conflicts");
    expect(out).not.toContain("⚠");
    inst.unmount();
  });

  it("renders the ⚠ band in BOTH compact and card modes (D-07 mode-independence)", () => {
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue(overlappingRows());
    const compact = renderCapture(6, 120);
    expect(compact.frame()).toContain("⚠");
    compact.inst.unmount();

    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue(overlappingRows());
    const card = renderCapture(80, 120);
    expect(card.frame()).toContain("⚠");
    card.inst.unmount();
  });

  it("does NOT raise a conflict from a dead/ghost row sharing the path (SC-3)", () => {
    const ts = new Date().toISOString();
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue([
      makeRow({ session_id: "live", folder: "projA", files: [{ file_path: "/abs/shared.ts", ts }] }),
      makeRow({ session_id: "ghost", folder: "projB", alive: false, readyToPrune: true, dotState: "stale", files: [{ file_path: "/abs/shared.ts", ts }] }),
    ]);
    const { inst, frame } = renderCapture();
    const out = frame();
    expect(out).toContain("0 conflicts");
    expect(out).not.toContain("⚠");
    inst.unmount();
  });
});

describe("App de-framed header (borderless, HEADER_LINES=3)", () => {
  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (pruneSession as unknown as { mockReset: () => void }).mockReset();
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps the title + summary but drops the round-border corner glyph", () => {
    const { inst, frame } = renderCapture();
    const out = frame();
    expect(out).toContain("◆ Concurrent Session Monitor");
    expect(out).toContain("0 live");
    expect(out).toContain("0 conflicts");
    // The round-border top-left corner glyph ╭ (U+256D) proves the frame is gone.
    expect(out).not.toContain("╭");
    inst.unmount();
  });
});

describe("App height-driven compact overflow (D-13)", () => {
  beforeEach(() => {
    (readAll as unknown as { mockReset: () => void }).mockReset();
    (pruneSession as unknown as { mockReset: () => void }).mockReset();
    const many = Array.from({ length: 10 }, (_, i) =>
      makeRow({ session_id: `s-${i}`, folder: `proj-${i}` }),
    );
    (readAll as unknown as { mockReturnValue: (v: unknown) => unknown }).mockReturnValue(many);
  });
  afterEach(() => vi.restoreAllMocks());

  it("collapses to one-line CompactRow rows when the rows do not fit", () => {
    const { inst, frame } = renderCapture(6, 120); // tiny height, wide enough not to wrap
    const out = frame();
    // CompactRow ends each line with the active-file count token ("0f"); the full
    // SessionCard instead prints "(no active files)".
    expect(out).toContain("0f");
    expect(out).not.toContain("(no active files)");
    inst.unmount();
  });

  it("renders full SessionCards when there is ample height", () => {
    const { inst, frame } = renderCapture(80, 120); // tall terminal
    const out = frame();
    expect(out).toContain("(no active files)");
    expect(out).not.toContain("0f");
    inst.unmount();
  });
});

describe("bin/csm.mjs clean shutdown (D-14, Pitfall 3)", () => {
  it("exits 0 on SIGTERM (unmounts the alt-screen shell instead of stranding)", async () => {
    const binPath = fileURLToPath(new URL("../../bin/csm.mjs", import.meta.url));
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "csm-shutdown-"));

    const code: number = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [binPath], {
        env: { ...process.env, CSM_STORE_DIR: store },
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", reject);
      child.on("exit", (c) => resolve(c ?? -1));
      // Give tsImport time to transpile the App -> Card -> aggregate graph and boot.
      setTimeout(() => child.kill("SIGTERM"), 600);
    });

    fs.rmSync(store, { recursive: true, force: true });
    expect(code).toBe(0);
  }, 15000);
});
