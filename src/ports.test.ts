import { afterEach, describe, expect, it, vi } from "vitest";

// RED: src/ports.ts (scanner + pure helpers) lands in Task 2 of plan 04.1-01.
import {
  parseLsofF,
  parsePpidMap,
  ancestryChain,
  splitHostPort,
  isExposed,
  livePidMap,
  attribute,
  scanPorts,
  portScanMs,
  APPLE_AGENT_DENYLIST,
  type ScannedPort,
} from "./ports.js";
import type { SessionRow } from "./aggregate.js";

/**
 * Mutable, hoisted spawn state so `vi.mock` can drive the (mocked) child_process
 * `execFile`. No real `lsof`/`ps` process is ever spawned by this suite.
 */
const spawnState = vi.hoisted(() => ({
  lsof: { stdout: "", reject: false },
  ps: { stdout: "", reject: false },
  calls: [] as { cmd: string; args: string[] }[],
}));

vi.mock("node:child_process", () => ({
  // promisify wraps this callback-style fn: execFile(cmd, args, opts, cb).
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, res?: { stdout: string; stderr: string }) => void,
  ) => {
    spawnState.calls.push({ cmd, args });
    const target = cmd === "lsof" ? spawnState.lsof : spawnState.ps;
    if (target.reject) {
      const err = new Error(`${cmd} failed`) as Error & { code: number };
      err.code = 1; // lsof exit 1 == no-match / spawn failure surrogate
      cb(err);
      return;
    }
    cb(null, { stdout: target.stdout, stderr: "" });
  },
}));

afterEach(() => {
  delete process.env.CSM_PORT_SCAN_MS;
  spawnState.lsof = { stdout: "", reject: false };
  spawnState.ps = { stdout: "", reject: false };
  spawnState.calls = [];
});

/** Cast a minimal partial into a SessionRow — livePidMap only reads a few fields. */
function row(partial: Partial<SessionRow>): SessionRow {
  return partial as unknown as SessionRow;
}

const PS_FIXTURE = [
  "  PID  PPID USER     COMMAND",
  "  111     1 user     /System/rapportd",
  "  222     1 user     /System/ControlCenter",
  "  333   300 user     node server.js",
  "  300     1 user     -zsh",
  "  444   300 user     node twin.js",
].join("\n");

describe("parse: parseLsofF -FpcLn field blocks", () => {
  it("yields {pid, command, login, name} with an UNTRUNCATED command", () => {
    // ControlCenter is 13 chars — column-mode lsof truncates to 9; -F does not.
    const fixture = ["p222", "cControlCenter", "Luser", "f6", "n*:57435"].join("\n") + "\n";
    const recs = parseLsofF(fixture);
    expect(recs).toEqual([
      { pid: 222, command: "ControlCenter", login: "user", name: "*:57435" },
    ]);
    expect(recs[0].command).toBe("ControlCenter"); // not "ControlCe"
  });

  it("parse: one process block can contribute multiple sockets", () => {
    const fixture = ["p333", "cnode", "Luser", "f7", "n127.0.0.1:3000", "f8", "n*:3001"].join("\n");
    const recs = parseLsofF(fixture);
    expect(recs.map((r) => r.name)).toEqual(["127.0.0.1:3000", "*:3001"]);
    expect(recs.every((r) => r.pid === 333 && r.command === "node")).toBe(true);
  });
});

describe("classif: isExposed + splitHostPort", () => {
  it("classifies all-interface binds as exposed", () => {
    expect(isExposed("*")).toBe(true);
    expect(isExposed("0.0.0.0")).toBe(true);
    expect(isExposed("::")).toBe(true);
    expect(isExposed("192.168.1.4")).toBe(true);
  });

  it("classifies loopback binds as local-only", () => {
    expect(isExposed("127.0.0.1")).toBe(false);
    expect(isExposed("::1")).toBe(false);
    expect(isExposed("localhost")).toBe(false);
    expect(isExposed("127.0.0.5")).toBe(false);
  });

  it("splits host + numeric port for IPv4, wildcard, and IPv6 bracket forms", () => {
    expect(splitHostPort("127.0.0.1:37777")).toEqual({ host: "127.0.0.1", port: 37777 });
    expect(splitHostPort("*:57434")).toEqual({ host: "*", port: 57434 });
    expect(splitHostPort("[::1]:37777")).toEqual({ host: "::1", port: 37777 });
    expect(splitHostPort("[::]:8080")).toEqual({ host: "::", port: 8080 });
  });
});

describe("ancestry: ancestryChain PPID walk", () => {
  it("walks a leaf pid to the root, stopping at pid<=1", () => {
    const ppid = new Map<number, number>([
      [500, 400],
      [400, 1],
    ]);
    expect(ancestryChain(500, ppid)).toEqual([500, 400]);
  });

  it("stops at the launchd(1) boundary", () => {
    expect(ancestryChain(500, new Map([[500, 1]]))).toEqual([500]);
  });

  it("terminates on an induced cycle without looping", () => {
    const cyclic = new Map<number, number>([
      [1000, 2000],
      [2000, 1000],
    ]);
    expect(ancestryChain(1000, cyclic)).toEqual([1000, 2000]);
  });
});

