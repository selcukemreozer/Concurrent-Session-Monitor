import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectConflicts, resolveRealpath } from "./conflicts.js";
import type { SessionRow } from "./aggregate.js";

/**
 * Realpath-anchored temp root. Anchoring on `fs.realpathSync(fs.mkdtempSync(...))`
 * is mandatory so the macOS `/var` -> `/private/var` fold is already applied before
 * any fixture path is built (RESEARCH Pitfall 1) — otherwise a symlink fixture's
 * resolved realpath would never string-equal the raw `/var/folders/...` mkdtemp path.
 */
let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "csm-conf-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A minimal-but-complete SessionRow builder (mirrors App.test.tsx makeRow) so every
 * fixture carries the full liveness surface (`alive`/`readyToPrune`/`dotState`) the
 * reducer's D-12 filter reads. Overrides win.
 */
function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    schema_version: 1,
    session_id: "sess-0001",
    folder: "proj",
    branch: "main",
    model: "claude",
    start_time: new Date().toISOString(),
    files: [],
    alive: true,
    readyToPrune: false,
    dotState: "active",
    ...overrides,
  } as SessionRow;
}

describe("resolveRealpath (D-04 never-throw + lexical fallback)", () => {
  it("passes an absolute non-existent path through as its lexical anchor (never throws)", () => {
    const abs = "/abs/does-not-exist.ts";
    expect(resolveRealpath(abs, "/some/cwd")).toBe(abs);
  });

  it("anchors a relative path on cwd and folds symlinks to the target's realpath", () => {
    fs.writeFileSync(path.join(root, "real.ts"), "");
    const link = path.join(root, "alias.ts");
    fs.symlinkSync(path.join(root, "real.ts"), link);
    // a symlink and its target resolve to the identical realpath
    expect(resolveRealpath("alias.ts", root)).toBe(resolveRealpath("real.ts", root));
    expect(resolveRealpath("real.ts", root)).toBe(path.join(root, "real.ts"));
  });
});

describe("detectConflicts (CONF-01 SC-1..SC-4)", () => {
  it("SC-1: two sessions on the same file (via a symlink) DO conflict, naming both (D-01/D-09)", () => {
    fs.writeFileSync(path.join(root, "real.ts"), "");
    const link = path.join(root, "alias.ts");
    fs.symlinkSync(path.join(root, "real.ts"), link); // both resolve to real.ts
    const now = Date.now();
    const rows = [
      makeRow({
        session_id: "a",
        folder: "projA",
        cwd: root,
        files: [{ file_path: path.join(root, "real.ts"), ts: new Date(now).toISOString() }],
      }),
      makeRow({
        session_id: "b",
        folder: "projB",
        cwd: root,
        files: [{ file_path: link, ts: new Date(now).toISOString() }],
      }),
    ];
    const c = detectConflicts(rows, now);
    expect(c).toHaveLength(1);
    expect(c[0].sessions.map((s) => s.session_id).sort()).toEqual(["a", "b"]);
    // the grouped entry keys on the resolved realpath, never the aliasing filename
    expect(c[0].realpath).toBe(path.join(root, "real.ts"));
  });

  it("SC-2: same filename in two worktrees does NOT conflict (realpath differs, never basename)", () => {
    const wtA = path.join(root, "wtA");
    const wtB = path.join(root, "wtB");
    fs.mkdirSync(wtA);
    fs.mkdirSync(wtB);
    fs.writeFileSync(path.join(wtA, "x.ts"), "");
    fs.writeFileSync(path.join(wtB, "x.ts"), "");
    const now = Date.now();
    const rows = [
      makeRow({
        session_id: "a",
        cwd: wtA,
        files: [{ file_path: path.join(wtA, "x.ts"), ts: new Date(now).toISOString() }],
      }),
      makeRow({
        session_id: "b",
        cwd: wtB,
        files: [{ file_path: path.join(wtB, "x.ts"), ts: new Date(now).toISOString() }],
      }),
    ];
    expect(detectConflicts(rows, now)).toHaveLength(0);
  });

  it("SC-3: a dead/stale session never enters a conflict (D-12 live-only, BEFORE pairing)", () => {
    const now = Date.now();
    const f = { file_path: "/abs/shared.ts", ts: new Date(now).toISOString() }; // absolute -> no real FS dep
    const rows = [
      makeRow({ session_id: "live", files: [f], alive: true, readyToPrune: false }),
      makeRow({ session_id: "dead", files: [f], alive: false, readyToPrune: true }),
    ];
    expect(detectConflicts(rows, now)).toHaveLength(0); // only one LIVE session on the file
  });

  it("SC-4: conflict clears the tick a file drops out of a session's window (D-13 re-derivation)", () => {
    const now = Date.now();
    const f = { file_path: "/abs/shared.ts", ts: new Date(now).toISOString() };
    const both = [makeRow({ session_id: "a", files: [f] }), makeRow({ session_id: "b", files: [f] })];
    expect(detectConflicts(both, now)).toHaveLength(1);
    const cleared = [makeRow({ session_id: "a", files: [f] }), makeRow({ session_id: "b", files: [] })];
    expect(detectConflicts(cleared, now)).toHaveLength(0);
  });

  it("de-dupe (Pitfall 2): one session touching a path AND a symlink to it does NOT self-conflict", () => {
    fs.writeFileSync(path.join(root, "real.ts"), "");
    const link = path.join(root, "alias.ts");
    fs.symlinkSync(path.join(root, "real.ts"), link);
    const now = Date.now();
    // a SINGLE session touches both the file and its alias -> one realpath, one session
    const rows = [
      makeRow({
        session_id: "solo",
        cwd: root,
        files: [
          { file_path: path.join(root, "real.ts"), ts: new Date(now).toISOString() },
          { file_path: link, ts: new Date(now).toISOString() },
        ],
      }),
    ];
    expect(detectConflicts(rows, now)).toHaveLength(0); // >=2 requires DISTINCT session_ids
  });
});
