// The v2 crash path (Phase 9, plan 09-06; D-25, KEYS-04 "the terminal is
// restored after a crash").
//
// Ink and Node already restore the terminal on an uncaught exception. What they
// leave is a raw multi-line stack, render errors that vanish inside the alt
// screen, and out-of-order output on macOS pipes (RESEARCH Pitfalls 3 and 4).
// This module turns ANY crash into one fixed sequence (D-25 order):
//
//   1. restore the terminal (unmount Ink; raw-mode / alt-screen fallback),
//   2. write exactly ONE sanitized stderr line
//        `csm crashed: <message> \u2014 details in <path>`,
//   3. append the stack to crash.log (timestamp + pid + stack ONLY; the error
//      object is never serialized and the environment is never read),
//   4. exit 1.
//
// A second fault while handling a crash only exits 1, and a failing restore,
// stderr write or log write never stops the exit. The panel NEVER auto-restarts.
//
// The stderr writer that entry.ts injects must be synchronous
// (`fs.writeSync(2, ...)`): stderr to a pipe is async on macOS (Pitfall 4), so
// an async write can be lost when exit(1) runs. That wiring, and installing the
// handler for the v2 panel only (the default since 2.0.0, plan 10-17; not for
// `CSM_UI=legacy`), lives in entry.ts (plan 09-14).
//
// Source kept ASCII-only (special code points are written as escapes).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { oneLine, truncateEnd } from "./ui/text.js";
import { sanitize } from "../sanitize.js";
import { storeRoot } from "../paths.js";

export const CRASH_LOG = "crash.log";
export const CRASH_LOG_CAP = 256 * 1024;
/** The most bytes of body one crash.log entry keeps (IN-03, Phase 10 plan 10-02). */
export const CRASH_ENTRY_CAP = CRASH_LOG_CAP / 4;
/** The line that replaces a cut entry body's tail. */
const TRUNCATED = sanitize("\u2026[truncated]");
export const CRASH_MSG_CELLS = 120;

/** Everything the crash handler touches, injected so it is unit-testable. */
export interface CrashDeps {
  restore(): void;
  writeErr(line: string): void;
  appendLog(entry: string): void;
  exit(code: number): void;
  displayLogPath: string;
  now(): Date;
}

/** The terminal surface restoreTerminal falls back to when Ink cannot unmount. */
export interface RestoreIo {
  stdin: { isTTY?: boolean; setRawMode?: (m: boolean) => unknown };
  stdoutIsTTY: boolean;
  writeOut(s: string): void;
}

/** String(x) that can never throw (a hostile toString / Symbol.toPrimitive). */
function safeString(x: unknown): string {
  try {
    return String(x);
  } catch {
    return "unknown error";
  }
}

/** The raw message: Error.message for an Error, else String(err). */
function rawMessage(err: unknown): string {
  if (err instanceof Error) {
    try {
      return safeString(err.message);
    } catch {
      return "";
    }
  }
  return safeString(err);
}

/**
 * The one-line crash message: sanitized, whitespace collapsed, at most
 * CRASH_MSG_CELLS cells; an empty result becomes "unknown error".
 */
export function crashMessage(err: unknown): string {
  const m = truncateEnd(oneLine(rawMessage(err)), CRASH_MSG_CELLS);
  return m === "" ? "unknown error" : m;
}

/** The longest prefix of `s` that is at most `cap` UTF-8 bytes, cut between code points. */
function capBytes(s: string, cap: number): string {
  if (Buffer.byteLength(s) <= cap) return s;
  let bytes = 0;
  let i = 0;
  for (const cp of s) {
    const b = Buffer.byteLength(cp);
    if (bytes + b > cap) break;
    bytes += b;
    i += cp.length;
  }
  return s.slice(0, i);
}

/**
 * The crash.log entry: `[<ISO>] pid <pid>`, then the Error's stack (else its
 * message, else String(err)), every line passed through sanitize, ending with
 * a newline. Never serializes the error object as a whole. A body longer than
 * CRASH_ENTRY_CAP bytes is cut on a code-point boundary and followed by a
 * `...[truncated]` line, so one huge throw cannot outgrow the log cap (IN-03).
 */
export function crashEntry(err: unknown, now: Date, pid: number): string {
  let body = "";
  if (err instanceof Error) {
    try {
      const stack: unknown = err.stack;
      if (typeof stack === "string" && stack !== "") body = stack;
    } catch {
      body = "";
    }
    if (body === "") body = rawMessage(err);
  }
  if (body === "") body = safeString(err);
  const lines = body.split(/\r?\n/).map((l) => sanitize(l));
  const full = lines.join("\n");
  const kept = capBytes(full, CRASH_ENTRY_CAP);
  const tail = kept.length < full.length ? `\n${TRUNCATED}` : "";
  return `[${now.toISOString()}] pid ${pid}\n${kept}${tail}\n`;
}

