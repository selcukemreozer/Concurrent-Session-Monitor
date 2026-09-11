import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// TDD guard for /csm-setup's symlink helper (D-02, threat T-05-01 TOCTOU/clobber).
//
// scripts/csm-setup.mjs must be idempotent AND non-clobbering: it creates
// ~/.local/bin/csm -> ${CLAUDE_PLUGIN_ROOT}/bin/csm.mjs only when the target is
// absent, is a no-op when the correct symlink already exists, and must NEVER
// overwrite a real file or a foreign symlink (lstat/readlink BEFORE acting —
// never `ln -sf`, never unconditional unlink). It always exits 0.
//
// Every path below is a throwaway mkdtemp; HOME is redirected into the temp dir
// so os.homedir() resolves there and the real ~/.local/bin is never touched.
// The launcher filename is bin/csm.mjs (05-RESEARCH open-question #2 resolution:
// keep the file bin/csm.mjs, symlink ~/.local/bin/csm -> it).

const script = fileURLToPath(new URL("./csm-setup.mjs", import.meta.url));

function makeEnvDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "csm-setup-"));
  const home = path.join(base, "home");
  const pluginRoot = path.join(base, "plugin");
  fs.mkdirSync(path.join(pluginRoot, "bin"), { recursive: true });
  const launcher = path.join(pluginRoot, "bin", "csm.mjs");
  fs.writeFileSync(launcher, "#!/usr/bin/env node\n// fake launcher\n");
  fs.mkdirSync(home, { recursive: true });
  return { base, home, pluginRoot, launcher };
}

function run(home: string, pluginRoot: string) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
    encoding: "utf8",
  });
}

let dirs: ReturnType<typeof makeEnvDirs>;

beforeEach(() => {
  dirs = makeEnvDirs();
});

afterEach(() => {
  fs.rmSync(dirs.base, { recursive: true, force: true });
});

describe("csm-setup symlink helper (D-02, idempotent + non-clobbering)", () => {
  it("creates ~/.local/bin/csm -> plugin bin/csm.mjs when the target is absent", () => {
    const res = run(dirs.home, dirs.pluginRoot);
    expect(res.status).toBe(0);

    const target = path.join(dirs.home, ".local", "bin", "csm");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(target)).toBe(dirs.launcher);
  });

  it("is idempotent when the correct symlink already exists (unchanged, exit 0, says 'already')", () => {
    const first = run(dirs.home, dirs.pluginRoot);
    expect(first.status).toBe(0);

    const target = path.join(dirs.home, ".local", "bin", "csm");
    const before = fs.readlinkSync(target);

    const second = run(dirs.home, dirs.pluginRoot);
    expect(second.status).toBe(0);
    expect(fs.readlinkSync(target)).toBe(before); // link unchanged
    expect(second.stdout.toLowerCase()).toContain("already");
  });

  it("never clobbers a foreign plain FILE at the target (bytes unchanged, warns, exit 0)", () => {
    const localBin = path.join(dirs.home, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    const target = path.join(localBin, "csm");
    const sentinel = "DO NOT TOUCH — the user's own csm\n";
    fs.writeFileSync(target, sentinel);

    const res = run(dirs.home, dirs.pluginRoot);
    expect(res.status).toBe(0);
    // The pre-existing real file is byte-for-byte unchanged and still a file.
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe(sentinel);
    expect((res.stdout + res.stderr).toLowerCase()).toMatch(/warn|remove|manual/);
  });

  it("never clobbers a FOREIGN symlink pointing elsewhere (unchanged, warns, exit 0)", () => {
    const localBin = path.join(dirs.home, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    const target = path.join(localBin, "csm");
    const elsewhere = path.join(dirs.base, "some-other-tool");
    fs.writeFileSync(elsewhere, "#!/usr/bin/env node\n");
    fs.symlinkSync(elsewhere, target);

    const res = run(dirs.home, dirs.pluginRoot);
    expect(res.status).toBe(0);
    // The foreign symlink still points where it did — never repointed.
    expect(fs.readlinkSync(target)).toBe(elsewhere);
    expect((res.stdout + res.stderr).toLowerCase()).toMatch(/warn|remove|manual/);
  });
});
