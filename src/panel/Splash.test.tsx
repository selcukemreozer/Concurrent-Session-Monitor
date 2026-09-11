import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink";
import { Writable } from "node:stream";
import { Splash } from "./Splash.js";

// quick 260911-lsk: the csm launch splash — a green ASCII lighthouse emblem shown
// briefly before the live panel (Root gates it on TTY). Text assertions use
// App.test.tsx's raw-ink render + captured Writable (debug:true → full frame written
// synchronously). The color assertion inspects the returned element tree directly
// (not the ANSI frame) so it is independent of the ambient FORCE_COLOR/NO_COLOR level.

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

/** Recursively collect every `color` prop set on a node in a React element tree. */
function collectColors(node: React.ReactNode, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) collectColors(n, acc);
    return acc;
  }
  if (!node || typeof node !== "object") return acc;
  const el = node as React.ReactElement<{
    color?: string;
    children?: React.ReactNode;
  }>;
  if (el.props) {
    if (typeof el.props.color === "string") acc.push(el.props.color);
    collectColors(el.props.children, acc);
  }
  return acc;
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

  it("colors the emblem and wordmark brand green (not cyan)", () => {
    // Inspect the element tree, not the ANSI frame, so the assertion holds
    // whether or not the ambient environment enables terminal color.
    const colors = collectColors(Splash());
    expect(colors).toContain("green");
    expect(colors).not.toContain("cyan");
  });
});
