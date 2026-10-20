import { describe, it, expect, vi, afterEach } from "vitest";
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

// Phase 9 plan 09-13: the v2 root is stubbed the same way, so the variant
// switch is observable without mounting the real PanelApp (store hooks, timers).
vi.mock("./PanelApp.js", async () => {
  const ReactMod = await import("react");
  const { Text } = await import("ink");
  return { PanelApp: () => ReactMod.createElement(Text, null, "V2_STUB") };
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
    const { inst, frame } = renderCapture(<Root enableSplash={false} />);
    expect(frame()).toContain("PANEL_STUB");
    expect(frame()).not.toContain("CONCURRENT");
    inst.unmount();
  });

  it("shows the splash first, then transitions to the panel", async () => {
    const { inst, frame, clear } = renderCapture(
      <Root enableSplash={true} splashMs={30} />,
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

describe("Root CSM_UI variant switch (Phase 9 plan 09-13, D-22/D-23)", () => {
  const saved = process.env.CSM_UI;
  afterEach(() => {
    if (saved === undefined) delete process.env.CSM_UI;
    else process.env.CSM_UI = saved;
  });

  /** Set CSM_UI for one case; `undefined` removes it. */
  function setEnv(value: string | undefined): void {
    if (value === undefined) delete process.env.CSM_UI;
    else process.env.CSM_UI = value;
  }

  it("the legacy variant prop renders the 1.6.x App", () => {
    setEnv("v2");
    const { inst, frame } = renderCapture(<Root enableSplash={false} variant="legacy" />);
    expect(frame()).toContain("PANEL_STUB");
    expect(frame()).not.toContain("V2_STUB");
    inst.unmount();
  });

  it.each([
    ["unset", undefined],
    ["v1", "v1"],
    ["legacy", "legacy"],
    ["V2", "V2"],
    ["empty string", ""],
  ] as const)("CSM_UI %s keeps the 1.6.x App", (_label, value) => {
    setEnv(value);
    const { inst, frame } = renderCapture(<Root enableSplash={false} />);
    expect(frame()).toContain("PANEL_STUB");
    expect(frame()).not.toContain("V2_STUB");
    inst.unmount();
  });

  it.each([
    ["v2", "v2"],
    ["' v2 ' (trimmed)", " v2 "],
  ] as const)("CSM_UI %s opens the v2 shell", (_label, value) => {
    setEnv(value);
    const { inst, frame } = renderCapture(<Root enableSplash={false} />);
    expect(frame()).toContain("V2_STUB");
    expect(frame()).not.toContain("PANEL_STUB");
    inst.unmount();
  });

  it("the v2 variant prop opens the v2 shell", () => {
    setEnv(undefined);
    const { inst, frame } = renderCapture(<Root enableSplash={false} variant="v2" />);
    expect(frame()).toContain("V2_STUB");
    expect(frame()).not.toContain("PANEL_STUB");
    inst.unmount();
  });

  it("v2 shows the splash first, then the v2 shell", async () => {
    setEnv(undefined);
    const { inst, frame, clear } = renderCapture(
      <Root enableSplash={true} splashMs={30} variant="v2" />,
    );
    expect(frame()).toContain("CONCURRENT");
    expect(frame()).not.toContain("V2_STUB");
    clear();
    await sleep(150);
    expect(frame()).toContain("V2_STUB");
    expect(frame()).not.toContain("CONCURRENT");
    expect(frame()).not.toContain("PANEL_STUB");
    inst.unmount();
  });
});
