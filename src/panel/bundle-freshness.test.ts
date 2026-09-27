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
