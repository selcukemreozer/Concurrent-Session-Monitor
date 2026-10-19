import { describe, it, expect } from "vitest";
import type { Key } from "ink";
import {
  KEYMAP,
  FOOTER_HINTS,
  contextOf,
  hintsFor,
  resolve,
  type HintContext,
  type KeyInput,
} from "./keymap.js";
import { initialUi, type UiState } from "./uiState.js";

// Phase 9 plan 09-04 Task 3: one table drives key routing and the footer
// (D-13..D-19, D-24; T-09-08b, T-09-11a).
const at = (over: Partial<UiState>): UiState => ({ ...initialUi, ...over });

/** A representative UiState for each hint context. */
const CTX: Record<HintContext, UiState> = {
  agents: at({}),
  agentsSelected: at({ selectedAgentId: "a1" }),
  phases: at({ focus: "right", rightTab: "phases" }),
  sessions: at({ focus: "right", rightTab: "sessions" }),
  ports: at({ focus: "ports" }),
  menu: at({ focus: "ports", mode: "menu" }),
  confirm: at({ focus: "ports", mode: "confirm" }),
  confirmKill: at({ focus: "ports", mode: "confirmKill" }),
  edit: at({ focus: "ports", mode: "edit" }),
};
const ALL = Object.keys(CTX) as HintContext[];
const NORMAL: HintContext[] = ["agents", "agentsSelected", "phases", "sessions", "ports"];
const OVERLAYS: HintContext[] = ["menu", "confirm", "confirmKill"];

const footer = (ui: UiState): string =>
  hintsFor(ui)
    .map((h) => `${h.key} ${h.label}`)
    .join(" · ");

const TAB: KeyInput = { tab: true };
const STAB: KeyInput = { tab: true, shift: true };
const ESC: KeyInput = { escape: true };
const ENTER: KeyInput = { return: true };

describe("KeyInput", () => {
  it("accepts Ink's Key structurally", () => {
    const k = { tab: true } as Key;
    const ki: KeyInput = k;
    expect(resolve("", ki, CTX.agents)).toEqual({ t: "focusNext" });
  });
});

describe("contextOf", () => {
  it.each(ALL)("maps the %s state to its context", (c) => {
    expect(contextOf(CTX[c])).toBe(c);
  });

  it("overlay modes win over focus and selection", () => {
    expect(contextOf(at({ selectedAgentId: "x", mode: "menu" }))).toBe("menu");
    expect(contextOf(at({ focus: "right", mode: "edit" }))).toBe("edit");
  });
});

describe("footer strings (UI-SPEC footer table)", () => {
  it.each<[string, UiState, string]>([
    [
      "agents, phases tab, not paused",
      CTX.agents,
      "tab focus · ←↑↓→ select agent · space pause files · r sessions · q quit",
    ],
    [
      "agents, sessions tab, paused",
      at({ rightTab: "sessions", filesPaused: true }),
      "tab focus · ←↑↓→ select agent · space resume files · r phases · q quit",
    ],
    ["agentsSelected", CTX.agentsSelected, "⏎ go to pane · ←↑↓→ move · esc clear · tab focus · q quit"],
    ["phases", CTX.phases, "↑↓ browse phases · ←→ project · r sessions · esc agents · tab focus · q quit"],
    [
      "sessions",
      CTX.sessions,
      "↑↓ select session · ⏎ copy resume · o new window · r phases · esc agents · q quit",
    ],
    ["ports", CTX.ports, "↑↓ browse ports · ⏎ actions · esc agents · tab focus · q quit"],
    ["menu", CTX.menu, "←→ choose · ⏎ select · esc close"],
    ["confirm", CTX.confirm, "y stop · n / esc cancel"],
    ["confirmKill", CTX.confirmKill, "y force stop · n / esc cancel"],
    ["edit", CTX.edit, "⏎ save · esc cancel"],
  ])("%s", (_name, ui, expected) => {
    expect(footer(ui)).toBe(expected);
  });
});

