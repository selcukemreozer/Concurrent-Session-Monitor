import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RESUME_ID_PATTERN,
  isResumableId,
  resumeCommand,
  validLaunchCwd,
  osascriptArgs,
  TERMINAL_SCRIPT,
  ITERM_SCRIPT,
  WARP_TAB_CONFIG_MARKER,
  tomlBasicString,
  warpTabConfigToml,
  writeWarpTabConfig,
  removeWarpTabConfig,
  cleanupWarpTabConfig,
  defaultRun,
  copyResume,
  openResume,
  MSG_COPIED,
  MSG_COPIED_LIVE,
  MSG_INVALID_ID,
  type LaunchDeps,
  type RunOptions,
} from "./launch.js";

/**
 * Resume launcher (Phase 8 plan 02, D-15/D-16, T-08-03/04/09/10/12).
 *
 * Every route test goes through an injected fake `deps` — no real pbcopy,
 * osascript or open is ever spawned and the real clipboard is never touched.
 * Only the R cases spawn a real child, and only node itself (process.execPath)
 * or a missing path. All files are written under a per-test temp `home`.
 */

const ID = "11111111-2222-3333-4444-555555555555";
const CMD = "claude --resume " + ID;

let home: string;
let cwd: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "csm-launch-")));
  cwd = path.join(home, "proj");
  fs.mkdirSync(cwd);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

interface Call {
  cmd: string;
  args: string[];
  opts: RunOptions;
}

interface FakeOver {
  termProgram?: string;
  platform?: string;
  results?: Record<string, boolean>;
}

function realIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fakeDeps(over: FakeOver = {}): { deps: LaunchDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: LaunchDeps = {
    async run(cmd, args, opts) {
      calls.push({ cmd, args: [...args], opts });
      const ok = over.results?.[cmd];
      return { ok: ok === undefined ? true : ok };
    },
    isDir: realIsDir,
    homedir: () => home,
    platform: over.platform ?? "darwin",
    termProgram: over.termProgram,
  };
  return { deps, calls };
}

const PBCOPY_CALL = () => ({ cmd: "/usr/bin/pbcopy", args: [], opts: { input: CMD, timeoutMs: 1500 } });
const tabConfigPath = () => path.join(home, ".warp", "tab_configs", "csm-resume.toml");

describe("id gate and command (U1-U2)", () => {
  it("U1 isResumableId accepts only a lowercase UUID", () => {
    expect(isResumableId(ID)).toBe(true);
    expect(RESUME_ID_PATTERN.test(ID)).toBe(true);
    const bad: unknown[] = [
      "-rf",
      ID.slice(1),
      "AAAAAAAA-2222-3333-4444-555555555555",
      "../x",
      42,
      undefined,
      ID + "\n",
    ];
    for (const b of bad) {
      expect(isResumableId(b)).toBe(false);
      if (typeof b === "string") expect(RESUME_ID_PATTERN.test(b)).toBe(false);
    }
  });

  it("U2 resumeCommand has no cd prefix (D-10)", () => {
    expect(resumeCommand(ID)).toBe("claude --resume " + ID);
  });
});

describe("validLaunchCwd (V1)", () => {
  it("returns the real folder", () => {
    expect(validLaunchCwd(cwd, realIsDir)).toBe(cwd);
  });

  it("rejects relative, unnormalized, control, format, surrogate, missing, file and odd inputs", () => {
    // BEL and RLO folders really exist, so only the code-point check can reject them.
    const bel = path.join(home, "a\u0007b");
    const rlo = path.join(home, "a‮b");
    fs.mkdirSync(bel);
    fs.mkdirSync(rlo);
    const file = path.join(home, "f.txt");
    fs.writeFileSync(file, "x");
    const bad: unknown[] = [
      "proj",
      home + "/a/../proj",
      bel,
      rlo,
      home + "/a\uD800b",
      path.join(home, "missing"),
      file,
      42,
      "",
      "/" + "a".repeat(4096),
    ];
    for (const b of bad) expect(validLaunchCwd(b, realIsDir)).toBeUndefined();
  });
});

