import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Version lockstep guard (05-REVIEW WR-02): Claude Code reads the plugin version
// from .claude-plugin/plugin.json, but package.json (and the root entries of
// package-lock.json) are the conventional Node source of truth. A bump applied
// to only one of them silently drifts — this test fails the suite if they
// disagree, so every version bump must touch all of them together.
//
// 261014-e2u: a bump must now ALSO update the README version badge, add a
// matching top "## vX.Y.Z" heading to CHANGELOG.md, and rebuild dist/panel.mjs
// (which embeds the version at build time for the panel's update notice).
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

/** Read a text file resolved relative to THIS test file. */
function readTextRel(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

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

  it("README version badge === plugin.json version (261014-e2u)", () => {
    const readme = readTextRel("../README.md");
    expect(readme).toContain(`version-${plugin.version}-`);
    expect(readme).toContain(`version ${plugin.version}`);
  });

  it("CHANGELOG.md top release heading === plugin.json version (261014-e2u)", () => {
    const top = readTextRel("../CHANGELOG.md")
      .split("\n")
      .find((l) => l.startsWith("## v"));
    expect(top).toBeDefined();
    const rest = top!.slice(`## v${plugin.version}`.length);
    expect(top!.startsWith(`## v${plugin.version}`)).toBe(true);
    expect(rest === "" || rest.startsWith(" ")).toBe(true);
  });

  it("dist/panel.mjs embeds the plugin.json version via the build-time define (261014-e2u)", () => {
    const bundle = readTextRel("../dist/panel.mjs");
    expect(bundle).toContain(JSON.stringify(plugin.version));
    expect(bundle).not.toContain("typeof __CSM_VERSION__");
  });
});
