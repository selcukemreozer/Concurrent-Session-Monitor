import { describe, expect, it } from "vitest";

import { WARP_SESSION_URL_RE, isWarpSessionUrl } from "./warp-url.js";
import { validWarpFocusUrl } from "./panel/registration.js";
import { WARP_URL_FIXTURES } from "./warp-url.fixtures.js";

// 261017-sbh D-01/D-04: one strict Warp session focus-URL rule, run against the
// shared fixture table.

describe("isWarpSessionUrl strict rule (261017-sbh)", () => {
  it("F1 matches ok for every fixture", () => {
    for (const f of WARP_URL_FIXTURES) {
      expect(isWarpSessionUrl(f.value), f.name).toBe(f.ok);
    }
  });

  it("F2 validWarpFocusUrl keeps only passing values", () => {
    for (const f of WARP_URL_FIXTURES) {
      expect(validWarpFocusUrl(f.value), f.name).toBe(f.ok ? f.value : null);
    }
  });

  it("F3 the regex has no flags and the D-01 source", () => {
    expect(WARP_SESSION_URL_RE.flags).toBe("");
    expect(WARP_SESSION_URL_RE.source).toBe(
      String.raw`^(warp|warppreview|warposs):\/\/session\/[0-9a-f]{32}$`,
    );
  });
});
