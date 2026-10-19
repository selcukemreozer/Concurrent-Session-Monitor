import { describe, it, expect } from "vitest";
import { uiVariant } from "./variant.js";

// Phase 9 plan 09-04 Task 1: CSM_UI selects the v2 shell only on an exact
// trimmed "v2" (D-23, T-09-13). Everything else opens the 1.6.x panel.
describe("uiVariant", () => {
  it("is legacy when CSM_UI is unset", () => {
    expect(uiVariant({})).toBe("legacy");
  });

  it.each(["", "v1", "legacy", "V2", "v2x", "2", " ", "v 2", "vv2"])(
    "is legacy for CSM_UI=%j",
    (v) => {
      expect(uiVariant({ CSM_UI: v })).toBe("legacy");
    },
  );

  it.each(["v2", " v2 ", "\tv2\n"])("is v2 for CSM_UI=%j", (v) => {
    expect(uiVariant({ CSM_UI: v })).toBe("v2");
  });

  it("defaults to process.env", () => {
    const prev = process.env.CSM_UI;
    try {
      process.env.CSM_UI = "v2";
      expect(uiVariant()).toBe("v2");
      delete process.env.CSM_UI;
      expect(uiVariant()).toBe("legacy");
    } finally {
      if (prev === undefined) delete process.env.CSM_UI;
      else process.env.CSM_UI = prev;
    }
  });
});
