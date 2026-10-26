import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CRASH_LOG,
  CRASH_LOG_CAP,
  CRASH_ENTRY_CAP,
  CRASH_MSG_CELLS,
  crashMessage,
  crashEntry,
  createCrashHandler,
  installCrashHandlers,
  appendCrashLog,
  crashLogDisplayPath,
  restoreTerminal,
  type CrashDeps,
  type RestoreIo,
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

describe("crashEntry size cap (Phase 10 plan 10-02, IN-03)", () => {
  const now = new Date("2026-10-19T10:00:00.000Z");
  const HEADER = "[2026-10-19T10:00:00.000Z] pid 9\n";

  /** The body lines of an entry: between the header line and the marker line. */
  function parts(entry: string): { header: string; body: string; marker: string } {
    const lines = entry.split("\n");
    expect(lines[lines.length - 1]).toBe("");
    return {
      header: lines[0] as string,
      body: lines.slice(1, -2).join("\n"),
      marker: lines[lines.length - 2] as string,
    };
  }

  it("IN-03 CRASH_ENTRY_CAP is a quarter of the log cap", () => {
    expect(CRASH_ENTRY_CAP).toBe(CRASH_LOG_CAP / 4);
  });

  it("IN-03 caps a 1 MB stack at CRASH_ENTRY_CAP bytes of body plus a marker line", () => {
    const err = new Error("huge");
    err.stack = "Error: huge\n" + "    at frame (file.ts:1:1)\n".repeat(40000);
    expect(Buffer.byteLength(err.stack)).toBeGreaterThan(1024 * 1024);
    const entry = crashEntry(err, now, 9);
    expect(entry.startsWith(HEADER)).toBe(true);
    const p = parts(entry);
    expect(Buffer.byteLength(p.body)).toBeLessThanOrEqual(CRASH_ENTRY_CAP);
    expect(Buffer.byteLength(p.body)).toBeGreaterThan(CRASH_ENTRY_CAP - 100);
    expect(p.marker).toBe(E + "[truncated]");
    expect(Buffer.byteLength(entry)).toBeLessThanOrEqual(
      Buffer.byteLength(HEADER) + CRASH_ENTRY_CAP + Buffer.byteLength(E + "[truncated]\n") + 1,
    );
  });

  it("IN-03 cuts on a code-point boundary (no lone surrogate, no replacement char)", () => {
    const smile = String.fromCodePoint(0x1f600);
    for (const lead of ["", "x", "xy", "xyz"]) {
      const entry = crashEntry(lead + smile.repeat(CRASH_ENTRY_CAP), now, 9);
      const p = parts(entry);
      expect(Buffer.byteLength(p.body)).toBeLessThanOrEqual(CRASH_ENTRY_CAP);
      expect(p.body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      expect(p.body).not.toContain(String.fromCharCode(0xfffd));
      expect(p.body.endsWith(smile)).toBe(true);
    }
  });

  it("IN-03 leaves an entry under the cap unchanged (no marker)", () => {
    const noStack = new Error("plain");
    noStack.stack = undefined;
    expect(crashEntry(noStack, now, 7)).toBe("[2026-10-19T10:00:00.000Z] pid 7\nplain\n");
    const exact = "a".repeat(CRASH_ENTRY_CAP);
    expect(crashEntry(exact, now, 7)).toBe("[2026-10-19T10:00:00.000Z] pid 7\n" + exact + "\n");
  });
});

// ---------------------------------------------------------------------------
// Task 2: crash.log writer, display path, terminal restore.
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(os.tmpdir() + "/csm-crash-");
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop() as string;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("appendCrashLog", () => {
  it("creates crash.log with mode 0600 and appends", () => {
    const dir = tmpDir();
    appendCrashLog("one\n", dir);
    const file = path.join(dir, CRASH_LOG);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    appendCrashLog("two\n", dir);
    expect(fs.readFileSync(file, "utf8")).toBe("one\ntwo\n");
  });

  it("rotates once to crash.log.1 past the cap", () => {
    const dir = tmpDir();
    const file = path.join(dir, CRASH_LOG);
    const old = "a".repeat(CRASH_LOG_CAP);
    fs.writeFileSync(file, old, { mode: 0o600 });
    fs.writeFileSync(file + ".1", "older rotation\n");
    appendCrashLog("new\n", dir);
    expect(fs.readFileSync(file + ".1", "utf8")).toBe(old);
    expect(fs.readFileSync(file, "utf8")).toBe("new\n");
    expect(fs.existsSync(file + ".2")).toBe(false);
  });

  it("does not rotate while under the cap", () => {
    const dir = tmpDir();
    const file = path.join(dir, CRASH_LOG);
    fs.writeFileSync(file, "a".repeat(CRASH_LOG_CAP - 10), { mode: 0o600 });
    appendCrashLog("tiny\n", dir);
    expect(fs.existsSync(file + ".1")).toBe(false);
    expect(fs.statSync(file).size).toBe(CRASH_LOG_CAP - 5);
  });

  it("never writes through a symlink", () => {
    const dir = tmpDir();
    const outside = tmpDir();
    const target = path.join(outside, "victim.txt");
    fs.writeFileSync(target, "untouched\n");
    fs.symlinkSync(target, path.join(dir, CRASH_LOG));
    expect(() => appendCrashLog("evil\n", dir)).not.toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("untouched\n");
  });

  it("never rotates a symlink even past the cap", () => {
    const dir = tmpDir();
    const outside = tmpDir();
    const target = path.join(outside, "big.txt");
    const big = "b".repeat(CRASH_LOG_CAP + 1);
    fs.writeFileSync(target, big);
    fs.symlinkSync(target, path.join(dir, CRASH_LOG));
    expect(() => appendCrashLog("evil\n", dir)).not.toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe(big);
    expect(fs.existsSync(path.join(dir, CRASH_LOG + ".1"))).toBe(false);
  });

  it("IN-03 forces mode 0600 on a pre-existing 0644 crash.log", () => {
    const dir = tmpDir();
    const file = path.join(dir, CRASH_LOG);
    fs.writeFileSync(file, "old\n");
    fs.chmodSync(file, 0o644);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    appendCrashLog("new\n", dir);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toBe("old\nnew\n");
  });

  it("IN-03 still refuses a symlinked crash.log and leaves the target's mode alone", () => {
    const dir = tmpDir();
    const outside = tmpDir();
    const target = path.join(outside, "victim.txt");
    fs.writeFileSync(target, "untouched\n");
    fs.chmodSync(target, 0o644);
    fs.symlinkSync(target, path.join(dir, CRASH_LOG));
    expect(() => appendCrashLog("evil\n", dir)).not.toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("untouched\n");
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
  });

  it("creates a missing directory", () => {
    const dir = path.join(tmpDir(), "nested", "store");
    appendCrashLog("entry\n", dir);
    expect(fs.readFileSync(path.join(dir, CRASH_LOG), "utf8")).toBe("entry\n");
  });

  it("never throws when dir is a regular file", () => {
    const file = path.join(tmpDir(), "not-a-dir");
    fs.writeFileSync(file, "x");
    expect(() => appendCrashLog("entry\n", file)).not.toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("x");
  });
});

describe("crashLogDisplayPath", () => {
  it("shows $HOME as ~", () => {
    expect(crashLogDisplayPath("/Users/x/.claude/csm", "/Users/x")).toBe(
      "~/.claude/csm/crash.log",
    );
  });

  it("keeps a path outside $HOME absolute", () => {
    expect(crashLogDisplayPath("/var/tmp/csm", "/Users/x")).toBe(
      "/var/tmp/csm/crash.log",
    );
  });

  it("does not treat a sibling prefix of $HOME as home", () => {
    expect(crashLogDisplayPath("/Users/xavier/csm", "/Users/x")).toBe(
      "/Users/xavier/csm/crash.log",
    );
  });

  it("honors CSM_STORE_DIR through storeRoot()", () => {
    const dir = tmpDir();
    const prev = process.env.CSM_STORE_DIR;
    process.env.CSM_STORE_DIR = dir;
    try {
      expect(crashLogDisplayPath()).toBe(
        crashLogDisplayPath(dir, os.homedir()),
      );
      expect(crashLogDisplayPath(dir, "/nonexistent-home")).toBe(
        dir + "/crash.log",
      );
    } finally {
      if (prev === undefined) delete process.env.CSM_STORE_DIR;
      else process.env.CSM_STORE_DIR = prev;
    }
  });

  it("strips control bytes from the dir", () => {
    const p = crashLogDisplayPath("/tmp/a" + ESC + "b", "/Users/x");
    expect(p).not.toContain(ESC);
    expect(p).toBe("/tmp/ab/crash.log");
  });
});

describe("restoreTerminal", () => {
  function fakeIo(tty: boolean): {
    io: RestoreIo;
    raw: boolean[];
    out: string[];
  } {
    const raw: boolean[] = [];
    const out: string[] = [];
    const io: RestoreIo = {
      stdin: {
        isTTY: tty,
        setRawMode: (m: boolean) => {
          raw.push(m);
        },
      },
      stdoutIsTTY: tty,
      writeOut: (s: string) => {
        out.push(s);
      },
    };
    return { io, raw, out };
  }

  const RESTORE_SEQ = ESC + "[?1049l" + ESC + "[?25h";

  it("a successful unmount is the whole restore", () => {
    const f = fakeIo(true);
    let unmounted = 0;
    restoreTerminal(
      {
        unmount: () => {
          unmounted++;
        },
      },
      f.io,
    );
    expect(unmounted).toBe(1);
    expect(f.raw).toEqual([]);
    expect(f.out).toEqual([]);
  });

  it("falls back when unmount throws", () => {
    const f = fakeIo(true);
    restoreTerminal(
      {
        unmount: () => {
          throw new Error("ink gone");
        },
      },
      f.io,
    );
    expect(f.raw).toEqual([false]);
    expect(f.out).toEqual([RESTORE_SEQ]);
  });

  it("falls back when there is no Ink instance", () => {
    const f = fakeIo(true);
    restoreTerminal(undefined, f.io);
    expect(f.raw).toEqual([false]);
    expect(f.out).toEqual([RESTORE_SEQ]);
  });

  it("does nothing to a non-TTY", () => {
    const f = fakeIo(false);
    restoreTerminal(undefined, f.io);
    expect(f.raw).toEqual([]);
    expect(f.out).toEqual([]);
  });

  it("a throwing setRawMode or writeOut never escapes", () => {
    const io: RestoreIo = {
      stdin: {
        isTTY: true,
        setRawMode: () => {
          throw new Error("EIO");
        },
      },
      stdoutIsTTY: true,
      writeOut: () => {
        throw new Error("EPIPE");
      },
    };
    expect(() => restoreTerminal(undefined, io)).not.toThrow();
  });
});
