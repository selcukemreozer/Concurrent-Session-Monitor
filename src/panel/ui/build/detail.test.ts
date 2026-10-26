import { describe, it, expect } from "vitest";
import type { SessionRow } from "../../../aggregate.js";
import type { ScannedPort } from "../../../ports.js";
import { buildDetail } from "./detail.js";

// Phase 10 plan 10-11 Task 1: the pure detail-strip builder (LAYOUT-07, 09 D-12, T-10-29).

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

function row(id: string, flags: Partial<SessionRow> = {}): SessionRow {
  return {
    schema_version: 1,
    session_id: id,
    folder: "csm-demo",
    branch: "main",
    model: "claude",
    start_time: iso(NOW - 6 * 60_000),
    files: [],
    reads: [],
    alive: true,
    readyToPrune: false,
    dotState: "active",
    asking: false,
    attention: false,
    running: false,
    subagent: false,
    ...flags,
  } as SessionRow;
}

function port(p: number, command: string, ancestryPids: number[]): ScannedPort {
  return { port: p, pid: ancestryPids[0] ?? 0, command, exposed: false, ancestryPids, origin: "other" };
}

const P = "move the coupon field into the cart summary, then recompute the total and run the tests";

describe("buildDetail", () => {
  const me = row("s1", {
    title: "checkout screen",
    running: true,
    intent: "checkout screen",
    transcript_model: "claude-opus-4-7",
    last_prompt: P,
    pid: 100,
  });
  const other = row("s2", { title: "landing", running: true, pid: 200 });
  const ports = [
    port(5173, "vite", [51730, 100]),
    port(8080, "node", [80800, 200]),
    port(3000, "bun", [30000, 4, 100]),
  ];

  it("builds a running row with its owned ports sorted by port number", () => {
    const d = buildDetail({ row: me, branches: new Map(), ports, liveRows: [me, other], now: NOW });
    expect(d).toEqual({
      id: "s1",
      name: "checkout screen",
      state: "running",
      uptime: "6m",
      model: "opus 4.7",
      intent: "checkout screen",
      branch: "main",
      ports: [
        { port: 3000, proc: "bun" },
        { port: 5173, proc: "vite" },
      ],
      prompt: P,
    });
  });

  it("never attributes another session's port to this one (T-10-29)", () => {
    const d = buildDetail({ row: other, branches: new Map(), ports, liveRows: [me, other], now: NOW });
    expect(d.ports).toEqual([{ port: 8080, proc: "node" }]);
  });

  it("a dead owner claims nothing", () => {
    const dead = { ...me, alive: false } as SessionRow;
    const d = buildDetail({ row: dead, branches: new Map(), ports, liveRows: [dead, other], now: NOW });
    expect(d.ports).toEqual([]);
  });

  it("lists one port number once (IPv4 + IPv6 listeners)", () => {
    const dup = [port(3000, "bun", [1, 100]), port(3000, "bun", [1, 100])];
    const d = buildDetail({ row: me, branches: new Map(), ports: dup, liveRows: [me], now: NOW });
    expect(d.ports).toEqual([{ port: 3000, proc: "bun" }]);
  });

  it("an idle row with no intent and no prompt", () => {
    const r = row("s3");
    const d = buildDetail({ row: r, branches: new Map(), ports: [], liveRows: [r], now: NOW });
    expect(d.state).toBe("idle");
    expect(d.intent).toBeNull();
    expect(d.prompt).toBeNull();
    expect(d.name).toBe("csm-demo");
  });

  it("the live branch wins over the snapshot; an unparseable start shows the dash", () => {
    const r = row("s4", { cwd: "/w/x", start_time: "nope" });
    const d = buildDetail({ row: r, branches: new Map([["/w/x", "feat/y"]]), ports: [], liveRows: [r], now: NOW });
    expect(d.branch).toBe("feat/y");
    expect(d.uptime).toBe("—");
  });

  it("asking / waiting / subagent map through cardState", () => {
    for (const [flags, state] of [
      [{ asking: true }, "asking"],
      [{ attention: true }, "waiting"],
      [{ subagent: true }, "subagent"],
    ] as const) {
      const r = row("s5", flags);
      expect(buildDetail({ row: r, branches: new Map(), ports: [], liveRows: [r], now: NOW }).state).toBe(state);
    }
  });
});
