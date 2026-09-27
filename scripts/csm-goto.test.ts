import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// /csm-goto (scripts/csm-goto.mjs) — 260927-59z: takes NO arguments and brings
// the terminal running the CSM panel to the front, using the panel.json the
// panel writes at the store root on start. The CSM_OPEN_CMD test seam points
// the opener at a fixture shell script that logs its argv (one line per argv
// entry), so nothing is ever really focused.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const csmGoto = path.join(repoRoot, "scripts", "csm-goto.mjs");
const commandMd = path.join(repoRoot, "commands", "csm-goto.md");

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

let tmp: string;
let openStub: string;
let openLog: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-goto-"));
  openLog = path.join(tmp, "open.log");
  openStub = path.join(tmp, "open-stub.sh");
  fs.writeFileSync(openStub, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${openLog}"\n`);
  fs.chmodSync(openStub, 0o755);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function panelFile(): string {
  return path.join(tmp, "panel.json");
}

function writePanel(obj: unknown) {
  fs.writeFileSync(panelFile(), JSON.stringify(obj));
}

function writeRaw(text: string) {
  fs.writeFileSync(panelFile(), text);
}

function runGoto(...extraArgs: string[]) {
  return runGotoEnv({}, ...extraArgs);
}

function runGotoEnv(envOverrides: Record<string, string>, ...extraArgs: string[]) {
  return spawnSync(process.execPath, [csmGoto, ...extraArgs], {
    env: { ...process.env, CSM_STORE_DIR: tmp, CSM_OPEN_CMD: openStub, ...envOverrides },
    encoding: "utf8",
  });
}

function opened(): string[] {
  if (!fs.existsSync(openLog)) return [];
  return fs.readFileSync(openLog, "utf8").split("\n").filter(Boolean);
}

function resetLog() {
  fs.rmSync(openLog, { force: true });
}

const LIVE = process.pid; // the vitest worker — alive for the whole run
const DEAD = (() => {
  const r = spawnSync(process.execPath, ["-e", ""]);
  return r.pid as number; // finished → no longer alive
})();

const WARP_PANEL = {
  schema_version: 1,
  pid: LIVE,
  started: "2026-09-27T10:00:00.000Z",
  term_program: "WarpTerminal",
  warp_focus_url: "warp://session/p1",
  tty: "ttys003",
};

describe("csm-goto focuses the CSM panel's terminal (260927-59z)", () => {
  it("G1 no panel.json → no-panel message, nothing opened", () => {
    const res = runGoto();
    expect(res.status).toBe(0);
    expect(opened()).toEqual([]);
    expect(res.stdout).toContain("No CSM panel is running");
    expect(res.stdout).toContain("start it with `csm`");

    const res2 = runGotoEnv({ CSM_STORE_DIR: path.join(tmp, "does-not-exist") });
    expect(res2.status).toBe(0);
    expect(opened()).toEqual([]);
    expect(res2.stdout).toContain("No CSM panel is running");
  });

  it("G2 dead pid → no-panel message, nothing opened", () => {
    writePanel({ pid: DEAD, term_program: "WarpTerminal", warp_focus_url: "warp://session/p1" });
    const res = runGoto();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("No CSM panel is running");
    expect(opened()).toEqual([]);
  });

  it("G3 Warp: opens the panel's exact pane via its focus URL", () => {
    writePanel(WARP_PANEL);
    const res = runGoto();
    expect(res.status).toBe(0);
    expect(opened()).toEqual(["warp://session/p1"]);
    expect(res.stdout).toContain("Focused the CSM panel (Warp)");
  });

  it("G4 known terminals without a focus URL → app-level fallback", () => {
    const table: Array<[string, string]> = [
      ["Apple_Terminal", "Terminal"],
      ["iTerm.app", "iTerm"],
      ["WarpTerminal", "Warp"],
      ["ghostty", "Ghostty"],
      ["vscode", "Visual Studio Code"],
    ];
    for (const [term, app] of table) {
      resetLog();
      writePanel({ pid: LIVE, term_program: term, warp_focus_url: null, tty: "ttys001" });
      const res = runGoto();
      expect(res.status, term).toBe(0);
      expect(opened(), term).toEqual(["-a", app]);
      expect(res.stdout).toContain(`Brought ${app} to the front`);
      expect(res.stdout).toContain("only the app could be focused");
    }
  });

  it("G5 unknown terminal → explains, shows pid/tty/terminal, opens nothing", () => {
    writePanel({ pid: LIVE, term_program: "tmux", warp_focus_url: null, tty: "ttys009" });
    const res = runGoto();
    expect(res.status).toBe(0);
    expect(opened()).toEqual([]);
    expect(res.stdout).toContain("can't be focused automatically");
    expect(res.stdout).toContain(`pid ${LIVE}`);
    expect(res.stdout).toContain("ttys009");
    expect(res.stdout).toContain("tmux");

    writePanel({ pid: LIVE, term_program: null, warp_focus_url: null, tty: null });
    const res2 = runGoto();
    expect(res2.stdout).toContain("tty unknown");
    expect(res2.stdout).toContain("terminal unknown");
    expect(opened()).toEqual([]);
  });

  it("G6 a hostile focus URL is never opened (app fallback only)", () => {
    const bad: unknown[] = [
      "https://evil.example/",
      "file:///etc/passwd",
      "warp://x y",
      "warp://x" + ESC + "[31m",
      "not a url",
      "warp://" + "a".repeat(3000),
      42,
    ];
    for (const url of bad) {
      resetLog();
      writePanel({ pid: LIVE, term_program: "WarpTerminal", warp_focus_url: url, tty: null });
      const res = runGoto();
      expect(res.status).toBe(0);
      expect(opened(), JSON.stringify(url).slice(0, 40)).toEqual(["-a", "Warp"]);
    }
  });

  it("G7 a hostile term_program never becomes an app; echoes are sanitized + bounded", () => {
    const hostile: unknown[] = [
      "__proto__",
      "constructor",
      "toString",
      "Terminal",
      "Apple_Terminal; open -a Calculator",
      "WarpTerminal\n",
      ESC + "[31m",
      42,
      {},
    ];
    for (const term of hostile) {
      resetLog();
      writePanel({ pid: LIVE, term_program: term, warp_focus_url: null, tty: null });
      const res = runGoto();
      expect(res.status).toBe(0);
      expect(opened(), JSON.stringify(term)).toEqual([]);
      expect(res.stdout).toContain("can't be focused automatically");
      expect(res.stdout).not.toContain(ESC);
    }

    for (const tty of ["tt" + ESC + "]0;pwn" + BEL + "ys1", "t".repeat(500)]) {
      writePanel({ pid: LIVE, term_program: "tmux", warp_focus_url: null, tty });
      const res = runGoto();
      expect(res.stdout).not.toContain(ESC);
      expect(res.stdout).not.toContain(BEL);
      expect(res.stdout.length).toBeLessThan(600);
    }
  });

  it("G8 malformed panel.json → no-panel message, nothing opened", () => {
    for (const raw of ["{", "null", "[]", '"str"']) {
      writeRaw(raw);
      const res = runGoto();
      expect(res.status).toBe(0);
      expect(res.stdout, raw).toContain("No CSM panel is running");
    }
    const base = { term_program: "WarpTerminal", warp_focus_url: "warp://session/p1" };
    for (const pid of [String(LIVE), -5, 1.5, 0, 1]) {
      writePanel({ ...base, pid });
      const res = runGoto();
      expect(res.stdout, String(pid)).toContain("No CSM panel is running");
    }
    writePanel(base); // missing pid
    expect(runGoto().stdout).toContain("No CSM panel is running");
    expect(opened()).toEqual([]);
  });

  it("G9 extra argv is ignored", () => {
    writePanel(WARP_PANEL);
    const res = runGoto("some-folder", "abc");
    expect(res.status).toBe(0);
    expect(opened()).toEqual(["warp://session/p1"]);
  });

  it("G10 a failing opener still exits 0 with a clear message", () => {
    writePanel(WARP_PANEL);
    const res = runGotoEnv({ CSM_OPEN_CMD: "/usr/bin/false" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Could not focus the CSM panel");
  });

  it("G11 read-only: panel.json unchanged, no new store entries", () => {
    writePanel(WARP_PANEL);
    const before = fs.readFileSync(panelFile());
    runGoto();
    expect(fs.readFileSync(panelFile()).equals(before)).toBe(true);
    expect(fs.readdirSync(tmp).sort()).toEqual(["open-stub.sh", "open.log", "panel.json"]);
  });

  it("G12 source + command guards (stdlib only, no shell, no-arg command)", () => {
    const src = fs.readFileSync(csmGoto, "utf8");
    const specs = [...src.matchAll(/import\s[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) {
      expect(s.startsWith("node:"), s).toBe(true);
      expect(s).not.toContain("src/");
    }
    expect(src).not.toMatch(/\bshell\s*:/);
    expect(src).not.toMatch(/\bexecSync\b/);
    expect(src).not.toMatch(/\bexec\(/);

    const md = fs.readFileSync(commandMd, "utf8");
    const lines = md.split("\n");
    const first = lines.indexOf("---");
    const second = lines.indexOf("---", first + 1);
    expect(first).toBe(0);
    expect(second).toBeGreaterThan(first);
    const front = lines.slice(first + 1, second).join("\n");
    expect(front).not.toMatch(/argument-hint/);
    expect(front).toMatch(/^description:.*panel/m);
    expect(md).not.toContain("$ARGUMENTS");
    const bang = lines.filter((l) => l.startsWith("!"));
    expect(bang).toEqual(['!`node "${CLAUDE_PLUGIN_ROOT}/scripts/csm-goto.mjs"`']);
  });
});
