import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { WARP_SESSION_URL_RE, isWarpSessionUrl } from "./warp-url.js";
import { validWarpFocusUrl } from "./panel/registration.js";
import { WARP_URL_FIXTURES } from "./warp-url.fixtures.js";

// 261017-sbh D-02/D-04: scripts/*.mjs are stdlib-only (T-1-SC) and cannot
// import src/warp-url.ts, so each carries a byte-identical copy of the strict
// Warp session regex literal. This test pins the canonical literal text, checks
// that all three copies match it, and runs the shared fixture table through
// every copy: the TS module, registration.ts, each extracted script literal and
// a spawned on-session-start hook. (scripts/csm-goto.test.ts G14 runs the table
// through a spawned csm-goto.)

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const FILES = {
  module: path.join(repoRoot, "src", "warp-url.ts"),
  goto: path.join(repoRoot, "scripts", "csm-goto.mjs"),
  sessionStart: path.join(repoRoot, "scripts", "on-session-start.mjs"),
} as const;

/** The canonical D-01 literal, held by the test itself. */
const PINNED = String.raw`/^(warp|warppreview|warposs):\/\/session\/[0-9a-f]{32}$/`;

const DECL = /^(?:export )?const WARP_SESSION_URL_RE = (\/.+\/[a-z]*);$/gm;

function literalsIn(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  return [...text.matchAll(DECL)].map((m) => m[1]);
}

function rebuild(literal: string): RegExp {
  const last = literal.lastIndexOf("/");
  return new RegExp(literal.slice(1, last), literal.slice(last + 1));
}

describe("Warp focus-URL rule parity across copies (261017-sbh)", () => {
  it("P1 each file declares exactly one byte-identical literal", () => {
    const found: string[] = [];
    for (const [name, file] of Object.entries(FILES)) {
      const lits = literalsIn(file);
      expect(lits.length, name).toBe(1);
      expect(lits[0], name).toBe(PINNED);
      found.push(lits[0]);
    }
    expect(new Set(found).size).toBe(1);
    expect(String(WARP_SESSION_URL_RE)).toBe(PINNED);
  });

  it("P2 every copy has no flags and runs the fixture table", () => {
    for (const [name, file] of Object.entries(FILES)) {
      const [lit] = literalsIn(file);
      expect(lit, name).toBeDefined();
      const re = rebuild(lit);
      expect(re.flags, name).toBe("");
      for (const f of WARP_URL_FIXTURES) {
        const got = typeof f.value === "string" && re.test(f.value);
        expect(got, `${name}: ${f.name}`).toBe(f.ok);
      }
    }
    for (const f of WARP_URL_FIXTURES) {
      expect(isWarpSessionUrl(f.value), `module: ${f.name}`).toBe(f.ok);
      expect(validWarpFocusUrl(f.value), `registration: ${f.name}`).toBe(
        f.ok ? f.value : null,
      );
    }
  });

  it("P3 both scripts import only node: modules (T-1-SC)", () => {
    for (const file of [FILES.goto, FILES.sessionStart]) {
      const src = fs.readFileSync(file, "utf8");
      const specs = [...src.matchAll(/import\s[^;]*?from\s+["']([^"']+)["']/g)].map(
        (m) => m[1],
      );
      expect(specs.length, file).toBeGreaterThan(0);
      for (const s of specs) expect(s.startsWith("node:"), `${file}: ${s}`).toBe(true);
      expect(src, file).not.toMatch(/\bimport\(/);
    }
  });
});

describe("on-session-start stores only a strict focus URL (261017-sbh)", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-warpurl-"));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function runHook(id: string, focus: string | undefined) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CSM_STORE_DIR: tmp,
      TERM_PROGRAM: "WarpTerminal",
      WARP_TERMINAL_SESSION_UUID: "u-1",
    };
    // The suite may run inside Warp: never rely on the inherited value.
    delete env.WARP_FOCUS_URL;
    if (focus !== undefined) env.WARP_FOCUS_URL = focus;
    const res = spawnSync(process.execPath, [FILES.sessionStart], {
      input: JSON.stringify({ session_id: id, cwd: tmp }),
      env,
      encoding: "utf8",
    });
    expect(res.status, id).toBe(0);
    return JSON.parse(
      fs.readFileSync(path.join(tmp, "sessions", id, "session.json"), "utf8"),
    );
  }

  it(
    "P4 warp.focus_url is the env value only when it passes, else \"\"",
    () => {
      WARP_URL_FIXTURES.forEach((f, index) => {
        if (!f.env) return;
        const rec = runHook("wu-" + index, f.value as string);
        expect(rec.warp?.focus_url, f.name).toBe(f.ok ? f.value : "");
        expect(rec.warp?.session_uuid, f.name).toBe("u-1");
      });
      const unset = runHook("wu-unset", undefined);
      expect(unset.warp?.focus_url).toBe("");
      expect(unset.warp?.session_uuid).toBe("u-1");
    },
    60000,
  );
});
