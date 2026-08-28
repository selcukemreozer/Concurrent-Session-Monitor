import { afterEach, describe, expect, it } from "vitest";
import { numEnv } from "./env.js";

const NAME = "CSM_TEST_NUM";

afterEach(() => {
  delete process.env[NAME];
});

describe("numEnv (WR-02)", () => {
  it("returns the default when the var is unset", () => {
    delete process.env[NAME];
    expect(numEnv(NAME, 1200)).toBe(1200);
  });

  it("returns the parsed value for a valid non-negative number", () => {
    process.env[NAME] = "5000";
    expect(numEnv(NAME, 1200)).toBe(5000);
  });

  it("accepts 0", () => {
    process.env[NAME] = "0";
    expect(numEnv(NAME, 1200)).toBe(0);
  });

  it("falls back to the default on a non-numeric value (NaN guard)", () => {
    process.env[NAME] = "2m";
    expect(numEnv(NAME, 1200)).toBe(1200);
    process.env[NAME] = "off";
    expect(numEnv(NAME, 1200)).toBe(1200);
  });

  it("falls back to the default on a negative number", () => {
    process.env[NAME] = "-5";
    expect(numEnv(NAME, 1200)).toBe(1200);
  });

  it("falls back to the default on a non-finite value", () => {
    process.env[NAME] = "Infinity";
    expect(numEnv(NAME, 1200)).toBe(1200);
  });
});

// Traceability (03.1-02, D-04/D-05): pin the CSM_READ_WINDOW_MS default. This is
// the NEW read-window env, a distinct axis from CSM_ACTIVE_MS / CSM_WINDOW_MS.
// numEnv is unchanged generic code, so this PASSES immediately — it exists to
// keep the canonical env default (30_000ms) traceable to a test.
describe("CSM_READ_WINDOW_MS default (D-04/D-05)", () => {
  afterEach(() => {
    delete process.env.CSM_READ_WINDOW_MS;
  });

  it("defaults to 30_000ms when unset", () => {
    delete process.env.CSM_READ_WINDOW_MS;
    expect(numEnv("CSM_READ_WINDOW_MS", 30000)).toBe(30000);
  });
});
