import { describe, it, expect } from "vitest";
import * as Card from "../Card.js";
import * as RowModels from "./rowModels.js";
import type { PortConfirm, PortGroup } from "./rowModels.js";
import type { PortConfirm as CardPortConfirm, PortGroup as CardPortGroup } from "../Card.js";

// Phase 9 plan 09-11 Task 2 (strangler S2): the pure legacy row models moved
// out of Card.tsx into ui/rowModels.ts. Card.tsx re-exports them, so every
// existing import keeps resolving to the very same value. The behaviour itself
// stays covered by the unchanged Card.test.tsx cases (port grouping,
// confirmPrompt, dotColor).

describe("legacy row models (moved from Card.tsx, D-23)", () => {
  it("Card.tsx re-exports every moved value by identity", () => {
    const names = [
      "dotColor",
      "groupPorts",
      "visiblePorts",
      "movePortCursor",
      "confirmPrompt",
      "PORTS_CAP",
      "WARP_HEADING",
      "OTHER_HEADING",
    ] as const;
    for (const n of names) {
      expect(RowModels[n], `rowModels.${n}`).toBeDefined();
      expect(Card[n], `Card.${n}`).toBe(RowModels[n]);
    }
  });

  it("keeps the exact 1.6.x heading strings and cap", () => {
    // Captured from Card.tsx before the move.
    expect(RowModels.WARP_HEADING).toBe("Warp'ta başlattın");
    expect(RowModels.OTHER_HEADING).toBe("Diğer");
    expect(RowModels.PORTS_CAP).toBe(12);
  });

  it("keeps the type re-exports interchangeable", () => {
    const g: PortGroup = { key: "k", heading: "h", ports: [] };
    const cg: CardPortGroup = g;
    const c: PortConfirm = { port: 3000, pid: 42, command: "node", signal: "SIGTERM" };
    const cc: CardPortConfirm = c;
    expect(cg).toBe(g);
    expect(RowModels.confirmPrompt(cc)).toBe("kill :3000 node (pid 42)? y/n");
  });

  it("keeps the pure helpers' contracts", () => {
    expect(RowModels.dotColor("active")).toBe("green");
    expect(RowModels.dotColor("idle")).toBe("yellow");
    expect(RowModels.dotColor("stale")).toBe("grey");
    expect(RowModels.movePortCursor(null, 1, 0)).toBeNull();
    expect(RowModels.movePortCursor(null, -1, 3)).toBe(0);
    expect(RowModels.movePortCursor(2, 1, 3)).toBe(2);
    expect(RowModels.groupPorts([], [])).toEqual([]);
    expect(RowModels.visiblePorts([])).toEqual([]);
  });
});
