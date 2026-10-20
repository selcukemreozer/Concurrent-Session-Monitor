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

/** True when any element in the tree carries a truthy Ink faint attribute prop. */
function hasFaint(node: React.ReactNode): boolean {
  if (Array.isArray(node)) return node.some((n) => hasFaint(n));
  if (!node || typeof node !== "object") return false;
  const el = node as React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;
  if (!el.props) return false;
  if (el.props["dimColor"]) return true;
  return hasFaint(el.props.children);
}

describe("Splash v2 palette (Phase 9 plan 09-13, D-22)", () => {
  it("recolors the emblem, wordmark and tagline with the v2 tokens", () => {
    const colors = collectColors(Splash({ palette: "v2" }));
    expect(colors).toContain("#E8C24A");
    expect(colors).toContain("#f5f3ec");
    expect(colors).toContain("#85827a");
    expect(colors).not.toContain("green");
  });

  it("never uses the faint attribute", () => {
    expect(hasFaint(Splash({ palette: "v2" }))).toBe(false);
  });

  it("the default stays the legacy green splash with the faint tagline", () => {
    expect(collectColors(Splash())).toEqual(["green", "green", "green"]);
    expect(hasFaint(Splash())).toBe(true);
    expect(collectColors(Splash({ palette: "legacy" }))).toEqual(["green", "green", "green"]);
  });

  it("the v2 splash renders the same wordmark and tagline text", () => {
    let buf = "";
    const out = new Writable({
      write(c, _e, cb) {
        buf += c.toString();
        cb();
      },
    }) as unknown as NodeJS.WriteStream;
    (out as unknown as { columns: number }).columns = 80;
    (out as unknown as { rows: number }).rows = 24;
    const inst = render(React.createElement(Splash, { palette: "v2" }), {
      stdout: out,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    expect(buf).toContain("CONCURRENT · SESSION · MONITOR");
    expect(buf).toContain("the watch never sleeps");
    expect(buf).toContain("((•))");
    inst.unmount();
  });
});
