import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { Box, Text } from "ink";
import { stripVTControlCharacters } from "node:util";
import {
  HOME_ERASE_DOWN,
  RESIZE_SETTLE_MS,
  useResizeRepaint,
  type Timers,
} from "./useResizeRepaint.js";
import { renderTty } from "../ui/test-harness.js";

// Phase 10 plan 10-04 (LAYOUT-05, D-01/D-02): the automatable checks (a)–(f)
// from RESEARCH Q2. Time is a manual fake clock injected through `timers`;
// no test sleeps on the wall clock, so nothing here flakes under load.

const ESC = String.fromCharCode(27);

/** A manual clock: `set` queues, `advance(ms)` runs every due callback in order. */
function manualTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const cleared: number[] = [];
  const armed: { id: number; ms: number; at: number }[] = [];
  const timers: Timers = {
    set(fn, ms) {
      seq += 1;
      pending.set(seq, { at: now + ms, fn });
      armed.push({ id: seq, ms, at: now });
      return seq;
    },
    clear(h) {
      const id = h as number;
      if (pending.delete(id)) cleared.push(id);
    },
  };
  function advance(ms: number): void {
    const target = now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of pending) {
        if (e[1].at <= target && (next === null || e[1].at < next[1].at)) next = e;
      }
      if (next === null) break;
      pending.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = target;
  }
  return { timers, advance, cleared, armed, pendingCount: () => pending.size };
}

/** Number of raw chunks that contain the clear. */
function clears(writes: string[]): number {
  return writes.filter((c) => c.includes(HOME_ERASE_DOWN)).length;
}

const BODY = ["body one " + "x".repeat(60), "body two", "body three"];

function Probe({ timers }: { timers: Timers }): React.ReactElement {
  useResizeRepaint({ timers });
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">{"◆ CSM  header " + "h".repeat(60)}</Text>
      {BODY.map((b) => (
        <Text key={b} wrap="truncate-end">
          {b}
        </Text>
      ))}
    </Box>
  );
}

describe("useResizeRepaint constants (D-01)", () => {
  it("settles 150 ms after the last resize and clears with Ink's homeAndEraseDown", () => {
    expect(RESIZE_SETTLE_MS).toBe(150);
    expect(HOME_ERASE_DOWN).toBe(ESC + "[1;1H" + ESC + "[0J");
    // Never the full-screen or scrollback erase.
    expect(HOME_ERASE_DOWN).not.toContain("[2J");
    expect(HOME_ERASE_DOWN).not.toContain("[3J");
  });
});

describe("useResizeRepaint (renderTty, injected timers)", () => {
  let unmount: (() => void) | null = null;
  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  it("(a) one resize writes exactly one clear chunk at once", () => {
    const clock = manualTimers();
    const r = renderTty(<Probe timers={clock.timers} />, { columns: 80, rows: 24 });
    unmount = () => r.inst.unmount();
    const before = clears(r.writes());
    expect(before).toBe(0);
    r.setSize(60, 24);
    r.resize();
    expect(clears(r.writes()) - before).toBe(1);
  });

  it("(b) the trailing clear comes exactly at 150 ms, not before", () => {
    const clock = manualTimers();
    const r = renderTty(<Probe timers={clock.timers} />, { columns: 80, rows: 24 });
    unmount = () => r.inst.unmount();
    r.setSize(60, 24);
    r.resize();
    expect(clears(r.writes())).toBe(1);
    expect(clock.armed.map((a) => a.ms)).toEqual([RESIZE_SETTLE_MS]);
    clock.advance(149);
    expect(clears(r.writes())).toBe(1);
    clock.advance(1);
    expect(clears(r.writes())).toBe(2);
    clock.advance(1000);
    expect(clears(r.writes())).toBe(2);
    expect(clock.pendingCount()).toBe(0);
  });

  it("(c) three resizes 50 ms apart: three immediate clears, one trailing 150 ms after the last", () => {
    const clock = manualTimers();
    const r = renderTty(<Probe timers={clock.timers} />, { columns: 80, rows: 24 });
    unmount = () => r.inst.unmount();
    r.setSize(70, 24);
    r.resize();
    clock.advance(50);
    r.setSize(60, 24);
    r.resize();
    clock.advance(50);
    r.setSize(50, 24);
    r.resize();
    expect(clears(r.writes())).toBe(3);
    // The first two trailing timers were reset, never fired.
    expect(clock.cleared).toHaveLength(2);
    clock.advance(149);
    expect(clears(r.writes())).toBe(3);
    clock.advance(1);
    expect(clears(r.writes())).toBe(4);
    clock.advance(1000);
    expect(clears(r.writes())).toBe(4);
  });

  it("(d) unmount clears the pending trailing timer and nothing more is written", () => {
    const clock = manualTimers();
    const r = renderTty(<Probe timers={clock.timers} />, { columns: 80, rows: 24 });
    r.setSize(60, 24);
    r.resize();
    expect(clock.pendingCount()).toBe(1);
    const pendingId = clock.armed[0]?.id;
    r.inst.unmount();
    expect(clock.pendingCount()).toBe(0);
    expect(clock.cleared).toContain(pendingId);
    const after = r.writes().length;
    clock.advance(1000);
    r.resize();
    expect(r.writes().length).toBe(after);
  });

  it("(e) a non-TTY stdout is never written to and no timer is armed", () => {
    const clock = manualTimers();
    const r = renderTty(<Probe timers={clock.timers} />, { columns: 80, rows: 24, isTTY: false });
    unmount = () => r.inst.unmount();
    r.setSize(40, 24);
    r.resize();
    r.resize();
    clock.advance(1000);
    expect(clears(r.writes())).toBe(0);
    expect(r.writes().join("")).not.toContain("[1;1H");
    expect(clock.armed).toHaveLength(0);
  });

  it("(f) after a narrow resize the repainted frame has one ◆ header, ≤ rows lines, each ≤ cols cells", () => {
    const clock = manualTimers();
    const r = renderTty(<Probe timers={clock.timers} />, { columns: 80, rows: 24 });
    unmount = () => r.inst.unmount();
    r.setSize(40, 24);
    r.resize();
    clock.advance(RESIZE_SETTLE_MS);
    const all = r.writes().join("");
    const at = all.lastIndexOf(HOME_ERASE_DOWN);
    expect(at).toBeGreaterThanOrEqual(0);
    let tail = all.slice(at + HOME_ERASE_DOWN.length);
    // Up to the next erase (log-update's eraseLines starts with ESC[2K).
    const nextErase = [tail.indexOf(ESC + "[2K"), tail.indexOf(HOME_ERASE_DOWN)]
      .filter((i) => i >= 0)
      .reduce((m, i) => Math.min(m, i), tail.length);
    tail = tail.slice(0, nextErase);
    const lines = stripVTControlCharacters(tail).split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    expect(lines.filter((l) => l.includes("◆"))).toHaveLength(1);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.length).toBeLessThanOrEqual(24);
    for (const l of lines) expect(Array.from(l).length).toBeLessThanOrEqual(40);
  });
});