describe("copyResume (C1-C4)", () => {
  it("C1 copies the command to pbcopy on stdin with no args", async () => {
    const { deps, calls } = fakeDeps();
    const r = await copyResume({ id: ID, live: false }, deps);
    expect(calls).toEqual([PBCOPY_CALL()]);
    expect(r).toEqual({ ok: true, copied: true, message: "copied ✓" });
    expect(MSG_COPIED).toBe("copied ✓");
  });

  it("C2 live row still copies (D-16)", async () => {
    const { deps, calls } = fakeDeps();
    const r = await copyResume({ id: ID, live: true }, deps);
    expect(calls).toEqual([PBCOPY_CALL()]);
    expect(r).toEqual({ ok: true, copied: true, message: "copied ✓ · session still open" });
    expect(MSG_COPIED_LIVE).toBe("copied ✓ · session still open");
  });

  it("C3 copy failure shows the full command", async () => {
    const { deps } = fakeDeps({ results: { "/usr/bin/pbcopy": false } });
    expect(await copyResume({ id: ID, live: false }, deps)).toEqual({
      ok: false,
      copied: false,
      message: "copy failed · run: " + CMD,
    });
    expect(await copyResume({ id: ID, live: true }, deps)).toEqual({
      ok: false,
      copied: false,
      message: "copy failed · run: " + CMD + " · session still open",
    });
  });

  it("C4 invalid id spawns nothing", async () => {
    const { deps, calls } = fakeDeps();
    const r = await copyResume({ id: "-x", live: false }, deps);
    expect(r).toEqual({ ok: false, copied: false, message: "refused: not a resumable session id" });
    expect(MSG_INVALID_ID).toBe("refused: not a resumable session id");
    expect(calls).toEqual([]);
  });
});

