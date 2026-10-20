import { describe, it, expect } from "vitest";
import type { SessionRow } from "../../aggregate.js";
import type { DisplayRow, Reconciled } from "../hooks/useRoster.js";
import type { Conflict } from "../../conflicts.js";
import { headerFromRoster } from "./headerModel.js";
import { fmtClock24 } from "./draw/header.js";
import { updateLabel } from "../../update.js";

function row(id: string, flags: Partial<SessionRow> = {}): SessionRow {
  return {
    schema_version: 1,
    session_id: id,
    folder: "proj",
    branch: "main",
    model: "claude",
    start_time: new Date(0).toISOString(),
    files: [],
    alive: true,
    readyToPrune: false,
    dotState: "active",
    ...flags,
  } as SessionRow;
}

function display(id: string, ended: boolean, flags: Partial<SessionRow> = {}): DisplayRow {
  return { id, ended, row: row(id, flags) };
}

const NOW = Date.UTC(2026, 9, 20, 12, 34, 56);

function roster(conflicts = 2): Reconciled {
  return {
    display: [
      display("a", false),
      display("b", false, { asking: true, attention: true }),
      display("c", false, { attention: true }),
      display("d", true, { asking: true }),
    ],
    live: 3,
    idle: 0,
    conflicts: Array.from({ length: conflicts }, () => ({}) as Conflict),
  };
}

describe("headerFromRoster (D-20 live header)", () => {
  it("counts only non-ended rows; asking+waiting counts once under asking", () => {
    const h = headerFromRoster(roster(), null, NOW);
    expect(h).toEqual({
      agents: 3,
      asking: 1,
      waiting: 1,
      conflicts: 2,
      clock: fmtClock24(NOW),
      update: null,
    });
  });

  it("a grace-ghost with the attention flag never counts as waiting", () => {
    const r: Reconciled = {
      display: [display("x", true, { attention: true }), display("y", true)],
      live: 0,
      idle: 0,
      conflicts: [],
    };
    expect(headerFromRoster(r, null, NOW)).toMatchObject({ agents: 0, asking: 0, waiting: 0, conflicts: 0 });
  });

  it("an update version gives the updateLabel of that version", () => {
    const h = headerFromRoster(roster(), "1.7.1", NOW);
    expect(h.update).toBe(updateLabel("1.7.1"));
    expect(h.update).not.toBeNull();
  });

  it("an invalid update version gives null", () => {
    expect(headerFromRoster(roster(), "not a version", NOW).update).toBeNull();
    expect(headerFromRoster(roster(), "", NOW).update).toBeNull();
  });
});
