import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PANEL_FILE,
  buildPanelRecord,
  detectTty,
  registerPanel,
  unregisterPanel,
  validWarpFocusUrl,
} from "./registration.js";

// 260927-59z D-01: the panel self-registers its terminal identity in
// <storeRoot>/panel.json so /csm-goto (no args) can focus the panel's terminal.
// Every test binds CSM_STORE_DIR to a throwaway mkdtemp dir (store.test.ts
// pattern) so the suite never touches the real ~/.claude/csm store.

const ESC = String.fromCharCode(0x1b);
const now = new Date("2026-09-27T10:00:00.000Z");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-panelreg-"));
  process.env.CSM_STORE_DIR = tmp;
});

afterEach(() => {
  delete process.env.CSM_STORE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function panelPath(): string {
  return path.join(tmp, "panel.json");
}

describe("panel self-registration (260927-59z)", () => {
  it("R1 builds the Warp record with a validated focus URL", () => {
    expect(PANEL_FILE).toBe("panel.json");
    const rec = buildPanelRecord({
      pid: 4242,
      env: {
        TERM_PROGRAM: "WarpTerminal",
        WARP_FOCUS_URL: "warp://session/abc-123",
      },
      now,
      tty: "ttys003",
    });
    expect(rec).toEqual({
      schema_version: 1,
      pid: 4242,
      started: "2026-09-27T10:00:00.000Z",
      term_program: "WarpTerminal",
      warp_focus_url: "warp://session/abc-123",
      tty: "ttys003",
    });
  });

  it("R2 gates the focus URL: warp: only, Warp terminal only", () => {
    const bad: Array<string | undefined> = [
      "https://evil.example/",
      "file:///etc/passwd",
      "warp://x y",
      "warp://x" + ESC + "[31m",
      "not a url",
      "",
      undefined,
      "warp://" + "a".repeat(2100),
    ];
    for (const url of bad) {
      const env: NodeJS.ProcessEnv = { TERM_PROGRAM: "WarpTerminal" };
      if (url !== undefined) env.WARP_FOCUS_URL = url;
      const rec = buildPanelRecord({ pid: 10, env, now, tty: null });
      expect(rec.warp_focus_url, JSON.stringify(url)).toBeNull();
    }
    const nonWarp = buildPanelRecord({
      pid: 10,
      env: {
        TERM_PROGRAM: "Apple_Terminal",
        WARP_FOCUS_URL: "warp://session/abc-123",
      },
      now,
      tty: null,
    });
    expect(nonWarp.warp_focus_url).toBeNull();
    expect(validWarpFocusUrl(42)).toBeNull();
    expect(validWarpFocusUrl(null)).toBeNull();
    expect(validWarpFocusUrl("warp://session/ok")).toBe("warp://session/ok");
  });

  it("R3 shapes term_program (absent/empty -> null, sanitized, capped at 64)", () => {
    const tp = (v: string | undefined) => {
      const env: NodeJS.ProcessEnv = {};
      if (v !== undefined) env.TERM_PROGRAM = v;
      return buildPanelRecord({ pid: 10, env, now, tty: null }).term_program;
    };
    expect(tp(undefined)).toBeNull();
    expect(tp("")).toBeNull();
    expect(tp("ghostty")).toBe("ghostty");
    expect(tp("gho" + ESC + "stty")).toBe("gho" + "stty");
    expect(tp("x".repeat(200))?.length).toBe(64);
  });

  it("R4 writes panel.json at the store root, 0600, atomically", () => {
    const ok = registerPanel({
      pid: 111,
      env: { TERM_PROGRAM: "ghostty" },
      now,
      tty: null,
    });
    expect(ok).toBe(true);
    expect(fs.existsSync(panelPath())).toBe(true);
    expect(fs.existsSync(path.join(tmp, "sessions", "panel.json"))).toBe(false);
    const parsed = JSON.parse(fs.readFileSync(panelPath(), "utf8"));
    expect(parsed).toEqual(
      buildPanelRecord({
        pid: 111,
        env: { TERM_PROGRAM: "ghostty" },
        now,
        tty: null,
      }),
    );
    expect(fs.statSync(panelPath()).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(tmp)).toEqual(["panel.json"]);
  });

  it("R5 last writer wins", () => {
    registerPanel({ pid: 111, env: {}, now, tty: null });
    registerPanel({ pid: 222, env: {}, now, tty: null });
    const parsed = JSON.parse(fs.readFileSync(panelPath(), "utf8"));
    expect(parsed.pid).toBe(222);
  });

  it("R6 unregister removes the file only when it still holds our pid", () => {
    registerPanel({ pid: 222, env: {}, now, tty: null });
    expect(unregisterPanel(111)).toBe(false);
    expect(fs.existsSync(panelPath())).toBe(true);
    expect(unregisterPanel(222)).toBe(true);
    expect(fs.existsSync(panelPath())).toBe(false);
    expect(() => unregisterPanel(222)).not.toThrow();
    expect(unregisterPanel(222)).toBe(false);

    fs.writeFileSync(panelPath(), '{"pid":2');
    expect(() => unregisterPanel(2)).not.toThrow();
    expect(unregisterPanel(2)).toBe(false);
    expect(fs.existsSync(panelPath())).toBe(true);

    fs.writeFileSync(panelPath(), "null");
    expect(unregisterPanel(2)).toBe(false);
    fs.writeFileSync(panelPath(), "[]");
    expect(unregisterPanel(2)).toBe(false);
  });

  it("R7 never throws on an unwritable store; detectTty is best-effort", () => {
    fs.writeFileSync(path.join(tmp, "afile"), "x");
    process.env.CSM_STORE_DIR = path.join(tmp, "afile", "sub");
    let result: boolean | undefined;
    expect(() => {
      result = registerPanel({ tty: null });
    }).not.toThrow();
    expect(result).toBe(false);

    let tty: string | null | undefined;
    expect(() => {
      tty = detectTty();
    }).not.toThrow();
    expect(tty === null || typeof tty === "string").toBe(true);
  });

  it("R8 entry.ts wires register after run() and unregister on exit + SIGHUP", () => {
    const entry = fs.readFileSync(
      fileURLToPath(new URL("./entry.ts", import.meta.url)),
      "utf8",
    );
    expect(entry).toMatch(
      /import\s*\{\s*registerPanel\s*,\s*unregisterPanel\s*\}\s*from\s*["']\.\/registration(?:\.js)?["']/,
    );
    expect(entry).toMatch(/process\.on\(\s*["']exit["']/);
    expect(entry).toContain("SIGHUP");
    const runIdx = entry.indexOf("instance = run()");
    // Word-boundary search so the unregisterPanel() calls never match.
    const regIdx = entry.search(/(?<![A-Za-z])registerPanel\(\)/);
    expect(runIdx).toBeGreaterThanOrEqual(0);
    expect(regIdx).toBeGreaterThan(runIdx);
  });
});
