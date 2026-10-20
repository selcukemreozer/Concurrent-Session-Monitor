import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Text } from "ink";
import { renderCapture } from "../ui/test-harness.js";
import { usePoll } from "./usePoll.js";

/**
 * usePoll contract (Phase 9, plan 09-10; T-09-14e). Real timers at a 20 ms
 * cadence: the hook owns one interval, an optional run-once-on-mount, an
 * overlap guard for async ticks (released on BOTH settle paths), and a
 * lifetime alive() that turns false on unmount.
 */

const CADENCE = 20;

function Probe({
  tick,
  cadence,
  immediate,
}: {
  tick: (alive: () => boolean) => void | Promise<unknown>;
  cadence: number | (() => number);
  immediate?: boolean;
}) {
  usePoll(tick, cadence, immediate === undefined ? undefined : { immediate });
  return <Text>probe</Text>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mounted: Array<{ unmount: () => void }> = [];
function mount(el: React.ReactElement) {
  const cap = renderCapture(el);
  mounted.push(cap.inst);
  return cap;
}

afterEach(() => {
  for (const inst of mounted.splice(0)) {
    try {
      inst.unmount();
    } catch {
      // already unmounted
    }
  }
});

describe("usePoll", () => {
  it("immediate: true runs one tick on mount, before the first interval", async () => {
    const tick = vi.fn();
    // A long cadence so only the immediate tick can have run.
    mount(<Probe tick={tick} cadence={10_000} immediate />);
    await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(1));
    await sleep(60);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("without immediate, the first tick waits for the interval", async () => {
    const tick = vi.fn();
    mount(<Probe tick={tick} cadence={10_000} />);
    await sleep(60);
    expect(tick).toHaveBeenCalledTimes(0);
  });

  it("evaluates a cadence function exactly once, inside the effect", async () => {
    const tick = vi.fn();
    const cadence = vi.fn(() => CADENCE);
    mount(<Probe tick={tick} cadence={cadence} />);
    await vi.waitFor(() => expect(tick.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(cadence).toHaveBeenCalledTimes(1);
  });

  it("never overlaps: a never-settling tick runs exactly once across 5+ intervals", async () => {
    const tick = vi.fn(() => new Promise<void>(() => {}));
    mount(<Probe tick={tick} cadence={CADENCE} immediate />);
    await sleep(CADENCE * 7);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("a rejected tick raises no unhandledRejection, and the next interval runs a new tick", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const tick = vi.fn(() => Promise.reject(new Error("scan failed")));
      mount(<Probe tick={tick} cadence={CADENCE} immediate />);
      await vi.waitFor(() => expect(tick.mock.calls.length).toBeGreaterThanOrEqual(3));
      // Give any stray rejection a macrotask to surface.
      await sleep(CADENCE * 2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("stops after unmount: no more ticks, and alive() returns false", async () => {
    let lastAlive: (() => boolean) | null = null;
    const tick = vi.fn((alive: () => boolean) => {
      lastAlive = alive;
    });
    const { inst } = mount(<Probe tick={tick} cadence={CADENCE} immediate />);
    await vi.waitFor(() => expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(lastAlive).not.toBeNull();
    expect(lastAlive!()).toBe(true);
    inst.unmount();
    const after = tick.mock.calls.length;
    await sleep(CADENCE * 5);
    expect(tick.mock.calls.length).toBe(after);
    expect(lastAlive!()).toBe(false);
  });

  it("always calls the latest tick passed on re-render", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { inst } = mount(<Probe tick={first} cadence={CADENCE} />);
    await vi.waitFor(() => expect(first).toHaveBeenCalled());
    inst.rerender(<Probe tick={second} cadence={CADENCE} />);
    await vi.waitFor(() => expect(second).toHaveBeenCalled());
  });
});
