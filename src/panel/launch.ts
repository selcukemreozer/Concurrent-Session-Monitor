import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resume launcher (Phase 8, CONTEXT D-15/D-16, RESEARCH Patterns 7 and 8).
 *
 * The panel's only side-effect module for the OTURUMLAR resume picker:
 *   - Enter → copyResume: put `claude --resume <id>` on the clipboard.
 *   - `o`   → openResume: copy first, then best-effort open a new Terminal /
 *             iTerm2 / Warp window in the session's folder that runs it.
 *
 * Contract:
 *   - User-initiated only (D-15/D-16). Nothing here runs on a timer or a poll.
 *   - Every route copies FIRST, so a silent launch failure never loses the
 *     command; a live session (D-16) is copied but never launched.
 *   - `id` and `cwd` come from untrusted transcript text. The id must be a
 *     lowercase UUID (never a leading `-`); the folder must be an absolute,
 *     normalized, control/format-free existing directory. Neither is ever
 *     spliced into shell or AppleScript source: osascript gets CONSTANT script
 *     lines plus `--`, cwd, id as argv and quotes them with `quoted form of`.
 *   - Binaries are spawned by absolute path with an argv array — no shell, no
 *     PATH lookup, no synchronous child-process API (the Ink render loop must
 *     never block). Each spawn has a timeout that SIGKILLs the child.
 *   - No exported function throws or rejects; every outcome is a result object.
 *
 * Warp tab config lifecycle: the Warp route (re)writes
 * `~/.warp/tab_configs/csm-resume.toml` on each use (atomic temp + rename),
 * and entry.ts removes it on a clean panel exit via cleanupWarpTabConfig(),
 * which only deletes a file THIS process wrote. While the panel runs the
 * "CSM resume" entry is visible in Warp's new-tab menu and re-runs the last
 * resume command if picked.
 */

// LOCKSTEP: same pattern as SESSION_UUID_PATTERN in src/transcript.ts.
export const RESUME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const PBCOPY_BIN = "/usr/bin/pbcopy";
export const OSASCRIPT_BIN = "/usr/bin/osascript";
export const OPEN_BIN = "/usr/bin/open";

const PBCOPY_TIMEOUT_MS = 1500;
/** Long enough for the first-use macOS Automation prompt to be answered. */
const OSASCRIPT_TIMEOUT_MS = 20000;
const OPEN_TIMEOUT_MS = 5000;

const MAX_CWD_LEN = 4096;
const REMOVE_READ_BYTES = 4096;

export const WARP_TAB_CONFIG_NAME = "csm-resume";
export const WARP_TAB_CONFIG_MARKER =
  "# csm-resume: written by the CSM panel (rewritten on each use, removed when the panel exits)";
