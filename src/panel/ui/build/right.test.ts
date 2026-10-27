import { describe, it, expect } from "vitest";
import type { FocusEntry, Phase, Progress } from "../../../phases.js";
import type { ResumeRow } from "../../../sessions.js";
import { buildProjects, buildSessions, currentPhaseNumber, phaseEntries } from "./right.js";

// Phase 10 plan 10-14 Task 1: the pure PHASES / SESSIONS view-model builders
// (D-23, KEYS-05: a project's identity is its root).

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

const ph = (number: string, name: string, plans: number, summaries: number, status = "In Progress"): Phase => ({
  number,
  name,
  plans,
  summaries,
  status,
});

const progress = (phases: Phase[], name = "Panel Redesign", version = "v2.0"): Progress => ({
  milestone_name: name,
  milestone_version: version,
  percent: 25,
  phases,
});

const row = (id: string, label: string, ageMs: number, live = false): ResumeRow => ({
  id,
  label,
  labelKind: "name",
  folder: "csm",
  mtimeMs: NOW - ageMs,
  live,
});

describe("phaseEntries", () => {
  it("maps complete phases to done, the first open one to current and the rest to pending", () => {
    const p = progress([
      ph("9", "UI Foundation", 16, 16, "Complete"),
      ph("10", "New Panel Layout", 17, 13),
      ph("11", "Port Go-to", 0, 0, "Pending"),
      ph("12", "Port Naming", 4, 0, "Pending"),
    ]);
    expect(phaseEntries(p)).toEqual([
      { number: "9", name: "UI Foundation", status: "done", plansDone: 16, plansTotal: 16 },
      { number: "10", name: "New Panel Layout", status: "current", plansDone: 13, plansTotal: 17 },
      { number: "11", name: "Port Go-to", status: "pending", plansDone: 0, plansTotal: null },
      { number: "12", name: "Port Naming", status: "pending", plansDone: 0, plansTotal: 4 },
    ]);
  });

  it("counts a phase whose every plan has a summary as done (phaseIsComplete)", () => {
    const p = progress([ph("1", "a", 3, 3, "In Progress"), ph("2", "b", 2, 1)]);
    expect(phaseEntries(p).map((e) => e.status)).toEqual(["done", "current"]);
  });

  it("marks every phase done when all are complete (no current)", () => {
    const p = progress([ph("1", "a", 1, 1, "Complete"), ph("2", "b", 2, 2)]);
    expect(phaseEntries(p).map((e) => e.status)).toEqual(["done", "done"]);
  });

  it("returns [] for no phases", () => {
    expect(phaseEntries(progress([]))).toEqual([]);
  });
});

describe("buildProjects", () => {
  const focus: FocusEntry[] = [
    { root: "/a", name: "CSM" },
    { root: "/b", name: "mvp-dash" },
  ];

  it("names a scanned project by milestone name + version and an unscanned one by its folder", () => {
    const map = new Map<string, Progress>([["/a", progress([ph("10", "Layout", 17, 13)])]]);
    const out = buildProjects(focus, map);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      root: "/a",
      name: "Panel Redesign v2.0",
      dir: "CSM",
      phases: [{ number: "10", name: "Layout", status: "current", plansDone: 13, plansTotal: 17 }],
    });
    // not scanned yet: drawn as `no roadmap`
    expect(out[1]).toEqual({ root: "/b", name: "mvp-dash", dir: "mvp-dash", phases: [] });
  });

  it("omits an empty version and falls back to the folder name for an empty milestone name", () => {
    const map = new Map<string, Progress>([
      ["/a", progress([], "Only Name", "")],
      ["/b", progress([], "", "")],
    ]);
    const out = buildProjects(focus, map);
    expect(out.map((p) => p.name)).toEqual(["Only Name", "mvp-dash"]);
  });

  it("keeps the focus-set order and returns [] for an empty set", () => {
    expect(buildProjects([], new Map())).toEqual([]);
    const rev = buildProjects([...focus].reverse(), new Map());
    expect(rev.map((p) => p.root)).toEqual(["/b", "/a"]);
  });
});

describe("currentPhaseNumber", () => {
  const project = (phases: ReturnType<typeof phaseEntries>) => ({ name: "x", dir: "x", phases });

  it("is the current phase's number", () => {
    const p = progress([ph("9", "a", 1, 1, "Complete"), ph("10", "b", 3, 1), ph("11", "c", 0, 0, "Pending")]);
    expect(currentPhaseNumber(project(phaseEntries(p)))).toBe("10");
  });

  it("is the last phase's number when all are done", () => {
    const p = progress([ph("9", "a", 1, 1, "Complete"), ph("10", "b", 2, 2, "Complete")]);
    expect(currentPhaseNumber(project(phaseEntries(p)))).toBe("10");
  });

  it("is null for an empty project or none at all", () => {
    expect(currentPhaseNumber(project([]))).toBeNull();
    expect(currentPhaseNumber(undefined)).toBeNull();
  });
});

describe("buildSessions", () => {
  it("maps rows in order with label, age and the isLive verdict", () => {
    const rows = [row("s1", "csm p8 plan", 5_000), row("s2", "checkout", 3 * 60_000, true), row("s3", "old", 2 * 86_400_000)];
    const isLive = (r: ResumeRow): boolean => r.live || r.id === "s1";
    expect(buildSessions(rows, isLive, NOW)).toEqual([
      { id: "s1", name: "csm p8 plan", ago: "5s", live: true },
      { id: "s2", name: "checkout", ago: "3m", live: true },
      { id: "s3", name: "old", ago: "2d", live: false },
    ]);
  });

  it("returns [] for null rows (first scan still running)", () => {
    expect(buildSessions(null, () => false, NOW)).toEqual([]);
  });
});
