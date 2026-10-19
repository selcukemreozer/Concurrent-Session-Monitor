import { describe, it, expect } from "vitest";
import {
  initialUi,
  FOCUS_ORDER,
  uiReducer,
  resolveSelected,
  SELECTION_IDLE_MS,
  type UiState,
  type Mode,
} from "./uiState.js";

// Phase 9 plan 09-04 Task 2: the pure UI reducer (D-13, D-15, D-24) and
// selection by id (RESEARCH Pitfall 7, T-09-07).
const at = (over: Partial<UiState>): UiState => ({ ...initialUi, ...over });

describe("initialUi / constants", () => {
  it("starts focused on AGENTS, PHASES tab, files live, normal, nothing selected", () => {
    expect(initialUi).toEqual({
      focus: "agents",
      rightTab: "phases",
      filesPaused: false,
      mode: "normal",
      selectedAgentId: null,
    });
  });

  it("FOCUS_ORDER is exactly agents → right → ports (FILES is never focusable)", () => {
    expect(FOCUS_ORDER).toEqual(["agents", "right", "ports"]);
    expect(FOCUS_ORDER).toHaveLength(3);
    expect(FOCUS_ORDER as readonly string[]).not.toContain("files");
  });

  it("SELECTION_IDLE_MS is 15000", () => {
    expect(SELECTION_IDLE_MS).toBe(15000);
  });
});

describe("focus cycle", () => {
  it("focusNext wraps agents → right → ports → agents", () => {
    let s = initialUi;
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      s = uiReducer(s, { t: "focusNext" });
      seen.push(s.focus);
    }
    expect(seen).toEqual(["right", "ports", "agents", "right"]);
  });

  it("focusPrev wraps agents → ports → right → agents", () => {
    let s = initialUi;
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      s = uiReducer(s, { t: "focusPrev" });
      seen.push(s.focus);
    }
    expect(seen).toEqual(["ports", "right", "agents"]);
  });

  it.each<Mode>(["menu", "confirm", "confirmKill", "edit"])(
    "Tab closes an open %s (mode → normal)",
    (mode) => {
      expect(uiReducer(at({ focus: "ports", mode }), { t: "focusNext" })).toMatchObject({
        focus: "agents",
        mode: "normal",
      });
      expect(uiReducer(at({ focus: "ports", mode }), { t: "focusPrev" })).toMatchObject({
        focus: "right",
        mode: "normal",
      });
    },
  );

  it("focusAgents returns focus to AGENTS", () => {
    expect(uiReducer(at({ focus: "ports" }), { t: "focusAgents" }).focus).toBe("agents");
  });
});

describe("pane actions", () => {
  it("toggleRight flips PHASES ⇄ SESSIONS in normal mode", () => {
    const a = uiReducer(initialUi, { t: "toggleRight" });
    expect(a.rightTab).toBe("sessions");
    expect(uiReducer(a, { t: "toggleRight" }).rightTab).toBe("phases");
  });

  it.each<Mode>(["menu", "confirm", "confirmKill", "edit"])(
    "toggleRight is a no-op (same object) in %s mode",
    (mode) => {
      const s = at({ mode });
      expect(uiReducer(s, { t: "toggleRight" })).toBe(s);
    },
  );

  it("toggleFiles flips filesPaused", () => {
    const a = uiReducer(initialUi, { t: "toggleFiles" });
    expect(a.filesPaused).toBe(true);
    expect(uiReducer(a, { t: "toggleFiles" }).filesPaused).toBe(false);
  });

  it("closeOverlay sets mode normal and keeps everything else", () => {
    const s = at({ focus: "ports", rightTab: "sessions", filesPaused: true, mode: "menu", selectedAgentId: "x" });
    expect(uiReducer(s, { t: "closeOverlay" })).toEqual({ ...s, mode: "normal" });
  });
});

describe("selection", () => {
  it("select sets and clearSelection clears selectedAgentId", () => {
    const a = uiReducer(initialUi, { t: "select", id: "abc" });
    expect(a.selectedAgentId).toBe("abc");
    expect(uiReducer(a, { t: "clearSelection" }).selectedAgentId).toBeNull();
  });

  it("quit and noop return the identical state object", () => {
    const s = at({ focus: "right" });
    expect(uiReducer(s, { t: "quit" })).toBe(s);
    expect(uiReducer(s, { t: "noop", binding: "portsActions" })).toBe(s);
  });
});

describe("resolveSelected (re-sort-then-act)", () => {
  const a = { id: "a", n: 1 };
  const b = { id: "b", n: 2 };
  const c = { id: "c", n: 3 };
  const ui = at({ selectedAgentId: "b" });

  it("finds the selected item by id", () => {
    expect(resolveSelected(ui, [a, b, c])).toBe(b);
  });

  it("still finds the same object after a re-sort", () => {
    expect(resolveSelected(ui, [c, b, a])).toBe(b);
  });

  it("returns null once the item is removed (fails closed)", () => {
    expect(resolveSelected(ui, [c, a])).toBeNull();
  });

  it("returns null with no selection", () => {
    expect(resolveSelected(initialUi, [a, b, c])).toBeNull();
  });
});
