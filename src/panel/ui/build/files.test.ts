import { describe, it, expect } from "vitest";
import type { SessionRow } from "../../../aggregate.js";
import type { DisplayRow } from "../../hooks/useRoster.js";
import type { Conflict } from "../../../conflicts.js";
import { stableOrder } from "./agents.js";
import { buildFiles, displayPath } from "./files.js";

// Phase 10 plan 10-12 Task 1: the pure live FILES builder (LAYOUT-03, LAYOUT-07,
// RESEARCH open question 3).

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

const f = (file_path: string) => ({ file_path, ts: T3 });

function conflict(path: string, ...sessions: Array<[string, string]>): Conflict {
  return {
    realpath: path,
    sessions: sessions.map(([session_id, title]) => ({
      session_id,
      folder: "proj",
      branch: "main",
      lastTouch: 0,
      title,
    })),
    lastActive: 0,
  };
}

function build(
  rows: SessionRow[],
  o: {
    order?: ReadonlyMap<string, number>;
    conflicts?: Conflict[];
    ended?: string[];
    selectedId?: string | null;
  } = {},
) {
  const display: DisplayRow[] = rows.map((r) => ({
    id: r.session_id,
    row: r,
    ended: o.ended?.includes(r.session_id) ?? false,
  }));
  return buildFiles({
    display,
    conflicts: o.conflicts ?? [],
    order: o.order ?? stableOrder(new Map(), rows),
    selectedId: o.selectedId ?? null,
  });
}