/** Characters refused in a folder on the Warp route (RESEARCH A2). */
export const WARP_UNSAFE_CWD = /[`$;|&<>"'\\]/;

export const MSG_COPIED = "copied ✓";
export const MSG_COPIED_LIVE = "copied ✓ · session still open";
export const MSG_INVALID_ID = "refused: not a resumable session id";

const OUT_LIVE = "session still open, no new tab opened";
const OUT_TERMINAL = "opened a new Terminal window";
const OUT_ITERM = "opened a new iTerm2 window";
const OUT_WARP = "opening in Warp…";
const OUT_WARP_FOLDER = "opened a Warp tab in the folder, paste the command";
const OUT_UNSUPPORTED = "no new tab for this terminal, paste the command";
const OUT_NO_FOLDER = "session folder not found, paste the command";
const OUT_LAUNCH_FAILED = "could not open a new tab, paste the command";

/**
 * Constant AppleScript for Terminal.app; `do script` with no target opens a
 * new window. cwd and id arrive as argv items 1 and 2 and are shell-quoted by
 * `quoted form of`, never spliced into the script source.
 */
export const TERMINAL_SCRIPT: readonly string[] = [
  "on run argv",
  'set cmd to "cd " & quoted form of (item 1 of argv) & " && claude --resume " & quoted form of (item 2 of argv)',
  'tell application "Terminal"',
  "activate",
  "do script cmd",
  "end tell",
  "end run",
];

/** Constant AppleScript for iTerm2; `write text` into a default-profile login shell. */
export const ITERM_SCRIPT: readonly string[] = [
  "on run argv",
  'set cmd to "cd " & quoted form of (item 1 of argv) & " && claude --resume " & quoted form of (item 2 of argv)',
  'tell application "iTerm2"',
  "activate",
  "set w to (create window with default profile)",
  "tell current session of w to write text cmd",
  "end tell",
  "end run",
];

type Route = "terminal" | "iterm" | "warp";

/** A Map (not an object) so prototype names such as `__proto__` never resolve. */
const ROUTE_ENTRIES: ReadonlyArray<readonly [string, Route]> = [
  ["Apple_Terminal", "terminal"],
  ["iTerm.app", "iterm"],
  ["WarpTerminal", "warp"],
];
export const LAUNCH_ROUTE_BY_TERM: ReadonlyMap<string, Route> = new Map(ROUTE_ENTRIES);

export interface RunOptions {
  input?: string;
  timeoutMs: number;
}

export interface LaunchDeps {
  run(cmd: string, args: readonly string[], opts: RunOptions): Promise<{ ok: boolean }>;
  isDir(p: string): boolean;
  homedir(): string;
  platform: string;
  termProgram: string | undefined;
}

export interface LaunchResult {
  ok: boolean;
  copied: boolean;
  message: string;
}

export interface ResumeTarget {
  id: string;
  cwd?: string;
  live: boolean;
}

export function isResumableId(id: unknown): id is string {
  return typeof id === "string" && RESUME_ID_PATTERN.test(id);
}

/** D-10: the plain resume command, no `cd` prefix. */
export function resumeCommand(id: string): string {
  return "claude --resume " + id;
}

const FORMAT_CP = /\p{Cf}/u;

/**
 * T-08-03: the folder a launch may `cd` into. Returns `cwd` only when it is a
 * 1..4096-char absolute, normalized path with no C0 / DEL / C1 / lone
 * surrogate / format (Cf) code point that names an existing directory.
 */
export function validLaunchCwd(cwd: unknown, isDir: (p: string) => boolean): string | undefined {
  try {
    if (typeof cwd !== "string" || cwd.length < 1 || cwd.length > MAX_CWD_LEN) return undefined;
    if (!path.isAbsolute(cwd) || path.normalize(cwd) !== cwd) return undefined;
    for (const ch of cwd) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp <= 0x1f || cp === 0x7f) return undefined;
      if (cp >= 0x80 && cp <= 0x9f) return undefined;
      if (cp >= 0xd800 && cp <= 0xdfff) return undefined;
      if (FORMAT_CP.test(ch)) return undefined;
    }
    return isDir(cwd) ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/** Constant script lines as `-e` pairs, then `--`, cwd, id as plain argv. */
export function osascriptArgs(lines: readonly string[], cwd: string, id: string): string[] {
  return [...lines.flatMap((l) => ["-e", l]), "--", cwd, id];
}

/** A TOML basic string: backslash doubled, double quote escaped. */
export function tomlBasicString(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** The Warp tab config: marker first, one terminal pane, no `[params]` table. */
export function warpTabConfigToml(cwd: string, id: string): string {
  return (
    [
      WARP_TAB_CONFIG_MARKER,
      'name = "CSM resume"',
      "",
      "[[panes]]",
      'id = "main"',
      'type = "terminal"',
      "directory = " + tomlBasicString(cwd),
      "commands = [" + tomlBasicString(resumeCommand(id)) + "]",
    ].join("\n") + "\n"
  );
}

function statIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function warpTabConfigDir(home: string): string {
  return path.join(home, ".warp", "tab_configs");
}

function warpTabConfigFile(home: string): string {
  return path.join(warpTabConfigDir(home), WARP_TAB_CONFIG_NAME + ".toml");
}

/** The home this process last wrote a tab config under (cleanup scope). */
let lastWrittenHome: string | null = null;

/**
 * Write `<home>/.warp/tab_configs/csm-resume.toml` atomically: a 0600 temp
 * created exclusively under a name that does not end in `.toml` (Warp indexes
 * `*.toml` stems), then rename. Re-checks its own inputs. Never throws.
 */
export function writeWarpTabConfig(home: string, cwd: string, id: string): boolean {
  let tmp: string | undefined;
  try {
    if (!isResumableId(id)) return false;
    if (typeof cwd !== "string" || WARP_UNSAFE_CWD.test(cwd)) return false;
    if (validLaunchCwd(cwd, statIsDir) === undefined) return false;
    const dir = warpTabConfigDir(home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    tmp = path.join(dir, `.${WARP_TAB_CONFIG_NAME}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    fs.writeFileSync(tmp, warpTabConfigToml(cwd, id), { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, warpTabConfigFile(home));
    tmp = undefined;
    lastWrittenHome = home;
    return true;
  } catch {
    if (tmp !== undefined) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // best effort
      }
    }
    return false;
  }
}

/**
 * Delete `<home>/.warp/tab_configs/csm-resume.toml` only when its first line
 * is WARP_TAB_CONFIG_MARKER. Reads at most 4 KiB, never follows a symlink,
 * returns whether the file was removed, never throws.
 */
export function removeWarpTabConfig(home: string = os.homedir()): boolean {
  try {
    const file = warpTabConfigFile(home);
    let head: string;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      if (!fs.fstatSync(fd).isFile()) return false;
      const buf = Buffer.alloc(REMOVE_READ_BYTES);
      const n = fs.readSync(fd, buf, 0, REMOVE_READ_BYTES, 0);
      head = buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    if (head.split("\n")[0] !== WARP_TAB_CONFIG_MARKER) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean-exit cleanup (called by entry.ts): removes the tab config only when
 * THIS process wrote it, so a second panel or a test run never deletes another
 * panel's live config. Never throws.
 */
export function cleanupWarpTabConfig(): boolean {
  try {
    if (lastWrittenHome === null) return false;
    const home = lastWrittenHome;
    lastWrittenHome = null;
    return removeWarpTabConfig(home);
  } catch {
    return false;
  }
}

/**
 * Real spawner: argv array, never a shell, optional stdin input, SIGKILL on
 * timeout. Resolves `{ ok: exit code === 0 }` at most once; never rejects.
 */
export function defaultRun(cmd: string, args: readonly string[], opts: RunOptions): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ ok });
    };
    try {
      const child = spawn(cmd, [...args], {
        stdio: [opts.input !== undefined ? "pipe" : "ignore", "ignore", "ignore"],
      });
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        finish(false);
      }, opts.timeoutMs);
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0));
      if (opts.input !== undefined && child.stdin) {
        child.stdin.on("error", () => {
          // EPIPE etc.: the exit code decides the outcome
        });
        child.stdin.end(opts.input);
      }
    } catch {
      finish(false);
    }
  });
}

