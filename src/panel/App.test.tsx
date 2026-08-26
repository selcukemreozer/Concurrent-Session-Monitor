import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink";
import { Writable } from "node:stream";

// RED (wave 01-04): App.tsx is the ~750ms poll + full re-read panel (PANEL-05).
// readAll (01-02) is the store reader the poll calls; mock it so the test asserts
// the poll WIRING, not the store.
vi.mock("../aggregate.js", () => ({ readAll: vi.fn(() => []) }));
import { readAll } from "../aggregate.js";
import { App } from "./App.js";

/** A non-TTY sink so Ink renders without touching the real terminal. */
function fakeStdout(): NodeJS.WriteStream {
  const out = new Writable({ write(_c, _e, cb) { cb(); } }) as unknown as NodeJS.WriteStream;
  (out as unknown as { columns: number }).columns = 80;
  (out as unknown as { rows: number }).rows = 24;
  return out;
}

describe("App poll loop (PANEL-05 live refresh, Pitfall 4 full re-read)", () => {
  beforeEach(() => {
    (readAll as unknown as { mockClear: () => void }).mockClear();
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
