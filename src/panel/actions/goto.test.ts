import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyHost,
  defaultGotoDeps,
  focusingText,
  PS_BIN,
  gotoVerdict,
  parseProcTable,
  runGoto,
  type GotoDeps,
  type GotoTarget,
} from "./goto.js";
import { ancestryChain } from "../../ports.js";
import { HEX32, WARP_URL_FIXTURES } from "../../warp-url.fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VALID = "warp://session/" + HEX32;
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

// ps -axo pid=,ppid=,comm= shaped fixtures; the session pid is always 4242.
const PS_WARP = [
  " 4242  4241 claude",
  " 4241  4240 -zsh",
  " 4240  4239 /Applications/Warp.app/Contents/MacOS/stable",
  " 4239     1 /Applications/Warp.app/Contents/MacOS/stable",
  "",
].join("\n");
const PS_WARP_PREVIEW = [
  " 4242  4241 claude",
  " 4241  4240 -zsh",
  " 4240     1 /Applications/WarpPreview.app/Contents/MacOS/preview",
  "",
].join("\n");
const PS_TMUX = [" 4242  4241 claude", " 4241  4230 zsh", " 4230     1 tmux", ""].join("\n");
const PS_SCREEN = [
  " 4242  4241 claude",
  " 4241  4235 -zsh",
  " 4235  4234 login",
  " 4234     1 SCREEN",
  "",
].join("\n");
const PS_VSCODE = [
  " 4242  4241 claude",
  " 4241  4236 /bin/zsh",
  " 4236  4200 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
  " 4200     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron",
  "",
].join("\n");
const PS_ITERM = [
  " 4242  4241 claude",
  " 4241  4237 -zsh",
  " 4237  4238 /usr/bin/login",
  " 4238     1 /Applications/iTerm.app/Contents/MacOS/iTerm2",
  "",
].join("\n");
const PS_NONE = [" 4242  4241 claude", " 4241     1 /bin/zsh", ""].join("\n");
const PS_MUX_IN_WARP = [
  " 4242  4241 claude",
  " 4241  4230 zsh",
  " 4230  4229 tmux",
  " 4229  4228 -zsh",
  " 4228     1 /Applications/Warp.app/Contents/MacOS/stable",
  "",
].join("\n");

function hostOf(ps: string, pid = 4242) {
  const t = parseProcTable(ps);
  return classifyHost(ancestryChain(pid, t.ppid), t.comm);
}

interface Calls {
  probe: number;
  started: number;
  table: number;
  open: string[];
}

function fakeDeps(o: Partial<GotoDeps> & { ps?: string | null } = {}): { deps: GotoDeps; calls: Calls } {
  const calls: Calls = { probe: 0, started: 0, table: 0, open: [] };
  const ps = o.ps === undefined ? PS_WARP : o.ps;
  const deps: GotoDeps = {
    probe: (pid) => {
      calls.probe++;
      return o.probe ? o.probe(pid) : "alive";
    },
    startedProbe: (pid) => {
      calls.started++;
      return o.startedProbe ? o.startedProbe(pid) : Promise.resolve("");
    },
    procTable: () => {
      calls.table++;
      return o.procTable ? o.procTable() : Promise.resolve(ps);
    },
    open: (url) => {
      calls.open.push(url);
      return o.open ? o.open(url) : Promise.resolve(true);
    },
  };
  return { deps, calls };
}

const TARGET: GotoTarget = { name: "alpha", pid: 4242, warp: { focus_url: VALID } };