describe("openResume (O1-O13)", () => {
  it("O1 live row copies and opens nothing (D-16)", async () => {
    const { deps, calls } = fakeDeps({ termProgram: "Apple_Terminal" });
    const r = await openResume({ id: ID, cwd, live: true }, deps);
    expect(calls).toEqual([PBCOPY_CALL()]);
    expect(r).toEqual({
      ok: false,
      copied: true,
      message: "session still open, no new tab opened · command copied",
    });
    expect(fs.existsSync(path.join(home, ".warp"))).toBe(false);
  });

  it("O2 Apple_Terminal runs the constant TERMINAL_SCRIPT over argv", async () => {
    const { deps, calls } = fakeDeps({ termProgram: "Apple_Terminal" });
    const r = await openResume({ id: ID, cwd, live: false }, deps);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(PBCOPY_CALL());
    expect(calls[1]!.cmd).toBe("/usr/bin/osascript");
    expect(calls[1]!.args).toEqual(osascriptArgs(TERMINAL_SCRIPT, cwd, ID));
    expect(osascriptArgs(TERMINAL_SCRIPT, cwd, ID)).toEqual([
      ...TERMINAL_SCRIPT.flatMap((l) => ["-e", l]),
      "--",
      cwd,
      ID,
    ]);
    expect(calls[1]!.opts.timeoutMs).toBe(20000);
    expect(r).toEqual({ ok: true, copied: true, message: "opened a new Terminal window · command copied" });
  });

  it("O3 iTerm.app runs ITERM_SCRIPT; both scripts are constant argv-quoting scripts", async () => {
    const { deps, calls } = fakeDeps({ termProgram: "iTerm.app" });
    const r = await openResume({ id: ID, cwd, live: false }, deps);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.cmd).toBe("/usr/bin/osascript");
    expect(calls[1]!.args).toEqual(osascriptArgs(ITERM_SCRIPT, cwd, ID));
    expect(calls[1]!.opts.timeoutMs).toBe(20000);
    expect(r).toEqual({ ok: true, copied: true, message: "opened a new iTerm2 window · command copied" });

    expect(TERMINAL_SCRIPT.some((l) => l.includes('tell application "Terminal"'))).toBe(true);
    expect(TERMINAL_SCRIPT.some((l) => l.includes("do script"))).toBe(true);
    expect(ITERM_SCRIPT.some((l) => l.includes('tell application "iTerm2"'))).toBe(true);
    expect(ITERM_SCRIPT.some((l) => l.includes("create window with default profile"))).toBe(true);
    expect(ITERM_SCRIPT.some((l) => l.includes("write text"))).toBe(true);
    for (const s of [TERMINAL_SCRIPT, ITERM_SCRIPT]) {
      expect(s[0]).toBe("on run argv");
      expect(s[s.length - 1]).toBe("end run");
      expect(s.some((l) => l.includes("quoted form of (item 1 of argv)"))).toBe(true);
      expect(s.some((l) => l.includes("quoted form of (item 2 of argv)"))).toBe(true);
    }
  });

  it("O4 a hostile folder name stays an argv item, never script source", async () => {
    const hostile = path.join(home, "a'b $(touch x) \"q\" ;rm");
    fs.mkdirSync(hostile);
    const { deps, calls } = fakeDeps({ termProgram: "Apple_Terminal" });
    await openResume({ id: ID, cwd: hostile, live: false }, deps);
    const osa = calls.find((c) => c.cmd === "/usr/bin/osascript");
    expect(osa).toBeDefined();
    const args = osa!.args;
    expect(args.slice(-2)).toEqual([hostile, ID]);
    const eValues: string[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === "-e") eValues.push(args[i + 1]!);
    expect(eValues.length).toBe(TERMINAL_SCRIPT.length);
    for (const v of eValues) {
      expect(TERMINAL_SCRIPT).toContain(v);
      expect(v).not.toContain("touch");
    }
    expect(fs.existsSync(path.join(home, "x"))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), "x"))).toBe(false);
  });

  it("O5 osascript failure falls back to the copy", async () => {
    const { deps } = fakeDeps({ termProgram: "Apple_Terminal", results: { "/usr/bin/osascript": false } });
    expect(await openResume({ id: ID, cwd, live: false }, deps)).toEqual({
      ok: false,
      copied: true,
      message: "could not open a new tab, paste the command · command copied",
    });
  });

  it("O6 WarpTerminal writes a 0600 marked tab config atomically and opens it", async () => {
    const { deps, calls } = fakeDeps({ termProgram: "WarpTerminal" });
    const r = await openResume({ id: ID, cwd, live: false }, deps);
    const file = tabConfigPath();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const text = fs.readFileSync(file, "utf8");
    expect(text.split("\n")[0]).toBe(WARP_TAB_CONFIG_MARKER);
    expect(text).toContain('directory = "' + cwd + '"');
    expect(text).toContain('commands = ["claude --resume ' + ID + '"]');
    expect(text).not.toContain("[params]");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["csm-resume.toml"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(PBCOPY_CALL());
    expect(calls[1]!.cmd).toBe("/usr/bin/open");
    expect(calls[1]!.args).toEqual(["warp://tab_config/csm-resume?new_window=true"]);
    expect(r).toEqual({ ok: true, copied: true, message: "opening in Warp… · command copied" });
  });

  it("O7 a Warp-unsafe folder is refused and only copied", async () => {
    const unsafe = path.join(home, "x$y");
    fs.mkdirSync(unsafe);
    const { deps, calls } = fakeDeps({ termProgram: "WarpTerminal" });
    const r = await openResume({ id: ID, cwd: unsafe, live: false }, deps);
    expect(fs.existsSync(tabConfigPath())).toBe(false);
    expect(calls).toEqual([PBCOPY_CALL()]);
    expect(r).toEqual({
      ok: false,
      copied: true,
      message: "no new tab for this terminal, paste the command · command copied",
    });
  });

  it("O8 a Warp write failure opens a plain tab in the folder", async () => {
    fs.writeFileSync(path.join(home, ".warp"), "not a dir");
    const { deps, calls } = fakeDeps({ termProgram: "WarpTerminal" });
    const r = await openResume({ id: ID, cwd, live: false }, deps);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(PBCOPY_CALL());
    expect(calls[1]!.cmd).toBe("/usr/bin/open");
    expect(calls[1]!.args).toEqual(["warp://action/new_tab?path=" + encodeURIComponent(cwd)]);
    expect(r.message).toBe("opened a Warp tab in the folder, paste the command · command copied");
    expect(r.copied).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("O9 TOML basic-string escaping and tab config shape", () => {
    expect(tomlBasicString('a\\b"c')).toBe('"a\\\\b\\"c"');
    const toml = warpTabConfigToml(cwd, ID);
    expect(toml).toContain('name = "CSM resume"');
    expect(toml).toContain("[[panes]]");
    expect(toml).toContain('type = "terminal"');
    expect(toml).not.toContain("[params]");
    expect(toml.endsWith("\n")).toBe(true);
  });

  it("O10 unsupported terminals and non-darwin only copy", async () => {
    for (const termProgram of ["ghostty", undefined, "__proto__"]) {
      const { deps, calls } = fakeDeps({ termProgram });
      const r = await openResume({ id: ID, cwd, live: false }, deps);
      expect(calls).toEqual([PBCOPY_CALL()]);
      expect(r).toEqual({
        ok: false,
        copied: true,
        message: "no new tab for this terminal, paste the command · command copied",
      });
    }
    const { deps, calls } = fakeDeps({ termProgram: "Apple_Terminal", platform: "linux" });
    const r = await openResume({ id: ID, cwd, live: false }, deps);
    expect(calls).toEqual([PBCOPY_CALL()]);
    expect(r.message).toBe("no new tab for this terminal, paste the command · command copied");
  });

  it("O11 a missing folder only copies", async () => {
    const { deps, calls } = fakeDeps({ termProgram: "Apple_Terminal" });
    const r = await openResume({ id: ID, cwd: path.join(home, "gone"), live: false }, deps);
    expect(calls).toEqual([PBCOPY_CALL()]);
    expect(r).toEqual({
      ok: false,
      copied: true,
      message: "session folder not found, paste the command · command copied",
    });
  });

  it("O12 copy failure with a successful launch shows the command", async () => {
    const { deps } = fakeDeps({ termProgram: "Apple_Terminal", results: { "/usr/bin/pbcopy": false } });
    expect(await openResume({ id: ID, cwd, live: false }, deps)).toEqual({
      ok: true,
      copied: false,
      message: "opened a new Terminal window · copy failed, run: " + CMD,
    });
  });

  it("O13 invalid id spawns nothing", async () => {
    const { deps, calls } = fakeDeps({ termProgram: "Apple_Terminal" });
    const r = await openResume({ id: "-rf", cwd, live: false }, deps);
    expect(r).toEqual({ ok: false, copied: false, message: MSG_INVALID_ID });
    expect(calls).toEqual([]);
  });
});

describe("Warp tab config cleanup (W1-W2)", () => {
  function writeMarked(first: string): string {
    const dir = path.join(home, ".warp", "tab_configs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "csm-resume.toml");
    fs.writeFileSync(file, first + '\nname = "CSM resume"\n');
    return file;
  }

  it("W1 removeWarpTabConfig removes only a marked file and never throws", () => {
    const file = writeMarked(WARP_TAB_CONFIG_MARKER);
    expect(removeWarpTabConfig(home)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);

    writeMarked("# someone else's config");
    expect(removeWarpTabConfig(home)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);

    fs.rmSync(file);
    expect(removeWarpTabConfig(home)).toBe(false);

    fs.rmSync(path.join(home, ".warp"), { recursive: true, force: true });
    fs.writeFileSync(path.join(home, ".warp"), "file");
    expect(() => removeWarpTabConfig(home)).not.toThrow();
    expect(removeWarpTabConfig(home)).toBe(false);
  });

  it("W2 cleanupWarpTabConfig removes only a file this process wrote", () => {
    cleanupWarpTabConfig(); // clear any state left by earlier cases
    const file = writeMarked(WARP_TAB_CONFIG_MARKER);
    expect(cleanupWarpTabConfig()).toBe(false);
    expect(fs.existsSync(file)).toBe(true);

    expect(writeWarpTabConfig(home, cwd, ID)).toBe(true);
    expect(cleanupWarpTabConfig()).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(cleanupWarpTabConfig()).toBe(false);
  });
});

describe("defaultRun real spawn against node only (R1-R3)", () => {
  const STDIN_PROG =
    'let s="";process.stdin.on("data",(d)=>{s+=d});process.stdin.on("end",()=>process.exit(s==="abc"?0:3))';

  it("R1 writes input to stdin and reports the exit code", async () => {
    expect(await defaultRun(process.execPath, ["-e", STDIN_PROG], { input: "abc", timeoutMs: 5000 })).toEqual({
      ok: true,
    });
    expect(await defaultRun(process.execPath, ["-e", STDIN_PROG], { input: "zzz", timeoutMs: 5000 })).toEqual({
      ok: false,
    });
  });

  it("R2 a hung child is killed at the timeout", async () => {
    const t0 = Date.now();
    const r = await defaultRun(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeoutMs: 200 });
    expect(r).toEqual({ ok: false });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("R3 a missing binary resolves ok false without rejecting", async () => {
    await expect(defaultRun("/nonexistent/csm-bin", [], { timeoutMs: 500 })).resolves.toEqual({ ok: false });
  });
});
