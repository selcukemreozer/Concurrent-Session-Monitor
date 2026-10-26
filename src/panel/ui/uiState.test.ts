import { describe, it, expect } from "vitest";
import {
  initialUi,
  FOCUS_ORDER,
  uiReducer,
  resolveSelected,
  SELECTION_IDLE_MS,
  FLASH_MS,
  flashVisible,
  selectionExpired,
  effectiveUi,
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
      phaseCursor: null,
      projectRoot: null,
      portCursor: null,
      flash: null,
      lastKeyAt: 0,
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

// Phase 10 plan 10-07 Task 1: identity-only cursors (D-23, KEYS-02), the
// footer flash slot (D-12), the idle drop (D-09) and fail-closed effectiveUi
// (KEYS-03, Pitfall 4). All clock-free: `now` is always passed in.
describe("Phase 10 identity cursors", () => {
  it("setProject sets projectRoot and clears phaseCursor", () => {
    const s = at({ phaseCursor: "10", projectRoot: "/a" });
    const n = uiReducer(s, { t: "setProject", root: "/b" });
    expect(n.projectRoot).toBe("/b");
    expect(n.phaseCursor).toBeNull();
  });

  it("setProject to the same root with no cursor returns the same object", () => {
    const s = at({ projectRoot: "/a", phaseCursor: null });
    expect(uiReducer(s, { t: "setProject", root: "/a" })).toBe(s);
  });

  it("setProject to the same root still clears a phase cursor", () => {
    const s = at({ projectRoot: "/a", phaseCursor: "3" });
    const n = uiReducer(s, { t: "setProject", root: "/a" });
    expect(n).not.toBe(s);
    expect(n.phaseCursor).toBeNull();
  });

  it("setPhaseCursor sets the phase number (an identity, not an index)", () => {
    const n = uiReducer(initialUi, { t: "setPhaseCursor", n: "04.2" });
    expect(n.phaseCursor).toBe("04.2");
    expect(uiReducer(n, { t: "setPhaseCursor", n: "04.2" })).toBe(n);
    expect(uiReducer(n, { t: "setPhaseCursor", n: null }).phaseCursor).toBeNull();
  });

  it("setPortCursor sets the portKey", () => {
    const n = uiReducer(initialUi, { t: "setPortCursor", key: "3000:123" });
    expect(n.portCursor).toBe("3000:123");
    expect(uiReducer(n, { t: "setPortCursor", key: "3000:123" })).toBe(n);
  });

  it("keyAt records the last key time", () => {
    const n = uiReducer(initialUi, { t: "keyAt", at: 1234 });
    expect(n.lastKeyAt).toBe(1234);
    expect(uiReducer(n, { t: "keyAt", at: 1234 })).toBe(n);
  });

  it("flash sets the flash and a new flash replaces the old one", () => {
    const a = uiReducer(initialUi, { t: "flash", text: "copied", ok: true, at: 100 });
    expect(a.flash).toEqual({ text: "copied", ok: true, at: 100 });
    const b = uiReducer(a, { t: "flash", text: "failed", ok: false, at: 200 });
    expect(b.flash).toEqual({ text: "failed", ok: false, at: 200 });
    expect(uiReducer(b, { t: "flash", text: "failed", ok: false, at: 200 })).toBe(b);
  });

  it("select with the current id returns the same object", () => {
    const s = at({ selectedAgentId: "x" });
    expect(uiReducer(s, { t: "select", id: "x" })).toBe(s);
    expect(uiReducer(initialUi, { t: "clearSelection" })).toBe(initialUi);
  });
});

describe("flashVisible (FLASH_MS = 2500, D-12)", () => {
  it("FLASH_MS is 2500", () => {
    expect(FLASH_MS).toBe(2500);
  });

  it("is null with no flash", () => {
    expect(flashVisible(initialUi, 0)).toBeNull();
  });

  it("shows {text, ok} for at <= now < at + 2500, else null", () => {
    const s = at({ flash: { text: "hi", ok: false, at: 1000 } });
    expect(flashVisible(s, 999)).toBeNull();
    expect(flashVisible(s, 1000)).toEqual({ text: "hi", ok: false });
    expect(flashVisible(s, 3499)).toEqual({ text: "hi", ok: false });
    expect(flashVisible(s, 3500)).toBeNull();
  });
});

describe("selectionExpired (SELECTION_IDLE_MS, D-09)", () => {
  it("is false with no selection", () => {
    expect(selectionExpired(at({ lastKeyAt: 0 }), 10 ** 9)).toBe(false);
  });

  it("is true iff now - lastKeyAt >= 15000 with a selection", () => {
    const s = at({ selectedAgentId: "a", lastKeyAt: 1000 });
    expect(selectionExpired(s, 15999)).toBe(false);
    expect(selectionExpired(s, 16000)).toBe(true);
  });
});

describe("effectiveUi (fails closed, Pitfall 4)", () => {
  const ids = new Set(["a"]);

  it("returns the same object with no selection", () => {
    expect(effectiveUi(initialUi, ids)).toBe(initialUi);
  });

  it("returns the same object when the selection resolves", () => {
    const s = at({ selectedAgentId: "a" });
    expect(effectiveUi(s, ids)).toBe(s);
  });

  it("drops a selection that no longer resolves (copy, input untouched)", () => {
    const s = at({ selectedAgentId: "b", focus: "agents" });
    const e = effectiveUi(s, ids);
    expect(e).not.toBe(s);
    expect(e).toEqual({ ...s, selectedAgentId: null });
    expect(s.selectedAgentId).toBe("b");
  });
});
