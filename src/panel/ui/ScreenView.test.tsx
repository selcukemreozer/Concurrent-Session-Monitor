import { describe, it, expect } from "vitest";
import React from "react";
import { ScreenView } from "./ScreenView.js";
import type { Line } from "./screen.js";
import { renderCapture, frameLines } from "./test-harness.js";

// Phase 9 plan 09-02 Task 3: ScreenView paints Line[] one row per Line. Colors
// are asserted on the element tree (never on ANSI), so this is independent of
// the ambient FORCE_COLOR/NO_COLOR level (same approach as Splash.test.tsx).

const DIAMOND = String.fromCodePoint(0x25c6);
const BRAND = "#E8C24A";
const FG = "#f5f3ec";

const LINES: Line[] = [
  [
    { text: DIAMOND, fg: BRAND },
    { text: " CSM", fg: FG, bold: true },
  ],
  [],
  [{ text: "x" }],
];

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

/** Walk a React element tree, calling `visit` on every element's props. */
function walk(node: React.ReactNode, visit: (props: AnyProps) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (!node || typeof node !== "object") return;
  const el = node as React.ReactElement<AnyProps>;
  if (el.props) {
    visit(el.props);
    walk(el.props.children, visit);
  }
}

/** Every `color` prop set in the tree. */
function collectColors(node: React.ReactNode): string[] {
  const acc: string[] = [];
  walk(node, (p) => {
    if (typeof p.color === "string") acc.push(p.color);
  });
  return acc;
}

describe("ScreenView", () => {
  it("renders exactly one terminal line per Line, a blank Line keeps its row", () => {
    const { inst, lastFrame } = renderCapture(<ScreenView lines={LINES} />, { rows: 3, columns: 40 });
    const lines = frameLines(lastFrame());
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(DIAMOND + " CSM");
    expect(lines[1]!.trim()).toBe("");
    expect(lines[2]).toContain("x");
    inst.unmount();
  });

  it("carries Seg colors as element props", () => {
    const tree = ScreenView({ lines: LINES });
    const colors = collectColors(tree);
    expect(colors).toContain(BRAND);
    expect(colors).toContain(FG);
  });

  it("maps a Seg bg to a backgroundColor prop and bold to bold", () => {
    const tree = ScreenView({ lines: [[{ text: "sel", fg: FG, bg: "#3a1a1b", bold: true }]] });
    const bgs: unknown[] = [];
    const bolds: unknown[] = [];
    walk(tree, (p) => {
      if (p.backgroundColor !== undefined) bgs.push(p.backgroundColor);
      if (p.bold !== undefined) bolds.push(p.bold);
    });
    expect(bgs).toEqual(["#3a1a1b"]);
    expect(bolds).toEqual([true]);
  });

  it("never sets the faint-text attribute", () => {
    const tree = ScreenView({ lines: [...LINES, [{ text: "dim", fg: "#8a8578" }]] });
    let faint = 0;
    walk(tree, (p) => {
      if ("dimColor" in p) faint++;
    });
    expect(faint).toBe(0);
  });

  it("does not shrink rows under a too-short terminal", () => {
    const { inst, lastFrame } = renderCapture(<ScreenView lines={LINES} />, { rows: 2, columns: 40 });
    expect(frameLines(lastFrame()).length).toBeGreaterThanOrEqual(3);
    inst.unmount();
  });
});