describe("hint integrity", () => {
  it.each(ALL)("every %s hint names a binding active in that context", (c) => {
    const hints = FOOTER_HINTS[c];
    expect(hints.length).toBeGreaterThan(0);
    for (const h of hints) {
      const row = KEYMAP.find((b) => b.id === h.binding);
      expect(row, `${c}: ${h.binding}`).toBeDefined();
      expect(row!.contexts, `${c}: ${h.binding}`).toContain(c);
    }
  });

  it("binding ids are unique", () => {
    const ids = KEYMAP.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Tab", () => {
  it.each(ALL.filter((c) => c !== "edit"))("Tab / Shift+Tab cycle focus in %s", (c) => {
    expect(resolve("", TAB, CTX[c])).toEqual({ t: "focusNext" });
    expect(resolve("", STAB, CTX[c])).toEqual({ t: "focusPrev" });
  });

  it("Tab is text in the name field (edit → null)", () => {
    expect(resolve("", TAB, CTX.edit)).toBeNull();
    expect(resolve("", STAB, CTX.edit)).toBeNull();
  });
});

describe("q", () => {
  it.each(NORMAL)("quits in %s", (c) => {
    expect(resolve("q", {}, CTX[c])).toEqual({ t: "quit" });
  });

  it.each(OVERLAYS)("closes the overlay in %s", (c) => {
    expect(resolve("q", {}, CTX[c])).toEqual({ t: "closeOverlay" });
  });

  it("is text in the name field (edit → null)", () => {
    expect(resolve("q", {}, CTX.edit)).toBeNull();
  });

  it.each(ALL)("does nothing with ctrl or meta held in %s", (c) => {
    expect(resolve("q", { ctrl: true }, CTX[c])).toBeNull();
    expect(resolve("q", { meta: true }, CTX[c])).toBeNull();
  });
});

describe("Esc precedence", () => {
  it.each(OVERLAYS)("closes the overlay in %s", (c) => {
    expect(resolve("", ESC, CTX[c])).toEqual({ t: "closeOverlay" });
  });

  it("cancels the name field (Phase 12 noop)", () => {
    expect(resolve("", ESC, CTX.edit)).toEqual({ t: "noop", binding: "editCancel" });
  });

  it("clears the selection in AGENTS", () => {
    expect(resolve("", ESC, CTX.agentsSelected)).toEqual({ t: "clearSelection" });
  });

  it.each<HintContext>(["phases", "sessions", "ports"])("returns focus to AGENTS from %s", (c) => {
    expect(resolve("", ESC, CTX[c])).toEqual({ t: "focusAgents" });
  });

  it("does nothing in AGENTS with no selection", () => {
    expect(resolve("", ESC, CTX.agents)).toBeNull();
  });
});

describe("r and space", () => {
  it.each(NORMAL)("r toggles the right tab and space toggles FILES in %s", (c) => {
    expect(resolve("r", {}, CTX[c])).toEqual({ t: "toggleRight" });
    expect(resolve(" ", {}, CTX[c])).toEqual({ t: "toggleFiles" });
  });

  it.each<HintContext>([...OVERLAYS, "edit"])("r is unbound in %s", (c) => {
    expect(resolve("r", {}, CTX[c])).toBeNull();
  });
});

describe("declined keys are unbound (D-13, D-14, D-19)", () => {
  const keys = [..."0123456789", "j", "k", "?", "z", "[", "]"];
  it.each(ALL)("no digit, j, k, ?, z, [ or ] resolves in %s", (c) => {
    for (const k of keys) expect(resolve(k, {}, CTX[c]), `${c}: ${k}`).toBeNull();
  });
});

describe("Phase 10–12 rows are noops in Phase 9 (T-09-11a)", () => {
  const noop = (binding: string) => ({ t: "noop", binding });

  it("arrows in AGENTS select / move", () => {
    for (const k of ["upArrow", "downArrow", "leftArrow", "rightArrow"] as const) {
      expect(resolve("", { [k]: true }, CTX.agents)).toEqual(noop("agentsSelect"));
      expect(resolve("", { [k]: true }, CTX.agentsSelected)).toEqual(noop("agentsMove"));
    }
    expect(resolve("", ENTER, CTX.agentsSelected)).toEqual(noop("agentsGoto"));
  });

  it("phases browse / project", () => {
    expect(resolve("", { upArrow: true }, CTX.phases)).toEqual(noop("phasesBrowse"));
    expect(resolve("", { downArrow: true }, CTX.phases)).toEqual(noop("phasesBrowse"));
    expect(resolve("", { leftArrow: true }, CTX.phases)).toEqual(noop("phasesProject"));
    expect(resolve("", { rightArrow: true }, CTX.phases)).toEqual(noop("phasesProject"));
  });

  it("sessions browse / Enter / o", () => {
    expect(resolve("", { downArrow: true }, CTX.sessions)).toEqual(noop("sessionsBrowse"));
    expect(resolve("", ENTER, CTX.sessions)).toEqual(noop("sessionsCopy"));
    expect(resolve("o", {}, CTX.sessions)).toEqual(noop("sessionsOpen"));
  });

  it("ports browse / Enter", () => {
    expect(resolve("", { upArrow: true }, CTX.ports)).toEqual(noop("portsBrowse"));
    expect(resolve("", ENTER, CTX.ports)).toEqual(noop("portsActions"));
  });

  it("menu ←/→ and Enter", () => {
    expect(resolve("", { leftArrow: true }, CTX.menu)).toEqual(noop("menuCycle"));
    expect(resolve("", { rightArrow: true }, CTX.menu)).toEqual(noop("menuCycle"));
    expect(resolve("", ENTER, CTX.menu)).toEqual(noop("menuSelect"));
  });

  it("confirm y / Enter / n and SIGKILL y / n", () => {
    expect(resolve("y", {}, CTX.confirm)).toEqual(noop("confirmYes"));
    expect(resolve("", ENTER, CTX.confirm)).toEqual(noop("confirmYes"));
    expect(resolve("n", {}, CTX.confirm)).toEqual(noop("confirmNo"));
    expect(resolve("y", {}, CTX.confirmKill)).toEqual(noop("sigkillYes"));
    expect(resolve("n", {}, CTX.confirmKill)).toEqual(noop("confirmNo"));
  });

  it("edit Enter saves", () => {
    expect(resolve("", ENTER, CTX.edit)).toEqual(noop("editSave"));
  });

  it("every non-P9 row resolves to a noop carrying its own id", () => {
    for (const b of KEYMAP.filter((r) => r.built !== 9 && r.id !== "clearSelection")) {
      expect(b.action(initialUi), b.id).toEqual(noop(b.id));
    }
  });
});

describe("Ctrl+C", () => {
  it("is not a KEYMAP row (Ink exitOnCtrlC consumes it)", () => {
    for (const c of ALL) expect(resolve("c", { ctrl: true }, CTX[c])).toBeNull();
  });
});
