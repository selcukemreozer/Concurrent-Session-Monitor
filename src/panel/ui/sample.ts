import type {
  AgentCard,
  FileGroup,
  HeaderModel,
  PanesModel,
  PhaseEntry,
  PortEntry,
  SessionEntry,
} from "./models.js";

/**
 * The v2 sample fixture (Phase 9, plan 09-05; D-03, D-20).
 *
 * The English translation of the design file's fixture (`design/CSM
 * Panel.dc.html` AGENTS / IDLE / CONFLICTS / PROJECTS / PORTS / SESSIONS).
 * Every pane filled from it is drawn under the ` sample ` chip (D-20) so it can
 * never be mistaken for live sessions (T-09-10); Phase 10 replaces it pane by
 * pane. The header is live and never carries the chip.
 */

const ID = {
  plan: "4be1c07a",
  api: "3fa9c1d2",
  checkout: "9c41e2a0",
  landing: "1d7f5b33",
  research: "b20e6f19",
} as const;

const agents: AgentCard[] = [
  {
    id: ID.plan,
    name: "csm p8 plan",
    dir: "CSM",
    branch: "main",
    uptime: "3h51m",
    model: "opus 4.7",
    prompt: "plan phase 9 from the design file and ask me before picking a branch",
    state: "asking",
    waitFor: null,
    subagents: 0,
    conflicts: 0,
    writes: 0,
    reads: 3,
    inConflict: false,
  },
  {
    id: ID.api,
    name: "api refactor",
    dir: "csm-demo",
    branch: "feat/api",
    uptime: "12m",
    model: "sonnet 4.6",
    prompt: "collapse the cart endpoints into one router and keep the old paths working",
    state: "waiting",
    waitFor: "4m",
    subagents: 0,
    conflicts: 0,
    writes: 1,
    reads: 1,
    inConflict: false,
  },
  {
    id: ID.checkout,
    name: "checkout screen",
    dir: "csm-demo",
    branch: "main",
    uptime: "6m",
    model: "opus 4.7",
    prompt: "move the coupon field into the cart summary, then recompute the total and run the tests",
    state: "running",
    waitFor: null,
    subagents: 0,
    conflicts: 1,
    writes: 2,
    reads: 2,
    inConflict: true,
  },
  {
    id: ID.landing,
    name: "landing copy",
    dir: "site",
    branch: "main",
    uptime: "22m",
    model: "haiku 4.5",
    prompt: "rewrite the hero headline as two shorter variants",
    state: "running",
    waitFor: null,
    subagents: 0,
    conflicts: 0,
    writes: 1,
    reads: 0,
    inConflict: false,
  },
  {
    id: ID.research,
    name: "dashboard research",
    dir: "mvp-dash",
    branch: "main",
    uptime: "53h",
    model: "opus 4.7",
    prompt: "compare the three competitor dashboards and summarize what each one tracks",
    state: "subagent",
    waitFor: null,
    subagents: 2,
    conflicts: 1,
    writes: 1,
    reads: 2,
    inConflict: true,
  },
];

const w = (path: string) => ({ path, kind: "write" as const });
const r = (path: string) => ({ path, kind: "read" as const });

const groups: FileGroup[] = [
  {
    agentId: ID.plan,
    name: "csm p8 plan",
    state: "asking",
    files: [r(".planning/ROADMAP.md"), r(".planning/phase-8.md"), r(".planning/phase-9.md")],
  },
  {
    agentId: ID.api,
    name: "api refactor",
    state: "waiting",
    files: [w("src/routes/cart.js"), r("src/db/schema.sql")],
  },
  {
    agentId: ID.checkout,
    name: "checkout screen",
    state: "running",
    files: [w("src/ui/Checkout.jsx"), w("src/ui/styles.css"), r("src/ui/check.jsx"), r("package.json")],
  },
  {
    agentId: ID.landing,
    name: "landing copy",
    state: "running",
    files: [w("content/hero.md")],
  },
  {
    agentId: ID.research,
    name: "dashboard research",
    state: "subagent",
    files: [w("docs/research.md"), r("src/lib/metrics.ts"), r("src/pages/Overview.tsx")],
  },
];

