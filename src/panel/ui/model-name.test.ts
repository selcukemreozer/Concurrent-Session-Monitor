import { describe, expect, it } from "vitest";
import { cardModel, shortModelName } from "./model-name.js";

describe("shortModelName (D-07, RESEARCH Q3)", () => {
  it.each([
    ["claude-opus-4-7", "opus 4.7"],
    ["claude-opus-5-5", "opus 5.5"],
    ["claude-sonnet-4-5-20250929", "sonnet 4.5"],
    ["claude-opus-4-20250514", "opus 4"],
    ["claude-3-5-sonnet-20241022", "sonnet 3.5"],
    ["claude-haiku-4-5", "haiku 4.5"],
    ["claude-opus-4-7[1m]", "opus 4.7"],
    ["claude-future-9", "future 9"],
    ["gpt-x", "gpt-x"],
    ["claude-weird_thing", "weird_thing"],
  ])("%s -> %s", (raw, short) => {
    expect(shortModelName(raw)).toBe(short);
  });

  it.each([[""], ["<synthetic>"], ["unknown"], [undefined], [null], [42], [{}]])(
    "%s -> null",
    (raw) => {
      expect(shortModelName(raw)).toBeNull();
    },
  );
});

describe("cardModel fallback chain (D-07)", () => {
  it("prefers the transcript model", () => {
    expect(cardModel({ transcript_model: "claude-opus-4-8", model: "claude-opus-4-7" })).toBe("opus 4.8");
  });
  it("falls back to the session.json model", () => {
    expect(cardModel({ model: "claude-opus-4-7" })).toBe("opus 4.7");
  });
  it("treats the unknown sentinel as absent", () => {
    expect(cardModel({ model: "unknown" })).toBeNull();
  });
  it("returns null when nothing is known", () => {
    expect(cardModel({})).toBeNull();
  });
  it("skips a synthetic transcript model", () => {
    expect(cardModel({ transcript_model: "<synthetic>", model: "claude-haiku-4-5" })).toBe("haiku 4.5");
  });
});