/**
 * The D-25 handler. The first call restores, writes the one line, logs and
 * exits 1 (each of the first three steps isolated in its own try/catch);
 * every later call (a fault while crashing) only exits 1.
 */
export function createCrashHandler(d: CrashDeps): (err: unknown) => void {
  let crashing = false;
  return (err: unknown): void => {
    if (crashing) {
      d.exit(1);
      return;
    }
    crashing = true;
    try {
      d.restore();
    } catch {
      // A failing restore must never stop the report or the exit.
    }
    try {
      d.writeErr(
        `csm crashed: ${crashMessage(err)} \u2014 details in ${d.displayLogPath}\n`,
      );
    } catch {
      // EPIPE / closed stderr: still log and exit.
    }
    try {
      d.appendLog(crashEntry(err, d.now(), process.pid));
    } catch {
      // An unwritable log must never stop the exit.
    }
    d.exit(1);
  };
}

/** Route uncaughtException and unhandledRejection to `handler`. */
export function installCrashHandlers(
  handler: (err: unknown) => void,
  proc: Pick<NodeJS.EventEmitter, "on"> = process,
): void {
  proc.on("uncaughtException", (err: unknown) => handler(err));
  proc.on("unhandledRejection", (reason: unknown) => handler(reason));
}

/**
 * Append one entry to `<dir>/crash.log` (T-09-04, T-09-05, T-09-06). Never
 * throws: a crash report must not cause a second crash.
 *
 *   - the directory is created 0700 when missing (dir comes from storeRoot()
 *     only, so CSM_STORE_DIR is honored through the one D-01b seam);
 *   - past CRASH_LOG_CAP the file rotates ONCE to crash.log.1 (replacing any
 *     older rotation), and only when lstat says it is a regular file;
 *   - the open is O_APPEND | O_CREAT | O_NOFOLLOW with mode 0600, so a
 *     pre-placed symlink is refused (ELOOP) and never written through;
 *   - the mode is forced to 0600 with fchmod on every append, so a
 *     pre-existing looser crash.log is tightened (IN-03, Phase 10 plan 10-02).
 */
export function appendCrashLog(entry: string, dir: string = storeRoot()): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, CRASH_LOG);
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(file);
    } catch {
      st = undefined; // missing: O_CREAT makes it
    }
    if (
      st !== undefined &&
      st.isFile() &&
      st.size + Buffer.byteLength(entry) > CRASH_LOG_CAP
    ) {
      fs.renameSync(file, path.join(dir, `${CRASH_LOG}.1`));
    }
    const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;
    const fd = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, entry);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Best-effort: unwritable store, symlinked log, dir is a file, ...
  }
}

/**
 * The crash.log path as shown on the stderr line: the real store root
 * (storeRoot(), so CSM_STORE_DIR is honored) with a leading $HOME shown as
 * `~`, passed through oneLine so a crafted dir cannot inject escapes.
 */
export function crashLogDisplayPath(
  dir: string = storeRoot(),
  home: string = os.homedir(),
): string {
  const full = path.join(dir, CRASH_LOG);
  const prefix = home + path.sep;
  const shown =
    home !== "" && home !== path.sep && full.startsWith(prefix)
      ? "~/" + full.slice(prefix.length)
      : full;
  return oneLine(shown);
}

const ESC = String.fromCharCode(27);
/** CSI ?1049l (leave the alt screen) then CSI ?25h (show the cursor). */
const RESTORE_SEQ = `${ESC}[?1049l${ESC}[?25h`;

function defaultIo(): RestoreIo {
  return {
    stdin: process.stdin,
    stdoutIsTTY: process.stdout.isTTY === true,
    writeOut: (s: string) => {
      fs.writeSync(1, s);
    },
  };
}

/**
 * Restore the terminal (T-09-14c). Unmounting Ink is the whole restore when it
 * works: Ink then leaves the alt screen, shows the cursor and drops raw mode
 * itself. The fallback below must NEVER run after a successful unmount: Ink
 * already wrote these bytes, and a repeat may move the cursor (RESEARCH A1).
 *
 * Only when unmount is impossible (no instance, or it throws): raw mode off on
 * a TTY stdin, and alt-screen-exit + cursor-show on a TTY stdout. Never throws.
 */
export function restoreTerminal(
  inst: { unmount(): void } | undefined,
  io: RestoreIo = defaultIo(),
): void {
  if (inst !== undefined) {
    try {
      inst.unmount();
      return;
    } catch {
      // fall through to the manual restore
    }
  }
  try {
    if (io.stdin.isTTY === true && typeof io.stdin.setRawMode === "function") {
      io.stdin.setRawMode(false);
    }
  } catch {
    // stdin already gone
  }
  try {
    if (io.stdoutIsTTY) io.writeOut(RESTORE_SEQ);
  } catch {
    // stdout already gone
  }
}
