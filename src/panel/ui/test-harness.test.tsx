import { describe, it, expect, vi } from "vitest";
import React, { useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import {
  renderCapture,
  renderTty,
  fakeTtyStdin,
  nonTtyStdin,
  press,
  KEYS,
  frameLines,
} from "./test-harness.js";

// Phase 9 plan 09-02 Task 3: prove the shared harness on the installed Ink
// (works the same on ink 7.1.1 and 8.x): fake TTY raw mode, key presses, the
// non-TTY degrade path and Ctrl+C exit.

/** Name a keypress the way the probe reports it. */
function keyName(input: string, key: { tab?: boolean; shift?: boolean; escape?: boolean; return?: boolean }): string {
  if (key.tab) return key.shift ? "tab+shift" : "tab";
  if (key.escape) return "escape";
  if (key.return) return "enter";
  return input;
}

/** The guarded keyboard child: only mounted when raw mode is supported. */
function Keys({ onKey }: { onKey: (name: string) => void }): null {
  useInput((input, key) => onKey(keyName(input, key)));
  return null;
}

function Probe(): React.ReactElement {
  const { isRawModeSupported } = useStdin();
  const [last, setLast] = useState("none");
  return (
    <Box flexDirection="column">
      <Text>last:{last}</Text>
      <Text>raw:{isRawModeSupported ? "yes" : "no"}</Text>
      {isRawModeSupported ? <Keys onKey={setLast} /> : null}
    </Box>
  );
}

describe("test-harness", () => {
  it("fake TTY: raw mode is engaged and Tab / Shift+Tab / Esc / q reach useInput", async () => {
    const raw: boolean[] = [];
    const stdin = fakeTtyStdin((m) => raw.push(m));
    const { inst, lastFrame } = renderCapture(<Probe />, { rows: 5, columns: 40, stdin });
    await vi.waitFor(() => expect(raw).toContain(true));
    expect(lastFrame()).toContain("raw:yes");

    press(stdin, KEYS.tab);
    await vi.waitFor(() => expect(lastFrame()).toContain("last:tab"));
    press(stdin, KEYS.shiftTab);
    await vi.waitFor(() => expect(lastFrame()).toContain("last:tab+shift"));
    press(stdin, KEYS.esc);
    await vi.waitFor(() => expect(lastFrame()).toContain("last:escape"));
    press(stdin, KEYS.q);
    await vi.waitFor(() => expect(lastFrame()).toContain("last:q"));
    inst.unmount();
  });

  it("non-TTY: the guarded keyboard child never mounts, the frame still renders", () => {
    const { inst, lastFrame } = renderCapture(<Probe />, { rows: 5, columns: 40, stdin: nonTtyStdin() });
    const lines = frameLines(lastFrame());
    expect(lines[0]).toContain("last:none");
    expect(lines[1]).toContain("raw:no");
    inst.unmount();
  });

  it("Ctrl+C exits the instance when exitOnCtrlC is on (the default)", async () => {
    const stdin = fakeTtyStdin();
    const { inst } = renderCapture(<Probe />, { stdin });
    await new Promise((r) => setTimeout(r, 20));
    press(stdin, KEYS.ctrlC);
    await expect(inst.waitUntilExit()).resolves.toBeUndefined();
  });

  it("frameLines strips VT sequences and drops one trailing empty line", () => {
    const ESC = String.fromCharCode(27);
    expect(frameLines(ESC + "[1mab" + ESC + "[22m\n\ncd\n")).toEqual(["ab", "", "cd"]);
  });

  it("KEYS are the terminal sequences Ink parses", () => {
    const ESC = String.fromCharCode(27);
    expect(KEYS.shiftTab).toBe(ESC + "[Z");
    expect(KEYS.up).toBe(ESC + "[A");
    expect(KEYS.ctrlC.codePointAt(0)).toBe(3);
    expect(KEYS.enter).toBe("\r");
  });
  it("renderTty: a fake TTY stdout with mutable size, a resize emitter and raw writes", () => {
    const { inst, out, writes, setSize, resize } = renderTty(<Text>hello</Text>, {
      columns: 50,
      rows: 10,
    });
    expect(out.isTTY).toBe(true);
    expect(out.columns).toBe(50);
    expect(out.rows).toBe(10);
    expect(writes().join("")).toContain("hello");
    let fired = 0;
    out.on("resize", () => {
      fired += 1;
    });
    setSize(30, 7);
    expect(out.columns).toBe(30);
    expect(out.rows).toBe(7);
    resize();
    expect(fired).toBe(1);
    // writes() returns a copy, so a caller cannot mutate the record.
    const snap = writes();
    snap.length = 0;
    expect(writes().length).toBeGreaterThan(0);
    inst.unmount();
  });

  it("renderTty: isTTY false models a piped stdout", () => {
    const { inst, out } = renderTty(<Text>x</Text>, { isTTY: false });
    expect(out.isTTY).toBe(false);
    expect(out.columns).toBe(80);
    expect(out.rows).toBe(24);
    inst.unmount();
  });
});
