import { describe, it, expect } from "vitest";
import type { SessionRow } from "../../../aggregate.js";
import type { DisplayRow } from "../../hooks/useRoster.js";
import type { Conflict } from "../../../conflicts.js";
import { buildAgents, cardState, stableOrder } from "./agents.js";

// Phase 10 plan 10-09 Task 1: the pure live AGENTS builder (D-05, D-07, D-08).

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();
const T1 = iso(NOW - 3 * 3600_000);
const T2 = iso(NOW - 2 * 3600_000);
const T3 = iso(NOW - 1 * 3600_000);

function row(id: string, flags: Partial<SessionRow> = {}): SessionRow {
  return {
    schema_version: 1,
    session_id: id,
    folder: "proj",
    branch: "main",
    model: "claude",
    start_time: T1,
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

function display(r: SessionRow, ended = false): DisplayRow {
  return { id: r.session_id, row: r, ended };
}

function conflict(...ids: string[]): Conflict {
  return {
    realpath: `/tmp/${ids.join("-")}`,
    sessions: ids.map((id) => ({ session_id: id, folder: "proj", branch: "main", lastTouch: 0 })),
    lastActive: 0,
  };
}

function build(
  rows: SessionRow[],
  o: { order?: ReadonlyMap<string, number>; conflicts?: Conflict[]; ended?: string[] } = {},
) {
  const order = o.order ?? stableOrder(new Map(), rows);
  return buildAgents({
    display: rows.map((r) => display(r, o.ended?.includes(r.session_id) ?? false)),
    conflicts: o.conflicts ?? [],
    branches: new Map(),
    order,
    now: NOW,
  });
}

describe("stableOrder (D-05, Pitfall 2)", () => {
  it("assigns seqs by start time ascending on an empty map", () => {
    const m = stableOrder(new Map(), [
      { session_id: "c", start_time: T3 },
      { session_id: "a", start_time: T1 },
      { session_id: "b", start_time: T2 },
    ]);
    expect([...m.entries()].sort((x, y) => x[1] - y[1])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("breaks start-time ties by session_id", () => {
    const m = stableOrder(new Map(), [
      { session_id: "z", start_time: T1 },
      { session_id: "m", start_time: T1 },
    ]);
    expect(m.get("m")).toBe(0);
    expect(m.get("z")).toBe(1);
  });

  it("treats an invalid start_time as 0 (first) and never throws", () => {
    const m = stableOrder(new Map(), [
      { session_id: "a", start_time: T1 },
      { session_id: "bad", start_time: "not a date" },
    ]);
    expect(m.get("bad")).toBe(0);
    expect(m.get("a")).toBe(1);
  });

  it("keeps existing seqs, appends unseen ids after the max, drops vanished ids", () => {
    const prev = new Map([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    const m = stableOrder(prev, [
      { session_id: "c", start_time: T3 },
      { session_id: "a", start_time: T1 },
      { session_id: "new2", start_time: T2 },
      { session_id: "new1", start_time: T1 },
    ]);
    expect(m.get("a")).toBe(0);
    expect(m.get("c")).toBe(2);
    expect(m.has("b")).toBe(false);
    expect(m.get("new1")).toBe(3);
    expect(m.get("new2")).toBe(4);
  });

  it("a compact (start_time rewritten to now) keeps the seq", () => {
    const rows = [
      { session_id: "a", start_time: T1 },
      { session_id: "b", start_time: T2 },
      { session_id: "c", start_time: T3 },
    ];
    const prev = stableOrder(new Map(), rows);
    const next = stableOrder(prev, [{ session_id: "a", start_time: iso(NOW) }, rows[1]!, rows[2]!]);
    expect(next.get("a")).toBe(0);
    expect(next.get("b")).toBe(1);
    expect(next.get("c")).toBe(2);
  });
});

describe("cardState (D-08)", () => {
  it("maps the pre-gated booleans to a card state, or null for a strip", () => {
    expect(cardState(row("x", { asking: true, attention: true }))).toBe("asking");
    expect(cardState(row("x", { attention: true }))).toBe("waiting");
    expect(cardState(row("x", { running: true }))).toBe("running");
    expect(cardState(row("x", { subagent: true }))).toBe("subagent");
    expect(cardState(row("x"))).toBeNull();
  });
});

describe("buildAgents (LAYOUT-07, D-05, D-07, D-08)", () => {
  it("splits cards and strips, both in seq order, and excludes ended rows", () => {
    const rows = [
      row("s3", { start_time: T3, running: true }),
      row("s1", { start_time: T1 }),
      row("s2", { start_time: T2, asking: true }),
      row("s0", { start_time: iso(NOW - 4 * 3600_000), running: true }),
      row("gone", { start_time: T1, running: true }),
    ];
    const b = build(rows, { ended: ["gone"] });
    expect(b.agents.map((a) => a.id)).toEqual(["s0", "s2", "s3"]);
    expect(b.idle.map((s) => s.id)).toEqual(["s1"]);
    expect(b.byId.has("gone")).toBe(false);
    expect(b.byId.get("s2")?.session_id).toBe("s2");
  });

  it("re-sorted input keeps the same card order", () => {
    const rows = [
      row("a", { start_time: T1, running: true }),
      row("b", { start_time: T2, running: true }),
      row("c", { start_time: T3, running: true }),
    ];
    const order = stableOrder(new Map(), rows);
    const first = build(rows, { order }).agents.map((a) => a.id);
    const reversed = [...rows].reverse();
    const second = build(reversed, { order: stableOrder(order, reversed) }).agents.map((a) => a.id);
    expect(first).toEqual(["a", "b", "c"]);
    expect(second).toEqual(first);
  });

  it("a compact (start_time rewritten) does not move the card", () => {
    const rows = [
      row("a", { start_time: T1, running: true }),
      row("b", { start_time: T2, running: true }),
      row("c", { start_time: T3, running: true }),
    ];
    const order = stableOrder(new Map(), rows);
    const compacted = [row("a", { start_time: iso(NOW), running: true }), rows[1]!, rows[2]!];
    const b = build(compacted, { order: stableOrder(order, compacted) });
    expect(b.agents.map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  it("ids missing from the order sort after the known ids by start time", () => {
    const rows = [
      row("late2", { start_time: T2, running: true }),
      row("late1", { start_time: T1, running: true }),
      row("known", { start_time: T3, running: true }),
    ];
    const b = build(rows, { order: new Map([["known", 0]]) });
    expect(b.agents.map((a) => a.id)).toEqual(["known", "late1", "late2"]);
  });

  it("fills the card fields from the row", () => {
    const r = row("s1", {
      title: "checkout screen",
      folder: "shop",
      branch: "main",
      cwd: "/w/shop",
      start_time: iso(NOW - 6 * 60_000),
      transcript_model: "claude-opus-4-7",
      model: "claude-sonnet-4-5",
      last_prompt: "move the coupon field",
      running: true,
      files: [{}, {}] as SessionRow["files"],
      reads: [{}] as SessionRow["reads"],
    });
    const b = buildAgents({
      display: [display(r), display(row("s2", { running: true }))],
      conflicts: [conflict("s1", "s2"), conflict("s1", "s3"), conflict("s2", "s3")],
      branches: new Map([["/w/shop", "feat/coupon"]]),
      order: new Map([
        ["s1", 0],
        ["s2", 1],
      ]),
      now: NOW,
    });
    expect(b.agents[0]).toEqual({
      id: "s1",
      name: "checkout screen",
      dir: "shop",
      branch: "feat/coupon",
      uptime: "6m",
      model: "opus 4.7",
      prompt: "move the coupon field",
      state: "running",
      waitFor: null,
      subagents: 0,
      conflicts: 2,
      writes: 2,
      reads: 1,
      inConflict: true,
    });
    expect(b.agents[1]?.conflicts).toBe(2);
  });

  it("uses the folder name without a title, the session.json model as fallback and null without a prompt", () => {
    const b = build([row("s1", { folder: "api", model: "claude-sonnet-4-5", running: true })]);
    const c = b.agents[0]!;
    expect(c.name).toBe("api");
    expect(c.model).toBe("sonnet 4.5");
    expect(c.prompt).toBeNull();
    expect(c.conflicts).toBe(0);
    expect(c.inConflict).toBe(false);
  });

  it("waitFor only for a waiting card with a valid attention_ts", () => {
    const b = build([
      row("w", { attention: true, attention_ts: iso(NOW - 4 * 60_000) }),
      row("w-bad", { attention: true, attention_ts: "nope" }),
      row("a", { asking: true, attention: true, attention_ts: iso(NOW - 4 * 60_000) }),
    ]);
    const by = new Map(b.agents.map((c) => [c.id, c]));
    expect(by.get("w")?.waitFor).toBe("4m");
    expect(by.get("w-bad")?.waitFor).toBeNull();
    expect(by.get("a")?.state).toBe("asking");
    expect(by.get("a")?.waitFor).toBeNull();
  });

  it("subagents comes from subagent_count", () => {
    const b = build([row("s", { subagent: true, subagent_count: 3 }), row("t", { subagent: true })]);
    expect(b.agents.map((c) => c.subagents)).toEqual([3, 0]);
  });

  it("an invalid start_time gives a dash uptime and never throws", () => {
    const b = build([row("s", { start_time: "garbage", running: true })]);
    expect(b.agents[0]?.uptime).toBe("—");
  });

  it("strips carry the label and the age of last_seen, then last_active, then start_time", () => {
    const b = build([
      row("seen", { title: "docs", last_seen: iso(NOW - 5 * 60_000), last_active: iso(NOW - 9 * 60_000) }),
      row("act", { folder: "web", last_active: iso(NOW - 9 * 60_000) }),
      row("start", { folder: "cli", start_time: iso(NOW - 2 * 3600_000) }),
    ]);
    const by = new Map(b.idle.map((s) => [s.id, s]));
    expect(by.get("seen")).toEqual({ id: "seen", name: "docs", ago: "5m" });
    expect(by.get("act")).toEqual({ id: "act", name: "web", ago: "9m" });
    expect(by.get("start")).toEqual({ id: "start", name: "cli", ago: "2h" });
  });

  it("a session moving between card and strip keeps its id", () => {
    const order = new Map([["s", 0]]);
    const asCard = build([row("s", { running: true })], { order });
    const asStrip = build([row("s")], { order });
    expect(asCard.agents.map((a) => a.id)).toEqual(["s"]);
    expect(asStrip.idle.map((a) => a.id)).toEqual(["s"]);
  });

  it("keeps strings raw (the draw sanitizes)", () => {
    const b = build([row("s", { last_prompt: "a\u001b[31mb", running: true })]);
    expect(b.agents[0]?.prompt).toBe("a\u001b[31mb");
  });

  it("never throws on odd input (missing files / reads arrays)", () => {
    const odd = row("s", { running: true });
    delete (odd as Partial<SessionRow>).files;
    delete (odd as Partial<SessionRow>).reads;
    const b = build([odd]);
    expect(b.agents[0]?.writes).toBe(0);
    expect(b.agents[0]?.reads).toBe(0);
  });
});
