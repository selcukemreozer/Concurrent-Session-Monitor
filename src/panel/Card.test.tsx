import { describe, it, expect } from "vitest";

// RED (wave 01-04): Card.tsx exports the SessionCard component and the osc8 helper.
import { osc8, SessionCard } from "./Card.js";

const ESC = String.fromCharCode(27); // 0x1B

describe("osc8 (D-06 clickable Warp go-to-pane hyperlink)", () => {
  it("wraps a url + label in an OSC-8 hyperlink escape sequence", () => {
    const out = osc8("warp://session/abc", "go to pane");
    // opening params: ESC ] 8 ; ; <url>
    expect(out).toContain(ESC + "]8;;warp://session/abc");
    expect(out).toContain("go to pane");
    expect(out.startsWith(ESC)).toBe(true);
  });

  it("sanitizes its url/label inputs so untrusted control bytes cannot inject", () => {
    const out = osc8("warp://x" + ESC + "evil", "lab" + ESC + "el");
    // the ESC embedded in the inputs is stripped; only the wrapper framing remains
    expect(out).toContain("warp://xevil");
    expect(out).toContain("label");
  });
});

describe("SessionCard (D-09 bordered card)", () => {
  it("is a renderable component export", () => {
    expect(typeof SessionCard).toBe("function");
  });
});