/** Phases before the current index are done, after it pending. */
function phases(
  list: ReadonlyArray<readonly [string, string]>,
  current: number,
  plans: readonly [number, number],
): PhaseEntry[] {
  return list.map(([number, name], i) => ({
    number,
    name,
    status: i < current ? "done" : i === current ? "current" : "pending",
    plansDone: i === current ? plans[0] : null,
    plansTotal: i === current ? plans[1] : null,
  }));
}

const port = (p: number, proc: string, pid: number, owner: string | null, exposed = false): PortEntry => ({
  key: String(p),
  port: p,
  proc,
  pid,
  exposed,
  owner,
});

const sessions: SessionEntry[] = [
  { id: "4be1c07a", name: "csm p8 plan", ago: "now", live: true },
  { id: "9c41e2a0", name: "checkout screen", ago: "1m", live: true },
  { id: "1d7f5b33", name: "landing copy", ago: "3m", live: true },
  { id: "3fa9c1d2", name: "api refactor", ago: "4m", live: true },
  { id: "b20e6f19", name: "dashboard research", ago: "9m", live: true },
  { id: "77c0a8e4", name: "project requirements", ago: "5h", live: true },
  { id: "e5d21c90", name: "gm country names", ago: "34h", live: true },
  { id: "0a4b9d17", name: "csm file read write", ago: "53h", live: true },
  { id: "c81f4e02", name: "mvp-dashboard-beta", ago: "3d", live: false },
  { id: "5e9a3b6c", name: "port naming spike", ago: "4d", live: false },
  { id: "d3b7710f", name: "csm p7 execute", ago: "6d", live: false },
];

export const SAMPLE: PanesModel = {
  agents,
  idle: [
    { id: "77c0a8e4", name: "project requirements", ago: "5h" },
    { id: "e5d21c90", name: "gm country names", ago: "34h" },
    { id: "0a4b9d17", name: "csm file read write", ago: "53h" },
  ],
  conflicts: [{ a: "dashboard research", b: "checkout screen", path: "src/server.js" }],
  groups,
  projects: [
    {
      name: "Panel Redesign & Port Navigation v2.0",
      dir: "CSM",
      phases: phases(
        [
          ["9", "UI Foundation & Design Contract"],
          ["10", "New Panel Layout & Session Go-to"],
          ["11", "Port Go-to, Browser & Kill"],
          ["12", "Port Naming"],
        ],
        0,
        [0, 3],
      ),
    },
    {
      name: "Scale & Insights v2.1",
      dir: "mvp-dash",
      phases: phases(
        [
          ["31", "auth flow"],
          ["32", "billing sync"],
          ["33", "ci pipeline monitoring"],
          ["34", "v2.0 gate closure"],
          ["35", "production platform on outplane"],
          ["35.1", "transactional email via own smtp"],
          ["35.2", "security network hardening"],
          ["36", "async cloro measurement"],
          ["37", "prompt weighting heuristic"],
          ["38", "dashboard redesign"],
          ["38.1", "sources tab"],
          ["39", "research agent"],
        ],
        2,
        [3, 7],
      ),
    },
  ],
  projectIndex: 1,
  sessions,
  sessionStatus: null,
  ports: [
    port(3000, "bun", 41822, "checkout screen"),
    port(5173, "vite", 38810, "dashboard research"),
    port(27036, "steam_osx", 811, null, true),
    port(37777, "bun", 4993, null),
    port(9277, "stable", 72085, null),
    port(57343, "steam_osx", 811, null),
    port(57150, "steam_osx", 811, null),
    port(57152, "steam_osx", 811, null),
  ],
};

export const SAMPLE_HEADER: HeaderModel = {
  agents: 8,
  asking: 1,
  waiting: 1,
  conflicts: 1,
  clock: "22:18:58",
  update: null,
};
