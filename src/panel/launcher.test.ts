import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Source-level regression guard for the single-ink-instance invariant, now
// re-pointed at the BUNDLED architecture (Phase 5, D-01).
//
// Before Phase 5 `bin/csm.mjs` transpiled main.tsx on import via tsx while App
// was pulled in through tsx's loader — two loaders, so importing ink/react in
// both the launcher and the tsx graph instantiated ink TWICE, isRawModeSupported
// collapsed to false, and the FAZLAR keyboard died on every TTY. After Phase 5
// the launcher imports one pre-bundled dist/panel.mjs (one ink instance, no tsx
// at runtime), so that bug class is structurally impossible. The invariant we
// still guard at the SOURCE-text level (stdlib fs + url only — no PTY, no deps):
//   - bin/csm.mjs imports ONLY the bundle — nothing from ink/react/tsx.
//   - src/panel/entry.ts (the bundle entry) imports run() from main and awaits
//     waitUntilExit — it is NOT itself a render() site.
//   - src/panel/main.tsx exports run() and is the SOLE render() call site.

/** Read a source file resolved relative to THIS test file. */
function readRel(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("launcher single-ink-instance invariant (bundled architecture)", () => {
  it("bin/csm.mjs imports nothing directly from ink, react, or tsx", () => {
    const bin = readRel("../../bin/csm.mjs");
    expect(bin).not.toMatch(/from\s+['"]ink['"]/);
    expect(bin).not.toMatch(/from\s+['"]react['"]/);
    expect(bin).not.toMatch(/tsx\/esm\/api/);
  });

  it("bin/csm.mjs boots by importing the committed bundle dist/panel.mjs", () => {
    const bin = readRel("../../bin/csm.mjs");
    expect(bin).toMatch(/dist\/panel\.mjs/);
  });

  it("src/panel/entry.ts imports run() from main and awaits waitUntilExit (no render call)", () => {
    const entry = readRel("./entry.ts");
    expect(entry).toMatch(
      /import\s*\{\s*run\s*\}\s*from\s+['"]\.\/main(\.js)?['"]/,
    );
    expect(entry).toContain("waitUntilExit");
    expect(entry).not.toMatch(/render\(/);
  });

  it("src/panel/main.tsx exports run() and is the sole render() call site", () => {
    const main = readRel("./main.tsx");
    expect(main).toMatch(/export\s+function\s+run/);
    expect(main).toContain("render(");
  });
});
