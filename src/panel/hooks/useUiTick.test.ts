import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { Text } from "ink";
import { UI_TICK_MS, TICKER_TICKS, animStep, useUiTick, type Anim } from "./useUiTick.js";
import { renderCapture, frameLines } from "../ui/test-harness.js";

function run(n: number, paused: boolean, tickerTicks?: number): Anim[] {
  const out: Anim[] = [];
  let a: Anim = { tick: 0, step: 0 };
  for (let i = 0; i < n; i++) {
    a = animStep(a, paused, tickerTicks);
    out.push(a);
  }
  return out;
}

describe("useUiTick constants (UI-SPEC Motion)", () => {
  it("UI tick is 250 ms and the ticker steps every 2 ticks", () => {
    expect(UI_TICK_MS).toBe(250);
    expect(TICKER_TICKS).toBe(2);
  });
});

describe("animStep (pure, no timers)", () => {
  it("not paused: ticks 1..4, steps 0,1,1,2", () => {
    const r = run(4, false);
    expect(r.map((a) => a.tick)).toEqual([1, 2, 3, 4]);
    expect(r.map((a) => a.step)).toEqual([0, 1, 1, 2]);
  });

  it("paused: ticks still advance, step stays 0", () => {
    const r = run(4, true);
    expect(r.map((a) => a.tick)).toEqual([1, 2, 3, 4]);
    expect(r.map((a) => a.step)).toEqual([0, 0, 0, 0]);
  });

  it("tickerTicks 4 advances the step every 4 ticks", () => {
    const r = run(8, false, 4);
    expect(r.map((a) => a.step)).toEqual([0, 0, 0, 1, 1, 1, 1, 2]);
  });

  it("returns a new object and never mutates its input", () => {
    const a: Anim = { tick: 1, step: 0 };
    const b = animStep(a, false);
    expect(b).not.toBe(a);
    expect(a).toEqual({ tick: 1, step: 0 });
  });
});

describe("useUiTick (fake timers only)", () => {
  let inst: { unmount: () => void } | null = null;
  afterEach(() => {
    inst?.unmount();
    inst = null;
    vi.useRealTimers();
  });

  interface ProbeProps {
    active: boolean;
    paused: boolean;
    tickMs?: number;
  }
  function Probe(p: ProbeProps) {
    const a = useUiTick(p);
    return React.createElement(Text, null, `t${a.tick} s${a.step}`);
  }
  const probe = (p: ProbeProps) => React.createElement(Probe, p);

  it("ticks once per interval while active", async () => {
    vi.useFakeTimers();
    const r = renderCapture(probe({ active: true, paused: false, tickMs: 100 }));
    inst = r.inst;
    expect(frameLines(r.lastFrame())[0]).toBe("t0 s0");
    await vi.advanceTimersByTimeAsync(400);
    expect(frameLines(r.lastFrame())[0]).toBe("t4 s2");
  });

  it("schedules nothing while inactive", async () => {
    vi.useFakeTimers();
    const r = renderCapture(probe({ active: false, paused: false, tickMs: 100 }));
    inst = r.inst;
    await vi.advanceTimersByTimeAsync(1000);
    expect(frameLines(r.lastFrame())[0]).toBe("t0 s0");
  });

  it("reads the latest paused value without restarting the clock", async () => {
    vi.useFakeTimers();
    const r = renderCapture(probe({ active: true, paused: false, tickMs: 100 }));
    inst = r.inst;
    await vi.advanceTimersByTimeAsync(200);
    expect(frameLines(r.lastFrame())[0]).toBe("t2 s1");
    r.inst.rerender(probe({ active: true, paused: true, tickMs: 100 }));
    await vi.advanceTimersByTimeAsync(400);
    expect(frameLines(r.lastFrame())[0]).toBe("t6 s1");
  });
});
