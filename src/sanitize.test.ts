import { describe, it, expect } from "vitest";

// RED (wave 01-04): sanitize.ts is the render-boundary control-char strip (T-1-02).
import { sanitize } from "./sanitize.js";

const ESC = String.fromCharCode(27); // 0x1B

describe("sanitize (T-1-02 render-boundary control-char strip, Pitfall 6)", () => {
  it("leaves clean printable text intact", () => {
    expect(sanitize("safe")).toBe("safe");
    expect(sanitize("src/panel/App.tsx")).toBe("src/panel/App.tsx");
  });

  it("removes an ESC (0x1B) byte so an ANSI sequence cannot spoof the panel", () => {
    const bad = "a" + ESC + "[31mX";
    const out = sanitize(bad);
    expect(out).not.toContain(ESC);
    expect(out).toBe("a[31mX");
  });

  it("strips the full C0 range 0x00-0x1F", () => {
    for (let c = 0x00; c <= 0x1f; c++) {
      expect(sanitize("x" + String.fromCharCode(c) + "y")).toBe("xy");
    }
  });

  it("strips the C1 range 0x80-0x9F", () => {
    for (let c = 0x80; c <= 0x9f; c++) {
      expect(sanitize("x" + String.fromCharCode(c) + "y")).toBe("xy");
    }
  });

  it("keeps printable characters at/above 0xA0 (accented latin, greek, symbols)", () => {
    expect(sanitize("café")).toBe("café");
    expect(sanitize("Ω branch")).toBe("Ω branch");
    expect(sanitize("a b")).toBe("a b"); // NBSP (0xA0) is not a control char
  });

  it("coerces non-string input to a string without throwing", () => {
    expect(sanitize(undefined as unknown as string)).toBe("undefined");
    expect(sanitize(42 as unknown as string)).toBe("42");
    expect(sanitize(null as unknown as string)).toBe("null");
  });
});
