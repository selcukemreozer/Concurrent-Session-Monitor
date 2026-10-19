import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  CRASH_MSG_CELLS,
  crashMessage,
  crashEntry,
  createCrashHandler,
  installCrashHandlers,
  type CrashDeps,
} from "./crash.js";
import { cellWidth } from "./ui/text.js";

// Phase 9 plan 09-06: the crash module behind D-25 / KEYS-04. Every special
// code point is built with String.fromCharCode / String.fromCodePoint so this
// source stays plain ASCII (same convention as text.test.ts).

const ESC = String.fromCharCode(27);
const E = String.fromCodePoint(0x2026); // ellipsis
const DASH = String.fromCodePoint(0x2014); // em dash

/** Fake deps that record every call in order. */
function fakeDeps(over: Partial<CrashDeps> = {}): {
  deps: CrashDeps;
  calls: string[];
  errLines: string[];
  logEntries: string[];
} {
  const calls: string[] = [];
  const errLines: string[] = [];
  const logEntries: string[] = [];
  const deps: CrashDeps = {
    restore: () => {
      calls.push("restore");
    },
    writeErr: (line: string) => {
      calls.push("writeErr");
      errLines.push(line);
    },
    appendLog: (entry: string) => {
      calls.push("appendLog");
      logEntries.push(entry);
    },
    exit: (code: number) => {
      calls.push(`exit:${code}`);
    },
    displayLogPath: "~/.claude/csm/crash.log",
    now: () => new Date("2026-10-19T10:00:00.000Z"),
    ...over,
  };
  return { deps, calls, errLines, logEntries };
}

describe("crashMessage", () => {
  it("returns the Error message", () => {
    expect(crashMessage(new Error("boom"))).toBe("boom");
  });

  it("strips escapes and collapses newlines to one line", () => {
    const m = crashMessage(new Error("bad" + ESC + "[2Jpath\nline2"));
    expect(m).not.toContain(ESC);
    expect(m).not.toContain("\n");
    expect(m).toContain("[2Jpath line2");
  });

  it("caps the message at 120 cells with an ellipsis", () => {
    const m = crashMessage(new Error("x".repeat(300)));
    expect(CRASH_MSG_CELLS).toBe(120);
    expect(cellWidth(m)).toBeLessThanOrEqual(120);
    expect(m.endsWith(E)).toBe(true);
  });

  it("handles non-Error and empty inputs", () => {
    expect(crashMessage(42)).toBe("42");
    expect(crashMessage(new Error(""))).toBe("unknown error");
    expect(crashMessage(undefined)).toBe("undefined");
  });
});

describe("crashEntry", () => {
  const now = new Date("2026-10-19T10:00:00.000Z");

  it("holds the timestamp, the pid and the sanitized stack", () => {
    const err = new Error("kaput" + ESC + "[31m");
    const entry = crashEntry(err, now, 4242);
    expect(entry.startsWith("[2026-10-19T10:00:00.000Z] pid 4242\n")).toBe(true);
    expect(entry.endsWith("\n")).toBe(true);
    expect(entry).not.toContain(ESC);
    expect(entry).toContain("kaput[31m");
    // A stack frame line from this test file is present.
    expect(entry).toContain("crash.test");
  });

  it("never serializes other properties of the error object", () => {
    const err = new Error("leaky") as Error & { secret?: string };
    err.secret = "TOKEN-123";
    const entry = crashEntry(err, now, 1);
    expect(entry).not.toContain("TOKEN-123");
    expect(entry).toContain("leaky");
  });

  it("falls back to the message, then String(err)", () => {
    const noStack = new Error("plain");
    noStack.stack = undefined;
    expect(crashEntry(noStack, now, 7)).toBe(
      "[2026-10-19T10:00:00.000Z] pid 7\nplain\n",
    );
    expect(crashEntry("str" + ESC + "x", now, 7)).toBe(
      "[2026-10-19T10:00:00.000Z] pid 7\nstrx\n",
    );
  });
});

describe("createCrashHandler", () => {
  it("runs restore, writeErr, appendLog, exit:1 in that order", () => {
    const { deps, calls } = fakeDeps();
    createCrashHandler(deps)(new Error("boom"));
    expect(calls).toEqual(["restore", "writeErr", "appendLog", "exit:1"]);
  });

  it("writes exactly the one D-25 line", () => {
    const { deps, errLines } = fakeDeps();
    createCrashHandler(deps)(new Error("boom"));
    expect(errLines).toEqual([
      `csm crashed: boom ${DASH} details in ~/.claude/csm/crash.log\n`,
    ]);
    expect((errLines[0] as string).split("\n").length - 1).toBe(1);
  });

  it("logs the crash entry with the injected clock and process pid", () => {
    const { deps, logEntries } = fakeDeps();
    createCrashHandler(deps)(new Error("boom"));
    expect(logEntries).toHaveLength(1);
    expect(
      (logEntries[0] as string).startsWith(
        `[2026-10-19T10:00:00.000Z] pid ${process.pid}\n`,
      ),
    ).toBe(true);
  });

  it("keeps secrets off the stderr line and the log entry", () => {
    const { deps, errLines, logEntries } = fakeDeps();
    const err = new Error("boom") as Error & { secret?: string };
    err.secret = "TOKEN-123";
    createCrashHandler(deps)(err);
    expect(errLines.join("")).not.toContain("TOKEN-123");
    expect(logEntries.join("")).not.toContain("TOKEN-123");
  });

  it("a second fault only exits 1", () => {
    const { deps, calls } = fakeDeps();
    const handler = createCrashHandler(deps);
    handler(new Error("one"));
    calls.length = 0;
    handler(new Error("two"));
    expect(calls).toEqual(["exit:1"]);
  });

  it("a throwing restore never stops the rest", () => {
    const f = fakeDeps();
    f.deps.restore = () => {
      f.calls.push("restore");
      throw new Error("restore failed");
    };
    createCrashHandler(f.deps)(new Error("boom"));
    expect(f.calls).toEqual(["restore", "writeErr", "appendLog", "exit:1"]);
  });

  it("a throwing writeErr never stops the log or the exit", () => {
    const f = fakeDeps();
    f.deps.writeErr = () => {
      f.calls.push("writeErr");
      throw new Error("EPIPE");
    };
    createCrashHandler(f.deps)(new Error("boom"));
    expect(f.calls).toEqual(["restore", "writeErr", "appendLog", "exit:1"]);
  });

  it("a throwing appendLog never stops the exit", () => {
    const f = fakeDeps();
    f.deps.appendLog = () => {
      f.calls.push("appendLog");
      throw new Error("EACCES");
    };
    createCrashHandler(f.deps)(new Error("boom"));
    expect(f.calls).toEqual(["restore", "writeErr", "appendLog", "exit:1"]);
  });
});

describe("installCrashHandlers", () => {
  it("routes uncaughtException and unhandledRejection to the handler", () => {
    const seen: unknown[] = [];
    const proc = new EventEmitter();
    installCrashHandlers((err) => {
      seen.push(err);
    }, proc);
    const e = new Error("uncaught");
    const r = { reason: "rejected" };
    proc.emit("uncaughtException", e);
    proc.emit("unhandledRejection", r);
    expect(seen).toEqual([e, r]);
    expect(seen[0]).toBe(e);
    expect(seen[1]).toBe(r);
  });
});
