import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RESUME_ID_PATTERN,
  isResumableId,
  resumeCommand,
  commandCwd,
  shellSingleQuote,
  MSG_COPY_FAILED_PREFIX,
  validLaunchCwd,
  osascriptArgs,
  TERMINAL_SCRIPT,
  ITERM_SCRIPT,
  WARP_TAB_CONFIG_MARKER_PREFIX,
  WARP_TAB_CONFIG_TTL_MS,
  WARP_STEM_PATTERN,
  warpTabConfigMarker,
  warpTabConfigStem,
  tomlBasicString,
  warpTabConfigToml,
  writeWarpTabConfig,
  removeWarpTabConfig,
  cleanupWarpTabConfig,
  sweepStaleWarpTabConfigs,
  pidIsAlive,
  parseWarpStem,
  WARP_SWEEP_MAX_ENTRIES,
  type WarpSweepDeps,
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
  cleanupWarpTabConfig(); // module ownership state never leaks between cases
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

interface Later {
  fn: () => void;
  ms: number;
}

function realIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fakeDeps(over: FakeOver = {}): { deps: LaunchDeps; calls: Call[]; laters: Later[] } {
  const calls: Call[] = [];
  const laters: Later[] = [];
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
    later: (fn, ms) => {
      laters.push({ fn, ms });
    },
  };
  return { deps, calls, laters };
}

