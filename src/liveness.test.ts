import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// RED: src/liveness.ts (isProcessAlive/resolveLastSeen/staleMs/fmtUptime) lands in wave 02-01 Task 2.
import { isProcessAlive, resolveLastSeen, staleMs, fmtUptime } from "./liveness.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-live-"));
});

afterEach(() => {
  delete process.env.CSM_STALE_MS;
  delete process.env.CSM_ACTIVE_MS;
  delete process.env.CSM_WINDOW_MS;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Seed a shard dir with a `heartbeat` sidecar per the frozen on-disk contract. */
function seedHeartbeat(content: string, mtimeSec?: number): string {
  const dir = fs.mkdtempSync(path.join(tmp, "shard-"));
  const hb = path.join(dir, "heartbeat");
  fs.writeFileSync(hb, content);
  if (mtimeSec !== undefined) fs.utimesSync(hb, mtimeSec, mtimeSec);
  return dir;
}

describe("resolveLastSeen", () => {
  it("returns the heartbeat content timestamp in ms (LIFE-01)", () => {
    const iso = new Date("2020-01-02T03:04:05.000Z").toISOString();
    const dir = seedHeartbeat(iso);
    expect(resolveLastSeen(dir)).toBe(Date.parse(iso));
  });

  it("returns undefined when the heartbeat file is absent", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "empty-"));
    expect(resolveLastSeen(dir)).toBeUndefined();
  });

  it("falls back to the file mtime (ms) when content is unparseable", () => {
    const mtimeSec = 1_600_000_000; // fixed epoch seconds
    const dir = seedHeartbeat("not-a-timestamp", mtimeSec);
    expect(resolveLastSeen(dir)).toBe(mtimeSec * 1000);
  });
});

describe("isProcessAlive", () => {
  it("returns the stubbed probe verdict for a valid pid", () => {
    expect(isProcessAlive(1234, () => "alive")).toBe("alive");
    expect(isProcessAlive(1234, () => "dead")).toBe("dead");
  });

  it("returns 'unknown' without calling the probe for a bad pid", () => {
    let calls = 0;
    const probe = (): "alive" | "dead" => {
      calls++;
      return "alive";
    };
    expect(isProcessAlive(1.5, probe)).toBe("unknown");
    expect(isProcessAlive(0, probe)).toBe("unknown");
    expect(isProcessAlive(-1, probe)).toBe("unknown");
    expect(isProcessAlive(undefined, probe)).toBe("unknown");
    expect(calls).toBe(0);
  });

  it("real probe: self pid reads 'alive'", () => {
    expect(isProcessAlive(process.pid)).toBe("alive");
  });

  it("real probe: a spawned-then-exited child pid reads 'dead'", () => {
    const child = spawnSync(process.execPath, ["-e", ""]);
    expect(child.pid).toBeGreaterThan(0);
    expect(isProcessAlive(child.pid)).toBe("dead");
  });

  // --- PID-reuse identity guard (CR-01/WR-03), pure injected started-probe ---

  it("reuse: alive probe + mismatched started token => 'dead' (pid recycled)", () => {
    const verdict = isProcessAlive(
      1234,
      () => "alive",
      "Mon Jan  1 00:00:00 2020",
      () => "Wed Aug 27 09:00:00 2026", // a different process now holds pid 1234
    );
    expect(verdict).toBe("dead");
  });

  it("identity: alive probe + matching started token => 'alive'", () => {
    const token = "Mon Jan  1 00:00:00 2020";
    expect(isProcessAlive(1234, () => "alive", token, () => token)).toBe("alive");
  });

  it("soft miss: alive probe + empty re-derived token => 'alive' (TTL decides)", () => {
    let calls = 0;
    const started = (): string => {
      calls++;
      return ""; // cannot re-derive (pid gone / ps unavailable)
    };
    expect(isProcessAlive(1234, () => "alive", "Mon Jan  1 00:00:00 2020", started)).toBe("alive");
    expect(calls).toBe(1);
  });

  it("no expectedStarted: identity check is skipped, started-probe never called", () => {
    let calls = 0;
    const started = (): string => {
      calls++;
      return "whatever";
    };
    expect(isProcessAlive(1234, () => "alive", undefined, started)).toBe("alive");
    expect(calls).toBe(0);
  });

  it("dead base probe short-circuits before the identity check", () => {
    let calls = 0;
    const started = (): string => {
      calls++;
      return "whatever";
    };
    expect(isProcessAlive(1234, () => "dead", "Mon Jan  1 00:00:00 2020", started)).toBe("dead");
    expect(calls).toBe(0);
  });
});

describe("staleMs", () => {
  it("defaults to 120000", () => {
    expect(staleMs()).toBe(120000);
  });

  it("honors CSM_STALE_MS and is distinct from CSM_WINDOW_MS", () => {
    process.env.CSM_STALE_MS = "5000";
    process.env.CSM_WINDOW_MS = "999999"; // must NOT influence staleMs
    expect(staleMs()).toBe(5000);
  });
});

describe("fmtUptime", () => {
  const now = 10_000_000_000;
  it("sub-minute keeps seconds", () => {
    expect(fmtUptime(now - 45_000, now)).toBe("45s");
  });
  it("minutes drop seconds", () => {
    expect(fmtUptime(now - 42 * 60_000, now)).toBe("42m");
  });
  it("hours render as 'Xh Ym'", () => {
    expect(fmtUptime(now - (2 * 60 + 14) * 60_000, now)).toBe("2h 14m");
  });
});
