import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink";
import { Writable } from "node:stream";
import { Splash } from "./Splash.js";

// RED (quick 260911-lsk): the csm launch splash — a green ASCII lighthouse emblem
// shown briefly before the live panel (Root gates it on TTY). Mirrors App.test.tsx's
// raw-ink render + captured Writable (debug:true → full frame written synchronously).
// A probe confirmed Ink emits the ANSI green code to a captured non-TTY stream with
// debug:true, so the color assertion is reliable without FORCE_COLOR.

/** Render the Splash into a captured buffer (debug:true = synchronous full frame). */
function renderCapture() {
  let buf = "";
  const out = new Writable({
    write(c, _e, cb) {
      buf += c.toString();
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  (out as unknown as { columns: number }).columns = 80;
  (out as unknown as { rows: number }).rows = 24;
  const inst = render(React.createElement(Splash), {
    stdout: out,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return { inst, frame: () => buf };
}

describe("Splash (csm launch emblem)", () => {
  it("renders the wordmark and tagline", () => {
    const { inst, frame } = renderCapture();
    const f = frame();
    expect(f).toContain("CONCURRENT");
    expect(f).toContain("SESSION");
    expect(f).toContain("MONITOR");
    expect(f).toContain("the watch never sleeps");
    inst.unmount();
  });

  it("renders the brandmark in green (ANSI 32)", () => {
    const { inst, frame } = renderCapture();
    expect(frame()).toContain("[32m");
    inst.unmount();
  });
});