describe("gotoVerdict (RESEARCH Q1 matrix, first match wins)", () => {
  const ok = { warp: { focus_url: VALID } };
  it("ended or dead → process gone", () => {
    expect(gotoVerdict({ ...ok, ended: true }, "alive", "warp")).toEqual({ kind: "refuse", reason: "process gone" });
    expect(gotoVerdict(ok, "dead", "warp")).toEqual({ kind: "refuse", reason: "process gone" });
    expect(gotoVerdict({ warp: null }, "dead", "mux")).toEqual({ kind: "refuse", reason: "process gone" });
  });
  it("warp null with a mux / ide / warp host → pane not findable (D-13)", () => {
    for (const h of ["mux", "ide", "warp"] as const) {
      expect(gotoVerdict({ warp: null }, "alive", h)).toEqual({ kind: "refuse", reason: "pane not findable" });
    }
  });
  it("warp null otherwise → not a Warp session", () => {
    for (const h of ["otherApp", "none", "unknown"] as const) {
      expect(gotoVerdict({ warp: null }, "alive", h)).toEqual({ kind: "refuse", reason: "not a Warp session" });
    }
    expect(gotoVerdict({ warp: null }, "unknown", "unknown")).toEqual({
      kind: "refuse",
      reason: "not a Warp session",
    });
  });
  it("missing / non-object / invalid url → no Warp pane recorded", () => {
    for (const w of [undefined, "x", 42, {}, { focus_url: "" }, { focus_url: "warp://launch/x" }]) {
      expect(gotoVerdict({ warp: w }, "alive", "warp")).toEqual({ kind: "refuse", reason: "no Warp pane recorded" });
    }
  });
  it("alive unknown or a non-Warp host → pane not findable", () => {
    expect(gotoVerdict(ok, "unknown", "warp")).toEqual({ kind: "refuse", reason: "pane not findable" });
    for (const h of ["mux", "ide", "otherApp", "none", "unknown"] as const) {
      expect(gotoVerdict(ok, "alive", h)).toEqual({ kind: "refuse", reason: "pane not findable" });
    }
  });
  it("alive + Warp host + valid url → open that url", () => {
    expect(gotoVerdict(ok, "alive", "warp")).toEqual({ kind: "open", url: VALID });
  });
});

describe("parseProcTable", () => {
  it("parses pid, ppid and comm", () => {
    const t = parseProcTable("  101   100 /bin/zsh\n  100     1 /Applications/Warp.app/Contents/MacOS/stable\n");
    expect([...t.ppid]).toEqual([
      [101, 100],
      [100, 1],
    ]);
    expect(t.comm.get(101)).toBe("/bin/zsh");
    expect(t.comm.get(100)).toBe("/Applications/Warp.app/Contents/MacOS/stable");
  });
  it("skips a header and garbage lines; keeps inner spaces", () => {
    const t = parseProcTable("  PID  PPID COMM\nnot a line\n 7 1 /Applications/A B.app/Contents/MacOS/A B  \n\n");
    expect(t.ppid.size).toBe(1);
    expect(t.comm.get(7)).toBe("/Applications/A B.app/Contents/MacOS/A B");
  });
});

describe("classifyHost over ps fixtures", () => {
  it("Warp stable → warp", () => expect(hostOf(PS_WARP)).toBe("warp"));
  it("WarpPreview → warp", () => expect(hostOf(PS_WARP_PREVIEW)).toBe("warp"));
  it("tmux → mux", () => expect(hostOf(PS_TMUX)).toBe("mux"));
  it("GNU screen → mux", () => expect(hostOf(PS_SCREEN)).toBe("mux"));
  it("VS Code terminal → ide", () => expect(hostOf(PS_VSCODE)).toBe("ide"));
  it("iTerm → otherApp", () => expect(hostOf(PS_ITERM)).toBe("otherApp"));
  it("no app and no mux → none", () => expect(hostOf(PS_NONE)).toBe("none"));
  it("a mux below a Warp ancestor → mux (first match walking up)", () => expect(hostOf(PS_MUX_IN_WARP)).toBe("mux"));
  it("skips self (a session pid that is itself a Warp binary does not count)", () => {
    const t = parseProcTable(" 4242 1 /Applications/Warp.app/Contents/MacOS/stable\n");
    expect(classifyHost(ancestryChain(4242, t.ppid), t.comm)).toBe("none");
  });
  it("an empty chain → none", () => expect(classifyHost([], new Map())).toBe("none"));
});

describe("focusingText", () => {
  it("neutral copy with the cleaned name", () => {
    expect(focusingText("alpha")).toBe("focusing alpha");
    expect(focusingText("")).toBe("focusing session");
  });
  it("drops ESC / BEL / CR bytes", () => {
    const t = focusingText(`ev${ESC}[31mil${BEL}x\ry`);
    expect(t).not.toContain(ESC);
    expect(t).not.toContain(BEL);
    expect(t).not.toContain("\r");
    expect(t.startsWith("focusing ")).toBe(true);
  });
});

