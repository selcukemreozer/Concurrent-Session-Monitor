import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Source-level regression guard for the dual-ink-instance launcher bug.
//
// `node bin/csm.mjs` boots through Node's native ESM loader while App.tsx is
// pulled in by tsx's loader — two DIFFERENT loaders, so importing ink/react in
// BOTH the launcher and the tsx graph instantiates ink TWICE. render()'s
// StdinContext provider then comes from one ink copy while App's
// useStdin()/useInput() read the other copy's (unprovided) context, so
// isRawModeSupported collapses to false and the FAZLAR keyboard dies on every
// TTY. The fix: render() must live ONLY inside the tsx-loaded src/panel/main.tsx
// (one ink instance), and the launcher must import nothing from ink or react.
//
// This bug is loader-specific and cannot be reproduced inside vitest's
// single-instance transform, so we guard the invariant at the SOURCE text level
// (stdlib fs + url only — no PTY, no extra deps).

/** Read a source file resolved relative to THIS test file. */
function readRel(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("launcher single-ink-instance invariant (dual-loader regression)", () => {
  it("bin/csm.mjs imports nothing directly from ink or react", () => {
    const bin = readRel("../../bin/csm.mjs");
    expect(bin).not.toMatch(/from\s+['"]ink['"]/);
    expect(bin).not.toMatch(/from\s+['"]react['"]/);
  });

  it("bin/csm.mjs obtains the instance from main.tsx via the exported run()", () => {
    const bin = readRel("../../bin/csm.mjs");
    expect(bin).toMatch(/main\.(tsx|js)/);
    expect(bin).toContain("run(");
  });

  it("src/panel/main.tsx exports run() and is the sole render() call site", () => {
    const main = readRel("./main.tsx");
    expect(main).toMatch(/export\s+function\s+run/);
    expect(main).toContain("render(");
  });
});
