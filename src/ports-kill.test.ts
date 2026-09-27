import { describe, expect, it, vi } from "vitest";
import { killPort, chooseSignal, type KillDeps, type KillTarget, type KillContext } from "./ports.js";

/**
 * killPort guard matrix (260927-8ge D-06). Every call goes through an injected
 * fake `deps` — no real ps/lsof spawn and no real process.kill ever happens.
 */

const WARP = "/Applications/Warp.app/Contents/MacOS/stable";
const SELF = 5000;

const PS = [
  "  PID  PPID TTY      COMMAND",
  `  900     1 ??       ${WARP}`,
  `  901   900 ??       ${WARP} terminal-server`,
  "  4900  901 ttys001  -zsh",
  "  5000 4900 ttys001  node dist/panel.mjs",
  "  650   901 ttys002  -zsh",
  "  700   650 ttys002  claude",
  "  710   700 ttys002  node vite.js",
  "  800     1 ??       node server.js",
].join("\n");

interface FakeOpts {
  ps?: string | Error;
  lsof?: string | Error;
  kill?: (pid: number, sig: string) => void;
  execThrows?: boolean;
}

function fakeDeps(o: FakeOpts = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const kill = vi.fn(o.kill ?? (() => {}));
  const deps: KillDeps = {
    exec(cmd, args) {
      if (o.execThrows) throw new Error("sync boom");
      calls.push({ cmd, args });
      const v = cmd === "ps" ? (o.ps ?? PS) : (o.lsof ?? "");
      if (v instanceof Error) return Promise.reject(v);
      return Promise.resolve({ stdout: v });
    },
    kill,
  };
  return { deps, calls, kill };
}

function target(over: Partial<KillTarget> = {}): KillTarget {
  return { port: 3000, pid: 800, command: "node", signal: "SIGTERM", ...over };
}

const ctx = (over: Partial<KillContext> = {}): KillContext => ({
  livePids: new Set([700]),
  selfPid: SELF,
  ...over,
});

function lsofExit1(): Error {
  const e = new Error("lsof exit 1") as Error & { code: number };
  e.code = 1;
  return e;
}

describe("killPort guards (260927-8ge D-06)", () => {
  it.each([1, 0, -5, NaN, 2.5])("refuses pid %s without exec or kill", async (pid) => {
    const f = fakeDeps({ lsof: String(pid) });
    const r = await killPort(target({ pid }), ctx(), f.deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("geçersiz pid");
    expect(f.calls).toHaveLength(0);
    expect(f.kill).not.toHaveBeenCalled();
  });

  it.each([0, 70000, 3.5])("refuses port %s", async (port) => {
    const f = fakeDeps({ lsof: "800" });
    const r = await killPort(target({ port }), ctx(), f.deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("geçersiz port");
    expect(f.calls).toHaveLength(0);
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("refuses the panel's own pid", async () => {
    const f = fakeDeps({ lsof: String(SELF) });
    const r = await killPort(target({ pid: SELF }), ctx(), f.deps);
    expect(r).toEqual({ ok: false, message: "reddedildi: panelin kendisi" });
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("refuses a live Claude session pid", async () => {
    const f = fakeDeps({ lsof: "700" });
    const r = await killPort(target({ pid: 700 }), ctx(), f.deps);
    expect(r).toEqual({ ok: false, message: "reddedildi: Claude oturumu (pid 700)" });
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("fails closed when ps rejects", async () => {
    const f = fakeDeps({ ps: new Error("ps failed"), lsof: "800" });
    const r = await killPort(target(), ctx(), f.deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("süreç ağacı doğrulanamadı");
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("fails closed when ps output parses empty", async () => {
    const f = fakeDeps({ ps: "", lsof: "800" });
    const r = await killPort(target(), ctx(), f.deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("süreç ağacı doğrulanamadı");
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("refuses an ancestor of the panel process", async () => {
    const f = fakeDeps({ lsof: "4900" });
    const r = await killPort(target({ pid: 4900 }), ctx(), f.deps);
    expect(r).toEqual({ ok: false, message: "reddedildi: panelin üst süreci (pid 4900)" });
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("refuses the Warp app itself (not an ancestor of the panel)", async () => {
    // Panel not under Warp here, so the Warp guard (not the ancestor guard) fires.
    const ps = PS.replace("  4900  901 ttys001  -zsh", "  4900    1 ttys001  -zsh");
    const f = fakeDeps({ ps, lsof: "900" });
    const r = await killPort(target({ pid: 900, command: "stable" }), ctx(), f.deps);
    expect(r).toEqual({ ok: false, message: "reddedildi: Warp uygulaması" });
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("refuses when lsof re-verify exits 1 (pid no longer listens)", async () => {
    const f = fakeDeps({ lsof: lsofExit1() });
    const r = await killPort(target(), ctx(), f.deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("port artık bu pid'de değil");
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("refuses when lsof lists a different pid", async () => {
    const f = fakeDeps({ lsof: "8001\n" });
    const r = await killPort(target(), ctx(), f.deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("port artık bu pid'de değil");
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("maps ESRCH to a friendly already-gone message", async () => {
    const f = fakeDeps({
      lsof: "800\n",
      kill: () => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      },
    });
    const r = await killPort(target(), ctx(), f.deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("zaten sonlanmış");
  });

  it("maps EPERM to a permission message", async () => {
    const f = fakeDeps({
      lsof: "800\n",
      kill: () => {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      },
    });
    const r = await killPort(target(), ctx(), f.deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("EPERM");
  });

  it("never rejects when exec throws synchronously", async () => {
    const f = fakeDeps({ execThrows: true });
    await expect(killPort(target(), ctx(), f.deps)).resolves.toMatchObject({ ok: false });
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("allows killing an agent child whose ANCESTOR is a live session", async () => {
    const f = fakeDeps({ lsof: "710\n" });
    const r = await killPort(target({ pid: 710, port: 5173, command: "vite" }), ctx(), f.deps);
    expect(r.ok).toBe(true);
    expect(f.kill).toHaveBeenCalledWith(710, "SIGTERM");
  });

  it("happy path: exact lsof re-verify args and SIGTERM message", async () => {
    const f = fakeDeps({ lsof: "800\n" });
    const r = await killPort(target(), ctx(), f.deps);
    expect(r).toEqual({ ok: true, message: "SIGTERM → :3000 gönderildi" });
    const lsof = f.calls.find((c) => c.cmd === "lsof");
    expect(lsof!.args).toEqual(["-nP", "-iTCP:3000", "-sTCP:LISTEN", "-a", "-p", "800", "-t"]);
    expect(f.kill).toHaveBeenCalledWith(800, "SIGTERM");
  });

  it("SIGKILL target sends SIGKILL", async () => {
    const f = fakeDeps({ lsof: "800\n" });
    const r = await killPort(target({ signal: "SIGKILL" }), ctx(), f.deps);
    expect(r).toEqual({ ok: true, message: "SIGKILL → :3000 gönderildi" });
    expect(f.kill).toHaveBeenCalledWith(800, "SIGKILL");
  });
});

describe("chooseSignal (260927-8ge D-05)", () => {
  it("SIGTERM first, SIGKILL only after a later generation", () => {
    expect(chooseSignal(new Map(), "3000 800", 0)).toBe("SIGTERM");
    const sent = new Map([["3000 800", 2]]);
    expect(chooseSignal(sent, "3000 800", 2)).toBe("SIGTERM");
    expect(chooseSignal(sent, "3000 800", 3)).toBe("SIGKILL");
    expect(chooseSignal(sent, "3000 801", 3)).toBe("SIGTERM");
  });
});