describe("runGoto with fake deps", () => {
  it("success → open once with the url, neutral focusing flash", async () => {
    const { deps, calls } = fakeDeps();
    expect(await runGoto(TARGET, deps)).toEqual({ text: "focusing alpha", ok: false });
    expect(calls.open).toEqual([VALID]);
  });

  it("probe dead → process gone; no ps, no open", async () => {
    const { deps, calls } = fakeDeps({ probe: () => "dead" });
    expect(await runGoto(TARGET, deps)).toEqual({ text: "process gone", ok: false });
    expect(calls.table).toBe(0);
    expect(calls.open).toEqual([]);
  });

  it("ended → process gone without probing further", async () => {
    const { deps, calls } = fakeDeps();
    expect(await runGoto({ ...TARGET, ended: true }, deps)).toEqual({ text: "process gone", ok: false });
    expect(calls.table).toBe(0);
    expect(calls.open).toEqual([]);
  });

  it("a reused pid (lstart differs) → process gone", async () => {
    const { deps, calls } = fakeDeps({ startedProbe: () => Promise.resolve("Tue Oct 27 09:00:00 2026") });
    const r = await runGoto({ ...TARGET, pid_started: "Mon Oct 26 10:00:00 2026" }, deps);
    expect(r).toEqual({ text: "process gone", ok: false });
    expect(calls.started).toBe(1);
    expect(calls.open).toEqual([]);
  });

  it("the same lstart → alive", async () => {
    const { deps, calls } = fakeDeps({ startedProbe: () => Promise.resolve("Mon Oct 26 10:00:00 2026") });
    const r = await runGoto({ ...TARGET, pid_started: "Mon Oct 26 10:00:00 2026" }, deps);
    expect(r.text).toBe("focusing alpha");
    expect(calls.open).toEqual([VALID]);
  });

  it("an empty lstart is a soft miss → alive", async () => {
    const { deps, calls } = fakeDeps({ startedProbe: () => Promise.resolve("") });
    const r = await runGoto({ ...TARGET, pid_started: "Mon Oct 26 10:00:00 2026" }, deps);
    expect(r.text).toBe("focusing alpha");
    expect(calls.open).toEqual([VALID]);
  });

  it("no pid_started → the lstart probe is not run", async () => {
    const { deps, calls } = fakeDeps();
    await runGoto(TARGET, deps);
    expect(calls.started).toBe(0);
  });

  it("an invalid pid → unknown liveness and host → pane not findable", async () => {
    for (const pid of [undefined, 0, 1, Number.NaN, 2.5, -7]) {
      const { deps, calls } = fakeDeps();
      expect(await runGoto({ ...TARGET, pid }, deps), String(pid)).toEqual({ text: "pane not findable", ok: false });
      expect(calls.probe).toBe(0);
      expect(calls.table).toBe(0);
      expect(calls.open).toEqual([]);
    }
  });

  it("ps failed (null) → pane not findable", async () => {
    const { deps, calls } = fakeDeps({ ps: null });
    expect(await runGoto(TARGET, deps)).toEqual({ text: "pane not findable", ok: false });
    expect(calls.open).toEqual([]);
  });

  it("GNU screen with a valid inherited url → pane not findable, never opened (D-13)", async () => {
    const { deps, calls } = fakeDeps({ ps: PS_SCREEN });
    expect(await runGoto(TARGET, deps)).toEqual({ text: "pane not findable", ok: false });
    expect(calls.open).toEqual([]);
  });

  it("tmux, VS Code, iTerm and none hosts with a valid url → pane not findable", async () => {
    for (const ps of [PS_TMUX, PS_VSCODE, PS_ITERM, PS_NONE, PS_MUX_IN_WARP]) {
      const { deps, calls } = fakeDeps({ ps });
      expect(await runGoto(TARGET, deps)).toEqual({ text: "pane not findable", ok: false });
      expect(calls.open).toEqual([]);
    }
  });

  it("WarpPreview host → opens", async () => {
    const { deps, calls } = fakeDeps({ ps: PS_WARP_PREVIEW });
    expect((await runGoto(TARGET, deps)).text).toBe("focusing alpha");
    expect(calls.open).toEqual([VALID]);
  });

  it("warp null + Warp host → pane not findable; + no host → not a Warp session", async () => {
    const a = fakeDeps();
    expect(await runGoto({ ...TARGET, warp: null }, a.deps)).toEqual({ text: "pane not findable", ok: false });
    expect(a.calls.open).toEqual([]);
    const b = fakeDeps({ ps: PS_NONE });
    expect(await runGoto({ ...TARGET, warp: null }, b.deps)).toEqual({ text: "not a Warp session", ok: false });
    expect(b.calls.open).toEqual([]);
  });

  it("warp undefined → no Warp pane recorded", async () => {
    const { deps, calls } = fakeDeps();
    expect(await runGoto({ ...TARGET, warp: undefined }, deps)).toEqual({ text: "no Warp pane recorded", ok: false });
    expect(calls.open).toEqual([]);
  });

  it("the whole WARP_URL_FIXTURES table: only ok values reach open, exactly once (GOTO-05)", async () => {
    for (const f of WARP_URL_FIXTURES) {
      const { deps, calls } = fakeDeps();
      const r = await runGoto({ ...TARGET, warp: { focus_url: f.value } }, deps);
      if (f.ok) {
        expect(calls.open, f.name).toEqual([f.value]);
        expect(r.text, f.name).toBe("focusing alpha");
      } else {
        expect(calls.open, f.name).toEqual([]);
        expect(r.text, f.name).toBe("no Warp pane recorded");
      }
    }
  });

  it("open resolves false → pane not findable", async () => {
    const { deps, calls } = fakeDeps({ open: () => Promise.resolve(false) });
    expect(await runGoto(TARGET, deps)).toEqual({ text: "pane not findable", ok: false });
    expect(calls.open).toEqual([VALID]);
  });

  it("a name with ESC / BEL / CR → the flash has none of them", async () => {
    const { deps } = fakeDeps();
    const r = await runGoto({ ...TARGET, name: `a${ESC}[2Jb${BEL}c\rd` }, deps);
    expect(r.text.startsWith("focusing ")).toBe(true);
    expect(r.text).not.toContain(ESC);
    expect(r.text).not.toContain(BEL);
    expect(r.text).not.toContain("\r");
  });

  it("never throws: a throwing dep maps to the failed step's reason", async () => {
    const boom = (): never => {
      throw new Error("boom");
    };
    expect(await runGoto(TARGET, fakeDeps({ probe: boom }).deps)).toEqual({ text: "process gone", ok: false });
    const st = fakeDeps({ startedProbe: () => Promise.reject(new Error("x")) });
    expect((await runGoto({ ...TARGET, pid_started: "Mon" }, st.deps)).text).toBe("focusing alpha");
    expect(await runGoto(TARGET, fakeDeps({ procTable: boom }).deps)).toEqual({ text: "pane not findable", ok: false });
    expect(await runGoto(TARGET, fakeDeps({ procTable: () => Promise.reject(new Error("x")) }).deps)).toEqual({
      text: "pane not findable",
      ok: false,
    });
    expect(await runGoto(TARGET, fakeDeps({ open: boom }).deps)).toEqual({ text: "pane not findable", ok: false });
    expect(await runGoto(TARGET, fakeDeps({ open: () => Promise.reject(new Error("x")) }).deps)).toEqual({
      text: "pane not findable",
      ok: false,
    });
  });
});