/** Real deps, read at call time. */
export function defaultLaunchDeps(): LaunchDeps {
  return {
    run: defaultRun,
    isDir: statIsDir,
    homedir: () => os.homedir(),
    platform: process.platform,
    termProgram: process.env.TERM_PROGRAM,
  };
}

async function copyCommand(id: string, deps: LaunchDeps): Promise<boolean> {
  try {
    const r = await deps.run(PBCOPY_BIN, [], { input: resumeCommand(id), timeoutMs: PBCOPY_TIMEOUT_MS });
    return r?.ok === true;
  } catch {
    return false;
  }
}

async function runOk(deps: LaunchDeps, cmd: string, args: string[], timeoutMs: number): Promise<boolean> {
  try {
    const r = await deps.run(cmd, args, { timeoutMs });
    return r?.ok === true;
  } catch {
    return false;
  }
}

/** D-15 Enter: copy the resume command. ok === copied. Never throws. */
export async function copyResume(target: ResumeTarget, deps: LaunchDeps = defaultLaunchDeps()): Promise<LaunchResult> {
  try {
    const id = target?.id;
    if (!isResumableId(id)) return { ok: false, copied: false, message: MSG_INVALID_ID };
    const live = target.live === true;
    const copied = await copyCommand(id, deps);
    if (copied) return { ok: true, copied: true, message: live ? MSG_COPIED_LIVE : MSG_COPIED };
    const msg = "copy failed · run: " + resumeCommand(id) + (live ? " · session still open" : "");
    return { ok: false, copied: false, message: msg };
  } catch {
    return { ok: false, copied: false, message: MSG_INVALID_ID };
  }
}

/**
 * D-15 `o`: copy first, then open a new terminal window running the resume
 * command in the session's folder. A live row (D-16) is only copied. ok is
 * true only when a launch was dispatched and reported success. Never throws.
 */
export async function openResume(target: ResumeTarget, deps: LaunchDeps = defaultLaunchDeps()): Promise<LaunchResult> {
  let copied = false;
  let suffix = "";
  try {
    const id = target?.id;
    if (!isResumableId(id)) return { ok: false, copied: false, message: MSG_INVALID_ID };
    copied = await copyCommand(id, deps);
    suffix = copied ? " · command copied" : " · copy failed, run: " + resumeCommand(id);
    const done = (ok: boolean, outcome: string): LaunchResult => ({ ok, copied, message: outcome + suffix });

    if (target.live === true) return done(false, OUT_LIVE);

    const cwd = validLaunchCwd(target.cwd, (p) => deps.isDir(p));
    if (cwd === undefined) return done(false, OUT_NO_FOLDER);
    if (deps.platform !== "darwin") return done(false, OUT_UNSUPPORTED);

    const term = deps.termProgram;
    const route = typeof term === "string" ? LAUNCH_ROUTE_BY_TERM.get(term) : undefined;
    if (route === "terminal" || route === "iterm") {
      const script = route === "terminal" ? TERMINAL_SCRIPT : ITERM_SCRIPT;
      const ok = await runOk(deps, OSASCRIPT_BIN, osascriptArgs(script, cwd, id), OSASCRIPT_TIMEOUT_MS);
      if (!ok) return done(false, OUT_LAUNCH_FAILED);
      return done(true, route === "terminal" ? OUT_TERMINAL : OUT_ITERM);
    }
    if (route === "warp") {
      if (WARP_UNSAFE_CWD.test(cwd)) return done(false, OUT_UNSUPPORTED);
      if (writeWarpTabConfig(deps.homedir(), cwd, id)) {
        const ok = await runOk(
          deps,
          OPEN_BIN,
          [`warp://tab_config/${WARP_TAB_CONFIG_NAME}?new_window=true`],
          OPEN_TIMEOUT_MS,
        );
        return ok ? done(true, OUT_WARP) : done(false, OUT_LAUNCH_FAILED);
      }
      const ok = await runOk(deps, OPEN_BIN, ["warp://action/new_tab?path=" + encodeURIComponent(cwd)], OPEN_TIMEOUT_MS);
      return ok ? done(true, OUT_WARP_FOLDER) : done(false, OUT_LAUNCH_FAILED);
    }
    return done(false, OUT_UNSUPPORTED);
  } catch {
    return { ok: false, copied, message: OUT_LAUNCH_FAILED + suffix };
  }
}
