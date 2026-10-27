import { describe, it, expect } from "vitest";
import type { Key } from "ink";
import {
  KEYMAP,
  FOOTER_HINTS,
  contextOf,
  hintsFor,
  resolve,
  BUILT_PHASE,
  isIntent,
  type Intent,
  type HintContext,
  type KeyInput,
} from "./keymap.js";
import { initialUi, type Action, type UiState } from "./uiState.js";

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

/** The full UI-SPEC hint set (every phase built, i.e. Phase 12). */
const footer = (ui: UiState): string =>
  hintsFor(ui, 12)
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

describe("footer strings (UI-SPEC footer table, every phase built)", () => {
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

describe("unbuilt hints are hidden (10-15, KEYS-03)", () => {
  const live = (ui: UiState): string =>
    hintsFor(ui)
      .map((h) => `${h.key} ${h.label}`)
      .join(" · ");

  it("BUILT_PHASE is 10", () => {
    expect(BUILT_PHASE).toBe(10);
  });

  it("the PORTS footer drops the Phase 11 `⏎ actions` hint", () => {
    expect(live(CTX.ports)).toBe("↑↓ browse ports · esc agents · tab focus · q quit");
    expect(hintsFor(CTX.ports).map((h) => h.label)).not.toContain("actions");
    expect(hintsFor(CTX.ports).map((h) => h.binding)).not.toContain("portsActions");
  });

  it("the built Phase 10 sets are unchanged (agentsSelected still leads with `⏎ go to pane`)", () => {
    expect(hintsFor(CTX.agentsSelected)[0]).toEqual({ binding: "agentsGoto", key: "⏎", label: "go to pane" });
    for (const c of ["agents", "agentsSelected", "phases", "sessions"] as const) {
      expect(live(CTX[c]), c).toBe(footer(CTX[c]));
    }
  });

  it("the Phase 11/12 overlays keep only their built keys", () => {
    expect(live(CTX.menu)).toBe("esc close");
    expect(hintsFor(CTX.confirm)).toEqual([]);
    expect(hintsFor(CTX.confirmKill)).toEqual([]);
    expect(hintsFor(CTX.edit)).toEqual([]);
  });

  it("raising the built phase restores the later hints", () => {
    expect(hintsFor(CTX.ports, 11).map((h) => h.binding)).toContain("portsActions");
    expect(hintsFor(CTX.edit, 11)).toEqual([]);
    expect(hintsFor(CTX.edit, 12).map((h) => h.binding)).toEqual(["editSave", "editCancel"]);
  });

  it.each(ALL)("every %s hint returned is active in its context and already built", (c) => {
    for (const h of hintsFor(CTX[c])) {
      const row = KEYMAP.find((b) => b.id === h.binding);
      expect(row, `${c}: ${h.binding}`).toBeDefined();
      expect(row!.contexts, `${c}: ${h.binding}`).toContain(c);
      expect(row!.built, `${c}: ${h.binding}`).toBeLessThanOrEqual(BUILT_PHASE);
    }
  });

  it("routing is unchanged: Enter in PORTS still resolves to the portsActions noop", () => {
    expect(resolve("", ENTER, CTX.ports)).toEqual({ t: "noop", binding: "portsActions" });
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
  it.each(ALL.filter((c) => c !== "edit" && c !== "confirm" && c !== "confirmKill"))(
    "IN-01 Tab / Shift+Tab cycle focus in %s (normal contexts and the menu)",
    (c) => {
      expect(resolve("", TAB, CTX[c])).toEqual({ t: "focusNext" });
      expect(resolve("", STAB, CTX[c])).toEqual({ t: "focusPrev" });
    },
  );

  it.each<HintContext>(["confirm", "confirmKill"])("IN-01 Tab cannot dismiss a %s overlay (→ null)", (c) => {
    expect(resolve("", TAB, CTX[c])).toBeNull();
    expect(resolve("", STAB, CTX[c])).toBeNull();
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
  it("IN-01 closes the menu", () => {
    expect(resolve("", ESC, CTX.menu)).toEqual({ t: "closeOverlay" });
  });

  it.each<HintContext>(["confirm", "confirmKill"])(
    "IN-01 resolves to confirmNo in %s (the `n / esc` hint's binding; a noop until Phase 11)",
    (c) => {
      expect(resolve("", ESC, CTX[c])).toEqual({ t: "noop", binding: "confirmNo" });
    },
  );

  it("IN-01 the confirmNo row comes before the close row", () => {
    const ids = KEYMAP.map((b) => b.id);
    expect(ids.indexOf("confirmNo")).toBeLessThan(ids.indexOf("close"));
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

describe("P10 rows emit intents, P11/P12 rows stay noops (10-07; T-09-11a)", () => {
  const noop = (binding: string) => ({ t: "noop", binding });
  const DIRS = [
    ["upArrow", "up"],
    ["downArrow", "down"],
    ["leftArrow", "left"],
    ["rightArrow", "right"],
  ] as const;

  it("arrows in AGENTS emit move intents (select and move)", () => {
    for (const [k, dir] of DIRS) {
      expect(resolve("", { [k]: true }, CTX.agents)).toEqual({ t: "move", dir });
      expect(resolve("", { [k]: true }, CTX.agentsSelected)).toEqual({ t: "move", dir });
    }
    expect(resolve("", ENTER, CTX.agentsSelected)).toEqual({ t: "goto" });
  });

  it("phases ↑/↓ move and ←/→ cycle the project", () => {
    expect(resolve("", { upArrow: true }, CTX.phases)).toEqual({ t: "move", dir: "up" });
    expect(resolve("", { downArrow: true }, CTX.phases)).toEqual({ t: "move", dir: "down" });
    expect(resolve("", { leftArrow: true }, CTX.phases)).toEqual({ t: "project", dir: -1 });
    expect(resolve("", { rightArrow: true }, CTX.phases)).toEqual({ t: "project", dir: 1 });
  });

  it("sessions browse / Enter copy / o open", () => {
    expect(resolve("", { downArrow: true }, CTX.sessions)).toEqual({ t: "move", dir: "down" });
    expect(resolve("", { upArrow: true }, CTX.sessions)).toEqual({ t: "move", dir: "up" });
    expect(resolve("", ENTER, CTX.sessions)).toEqual({ t: "copy" });
    expect(resolve("o", {}, CTX.sessions)).toEqual({ t: "open" });
  });

  it("ports browse moves; Enter stays the P11 noop", () => {
    expect(resolve("", { upArrow: true }, CTX.ports)).toEqual({ t: "move", dir: "up" });
    expect(resolve("", { downArrow: true }, CTX.ports)).toEqual({ t: "move", dir: "down" });
    expect(resolve("", ENTER, CTX.ports)).toEqual(noop("portsActions"));
  });

  it.each(NORMAL)("PgDn / PgUp page in %s (D-16)", (c) => {
    expect(resolve("", { pageDown: true }, CTX[c])).toEqual({ t: "page", dir: 1 });
    expect(resolve("", { pageUp: true }, CTX[c])).toEqual({ t: "page", dir: -1 });
  });

  it.each<HintContext>([...OVERLAYS, "edit"])("PgUp / PgDn are unbound in %s", (c) => {
    expect(resolve("", { pageDown: true }, CTX[c])).toBeNull();
    expect(resolve("", { pageUp: true }, CTX[c])).toBeNull();
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

  it("every P11/P12 row resolves to a noop carrying its own id", () => {
    for (const b of KEYMAP.filter((r) => r.built === 11 || r.built === 12)) {
      expect(b.action(initialUi, "", {}), b.id).toEqual(noop(b.id));
    }
  });

  it("every P10 row except clearSelection resolves to an intent", () => {
    const p10 = KEYMAP.filter((r) => r.built === 10 && r.id !== "clearSelection");
    expect(p10.map((b) => b.id).sort()).toEqual(
      [
        "agentsGoto",
        "agentsMove",
        "agentsSelect",
        "page",
        "phasesBrowse",
        "phasesProject",
        "portsBrowse",
        "sessionsBrowse",
        "sessionsCopy",
        "sessionsOpen",
      ].sort(),
    );
    for (const b of p10) {
      const ctx = CTX[b.contexts[0]!];
      for (const key of [{ downArrow: true }, { rightArrow: true }, ENTER, { pageDown: true }, {}]) {
        for (const input of ["", "o"]) {
          if (!b.match(input, key)) continue;
          expect(isIntent(b.action(ctx, input, key)), `${b.id}`).toBe(true);
        }
      }
    }
  });

  it("no footer hint names the page binding (D-16)", () => {
    for (const c of ALL) {
      for (const h of FOOTER_HINTS[c]) expect(h.binding, c).not.toBe("page");
    }
  });
});

describe("isIntent", () => {
  const intents: Intent[] = [
    { t: "move", dir: "up" },
    { t: "move", dir: "left" },
    { t: "page", dir: 1 },
    { t: "page", dir: -1 },
    { t: "project", dir: 1 },
    { t: "goto" },
    { t: "copy" },
    { t: "open" },
  ];
  const actions: Action[] = [
    { t: "focusNext" },
    { t: "focusPrev" },
    { t: "focusAgents" },
    { t: "clearSelection" },
    { t: "select", id: "a" },
    { t: "closeOverlay" },
    { t: "toggleRight" },
    { t: "toggleFiles" },
    { t: "quit" },
    { t: "noop", binding: "portsActions" },
    { t: "setPhaseCursor", n: "1" },
    { t: "setProject", root: "/r" },
    { t: "setPortCursor", key: "k" },
    { t: "flash", text: "x", ok: true, at: 1 },
    { t: "keyAt", at: 1 },
  ];

  it.each(intents)("is true for intent %j", (i) => {
    expect(isIntent(i)).toBe(true);
  });

  it.each(actions)("is false for reducer action %j", (a) => {
    expect(isIntent(a)).toBe(false);
  });
});

describe("Ctrl+C", () => {
  it("is not a KEYMAP row (Ink exitOnCtrlC consumes it)", () => {
    for (const c of ALL) expect(resolve("c", { ctrl: true }, CTX[c])).toBeNull();
  });
});