/** D-10 REVISED line for a folder with no single quote in it. */
const cdLine = (dir: string) => "cd '" + dir + "' && " + CMD;
const PBCOPY_CALL = (input: string) => ({ cmd: "/usr/bin/pbcopy", args: [], opts: { input, timeoutMs: 1500 } });
const tabConfigDir = () => path.join(home, ".warp", "tab_configs");
/** Every per-launch tab config file (by stem) currently in the temp home. */
function tabConfigStems(): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(tabConfigDir());
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".toml"))
    .map((n) => n.slice(0, -".toml".length))
    .filter((stem) => WARP_STEM_PATTERN.test(stem));
}
const tabConfigFile = (stem: string) => path.join(tabConfigDir(), stem + ".toml");

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

  it("U2 resumeCommand prefixes a usable session cwd and falls back to the plain line (D-10 REVISED)", () => {
    expect(resumeCommand(ID)).toBe("claude --resume " + ID);
    expect(resumeCommand(ID, "/Users/x/Concurrent Session Monitor")).toBe(
      "cd '/Users/x/Concurrent Session Monitor' && claude --resume " + ID,
    );
    expect(resumeCommand(ID, "/w/it's")).toBe("cd '/w/it'\\''s' && claude --resume " + ID);
    const noCwd: unknown[] = [
      undefined,
      42,
      "",
      "rel/path",
      "/a/../b",
      "/a/",
      "/a\nb",
      "/a\u001bb",
      "/a\u007fb",
      "/a\u0085b",
      "/a\u202eb",
      "/a\u200bb",
      "/a\ud800b",
      "/a\\b",
      "/a`b",
      "/" + "a".repeat(4096),
    ];
    for (const c of noCwd) {
      expect(commandCwd(c)).toBeUndefined();
      expect(resumeCommand(ID, c)).toBe("claude --resume " + ID);
    }
    expect(commandCwd("/" + "a".repeat(4095))).toBe("/" + "a".repeat(4095));
    expect(commandCwd("/")).toBe("/");
  });

  it("Q1 shellSingleQuote round-trips hostile strings through /bin/sh unchanged", () => {
    const hostile = ["a b", "it's", "''", "$(touch pwned)", "`touch pwned`", "a;b|c&d", "~/x", "!x", "*?[a]", '"q"'];
    for (const h of hostile) {
      const r = spawnSync("/bin/sh", ["-c", "printf '%s' " + shellSingleQuote(h)], { cwd: home, encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(h);
    }
    expect(shellSingleQuote("it's")).toBe("'it'\\''s'");
    expect(fs.existsSync(path.join(home, "pwned"))).toBe(false);
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

describe("launch folder rule (L1)", () => {
  it("L1 validLaunchCwd is exactly commandCwd plus an existing-directory check, and never throws (T-08-03)", () => {
    // U2's full no-usable-cwd list, rebuilt here, plus the usable and boundary cases.
    const inputs: unknown[] = [
      undefined,
      42,
      "",
      "rel/path",
      "/a/../b",
      "/a/",
      "/a\nb",
      "/a\u001bb",
      "/a\u007fb",
      "/a\u0085b",
      "/a‮b",
      "/a​b",
      "/a\ud800b",
      "/a\\b",
      "/a`b",
      "/" + "a".repeat(4096),
      "/",
      cwd,
      "/Users/x/Concurrent Session Monitor",
      "/w/it's",
      "/a/b",
      "/a\\b",
      "/a`b",
      "/a/",
      "/" + "a".repeat(4095),
    ];
    const always = () => true;
    const never = () => false;
    const boom = (): boolean => {
      throw new Error("boom");
    };
    for (const x of inputs) {
      expect(validLaunchCwd(x, always)).toBe(commandCwd(x));
      expect(validLaunchCwd(x, never)).toBeUndefined();
      expect(() => validLaunchCwd(x, boom)).not.toThrow();
      expect(validLaunchCwd(x, boom)).toBeUndefined();
    }

    // The verifier's case: a real backslash folder is still refused.
    const backslash = path.join(home, "a\\b");
    fs.mkdirSync(backslash);
    expect(realIsDir(backslash)).toBe(true);
    expect(validLaunchCwd(backslash, realIsDir)).toBeUndefined();
    // The trailing-slash form of an existing folder is refused too.
    expect(realIsDir(cwd + "/")).toBe(true);
    expect(validLaunchCwd(cwd + "/", realIsDir)).toBeUndefined();
  });
});

describe("copyResume (C1-C4)", () => {
  it("C1 copies the cd-prefixed command to pbcopy on stdin with no args", async () => {
    const { deps, calls } = fakeDeps();
    const r = await copyResume({ id: ID, cwd, live: false }, deps);
    expect(calls).toEqual([PBCOPY_CALL(cdLine(cwd))]);
    expect(r).toEqual({ ok: true, copied: true, message: "copied ✓" });
    expect(MSG_COPIED).toBe("copied ✓");

    const plain = fakeDeps();
    await copyResume({ id: ID, live: false }, plain.deps);
    expect(plain.calls).toEqual([PBCOPY_CALL(CMD)]);
  });

  it("C2 live row still copies (D-16)", async () => {
    const { deps, calls } = fakeDeps();
    const r = await copyResume({ id: ID, live: true }, deps);
    expect(calls).toEqual([PBCOPY_CALL(CMD)]);
    expect(r).toEqual({ ok: true, copied: true, message: "copied ✓ · session still open" });
    expect(MSG_COPIED_LIVE).toBe("copied ✓ · session still open");
  });

  it("C3 copy failure shows the full command", async () => {
    const { deps } = fakeDeps({ results: { "/usr/bin/pbcopy": false } });
    expect(MSG_COPY_FAILED_PREFIX).toBe("copy failed · run: ");
    expect(await copyResume({ id: ID, cwd, live: false }, deps)).toEqual({
      ok: false,
      copied: false,
      message: "copy failed · run: " + cdLine(cwd),
    });
    expect(await copyResume({ id: ID, cwd, live: true }, deps)).toEqual({
      ok: false,
      copied: false,
      message: "copy failed · run: " + cdLine(cwd) + " · session still open",
    });
  });

  it("C4 invalid id spawns nothing", async () => {
    const { deps, calls } = fakeDeps();
    const r = await copyResume({ id: "-x", live: false }, deps);
    expect(r).toEqual({ ok: false, copied: false, message: "refused: not a resumable session id" });
    expect(MSG_INVALID_ID).toBe("refused: not a resumable session id");
    expect(calls).toEqual([]);
  });

  it("C5 an unexpected throw for a resumable id reports the copy-failed line, not an invalid id (IN-05)", async () => {
    const { deps } = fakeDeps();
    const target = {
      id: ID,
      cwd,
      get live(): boolean {
        throw new Error("boom");
      },
    };
    const r = await copyResume(target, deps);
    expect(r.ok).toBe(false);
    expect(r.copied).toBe(false);
    expect(r.message.startsWith(MSG_COPY_FAILED_PREFIX)).toBe(true);
    expect(r.message).toContain(cdLine(cwd));
    expect(r.message).not.toBe(MSG_INVALID_ID);
  });
});

describe("openResume (O1-O16)", () => {
  it("O1 live row copies and opens nothing (D-16)", async () => {
    const { deps, calls } = fakeDeps({ termProgram: "Apple_Terminal" });
    const r = await openResume({ id: ID, cwd, live: true }, deps);
    expect(calls).toEqual([PBCOPY_CALL(cdLine(cwd))]);
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
    expect(calls[0]).toEqual(PBCOPY_CALL(cdLine(cwd)));
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

  it("O6 WarpTerminal writes its own 0600 marked tab config, opens it by stem and deletes it after the TTL", async () => {
    const { deps, calls, laters } = fakeDeps({ termProgram: "WarpTerminal" });
    const r = await openResume({ id: ID, cwd, live: false }, deps);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(PBCOPY_CALL(cdLine(cwd)));
    expect(calls[1]!.cmd).toBe("/usr/bin/open");
    const uri = calls[1]!.args[0]!;
    expect(calls[1]!.args).toHaveLength(1);
    const m = /^warp:\/\/tab_config\/(.+)\?new_window=true$/.exec(uri);
    expect(m).not.toBeNull();
    const stem = m![1]!;
    expect(WARP_STEM_PATTERN.test(stem)).toBe(true);
    expect(stem.startsWith("csm-resume-" + ID.slice(0, 8) + "-" + process.pid + "-")).toBe(true);

    const file = tabConfigFile(stem);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const text = fs.readFileSync(file, "utf8");
    expect(text.split("\n")[0]!.startsWith(WARP_TAB_CONFIG_MARKER_PREFIX)).toBe(true);
    expect(text).toContain('directory = "' + cwd + '"');
    expect(text).toContain('commands = ["claude --resume ' + ID + '"]');
    expect(text).not.toContain("[params]");
    // No temp file is left behind (atomic temp + rename).
    expect(fs.readdirSync(tabConfigDir())).toEqual([stem + ".toml"]);
    expect(fs.readdirSync(tabConfigDir()).some((n) => n.startsWith(".csm-resume"))).toBe(false);
    expect(r).toEqual({ ok: true, copied: true, message: "opening in Warp… · command copied" });

    // WR-02: deletion is scheduled once, WARP_TAB_CONFIG_TTL_MS later.
    expect(WARP_TAB_CONFIG_TTL_MS).toBe(30000);
    expect(laters).toHaveLength(1);
    expect(laters[0]!.ms).toBe(WARP_TAB_CONFIG_TTL_MS);
    laters[0]!.fn();
    expect(fs.existsSync(file)).toBe(false);
    expect(cleanupWarpTabConfig()).toBe(false);
  });

  it("O6b a failed Warp open deletes the tab config at once and schedules nothing", async () => {
    const { deps, calls, laters } = fakeDeps({ termProgram: "WarpTerminal", results: { "/usr/bin/open": false } });
    const r = await openResume({ id: ID, cwd, live: false }, deps);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.cmd).toBe("/usr/bin/open");
    expect(String(calls[1]!.args[0])).toMatch(/^warp:\/\/tab_config\/csm-resume-/);
    expect(r).toEqual({ ok: false, copied: true, message: "could not open a new tab, paste the command · command copied" });
    expect(tabConfigStems()).toEqual([]);
    expect(laters).toEqual([]);
    expect(cleanupWarpTabConfig()).toBe(false);
  });

  it("O7 a Warp-unsafe folder is refused and only copied", async () => {
    const unsafe = path.join(home, "x$y");
    fs.mkdirSync(unsafe);
    const { deps, calls } = fakeDeps({ termProgram: "WarpTerminal" });
    const r = await openResume({ id: ID, cwd: unsafe, live: false }, deps);
    expect(tabConfigStems()).toEqual([]);
    expect(calls).toEqual([PBCOPY_CALL(cdLine(unsafe))]);
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
    expect(calls[0]).toEqual(PBCOPY_CALL(cdLine(cwd)));
    expect(calls[1]!.cmd).toBe("/usr/bin/open");
    expect(calls[1]!.args).toEqual(["warp://action/new_tab?path=" + encodeURIComponent(cwd)]);
    expect(r.message).toBe("opened a Warp tab in the folder, paste the command · command copied");
    expect(r.copied).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("O9 TOML basic-string escaping and tab config shape", () => {
    expect(tomlBasicString('a\\b"c')).toBe('"a\\\\b\\"c"');
    const marker = warpTabConfigMarker(process.pid, "0123abcd");
    const toml = warpTabConfigToml(cwd, ID, marker);
    expect(toml.split("\n")[0]).toBe(marker);
    expect(toml).toContain('name = "CSM resume ' + ID.slice(0, 8) + '"');
    expect(toml).toContain('commands = ["claude --resume ' + ID + '"]');
    expect(toml).toContain("[[panes]]");
    expect(toml).toContain('type = "terminal"');
    expect(toml).not.toContain("[params]");
    expect(toml.endsWith("\n")).toBe(true);
  });

  it("O10 unsupported terminals and non-darwin only copy", async () => {
    for (const termProgram of ["ghostty", undefined, "__proto__"]) {
      const { deps, calls } = fakeDeps({ termProgram });
      const r = await openResume({ id: ID, cwd, live: false }, deps);
      expect(calls).toEqual([PBCOPY_CALL(cdLine(cwd))]);
      expect(r).toEqual({
        ok: false,
        copied: true,
        message: "no new tab for this terminal, paste the command · command copied",
      });
    }
    const { deps, calls } = fakeDeps({ termProgram: "Apple_Terminal", platform: "linux" });
    const r = await openResume({ id: ID, cwd, live: false }, deps);
    expect(calls).toEqual([PBCOPY_CALL(cdLine(cwd))]);
    expect(r.message).toBe("no new tab for this terminal, paste the command · command copied");
  });

  it("O11 a missing folder only copies", async () => {
    const { deps, calls } = fakeDeps({ termProgram: "Apple_Terminal" });
    const r = await openResume({ id: ID, cwd: path.join(home, "gone"), live: false }, deps);
    expect(calls).toEqual([PBCOPY_CALL(cdLine(path.join(home, "gone")))]);
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
      message: "opened a new Terminal window · copy failed, run: " + cdLine(cwd),
    });
  });

  it("O13 invalid id spawns nothing", async () => {
    const { deps, calls } = fakeDeps({ termProgram: "Apple_Terminal" });
    const r = await openResume({ id: "-rf", cwd, live: false }, deps);
    expect(r).toEqual({ ok: false, copied: false, message: MSG_INVALID_ID });
    expect(calls).toEqual([]);
  });

  /** Existing folders that commandCwd refuses: the 08-VERIFICATION fish breakout, a backslash, a backtick, a trailing `/`. */
  function unsafeExistingFolders(): string[] {
    const fish = path.join(home, "x\\';touch pwned;#");
    const backslash = path.join(home, "a\\b");
    const backtick = path.join(home, "a`b");
    for (const d of [fish, backslash, backtick]) fs.mkdirSync(d);
    const folders = [fish, backslash, backtick, cwd + "/"];
    for (const d of folders) {
      expect(realIsDir(d)).toBe(true);
      expect(commandCwd(d)).toBeUndefined();
    }
    return folders;
  }

  const NO_FOLDER = {
    ok: false,
    copied: true,
    message: "session folder not found, paste the command · command copied",
  };

  it("O14 Terminal.app and iTerm2 refuse an existing folder commandCwd rejects, incl. the fish breakout (T-08-03)", async () => {
    const folders = unsafeExistingFolders();
    for (const termProgram of ["Apple_Terminal", "iTerm.app"]) {
      for (const folder of folders) {
        const { deps, calls } = fakeDeps({ termProgram });
        const r = await openResume({ id: ID, cwd: folder, live: false }, deps);
        expect(calls).toEqual([PBCOPY_CALL(CMD)]);
        expect(r).toEqual(NO_FOLDER);
      }
    }
    expect(fs.existsSync(path.join(home, "pwned"))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), "pwned"))).toBe(false);
  });

  it("O15 Warp refuses the same folders: no tab config, no open, the no-folder message (T-08-04)", async () => {
    const folders = unsafeExistingFolders();
    for (const folder of folders) {
      const { deps, calls, laters } = fakeDeps({ termProgram: "WarpTerminal" });
      const r = await openResume({ id: ID, cwd: folder, live: false }, deps);
      expect(calls).toEqual([PBCOPY_CALL(CMD)]);
      expect(tabConfigStems()).toEqual([]);
      expect(laters).toEqual([]);
      expect(r).toEqual(NO_FOLDER);
    }
  });

  it("O16 the copied line and the launched command name the same folder on every route (T-08-47)", async () => {
    const quoted = path.join(home, "it's here");
    fs.mkdirSync(quoted);
    for (const termProgram of ["Apple_Terminal", "iTerm.app"]) {
      for (const folder of [cwd, quoted]) {
        const { deps, calls } = fakeDeps({ termProgram });
        await openResume({ id: ID, cwd: folder, live: false }, deps);
        expect(calls[0]).toEqual(PBCOPY_CALL(resumeCommand(ID, folder)));
        expect(resumeCommand(ID, folder)).toBe("cd " + shellSingleQuote(folder) + " && " + CMD);
        expect(calls[1]!.cmd).toBe("/usr/bin/osascript");
        expect(calls[1]!.args.slice(-2)).toEqual([commandCwd(folder), ID]);
      }
    }
    // Warp: a `'` folder is WARP_UNSAFE_CWD-refused by design, so only the plain folder.
    const { deps, calls } = fakeDeps({ termProgram: "WarpTerminal" });
    await openResume({ id: ID, cwd, live: false }, deps);
    expect(calls[0]).toEqual(PBCOPY_CALL(resumeCommand(ID, cwd)));
    const stems = tabConfigStems();
    expect(stems).toHaveLength(1);
    expect(fs.readFileSync(tabConfigFile(stems[0]!), "utf8")).toContain("directory = " + tomlBasicString(commandCwd(cwd)!));
  });
});

describe("Warp tab config ownership (W1-W3)", () => {
  function plant(name: string, first: string): string {
    fs.mkdirSync(tabConfigDir(), { recursive: true });
    const file = path.join(tabConfigDir(), name);
    fs.writeFileSync(file, first + '\nname = "CSM resume"\n');
    return file;
  }

  it("W1 removeWarpTabConfig removes only a file whose first line is the exact marker and never throws", () => {
    const mine = warpTabConfigMarker(process.pid, "aaaaaaaa");
    expect(mine.startsWith(WARP_TAB_CONFIG_MARKER_PREFIX)).toBe(true);
    expect(mine).toContain("pid=" + process.pid);
    expect(mine).toContain("nonce=aaaaaaaa");

    const file = plant("csm-resume-11111111-1-aaaaaaaa.toml", mine);
    expect(removeWarpTabConfig(file, mine)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);

    // Another pid, another nonce, or a foreign first line: kept.
    for (const other of [
      warpTabConfigMarker(99999, "aaaaaaaa"),
      warpTabConfigMarker(process.pid, "bbbbbbbb"),
      "# someone else's config",
    ]) {
      plant("csm-resume-11111111-1-aaaaaaaa.toml", other);
      expect(removeWarpTabConfig(file, mine)).toBe(false);
      expect(fs.existsSync(file)).toBe(true);
    }

    // Missing file.
    fs.rmSync(file);
    expect(removeWarpTabConfig(file, mine)).toBe(false);

    // A symlink to a marked file is never followed or removed.
    const target = plant("real.toml", mine);
    fs.symlinkSync(target, file);
    expect(removeWarpTabConfig(file, mine)).toBe(false);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    fs.rmSync(file);

    // A directory at the path.
    fs.mkdirSync(file);
    expect(() => removeWarpTabConfig(file, mine)).not.toThrow();
    expect(removeWarpTabConfig(file, mine)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(file, { recursive: true });

    // A huge first line (only 4 KiB is read) is not a match.
    plant("csm-resume-11111111-1-aaaaaaaa.toml", mine + "x".repeat(8192));
    expect(removeWarpTabConfig(file, mine)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("W2 cleanupWarpTabConfig removes only the files this process wrote", () => {
    cleanupWarpTabConfig();
    const cfg = writeWarpTabConfig(home, cwd, ID);
    expect(cfg).toBeDefined();
    expect(cfg!.file).toBe(tabConfigFile(cfg!.stem));
    expect(fs.readFileSync(cfg!.file, "utf8").split("\n")[0]).toBe(cfg!.marker);

    const foreign = plant("csm-resume-deadbeef-99999-0badc0de.toml", warpTabConfigMarker(99999, "0badc0de"));
    expect(cleanupWarpTabConfig()).toBe(true);
    expect(fs.existsSync(cfg!.file)).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(cleanupWarpTabConfig()).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it("W3 two writes produce two distinct coexisting files, each with its own id and nonce", () => {
    const ID2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const a = writeWarpTabConfig(home, cwd, ID);
    const b = writeWarpTabConfig(home, cwd, ID2);
    const c = writeWarpTabConfig(home, cwd, ID);
    expect(a && b && c).toBeTruthy();
    const stems = [a!.stem, b!.stem, c!.stem];
    expect(new Set(stems).size).toBe(3);
    for (const st of stems) expect(WARP_STEM_PATTERN.test(st)).toBe(true);
    expect(tabConfigStems().sort()).toEqual([...stems].sort());
    expect(fs.readFileSync(a!.file, "utf8")).toContain('commands = ["claude --resume ' + ID + '"]');
    expect(fs.readFileSync(b!.file, "utf8")).toContain('commands = ["claude --resume ' + ID2 + '"]');
    for (const cfg of [a!, b!, c!]) expect(cfg.marker).toContain("pid=" + process.pid);
    const nonce = (m: string) => /nonce=([0-9a-f]{8})/.exec(m)?.[1];
    expect(new Set([a!.marker, b!.marker, c!.marker].map(nonce)).size).toBe(3);
    expect(warpTabConfigStem(ID, 42, "0123abcd")).toBe("csm-resume-11111111-42-0123abcd");
    expect(cleanupWarpTabConfig()).toBe(true);
    expect(tabConfigStems()).toEqual([]);
  });
});

describe("Warp tab config startup sweep (S1-S10)", () => {
  const DEAD = 4242;
  const NONCE = "0badc0de";
  const STEM = `csm-resume-11111111-${DEAD}-${NONCE}`;

  function plant(name: string, first: string): string {
    fs.mkdirSync(tabConfigDir(), { recursive: true });
    const file = path.join(tabConfigDir(), name);
    fs.writeFileSync(file, first + '\nname = "CSM resume"\n');
    return file;
  }

  /** Fake liveness probe: records every pid it is asked about. */
  function probe(alive: boolean | ((pid: number) => boolean)): { deps: WarpSweepDeps; asked: number[] } {
    const asked: number[] = [];
    const deps: WarpSweepDeps = {
      homedir: () => home,
      alive: (pid) => {
        asked.push(pid);
        return typeof alive === "function" ? alive(pid) : alive;
      },
    };
    return { deps, asked };
  }

  it("S1 a dead panel's exactly-marked config is removed", () => {
    const file = plant(STEM + ".toml", warpTabConfigMarker(DEAD, NONCE));
    const { deps, asked } = probe(false);
    expect(sweepStaleWarpTabConfigs(deps)).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
    expect(asked).toContain(DEAD);
  });

  it("S2 a running panel's config is kept", () => {
    const file = plant(STEM + ".toml", warpTabConfigMarker(DEAD, NONCE));
    const { deps } = probe(true);
    expect(sweepStaleWarpTabConfigs(deps)).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("S3 this process's own files are never swept and its pid is never probed", () => {
    const own = plant(`csm-resume-11111111-${process.pid}-aaaaaaaa.toml`, warpTabConfigMarker(process.pid, "aaaaaaaa"));
    const cfg = writeWarpTabConfig(home, cwd, ID);
    expect(cfg).toBeDefined();
    const { deps, asked } = probe(false);
    expect(sweepStaleWarpTabConfigs(deps)).toBe(0);
    expect(fs.existsSync(own)).toBe(true);
    expect(fs.existsSync(cfg!.file)).toBe(true);
    expect(asked).not.toContain(process.pid);
  });

  it("S4 a dead pid with a mismatched, foreign or empty first line is kept", () => {
    const { deps } = probe(false);
    for (const first of [
      warpTabConfigMarker(DEAD, "ffffffff"),
      warpTabConfigMarker(DEAD + 1, NONCE),
      "# someone else's config",
    ]) {
      const file = plant(STEM + ".toml", first);
      expect(sweepStaleWarpTabConfigs(deps)).toBe(0);
      expect(fs.existsSync(file)).toBe(true);
    }
    const file = path.join(tabConfigDir(), STEM + ".toml");
    fs.writeFileSync(file, "");
    expect(sweepStaleWarpTabConfigs(deps)).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("S5 names outside WARP_STEM_PATTERN are kept and never probed", () => {
    const marker = warpTabConfigMarker(DEAD, NONCE);
    const names = [
      STEM + ".toml.bak",
      `csm-resume-1111111-${DEAD}-${NONCE}.toml`,
      `csm-resume-11111111-0-${NONCE}.toml`,
      `csm-resume-11111111-${DEAD}-0BADC0DE.toml`,
      // another id so it can never case-fold onto the uppercase-nonce name on APFS
      `CSM-resume-22222222-${DEAD}-${NONCE}.toml`,
      "other.toml",
      STEM + ".tmp",
    ];
    const files = names.map((n) => plant(n, marker));
    const { deps, asked } = probe(false);
    expect(sweepStaleWarpTabConfigs(deps)).toBe(0);
    for (const f of files) expect(fs.existsSync(f)).toBe(true);
    expect(asked).toEqual([]);
  });

  it("S6 a symlink or a directory named like a config is kept and nothing throws", () => {
    const target = path.join(home, "elsewhere.toml");
    fs.writeFileSync(target, warpTabConfigMarker(DEAD, NONCE) + "\n");
    fs.mkdirSync(tabConfigDir(), { recursive: true });
    const link = path.join(tabConfigDir(), STEM + ".toml");
    fs.symlinkSync(target, link);
    const dirEntry = path.join(tabConfigDir(), `csm-resume-11111111-${DEAD}-cafebabe.toml`);
    fs.mkdirSync(dirEntry);
    const { deps } = probe(false);
    let n = -1;
    expect(() => {
      n = sweepStaleWarpTabConfigs(deps);
    }).not.toThrow();
    expect(n).toBe(0);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.statSync(dirEntry).isDirectory()).toBe(true);
  });

  it("S7 a leftover pre-rename temp is removed only for a dead foreign pid", () => {
    const deadTmp = plant(`.${STEM}.tmp`, warpTabConfigMarker(DEAD, NONCE));
    expect(sweepStaleWarpTabConfigs(probe(true).deps)).toBe(0);
    expect(fs.existsSync(deadTmp)).toBe(true);
    expect(sweepStaleWarpTabConfigs(probe(false).deps)).toBe(1);
    expect(fs.existsSync(deadTmp)).toBe(false);

    const ownTmp = plant(`.csm-resume-11111111-${process.pid}-${NONCE}.tmp`, warpTabConfigMarker(process.pid, NONCE));
    expect(sweepStaleWarpTabConfigs(probe(false).deps)).toBe(0);
    expect(fs.existsSync(ownTmp)).toBe(true);
  });

  it("S8 never throws and returns 0 on a missing dir, a file at .warp, a throwing homedir or a throwing probe", () => {
    expect(sweepStaleWarpTabConfigs(probe(false).deps)).toBe(0);

    fs.writeFileSync(path.join(home, ".warp"), "not a dir");
    expect(sweepStaleWarpTabConfigs(probe(false).deps)).toBe(0);
    fs.rmSync(path.join(home, ".warp"));

    const throwingHome: WarpSweepDeps = {
      homedir: () => {
        throw new Error("no home");
      },
      alive: () => false,
    };
    expect(sweepStaleWarpTabConfigs(throwingHome)).toBe(0);

    const file = plant(STEM + ".toml", warpTabConfigMarker(DEAD, NONCE));
    const throwingProbe: WarpSweepDeps = {
      homedir: () => home,
      alive: () => {
        throw new Error("probe failed");
      },
    };
    expect(sweepStaleWarpTabConfigs(throwingProbe)).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("S9 one run examines at most WARP_SWEEP_MAX_ENTRIES names; the next run removes the rest", () => {
    const total = WARP_SWEEP_MAX_ENTRIES + 20;
    for (let i = 1; i <= total; i++) {
      const nonce = i.toString(16).padStart(8, "0");
      plant(`csm-resume-11111111-${DEAD}-${nonce}.toml`, warpTabConfigMarker(DEAD, nonce));
    }
    expect(tabConfigStems()).toHaveLength(total);
    const first = sweepStaleWarpTabConfigs(probe(false).deps);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(WARP_SWEEP_MAX_ENTRIES);
    const second = sweepStaleWarpTabConfigs(probe(false).deps);
    expect(first + second).toBe(total);
    expect(tabConfigStems()).toEqual([]);
  });

  it("S10 pidIsAlive errs safe (only ESRCH is dead) and parseWarpStem reads pid and nonce", () => {
    expect(pidIsAlive(process.pid)).toBe(true);
    expect(pidIsAlive(1)).toBe(true);
    const child = spawnSync(process.execPath, ["-e", "0"]);
    expect(typeof child.pid).toBe("number");
    expect(pidIsAlive(child.pid!)).toBe(false);
    expect(pidIsAlive(2 ** 40)).toBe(true);

    expect(parseWarpStem("csm-resume-11111111-42-0123abcd")).toEqual({ pid: 42, nonce: "0123abcd" });
    expect(parseWarpStem("csm-resume-11111111-0-0123abcd")).toBeUndefined();
    expect(parseWarpStem("csm-resume-11111111-42-0123ABCD")).toBeUndefined();
    expect(parseWarpStem("other")).toBeUndefined();
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
