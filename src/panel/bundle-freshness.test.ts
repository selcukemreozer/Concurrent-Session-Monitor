import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// INV-2 / Pitfall 3: the COMMITTED dist/panel.mjs must stay byte-in-sync with its
// sources. A src/panel change that ships without a rebuild would silently give
// installed users old behavior (installs run no build step). Guard: re-run the
// EXACT build script that `npm run build` runs (scripts/build.mjs, single source
// of truth) into a temp outfile, then byte-diff against the committed bundle. If
// they differ, someone changed a source without rebuilding — rebuild and
// re-commit dist/panel.mjs.
//
// Stdlib only. The build script takes the outfile as its first argument, so we
// never clobber the committed bundle, and it is invoked directly via node
// (execFile, no shell) — the build no longer depends on shell quoting (WR-03).

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const COMMITTED = join(REPO_ROOT, "dist", "panel.mjs");
const BUILD_SCRIPT = join(REPO_ROOT, "scripts", "build.mjs");

describe("committed bundle freshness (INV-2)", () => {
  it("npm run build delegates to the shell-independent scripts/build.mjs", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    );
    expect(pkg.scripts.build).toBe("node scripts/build.mjs");
  });

  it("dist/panel.mjs is byte-identical to a fresh rebuild of its sources", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "csm-bundle-fresh-"));
    const tmpOut = join(tmpDir, "panel.fresh.mjs");

    execFileSync(process.execPath, [BUILD_SCRIPT, tmpOut], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "pipe"],
    });

    const committed = readFileSync(COMMITTED);
    const fresh = readFileSync(tmpOut);
    expect(
      committed.equals(fresh),
      "dist/panel.mjs is stale — run `npm run build` and re-commit it",
    ).toBe(true);
  }, 60000);
});

// React production build (261020-wr6): scripts/build.mjs once had no
// process.env.NODE_ENV define, so React's CJS entry points (react,
// react/jsx-runtime, react-reconciler, scheduler) chose their development build
// at RUNTIME — and since the launcher never sets NODE_ENV, every installed panel
// ran dev React. In 1.6.1 the dev reconciler's performance.measure ("Performance
// Tracks") entries were never cleared, so a long-running panel hit
// MaxPerformanceEntryBufferExceededWarning (1,000,001 entries) and grew without
// bound (1.1 GB RSS after 3h36m). The fix is the esbuild define in
// scripts/build.mjs. These tests read the COMMITTED bundle; together with the
// INV-2 byte-diff above (which re-runs build.mjs) they lock the define and the
// committed bundle in step: dropping the define, or committing a bundle built
// without it, fails the suite.
//
// Assertions match esbuild's non-minified module-boundary comments
// (`// node_modules/<path>`) and literal API names — never minified identifiers.

function countLiteral(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const FIX_HINT =
  "check the process.env.NODE_ENV define in scripts/build.mjs and run `npm run build`";

describe("committed bundle uses React's production build (261020-wr6)", () => {
  const bundle = readFileSync(COMMITTED, "utf8");

  it("bundles no *.development.js module from node_modules", () => {
    const devModules =
      bundle.match(/^\/\/ node_modules\/\S+\.development\.js$/gm) ?? [];
    expect(devModules, `dev React modules are bundled — ${FIX_HINT}`).toEqual(
      [],
    );
  });

  it("bundles the production react and react-reconciler modules", () => {
    for (const mod of [
      "node_modules/react-reconciler/cjs/react-reconciler.production.js",
      "node_modules/react/cjs/react.production.js",
    ]) {
      expect(
        bundle.split("\n").includes(`// ${mod}`),
        `missing production module ${mod} — ${FIX_HINT}`,
      ).toBe(true);
    }
  });

  it("has no performance.measure call sites and no runtime NODE_ENV switch", () => {
    expect(
      countLiteral(bundle, "performance.measure("),
      `performance.measure( call sites leak perf_hooks entries — ${FIX_HINT}`,
    ).toBe(0);
    expect(
      countLiteral(bundle, "process.env.NODE_ENV"),
      `runtime NODE_ENV switch left in the bundle — ${FIX_HINT}`,
    ).toBe(0);
  });
});
