import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Source-text guard for the dependency policy of milestone v2.0 (Phase 9, plan
// 09-01). It mirrors launcher.test.ts: stdlib fs + path + url only, no PTY, no
// extra deps. It fails the suite if any of these ever appear:
//   - a second ink or react in the lockfile (the dual-Ink bug class: two
//     instances split the input context and kill raw-mode keyboard input);
//   - a nested ink/string-width (Ink must measure text with the same hoisted
//     string-width the v2 screen buffer imports);
//   - a second Ink copy bundled into dist/panel.mjs;
//   - a new runtime dependency beyond {ink, react, tsx};
//   - a text-input package (ink-text-input, ink-select-input, @inkjs/ui) or
//     Ink's focus manager, which would hijack keys from the one input dispatcher;
//   - a second `render` import site from ink (main.tsx is the only one).

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_ROOT = path.join(REPO_ROOT, "src");

/** Read a file resolved relative to the repo root. */
function readRoot(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

/** Count non-overlapping occurrences of a literal substring. */
function countLiteral(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Every non-test .ts/.tsx source file under src/, as repo-relative POSIX paths. */
function nonTestSources(): string[] {
  const entries = readdirSync(SRC_ROOT, { recursive: true, encoding: "utf8" });
  return entries
    .filter((rel) => /\.(ts|tsx)$/.test(rel))
    .filter((rel) => !path.basename(rel).includes(".test."))
    .map((rel) => path.posix.join("src", rel.split(path.sep).join("/")))
    .sort();
}

const BANNED_MODULES = ["ink-text-input", "ink-select-input", "@inkjs/ui"];

// Test-only helper (created in plan 09-02) that may import `render` from ink.
// The bundle never imports it. Its absence is tolerated.
const RENDER_ALLOWLIST = ["src/panel/ui/test-harness.ts"];

describe("dependency policy (single Ink, no focus manager, no new runtime deps)", () => {
  it("package-lock.json has exactly one ink and exactly one react", () => {
    const lock = JSON.parse(readRoot("package-lock.json")) as {
      packages: Record<string, unknown>;
    };
    const keys = Object.keys(lock.packages);
    const isPkg = (key: string, name: string) =>
      key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`);
    const inks = keys.filter((k) => isPkg(k, "ink"));
    const reacts = keys.filter((k) => isPkg(k, "react"));
    expect(inks, `ink entries in package-lock.json: ${inks.join(", ")}`).toEqual([
      "node_modules/ink",
    ]);
    expect(reacts, `react entries in package-lock.json: ${reacts.join(", ")}`).toEqual([
      "node_modules/react",
    ]);
  });

  it("ink has no nested string-width (it shares the hoisted copy)", () => {
    const lock = JSON.parse(readRoot("package-lock.json")) as {
      packages: Record<string, unknown>;
    };
    expect(Object.keys(lock.packages)).not.toContain("node_modules/ink/node_modules/string-width");
  });

  it("dist/panel.mjs bundles exactly one copy of Ink", () => {
    // Both markers are exactly 1 on the ink 8.0.0 bundle built in 09-01.
    const bundle = readRoot("dist/panel.mjs");
    expect(countLiteral(bundle, '"InternalErrorBoundary"'), '"InternalErrorBoundary" count').toBe(1);
    expect(countLiteral(bundle, "var Ink = class"), "`var Ink = class` count").toBe(1);
  });

  it("runtime dependencies are exactly {ink, react, tsx}", () => {
    const pkg = JSON.parse(readRoot("package.json")) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["ink", "react", "tsx"]);
  });

  it("no non-test source imports a text-input package or Ink's focus manager", () => {
    const files = nonTestSources();
    expect(files.length).toBeGreaterThan(0);
    const escaped = BANNED_MODULES.map((m) => m.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
    const specifier = new RegExp(
      String.raw`(?:\bfrom\s*|\bimport\s*\(?\s*)["'](${escaped.join("|")})(?:/[^"']*)?["']`,
    );
    const inkImport = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']ink["']/g;
    const focusCall = /\buseFocus(Manager)?\s*\(/;
    const offenders: string[] = [];
    for (const rel of files) {
      const text = readRoot(rel);
      const banned = text.match(specifier);
      if (banned) offenders.push(`${rel}: imports ${banned[1]}`);
      for (const m of text.matchAll(inkImport)) {
        if (/\buseFocus(Manager)?\b/.test(m[1] ?? "")) {
          offenders.push(`${rel}: imports the focus manager from ink`);
        }
      }
      if (focusCall.test(text)) offenders.push(`${rel}: calls useFocus/useFocusManager`);
    }
    expect(offenders).toEqual([]);
  });

  it("src/panel/main.tsx is the only non-test source that imports render from ink", () => {
    const renderImport = /import\s*\{[^}]*\brender\b[^}]*\}\s*from\s*["']ink["']/;
    const sites = nonTestSources()
      .filter((rel) => !RENDER_ALLOWLIST.includes(rel))
      .filter((rel) => renderImport.test(readRoot(rel)));
    expect(sites, `render import sites: ${sites.join(", ")}`).toEqual(["src/panel/main.tsx"]);
    // The allowlisted helper is optional. When present it must stay test-only:
    // main.tsx (the bundle's render site) never imports it.
    for (const rel of RENDER_ALLOWLIST) {
      if (existsSync(path.join(REPO_ROOT, rel))) {
        expect(readRoot("src/panel/main.tsx")).not.toMatch(/test-harness/);
      }
    }
  });
});
