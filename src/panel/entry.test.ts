import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Plan 09-14 (KEYS-04, D-23, D-25): entry.ts wires the v2 crash handler.
//
// entry.ts has top-level side effects (it mounts the panel through run() and
// registers process listeners), so it is NOT imported here. These assertions
// read its source text, in the style of launcher.test.ts. The behavior itself
// is proven end to end in a real PTY by exit-pty.test.ts.

const ENTRY = readFileSync(fileURLToPath(new URL("./entry.ts", import.meta.url)), "utf8");

describe("entry.ts v2 crash wiring (09-14)", () => {
  it("imports the five crash functions from ./crash.js and uiVariant from ./ui/variant.js", () => {
    const m = ENTRY.match(/import\s*\{([^}]*)\}\s*from\s+["']\.\/crash\.js["']/);
    expect(m, "no named import from ./crash.js").not.toBeNull();
    const names = (m?.[1] ?? "").split(",").map((s) => s.trim());
    for (const n of [
      "createCrashHandler",
      "installCrashHandlers",
      "appendCrashLog",
      "crashLogDisplayPath",
      "restoreTerminal",
    ]) {
      expect(names).toContain(n);
    }
    expect(ENTRY).toMatch(
      /import\s*\{\s*uiVariant\s*\}\s*from\s+["']\.\/ui\/variant\.js["']/,
    );
  });

  it("gates the crash handler on the v2 variant", () => {
    expect(ENTRY).toContain('uiVariant() === "v2"');
    expect(ENTRY).toContain("createCrashHandler(");
    expect(ENTRY).toContain("restoreTerminal(instance)");
  });

  it("installs the crash handlers before Ink mounts (before instance = run())", () => {
    const install = ENTRY.indexOf("installCrashHandlers(");
    const mount = ENTRY.indexOf("instance = run()");
    expect(install).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(-1);
    expect(install).toBeLessThan(mount);
  });

  it("writes the crash line synchronously to fd 2 (Pitfall 4)", () => {
    expect(ENTRY).toContain("fs.writeSync(2");
    expect(ENTRY).toMatch(/import\s+\*\s+as\s+fs\s+from\s+["']node:fs["']/);
  });

  it("wraps waitUntilExit in try/catch; the non-v2 path re-throws (Pitfall 3, D-23)", () => {
    const wait = ENTRY.indexOf("await instance.waitUntilExit()");
    expect(wait).toBeGreaterThan(-1);
    const tryAt = ENTRY.lastIndexOf("try {", wait);
    expect(tryAt).toBeGreaterThan(-1);
    // the try must be the one directly around the await
    expect(ENTRY.slice(tryAt, wait)).toMatch(/^try \{\s*$/);
    const catchAt = ENTRY.indexOf("catch (err", wait);
    expect(catchAt).toBeGreaterThan(wait);
    const catchBody = ENTRY.slice(catchAt, catchAt + 400);
    expect(catchBody).toContain("throw err");
    expect(catchBody).toContain("onCrash(err)");
  });

  it("still imports run() from ./main and never mounts Ink itself", () => {
    expect(ENTRY).toMatch(/import\s*\{\s*run\s*\}\s*from\s+["']\.\/main(\.js)?["']/);
    expect(ENTRY).not.toMatch(/render\(/);
  });
});
