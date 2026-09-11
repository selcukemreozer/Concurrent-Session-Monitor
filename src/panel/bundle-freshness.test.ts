import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// INV-2 / Pitfall 3: the COMMITTED dist/panel.mjs must stay byte-in-sync with its
// sources. A src/panel change that ships without a rebuild would silently give
// installed users old behavior (installs run no build step). Guard: re-run the
// EXACT build recipe from package.json (single source of truth) into a temp
// --outfile, then byte-diff against the committed bundle. If they differ, someone
// changed a source without rebuilding — rebuild and re-commit dist/panel.mjs.
//
// Stdlib only. We rewrite only the --outfile target so we never clobber the
// committed bundle, and prepend node_modules/.bin to PATH so `esbuild` resolves
// exactly as `npm run build` would.

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const COMMITTED = join(REPO_ROOT, "dist", "panel.mjs");

describe("committed bundle freshness (INV-2)", () => {
  it("dist/panel.mjs is byte-identical to a fresh rebuild of its sources", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    );
    const buildCmd: string = pkg.scripts.build;
    expect(buildCmd).toContain("--outfile=dist/panel.mjs");

    const tmpDir = mkdtempSync(join(tmpdir(), "csm-bundle-fresh-"));
    const tmpOut = join(tmpDir, "panel.fresh.mjs");
    const freshCmd = buildCmd.replace(
      "--outfile=dist/panel.mjs",
      `--outfile=${tmpOut}`,
    );

    execSync(freshCmd, {
      cwd: REPO_ROOT,
      shell: "/bin/sh",
      env: {
        ...process.env,
        PATH: `${join(REPO_ROOT, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
      },
    });

    const committed = readFileSync(COMMITTED);
    const fresh = readFileSync(tmpOut);
    expect(
      committed.equals(fresh),
      "dist/panel.mjs is stale — run `npm run build` and re-commit it",
    ).toBe(true);
  }, 60000);
});
