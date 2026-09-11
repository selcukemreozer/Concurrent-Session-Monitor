import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink";
import { Writable } from "node:stream";

// RED (quick 260911-lsk): Root owns the splash→panel phase switch. Stub the heavy
// App (its poll timers / store reads are irrelevant here) so the test isolates the
// switch: enableSplash=false mounts the panel immediately; enableSplash + a small
// splashMs shows the Splash first, then the panel after the timeout. The real Splash
// is kept (not mocked) so its wordmark distinguishes the splash phase from the stub.
vi.mock("./App.js", async () => {
  const ReactMod = await import("react");
  const { Text } = await import("ink");
  return { App: () => ReactMod.createElement(Text, null, "PANEL_STUB") };
});

import { Root } from "./Root.js";

/** Render a node into a captured buffer; clear() resets between phases. */
function renderCapture(node: React.ReactElement) {
  let buf = "";
  const out = new Writable({
    write(c, _e, cb) {
      buf += c.toString();
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  (out as unknown as { columns: number }).columns = 80;
  (out as unknown as { rows: number }).rows = 24;
  const inst = render(node, {
    stdout: out,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    inst,
    frame: () => buf,
    clear: () => {
      buf = "";
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Root (csm splash → panel switch)", () => {
  it("mounts the panel immediately when the splash is disabled", () => {
    const { inst, frame } = renderCapture(
      React.createElement(Root, { enableSplash: false }),
    );
    expect(frame()).toContain("PANEL_STUB");
    expect(frame()).not.toContain("CONCURRENT");
    inst.unmount();
  });

  it("shows the splash first, then transitions to the panel", async () => {
    const { inst, frame, clear } = renderCapture(
      React.createElement(Root, { enableSplash: true, splashMs: 30 }),
    );
    // Phase 1 — splash.
    expect(frame()).toContain("CONCURRENT");
    expect(frame()).not.toContain("PANEL_STUB");
    // Phase 2 — after the timeout, the panel takes over.
    clear();
    await sleep(150);
    expect(frame()).toContain("PANEL_STUB");
    expect(frame()).not.toContain("CONCURRENT");
    inst.unmount();
  });
});