describe("displayPath", () => {
  it("is relative under the session's own cwd", () => {
    expect(displayPath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
  });
  it("keeps a path outside the cwd absolute", () => {
    expect(displayPath("/other/x.ts", "/repo")).toBe("/other/x.ts");
  });
  it("needs the prefix to end at a path separator", () => {
    expect(displayPath("/repo2/x.ts", "/repo")).toBe("/repo2/x.ts");
  });
  it("accepts a cwd with a trailing slash", () => {
    expect(displayPath("/repo/src/a.ts", "/repo/")).toBe("src/a.ts");
  });
  it("returns the raw path without a cwd", () => {
    expect(displayPath("/repo/src/a.ts", undefined)).toBe("/repo/src/a.ts");
    expect(displayPath("/repo/src/a.ts", "")).toBe("/repo/src/a.ts");
  });
  it("keeps the raw path when it equals the cwd", () => {
    expect(displayPath("/repo", "/repo")).toBe("/repo");
  });
});

describe("buildFiles conflicts (LAYOUT-03, open question 3)", () => {
  const s1 = row("s1", { title: "dashboard research" });
  const s2 = row("s2", { title: "checkout screen" });
  const s3 = row("s3", { title: "third" });
  const s4 = row("s4", { title: "fourth" });

  it("maps a 2-session conflict with no `more` field", () => {
    const b = build([s1, s2], {
      conflicts: [conflict("/repo/src/server.js", ["s1", "dashboard research"], ["s2", "checkout screen"])],
    });
    expect(b.conflicts).toEqual([{ a: "dashboard research", b: "checkout screen", path: "/repo/src/server.js" }]);
    expect("more" in b.conflicts[0]!).toBe(false);
  });

  it("names the first two sessions and counts the rest as `more`", () => {
    const b = build([s1, s2, s3, s4], {
      conflicts: [
        conflict(
          "/repo/src/server.js",
          ["s1", "dashboard research"],
          ["s2", "checkout screen"],
          ["s3", "third"],
          ["s4", "fourth"],
        ),
      ],
    });
    expect(b.conflicts).toEqual([
      { a: "dashboard research", b: "checkout screen", more: 2, path: "/repo/src/server.js" },
    ]);
  });

  it("falls back to the folder when a conflict session has no title", () => {
    const c: Conflict = {
      realpath: "/repo/x",
      sessions: [
        { session_id: "s1", folder: "alpha", branch: "main", lastTouch: 0 },
        { session_id: "s2", folder: "beta", branch: "main", lastTouch: 0 },
      ],
      lastActive: 0,
    };
    expect(build([s1, s2], { conflicts: [c] }).conflicts[0]).toEqual({ a: "alpha", b: "beta", path: "/repo/x" });
  });

  it("keeps the roster's conflict order", () => {
    const b = build([s1, s2], {
      conflicts: [conflict("/z", ["s2", "B"], ["s1", "A"]), conflict("/a", ["s1", "A"], ["s2", "B"])],
    });
    expect(b.conflicts.map((c) => [c.path, c.a, c.b])).toEqual([
      ["/z", "B", "A"],
      ["/a", "A", "B"],
    ]);
  });
});

describe("buildFiles groups", () => {
  it("lists writes first then reads, with paths relative to the session cwd", () => {
    const r = row("s1", {
      title: "one",
      cwd: "/repo",
      running: true,
      files: [f("/repo/src/w1.ts"), f("/repo/src/w2.ts")],
      reads: [f("/repo/src/r1.ts"), f("/elsewhere/r2.ts")],
    });
    const b = build([r]);
    expect(b.groups).toEqual([
      {
        agentId: "s1",
        name: "one",
        state: "running",
        files: [
          { path: "src/w1.ts", kind: "write" },
          { path: "src/w2.ts", kind: "write" },
          { path: "src/r1.ts", kind: "read" },
          { path: "/elsewhere/r2.ts", kind: "read" },
        ],
      },
    ]);
  });

  it("follows the stable order map, ids missing from it last", () => {
    const a = row("a", { start_time: T1, files: [f("/a")] });
    const bb = row("b", { start_time: T2, files: [f("/b")] });
    const c = row("c", { start_time: T3, files: [f("/c")] });
    const order = new Map([
      ["c", 0],
      ["a", 1],
    ]);
    expect(build([a, bb, c], { order }).groups.map((g) => g.agentId)).toEqual(["c", "a", "b"]);
  });

  it("omits a session with no files and excludes ended rows", () => {
    const a = row("a", { files: [f("/a")] });
    const empty = row("e");
    const gone = row("g", { files: [f("/g")] });
    expect(build([a, empty, gone], { ended: ["g"] }).groups.map((g) => g.agentId)).toEqual(["a"]);
  });

  it("uses the card state, or idle", () => {
    const a = row("a", { asking: true, files: [f("/a")] });
    const i = row("i", { reads: [f("/i")] });
    const st = build([a, i]).groups.map((g) => g.state);
    expect(st).toEqual(["asking", "idle"]);
  });

  it("tolerates missing files / reads arrays", () => {
    const r = row("a", { files: undefined as unknown as [], reads: undefined as unknown as [] });
    expect(build([r]).groups).toEqual([]);
  });
});

describe("buildFiles narrowing (LAYOUT-07)", () => {
  const s1 = row("s1", { title: "one", files: [f("/one")] });
  const s2 = row("s2", { title: "two", files: [f("/two")] });
  const s3 = row("s3", { title: "three", files: [f("/three")] });
  const conflicts = [
    conflict("/x", ["s1", "one"], ["s3", "three"]),
    conflict("/y", ["s2", "two"], ["s1", "one"]),
  ];

  it("narrows to the selected live session's group and conflicts", () => {
    const b = build([s1, s2, s3], { conflicts, selectedId: "s2" });
    expect(b.narrowed).toBe(true);
    expect(b.groups.map((g) => g.agentId)).toEqual(["s2"]);
    expect(b.conflicts.map((c) => c.path)).toEqual(["/y"]);
  });

  it("shows everything with no selection", () => {
    const b = build([s1, s2, s3], { conflicts, selectedId: null });
    expect(b.narrowed).toBe(false);
    expect(b.groups).toHaveLength(3);
    expect(b.conflicts).toHaveLength(2);
  });

  it("shows everything for an unknown or ended selection", () => {
    expect(build([s1, s2, s3], { conflicts, selectedId: "nope" }).narrowed).toBe(false);
    const ended = build([s1, s2, s3], { conflicts, selectedId: "s3", ended: ["s3"] });
    expect(ended.narrowed).toBe(false);
    expect(ended.groups.map((g) => g.agentId)).toEqual(["s1", "s2"]);
  });

  it("narrows to a selected session with no files: empty groups, its conflicts only", () => {
    const quiet = row("q", { title: "quiet" });
    const b = build([s1, quiet], { conflicts, selectedId: "q" });
    expect(b.narrowed).toBe(true);
    expect(b.groups).toEqual([]);
    expect(b.conflicts).toEqual([]);
  });
});
