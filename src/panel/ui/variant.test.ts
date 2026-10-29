import { describe, it, expect } from "vitest";
import { uiVariant } from "./variant.js";

// Phase 10 plan 10-17 (D-22, T-09-13 / T-10-42): from 2.0.0 the new panel is
// the default. Only an exact trimmed "legacy" opens the previous panel (for one
// release, removed in 2.1.0); every other value, unset included, opens v2.
describe("uiVariant", () => {
  it("is v2 when CSM_UI is unset", () => {
    expect(uiVariant({})).toBe("v2");
  });

  it.each(["LEGACY", "Legacy", "v1", "", "v2", " v2 ", " ", "legacy2", "le gacy", "legacyx"])(
    "is v2 for CSM_UI=%j",
    (v) => {
      expect(uiVariant({ CSM_UI: v })).toBe("v2");
    },
  );

  it.each(["legacy", " legacy ", "\tlegacy\n"])("is legacy for CSM_UI=%j", (v) => {
    expect(uiVariant({ CSM_UI: v })).toBe("legacy");
  });

  it("defaults to process.env", () => {
    const prev = process.env.CSM_UI;
    try {
      process.env.CSM_UI = "legacy";
      expect(uiVariant()).toBe("legacy");
      delete process.env.CSM_UI;
      expect(uiVariant()).toBe("v2");
    } finally {
      if (prev === undefined) delete process.env.CSM_UI;
      else process.env.CSM_UI = prev;
    }
  });
});
