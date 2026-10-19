import { describe, it, expect } from "vitest";
import { SAMPLE, SAMPLE_HEADER } from "./sample.js";

// Phase 9 plan 09-05 Task 1: the English sample fixture (D-03, D-20) agrees
// with the approved 175x55 frame and with itself (card counts = file groups).

/** Every string value reachable from a value (deep). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v !== null && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** The design file's Turkish UI words and idle names (D-03). Whole-word match. */
const TURKISH_WORDS = [
  "aktif",
  "dosya",
  "diğer",
  "şimdi",
  "çakışma",
  "okunan",
  "yazılan",
  "oturum",
  "proje",
  "proje için gerekli",
  "gm ülke isimleri",
  "csm dosya okuma yazma",
];

const wholeWord = (w: string): RegExp => new RegExp(`(?<!\\p{L})${w}(?!\\p{L})`, "iu");

describe("SAMPLE agents", () => {
  it("lists the five design agents in order with their states", () => {
    expect(SAMPLE.agents.map((a) => [a.name, a.state])).toEqual([
      ["csm p8 plan", "asking"],
      ["api refactor", "waiting"],
      ["checkout screen", "running"],
      ["landing copy", "running"],
      ["dashboard research", "subagent"],
    ]);
  });

  it("carries the design's dir / branch / uptime / model / prompt", () => {
    const [a0, a1, a2, a3, a4] = SAMPLE.agents;
    expect([a0?.dir, a0?.branch, a0?.uptime, a0?.model]).toEqual(["CSM", "main", "3h51m", "opus 4.7"]);
    expect(a0?.prompt).toBe("plan phase 9 from the design file and ask me before picking a branch");
    expect([a1?.dir, a1?.branch, a1?.uptime, a1?.model, a1?.waitFor]).toEqual([
      "csm-demo",
      "feat/api",
      "12m",
      "sonnet 4.6",
      "4m",
    ]);
    expect(a1?.prompt).toBe("collapse the cart endpoints into one router and keep the old paths working");
    expect([a2?.dir, a2?.branch, a2?.uptime, a2?.model]).toEqual(["csm-demo", "main", "6m", "opus 4.7"]);
    expect(a2?.prompt).toBe(
      "move the coupon field into the cart summary, then recompute the total and run the tests",
    );
    expect([a3?.dir, a3?.branch, a3?.uptime, a3?.model]).toEqual(["site", "main", "22m", "haiku 4.5"]);
    expect(a3?.prompt).toBe("rewrite the hero headline as two shorter variants");
    expect([a4?.dir, a4?.branch, a4?.uptime, a4?.model, a4?.subagents]).toEqual([
      "mvp-dash",
      "main",
      "53h",
      "opus 4.7",
      2,
    ]);
    expect(a4?.prompt).toBe("compare the three competitor dashboards and summarize what each one tracks");
  });

  it("has the design counts and conflict flags", () => {
    expect(SAMPLE.agents.map((a) => [a.writes, a.reads, a.conflicts, a.inConflict])).toEqual([
      [0, 3, 0, false],
      [1, 1, 0, false],
      [2, 2, 1, true],
      [1, 0, 0, false],
      [1, 2, 1, true],
    ]);
  });

  it("has unique ids", () => {
    const ids = SAMPLE.agents.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("SAMPLE idle, conflicts, files", () => {
  it("has the three translated idle strips", () => {
    expect(SAMPLE.idle.map((s) => [s.name, s.ago])).toEqual([
      ["project requirements", "5h"],
      ["gm country names", "34h"],
      ["csm file read write", "53h"],
    ]);
  });

  it("has exactly one conflict on src/server.js", () => {
    expect(SAMPLE.conflicts).toEqual([
      { a: "dashboard research", b: "checkout screen", path: "src/server.js" },
    ]);
  });

  it("has one file group per agent, in agent order, writes before reads", () => {
    expect(SAMPLE.groups.map((g) => g.agentId)).toEqual(SAMPLE.agents.map((a) => a.id));
    expect(SAMPLE.groups.map((g) => g.name)).toEqual(SAMPLE.agents.map((a) => a.name));
    for (const g of SAMPLE.groups) {
      const kinds = g.files.map((f) => f.kind);
      const firstRead = kinds.indexOf("read");
      if (firstRead >= 0) expect(kinds.slice(firstRead).every((k) => k === "read")).toBe(true);
    }
    const byName = Object.fromEntries(SAMPLE.groups.map((g) => [g.name, g.files.map((f) => f.path)]));
    expect(byName["checkout screen"]).toEqual([
      "src/ui/Checkout.jsx",
      "src/ui/styles.css",
      "src/ui/check.jsx",
      "package.json",
    ]);
    expect(byName["dashboard research"]).toEqual([
      "docs/research.md",
      "src/lib/metrics.ts",
      "src/pages/Overview.tsx",
    ]);
  });

  it("card write/read counts match the agent's file group", () => {
    for (const a of SAMPLE.agents) {
      const g = SAMPLE.groups.find((x) => x.agentId === a.id);
      expect(g, a.name).toBeDefined();
      expect(g?.files.filter((f) => f.kind === "write").length, a.name).toBe(a.writes);
      expect(g?.files.filter((f) => f.kind === "read").length, a.name).toBe(a.reads);
      expect(g?.state).toBe(a.state);
    }
  });

  it("totals 14 unique files including the conflict path", () => {
    const paths = new Set<string>();
    for (const g of SAMPLE.groups) for (const f of g.files) paths.add(f.path);
    for (const c of SAMPLE.conflicts) paths.add(c.path);
    expect(paths.size).toBe(14);
  });

  it("conflict counts match the conflicts list", () => {
    for (const a of SAMPLE.agents) {
      const n = SAMPLE.conflicts.filter((c) => c.a === a.name || c.b === a.name).length;
      expect(a.conflicts, a.name).toBe(n);
      expect(a.inConflict, a.name).toBe(n > 0);
    }
  });
});

describe("SAMPLE projects", () => {
  it("selects project 1", () => {
    expect(SAMPLE.projectIndex).toBe(1);
    expect(SAMPLE.projects.map((p) => [p.name, p.dir])).toEqual([
      ["Panel Redesign & Port Navigation v2.0", "CSM"],
      ["Scale & Insights v2.1", "mvp-dash"],
    ]);
  });

  it("project 0 is phases 9-12 with phase 9 current at 0/3", () => {
    const p = SAMPLE.projects[0]!;
    expect(p.phases.map((x) => [x.number, x.name, x.status])).toEqual([
      ["9", "UI Foundation & Design Contract", "current"],
      ["10", "New Panel Layout & Session Go-to", "pending"],
      ["11", "Port Go-to, Browser & Kill", "pending"],
      ["12", "Port Naming", "pending"],
    ]);
    expect([p.phases[0]?.plansDone, p.phases[0]?.plansTotal]).toEqual([0, 3]);
  });

  it("project 1 has the design's 12 phases, 33 current at 3/7", () => {
    const p = SAMPLE.projects[1]!;
    expect(p.phases.map((x) => x.number)).toEqual([
      "31",
      "32",
      "33",
      "34",
      "35",
      "35.1",
      "35.2",
      "36",
      "37",
      "38",
      "38.1",
      "39",
    ]);
    expect(p.phases.map((x) => x.status)).toEqual([
      "done",
      "done",
      "current",
      ...Array.from({ length: 9 }, () => "pending"),
    ]);
    const cur = p.phases[2]!;
    expect([cur.name, cur.plansDone, cur.plansTotal]).toEqual(["ci pipeline monitoring", 3, 7]);
    expect(p.phases[11]?.name).toBe("research agent");
  });
});

describe("SAMPLE ports and sessions", () => {
  it("has the design's 8 ports keyed by port number", () => {
    expect(SAMPLE.ports.map((p) => [p.port, p.proc, p.pid, p.owner, p.exposed])).toEqual([
      [3000, "bun", 41822, "checkout screen", false],
      [5173, "vite", 38810, "dashboard research", false],
      [27036, "steam_osx", 811, null, true],
      [37777, "bun", 4993, null, false],
      [9277, "stable", 72085, null, false],
      [57343, "steam_osx", 811, null, false],
      [57150, "steam_osx", 811, null, false],
      [57152, "steam_osx", 811, null, false],
    ]);
    for (const p of SAMPLE.ports) expect(p.key).toBe(String(p.port));
  });

  it("has the design's 11 sessions with translated times", () => {
    expect(SAMPLE.sessions.map((s) => [s.name, s.ago, s.live])).toEqual([
      ["csm p8 plan", "now", true],
      ["checkout screen", "1m", true],
      ["landing copy", "3m", true],
      ["api refactor", "4m", true],
      ["dashboard research", "9m", true],
      ["project requirements", "5h", true],
      ["gm country names", "34h", true],
      ["csm file read write", "53h", true],
      ["mvp-dashboard-beta", "3d", false],
      ["port naming spike", "4d", false],
      ["csm p7 execute", "6d", false],
    ]);
    expect(SAMPLE.sessions[3]?.id).toBe("3fa9c1d2");
    expect(SAMPLE.sessionStatus).toBeNull();
  });
});

describe("SAMPLE_HEADER", () => {
  it("matches the busy frame", () => {
    expect(SAMPLE_HEADER).toEqual({
      agents: 8,
      asking: 1,
      waiting: 1,
      conflicts: 1,
      clock: "22:18:58",
      update: null,
    });
  });

  it("agrees with the sample agents", () => {
    expect(SAMPLE_HEADER.agents).toBe(SAMPLE.agents.length + SAMPLE.idle.length);
    expect(SAMPLE_HEADER.asking).toBe(SAMPLE.agents.filter((a) => a.state === "asking").length);
    expect(SAMPLE_HEADER.waiting).toBe(SAMPLE.agents.filter((a) => a.state === "waiting").length);
    expect(SAMPLE_HEADER.conflicts).toBe(SAMPLE.conflicts.length);
  });
});

describe("English only (D-03)", () => {
  const all = [...strings(SAMPLE), ...strings(SAMPLE_HEADER)];

  it("scans a non-trivial number of strings", () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it.each(TURKISH_WORDS)("no string contains the Turkish word %j", (w) => {
    const re = wholeWord(w);
    expect(all.filter((s) => re.test(s))).toEqual([]);
  });

  it("no string carries a Turkish-only letter", () => {
    expect(all.filter((s) => /[ğĞıİşŞ]/u.test(s))).toEqual([]);
  });
});