describe("defaultGotoDeps", () => {
  it("returns the four probes without running anything", () => {
    const d = defaultGotoDeps();
    expect(typeof d.probe).toBe("function");
    expect(typeof d.startedProbe).toBe("function");
    expect(typeof d.procTable).toBe("function");
    expect(typeof d.open).toBe("function");
  });
});

describe("goto.ts source (T-10-25, Pitfall 6, D-13)", () => {
  const src = fs.readFileSync(path.join(HERE, "goto.ts"), "utf8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  it("imports the child-process module only for execFile", () => {
    const imps = [...code.matchAll(/import\s+([^;]*?)\s+from\s+["']node:child_process["']/g)].map((m) => m[1].trim());
    expect(imps).toEqual(["{ execFile }"]);
  });
  it("sets no shell option and makes no synchronous exec call", () => {
    expect(code).not.toMatch(/shell\s*:/);
    expect(code).not.toMatch(/execFileSync|execSync|spawnSync/);
  });
  it("never picks a pane from the terminal device or the working directory", () => {
    expect(code).not.toMatch(/tty|cwd/);
  });
  it("runs ps by absolute path only, never through PATH (WR-03)", () => {
    expect(PS_BIN).toBe("/bin/ps");
    const calls = [...code.matchAll(/(?<!function )execText\(\s*([^,]+),/g)].map((m) => m[1].trim());
    expect(calls).toEqual(["PS_BIN", "PS_BIN"]);
    expect(code).not.toMatch(/["']ps["']/);
  });
  it("re-checks the url right before open and walks ancestry with ancestryChain", () => {
    expect((code.match(/isWarpSessionUrl\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(code).toMatch(/ancestryChain\(/);
  });
});
