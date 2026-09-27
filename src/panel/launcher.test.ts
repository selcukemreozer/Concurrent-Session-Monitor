import { describe, it, expect, afterEach } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
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

// 05 IN-02: a missing bundle gets a one-line actionable message (exit 1, no
// stack); anything else thrown while importing the bundle is re-thrown so real
// boot errors keep their full stack. Runs a COPY of bin/csm.mjs in a temp
// install dir with process.execPath — stdlib only, no PTY.
describe("launcher missing-bundle handling (05 IN-02)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Temp install root with bin/csm.mjs copied in and an optional dist/panel.mjs. */
  function install(panel?: string): string {
    const root = mkdtempSync(path.join(tmpdir(), "csm-launcher-"));
    dirs.push(root);
    mkdirSync(path.join(root, "bin"));
    copyFileSync(
      fileURLToPath(new URL("../../bin/csm.mjs", import.meta.url)),
      path.join(root, "bin", "csm.mjs"),
    );
    if (panel !== undefined) {
      mkdirSync(path.join(root, "dist"));
      writeFileSync(path.join(root, "dist", "panel.mjs"), panel);
    }
    return root;
  }

  function launch(root: string) {
    return spawnSync(process.execPath, [path.join(root, "bin", "csm.mjs")], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
  }

  it("no dist/: exits 1 with one actionable stderr line and no stack trace", () => {
    const res = launch(install());
    expect(res.status).toBe(1);
    const lines = res.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^csm: panel bundle not found at .*dist[\\/]panel\.mjs; reinstall the plugin/);
    expect(res.stderr).not.toMatch(/^\s+at /m);
    expect(res.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });

  it("a module missing INSIDE the bundle is re-thrown, not reported as a missing bundle", () => {
    const res = launch(install('import "csm-no-such-package-zz";\n'));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("ERR_MODULE_NOT_FOUND");
    expect(res.stderr).toContain("csm-no-such-package-zz");
    expect(res.stderr).not.toContain("panel bundle not found");
  });

  it("a genuine panel boot error keeps its full stack", () => {
    const res = launch(install('throw new Error("csm-boot-boom");\n'));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("csm-boot-boom");
    expect(res.stderr).toMatch(/^\s+at /m);
    expect(res.stderr).not.toContain("panel bundle not found");
  });
});
