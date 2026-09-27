import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Version lockstep guard (05-REVIEW WR-02): Claude Code reads the plugin version
// from .claude-plugin/plugin.json, but package.json (and the root entries of
// package-lock.json) are the conventional Node source of truth. A bump applied
// to only one of them silently drifts — this test fails the suite if they
// disagree, so every version bump must touch all of them together.
//
// Source-text style mirrors readme-docs.test.ts: stdlib fs + url only, no deps.

type Json = Record<string, unknown>;

/** Parse a JSON file resolved relative to THIS test file. */
function readJsonRel(rel: string): Json {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"),
  ) as Json;
}

const plugin = readJsonRel("../.claude-plugin/plugin.json");
const pkg = readJsonRel("../package.json");
const lock = readJsonRel("../package-lock.json");
const marketplace = readJsonRel("../.claude-plugin/marketplace.json");

describe("version lockstep (WR-02)", () => {
  it("plugin.json declares a semver version", () => {
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("package.json version === plugin.json version", () => {
    expect(pkg.version).toBe(plugin.version);
  });

  it("package-lock.json root versions === plugin.json version", () => {
    expect(lock.version).toBe(plugin.version);
    const packages = lock.packages as Record<string, Json>;
    expect(packages[""].version).toBe(plugin.version);
  });

  it("marketplace.json plugin entry version (if declared) === plugin.json version", () => {
    const entries = (marketplace.plugins ?? []) as Json[];
    for (const entry of entries) {
      if (entry.name === plugin.name && entry.version !== undefined) {
        expect(entry.version).toBe(plugin.version);
      }
    }
  });
});
