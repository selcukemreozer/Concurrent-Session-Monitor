import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// SC-2 / D-01 smoke boot: the COMMITTED dist/panel.mjs must boot under plain
// `node` in a directory that contains only that one file (zero node_modules),
// with no unresolved-module crash (Pitfall 1: react-devtools-core) and no
// dynamic-require-of-assert crash (Pitfall 2: signal-exit → require('assert')).
//
// Stdlib only (fs/os/path/child_process/url) — no PTY, no extra deps — mirroring
// the source-text style of launcher.test.ts (relative-path resolution off the
// test file). This is RED until Task 2 builds+commits dist/panel.mjs; that is
// the intended starting state — do NOT soften the assertions to make it pass.

/** Resolve a path relative to THIS test file. */
function resolveRel(rel: string): string {
  return fileURLToPath(new URL(rel, import.meta.url));
}

const BUNDLE = resolveRel("../../dist/panel.mjs");

describe("bundled panel smoke boot (SC-2, D-01)", () => {
  it("boots in a node_modules-free temp dir with no unresolved-module or dynamic-require crash", async () => {
    // RED guard: the committed bundle must exist. Absent until Task 2 builds it.
    expect(
      existsSync(BUNDLE),
      "dist/panel.mjs is missing — build+commit it (Task 2)",
    ).toBe(true);

    // Isolate: copy the bundle into a fresh temp dir with NO node_modules, and
    // point the store at a second temp dir so the panel never touches real state.
    const runDir = mkdtempSync(join(tmpdir(), "csm-bundle-run-"));
    const storeDir = mkdtempSync(join(tmpdir(), "csm-bundle-store-"));
    const copy = join(runDir, "panel.mjs");
    copyFileSync(BUNDLE, copy);

    const child = spawn(process.execPath, [copy], {
      cwd: runDir,
      env: { ...process.env, CSM_STORE_DIR: storeDir },
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    let exitedEarly = false;
    const exitPromise = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    void exitPromise.then(() => {
      exitedEarly = true;
    });

    // Give it time to fully boot the Ink render + first poll tick.
    await new Promise((r) => setTimeout(r, 1500));

    // A boot crash (unresolved module / dynamic require) exits immediately.
    expect(exitedEarly, `panel exited during boot; stderr:\n${stderr}`).toBe(
      false,
    );
    expect(stderr).not.toMatch(
      /ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/,
    );
    expect(stderr).not.toMatch(/Dynamic require of .* is not supported/);

    // Clean teardown: SIGTERM triggers the entry.ts shutdown → exit 0.
    child.kill("SIGTERM");
    const code = await exitPromise;
    expect(code === 0 || code === null).toBe(true);
  }, 20000);
});
