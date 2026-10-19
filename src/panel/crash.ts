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
//        `csm crashed: <message> — details in <path>`,
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
// handler for `CSM_UI=v2` only, lives in entry.ts (plan 09-14).
//
// Source kept ASCII-only (special code points are written as escapes).
import { oneLine, truncateEnd } from "./ui/text.js";
import { sanitize } from "../sanitize.js";

export const CRASH_LOG = "crash.log";
export const CRASH_LOG_CAP = 256 * 1024;
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

/**
 * The crash.log entry: `[<ISO>] pid <pid>`, then the Error's stack (else its
 * message, else String(err)), every line passed through sanitize, ending with
 * a newline. Never serializes the error object as a whole.
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
  return `[${now.toISOString()}] pid ${pid}\n${lines.join("\n")}\n`;
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
        `csm crashed: ${crashMessage(err)} — details in ${d.displayLogPath}\n`,
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
