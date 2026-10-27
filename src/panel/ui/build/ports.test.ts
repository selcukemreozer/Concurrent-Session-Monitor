import { describe, it, expect } from "vitest";
import type { SessionRow } from "../../../aggregate.js";
import type { ScannedPort } from "../../../ports.js";
import { buildPorts } from "./ports.js";

// Phase 10 plan 10-15 Task 1: the pure live PORTS builder (D-23, KEYS-02).

function row(id: string, pid: number, title: string, flags: Partial<SessionRow> = {}): SessionRow {
  return {
    schema_version: 1,
    session_id: id,
    folder: "proj",
    branch: "main",
    model: "claude",
    start_time: "2026-10-27T12:00:00.000Z",
    files: [],
    reads: [],
    alive: true,
    readyToPrune: false,
    dotState: "active",
    asking: false,
    attention: false,
    running: false,
    subagent: false,
    pid,
    title,
    ...flags,
  } as SessionRow;
}

function scanned(port: number, pid: number, command: string, ancestryPids: number[], exposed = false): ScannedPort {
  return { port, pid, command, exposed, ancestryPids, origin: "other" };
}

const VITE = scanned(5173, 20, "vite", [20, 10]);
const BUN = scanned(3000, 30, "bun", [30, 11]);
const STEAM = scanned(27036, 811, "steam_osx", [811], true);
const ROWS = [row("s-a", 10, "dashboard research"), row("s-b", 11, "checkout screen")];

describe("buildPorts", () => {
  it("orders by port, keys by portKey and names the owning live session", () => {
    expect(buildPorts([VITE, BUN, STEAM], ROWS)).toEqual([
      { key: "3000 30", port: 3000, proc: "bun", pid: 30, exposed: false, owner: "checkout screen" },
      { key: "5173 20", port: 5173, proc: "vite", pid: 20, exposed: false, owner: "dashboard research" },
      { key: "27036 811", port: 27036, proc: "steam_osx", pid: 811, exposed: true, owner: null },
    ]);
  });

  it("keeps the same port on two pids as two entries, ordered by pid", () => {
    const out = buildPorts([scanned(8080, 70, "node", [70]), scanned(8080, 50, "node", [50])], []);
    expect(out.map((p) => p.key)).toEqual(["8080 50", "8080 70"]);
  });

  it("a dead or prune-ready row never owns a port (livePidMap rule)", () => {
    const rows = [
      row("dead", 10, "dead one", { alive: false }),
      row("prune", 11, "prune one", { readyToPrune: true }),
    ];
    expect(buildPorts([VITE, BUN], rows).map((p) => p.owner)).toEqual([null, null]);
  });

  it("falls back to the folder name when the owner has no title", () => {
    const out = buildPorts([VITE], [row("s-a", 10, "", { title: undefined, folder: "web-app" })]);
    expect(out[0]!.owner).toBe("web-app");
  });

  it("keeps proc RAW (the draw layer makes it cell-safe) and does not mutate its input", () => {
    const input = [scanned(9000, 5, "evil\x1b[31m", [5]), VITE];
    const before = JSON.stringify(input);
    const out = buildPorts(input, []);
    expect(out.map((p) => p.port)).toEqual([5173, 9000]);
    expect(out[1]!.proc).toBe("evil\x1b[31m");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("an empty scan is an empty list", () => {
    expect(buildPorts([], ROWS)).toEqual([]);
  });
});