describe("parsePpidMap", () => {
  it("skips the header and builds pid->ppid for integer rows only (COMMAND may have spaces)", () => {
    const m = parsePpidMap(PS_FIXTURE);
    expect(m.get(333)).toBe(300);
    expect(m.get(300)).toBe(1);
    expect(m.has(111)).toBe(true);
  });
});

describe("dedup + non-fatal: scanPorts", () => {
  it("dedup: collapses an IPv4+IPv6 (port,pid) twin into one entry, exposed if either twin is", async () => {
    spawnState.lsof.stdout =
      ["p444", "cnode", "Luser", "f8", "n127.0.0.1:9090", "f9", "n[::]:9090"].join("\n") + "\n";
    spawnState.ps.stdout = PS_FIXTURE;
    const res = await scanPorts(1000);
    const twins = res.filter((p) => p.port === 9090 && p.pid === 444);
    expect(twins).toHaveLength(1);
    expect(twins[0].exposed).toBe(true); // [::] twin is exposed → collapsed entry is exposed
  });

  it("non-fatal: resolves [] (never throws) when lsof rejects (exit code 1 / no match)", async () => {
    spawnState.lsof.reject = true;
    await expect(scanPorts(1000)).resolves.toEqual([]);
  });

  it("non-fatal: a failing ps still yields ports (all fall to the user bucket)", async () => {
    spawnState.lsof.stdout = ["p333", "cnode", "Luser", "f7", "n127.0.0.1:3000"].join("\n") + "\n";
    spawnState.ps.reject = true;
    const res = await scanPorts(1000);
    expect(res).toHaveLength(1);
    expect(res[0].port).toBe(3000);
    expect(res[0].ancestryPids).toEqual([333]); // no ps map → chain is just self
  });
});

describe("user: scanPorts carries the -a -u <uid> filter (D-01)", () => {
  it("passes -a -u <uid> to lsof", async () => {
    spawnState.lsof.stdout = "";
    spawnState.ps.stdout = PS_FIXTURE;
    await scanPorts(1000);
    const lsofCall = spawnState.calls.find((c) => c.cmd === "lsof");
    expect(lsofCall).toBeDefined();
    expect(lsofCall!.args).toContain("-a");
    expect(lsofCall!.args).toContain("-u");
    expect(lsofCall!.args).toContain("1000");
  });
});

describe("denylist: Apple background agents excluded (D-01)", () => {
  it("APPLE_AGENT_DENYLIST contains the curated Apple agent command names", () => {
    for (const name of [
      "rapportd",
      "ControlCenter",
      "sharingd",
      "AirPlayXPCHelper",
      "identityservicesd",
      "remoted",
    ]) {
      expect(APPLE_AGENT_DENYLIST.has(name)).toBe(true);
    }
  });

  it("excludes rapportd + ControlCenter while a genuine node dev-server survives", async () => {
    spawnState.lsof.stdout =
      [
        "p111",
        "crapportd",
        "Luser",
        "f5",
        "n*:57434",
        "p222",
        "cControlCenter",
        "Luser",
        "f6",
        "n*:57435",
        "p333",
        "cnode",
        "Luser",
        "f7",
        "n127.0.0.1:3000",
      ].join("\n") + "\n";
    spawnState.ps.stdout = PS_FIXTURE;
    const res = await scanPorts(1000);
    const commands = res.map((p) => p.command);
    expect(commands).not.toContain("rapportd");
    expect(commands).not.toContain("ControlCenter");
    expect(commands).toContain("node");
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ port: 3000, pid: 333, command: "node", exposed: false });
  });
});

describe("attribute: livePidMap + attribute render-time join", () => {
  it("livePidMap includes only alive && !readyToPrune && numeric pid", () => {
    const rows = [
      row({ pid: 400, alive: true, readyToPrune: false }),
      row({ pid: 999, alive: true, readyToPrune: true }), // dead-session prune guard
      row({ pid: 500, alive: false, readyToPrune: false }),
      row({ pid: undefined, alive: true, readyToPrune: false }),
    ];
    const live = livePidMap(rows);
    expect(live.has(400)).toBe(true);
    expect(live.has(999)).toBe(false); // readyToPrune excluded (pid-reuse guard)
    expect(live.has(500)).toBe(false);
    expect(live.size).toBe(1);
  });

  it("attribute returns the first ancestry match, else null (user bucket)", () => {
    const live = livePidMap([row({ pid: 400, alive: true, readyToPrune: false })]);
    const p: ScannedPort = {
      port: 3000,
      pid: 333,
      command: "node",
      exposed: false,
      ancestryPids: [333, 300, 400],
    };
    expect(attribute(p, live)).toBe(live.get(400));

    const orphan: ScannedPort = { ...p, ancestryPids: [7, 8, 9] };
    expect(attribute(orphan, live)).toBeNull();
  });
});

describe("portScanMs cadence accessor (D-05)", () => {
  it("defaults to 2500", () => {
    expect(portScanMs()).toBe(2500);
  });

  it("honors CSM_PORT_SCAN_MS", () => {
    process.env.CSM_PORT_SCAN_MS = "1234";
    expect(portScanMs()).toBe(1234);
  });
});
