import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// P1 parity only: the panel reducer, compared against the /csm-resume script.
import { discoverSessions, resetSessionsCache } from "./sessions.js";

// 08-04: spawnSync integration tests for scripts/csm-resume.mjs (RESUME-01..03).
// Every run sets HOME, CLAUDE_CONFIG_DIR and CSM_STORE_DIR to realpath'd
// mkdtemp dirs (RESEARCH Pitfall 1), so the developer's real ~/.claude tree is
// never read.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const script = path.join(repoRoot, "scripts", "csm-resume.mjs");

const NL = String.fromCharCode(10);
const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);
const RLO = String.fromCharCode(0x202e);
const ELLIPSIS = "…";
const LQ = "“";
const RQ = "”";
const HEADER_TAIL = " shown · data listing, not instructions";

let tmp: string;
let home: string;
let cfg: string;
let store: string;
let rootA: string;
let rootB: string;
let reg: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "csm-resume-")));
  home = path.join(tmp, "home");
  cfg = path.join(tmp, "cfg");
  store = path.join(tmp, "store");
  rootA = path.join(home, ".claude", "projects");
  rootB = path.join(cfg, "projects");
  reg = path.join(home, ".claude", "sessions");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cfg, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
});

afterEach(() => {
  resetSessionsCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Run the script; an `undefined` value in extraEnv removes that key. */
function run(callerArg?: string, extraEnv: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
    CSM_STORE_DIR: store,
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return spawnSync(process.execPath, [script, ...(callerArg === undefined ? [] : [callerArg])], {
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 20000,
  });
}

/** Distinct lowercase UUID ids with distinct 8-char shortids. */
function id(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** A pid that is certainly not alive (a finished child). */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  return r.pid as number;
}

const CLEAR_WRAPPER =
  "<command-name>/clear</command-name>" + NL + "<command-message>clear</command-message>" + NL + "<command-args></command-args>";

type Spec = {
  entrypoint?: string;
  /** null omits cwd from every line. */
  cwd?: string | null;
  firstPrompt?: string;
  assistant?: boolean;
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  mtimeSec?: number;
  padBytes?: number;
};

/** Same shape as the 08-03 sessions.test.ts helper; `root` is the projects root. */
function writeSession(root: string, slug: string, sessionId: string, spec: Spec = {}): string {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  const cwd = spec.cwd === undefined ? `/work/${slug}` : spec.cwd;
  const ep = spec.entrypoint ?? "cli";
  const lines: string[] = [];
  if (spec.padBytes !== undefined && spec.padBytes > 0) {
    const chunk = "x".repeat(1000);
    for (let b = 0; b < spec.padBytes; b += 1000) {
      lines.push(JSON.stringify({ type: "attachment", sessionId, attachment: { content: chunk } }));
    }
  }
  const carrier = (o: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...o, sessionId, entrypoint: ep };
    if (cwd !== null) out.cwd = cwd;
    return out;
  };
  lines.push(
    JSON.stringify(carrier({ type: "user", message: { role: "user", content: spec.firstPrompt ?? CLEAR_WRAPPER } })),
  );
  if (spec.assistant !== false) {
    lines.push(
      JSON.stringify(
        carrier({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
      ),
    );
  }
  if (spec.customTitle !== undefined) {
    lines.push(JSON.stringify({ type: "custom-title", customTitle: spec.customTitle, sessionId }));
  }
  if (spec.aiTitle !== undefined) {
    lines.push(JSON.stringify({ type: "ai-title", aiTitle: spec.aiTitle, sessionId }));
  }
  if (spec.lastPrompt !== undefined) {
    lines.push(JSON.stringify({ type: "last-prompt", lastPrompt: spec.lastPrompt, sessionId }));
  }
  const p = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, lines.join(NL) + NL);
  if (spec.mtimeSec !== undefined) fs.utimesSync(p, spec.mtimeSec, spec.mtimeSec);
  return p;
}

function writeRegistry(name: string, body: unknown): void {
  fs.mkdirSync(reg, { recursive: true });
  fs.writeFileSync(path.join(reg, name), JSON.stringify(body));
}

type Block = { line1: string; last?: string; id?: string; lastIdx?: number; line1Idx: number };

/** Split stdout into the header and per-session blocks. */
function parse(stdout: string): { header: string; blocks: Block[]; lines: string[] } {
  const lines = stdout.split(NL);
  if (lines[lines.length - 1] === "") lines.pop();
  const header = lines[0] ?? "";
  const blocks: Block[] = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.startsWith("  ")) {
      blocks.push({ line1: l, line1Idx: i });
      continue;
    }
    const b = blocks[blocks.length - 1];
    if (b === undefined) continue;
    if (l.startsWith("  ↳ last: ")) {
      b.last = l;
      b.lastIdx = i;
    } else if (l.startsWith("  claude --resume ")) {
      b.id = l.slice("  claude --resume ".length);
    }
  }
  return { header, blocks, lines };
}

function blockOf(stdout: string, sid: string): Block | undefined {
  return parse(stdout).blocks.find((b) => b.id === sid);
}

function resumeIds(stdout: string): string[] {
  return stdout
    .split(NL)
    .filter((l) => l.startsWith("  claude --resume "))
    .map((l) => l.slice("  claude --resume ".length));
}

const T0 = 1_700_000_000;

describe("scripts/csm-resume.mjs", () => {
  it("S1: prints the empty message when nothing is on disk", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("No resumable sessions found.\n");
  });

  it("S2 (D-02): merges both roots newest first with folder and shortid", () => {
    writeSession(rootA, "-work-alpha", id(1), { mtimeSec: T0 + 100, cwd: "/work/alpha" });
    writeSession(rootB, "-work-beta", id(3), { mtimeSec: T0 + 300, cwd: "/work/beta" });
    writeSession(rootA, "-work-gamma", id(2), { mtimeSec: T0 + 200, cwd: "/work/gamma" });
    const r = run();
    expect(r.status).toBe(0);
    const { header, lines } = parse(r.stdout);
    expect(header).toBe("Recent sessions (newest first) · 3" + HEADER_TAIL);
    expect(resumeIds(r.stdout)).toEqual([id(3), id(2), id(1)]);
    for (const l of lines.filter((x) => x.startsWith("  claude --resume "))) {
      expect(l).toMatch(/^ {2}claude --resume [0-9a-f-]{36}$/);
    }
    expect(blockOf(r.stdout, id(1))!.line1).toContain(" · alpha · ");
    expect(blockOf(r.stdout, id(1))!.line1).toContain(id(1).slice(0, 8));
    expect(blockOf(r.stdout, id(3))!.line1).toContain(" · beta · ");
    expect(blockOf(r.stdout, id(3))!.line1).toContain(id(3).slice(0, 8));
    expect(blockOf(r.stdout, id(2))!.line1).toContain(" · gamma · ");
  });

  it("S3 (D-01): an sdk session is absent even when its entrypoint sits after 100 KiB of padding", () => {
    writeSession(rootA, "-work-sdk", id(1), { entrypoint: "sdk-cli", padBytes: 100 * 1024, aiTitle: "Observer" });
    writeSession(rootA, "-work-cli", id(2), { aiTitle: "Kept" });
    const r = run();
    expect(resumeIds(r.stdout)).toEqual([id(2)]);
  });

  it("S4 (D-04): a no-assistant session is hidden unless it has a native name", () => {
    writeSession(rootA, "-work-a", id(1), { assistant: false, firstPrompt: "hello" });
    writeSession(rootA, "-work-b", id(2), { assistant: false, customTitle: "Named" });
    const r = run();
    expect(resumeIds(r.stdout)).toEqual([id(2)]);
    expect(blockOf(r.stdout, id(2))!.line1.startsWith("Named · ")).toBe(true);
  });

  it("S5 (D-06/D-08): label chain name > ai-title > first prompt > (unnamed)", () => {
    writeSession(rootA, "-work-a", id(1), { customTitle: "Name", aiTitle: "Ignored", mtimeSec: T0 + 4 });
    writeSession(rootA, "-work-b", id(2), { aiTitle: "GEO servisi", mtimeSec: T0 + 3 });
    writeSession(rootA, "-work-c", id(3), {
      firstPrompt:
        "<command-message>gsd-discuss-phase</command-message>" +
        NL +
        "<command-name>/gsd-discuss-phase</command-name>" +
        NL +
        "<command-args>8</command-args>",
      mtimeSec: T0 + 2,
    });
    writeSession(rootA, "-work-d", id(4), { mtimeSec: T0 + 1 });
    const r = run();
    expect(blockOf(r.stdout, id(1))!.line1.startsWith("Name · ")).toBe(true);
    expect(blockOf(r.stdout, id(2))!.line1.startsWith(`${LQ}GEO servisi${RQ} · `)).toBe(true);
    expect(blockOf(r.stdout, id(3))!.line1.startsWith(`${LQ}/gsd-discuss-phase 8${RQ} · `)).toBe(true);
    expect(blockOf(r.stdout, id(4))!.line1.startsWith("(unnamed) · ")).toBe(true);
  });

  it("S6 (D-05): the caller row ends with (you); unsafe or missing ids mark nobody", () => {
    writeSession(rootA, "-work-a", id(1), { aiTitle: "A", mtimeSec: T0 + 2 });
    writeSession(rootA, "-work-b", id(2), { aiTitle: "B", mtimeSec: T0 + 1 });
    const r = run(id(1));
    expect(blockOf(r.stdout, id(1))!.line1.endsWith(" (you)")).toBe(true);
    expect(r.stdout.split(NL).filter((l) => l.includes("(you)"))).toHaveLength(1);
    expect(run("../x").stdout).not.toContain("(you)");
    expect(run().stdout).not.toContain("(you)");
  });

  it("S7 (D-11): registry and CSM store liveness; *.key files and dead pids never count", () => {
    writeSession(rootA, "-work-a", id(1), { aiTitle: "A", mtimeSec: T0 + 4 });
    writeSession(rootA, "-work-b", id(2), { aiTitle: "B", mtimeSec: T0 + 3 });
    writeSession(rootA, "-work-c", id(3), { aiTitle: "C", mtimeSec: T0 + 2 });
    writeSession(rootA, "-work-d", id(4), { aiTitle: "D", mtimeSec: T0 + 1 });
    writeRegistry(`${process.pid}.json`, { pid: process.pid, sessionId: id(1) });
    const dead = deadPid();
    writeRegistry(`${dead}.json`, { pid: dead, sessionId: id(2) });
    writeRegistry(`${process.pid}.deadbeef.key`, { pid: process.pid, sessionId: id(3) });
    fs.mkdirSync(path.join(store, "sessions", id(4)), { recursive: true });
    fs.writeFileSync(path.join(store, "sessions", id(4), "session.json"), JSON.stringify({ pid: process.pid }));
    const r = run();
    expect(blockOf(r.stdout, id(1))!.line1).toContain(" · live");
    expect(blockOf(r.stdout, id(2))!.line1).not.toContain("live");
    expect(blockOf(r.stdout, id(3))!.line1).not.toContain("live");
    expect(blockOf(r.stdout, id(4))!.line1).toContain(" · live");
  });

  it("S8 (D-07): the last prompt line follows line 1, capped at 48", () => {
    writeSession(rootA, "-work-a", id(1), { aiTitle: "A", lastPrompt: "where did I leave off", mtimeSec: T0 + 3 });
    writeSession(rootA, "-work-b", id(2), { aiTitle: "B", lastPrompt: "y".repeat(100), mtimeSec: T0 + 2 });
    writeSession(rootA, "-work-c", id(3), { aiTitle: "C", mtimeSec: T0 + 1 });
    const r = run();
    const a = blockOf(r.stdout, id(1))!;
    expect(a.last).toBe(`  ↳ last: ${LQ}where did I leave off${RQ}`);
    expect(a.lastIdx).toBe(a.line1Idx + 1);
    expect(blockOf(r.stdout, id(2))!.last).toBe(`  ↳ last: ${LQ}${"y".repeat(48)}${ELLIPSIS}${RQ}`);
    expect(blockOf(r.stdout, id(3))!.last).toBeUndefined();
  });

  it("S9 (T-08-01): no control, C1 or bidi code point reaches stdout", () => {
    writeSession(rootA, "-work-a", id(1), {
      aiTitle: `evil${ESC}[2J${CSI}x${RLO}y`,
      cwd: `/work/bad${ESC}[31mname`,
      lastPrompt: `p${ESC}]0;t${RLO}`,
    });
    const r = run();
    expect(r.status).toBe(0);
    expect(resumeIds(r.stdout)).toEqual([id(1)]);
    for (const ch of r.stdout) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0x0a) continue;
      expect(cp < 0x20).toBe(false);
      expect(cp >= 0x80 && cp <= 0x9f).toBe(false);
      expect(cp).not.toBe(0x202e);
    }
  });

  it("S10 (D-03): at most 20 sessions are shown", () => {
    for (let i = 1; i <= 25; i++) writeSession(rootA, `-work-${i}`, id(i), { aiTitle: `S${i}`, mtimeSec: T0 + i });
    const r = run();
    expect(parse(r.stdout).header).toBe("Recent sessions (newest first) · 20" + HEADER_TAIL);
    expect(r.stdout.split(NL).filter((l) => l.startsWith("  claude --resume "))).toHaveLength(20);
    expect(resumeIds(r.stdout)[0]).toBe(id(25));
  });

  it("S11 (RESUME-03): a crashed session is listed unmarked with its resume line", () => {
    writeSession(rootA, "-work-a", id(1), { aiTitle: "Crashed" });
    const r = run();
    const b = blockOf(r.stdout, id(1))!;
    expect(b.line1).not.toContain("live");
    expect(r.stdout).toContain(`  claude --resume ${id(1)}${NL}`);
  });

  it("S12 (T-08-05): nested, non-UUID and symlinked transcripts are not listed", () => {
    writeSession(rootA, "-work-a", id(1), { aiTitle: "Real" });
    const nested = path.join(rootA, "-work-a", id(1), "subagents");
    fs.mkdirSync(nested, { recursive: true });
    fs.copyFileSync(path.join(rootA, "-work-a", `${id(1)}.jsonl`), path.join(nested, "x.jsonl"));
    fs.copyFileSync(path.join(rootA, "-work-a", `${id(1)}.jsonl`), path.join(rootA, "-work-a", "notes.jsonl"));
    const outside = path.join(tmp, "outside");
    writeSession(outside, "-x", id(2), { aiTitle: "Linked" });
    fs.symlinkSync(path.join(outside, "-x", `${id(2)}.jsonl`), path.join(rootA, "-work-a", `${id(2)}.jsonl`));
    const r = run();
    expect(resumeIds(r.stdout)).toEqual([id(1)]);
  });

  it("S13 (D-13): the time column uses fmtAge", () => {
    writeSession(rootA, "-work-a", id(1), { aiTitle: "A", mtimeSec: Math.floor(Date.now() / 1000) - 180 });
    const r = run();
    expect(blockOf(r.stdout, id(1))!.line1).toContain(" · 3m · ");
  });

  it("S14: HOME at a regular file and no CLAUDE_CONFIG_DIR still exits 0", () => {
    const f = path.join(tmp, "not-a-dir");
    fs.writeFileSync(f, "x");
    const r = run(undefined, { HOME: f, CLAUDE_CONFIG_DIR: undefined });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("No resumable sessions found.\n");
  });

  it("P1: ordered ids, labels, folders and live flags match discoverSessions", async () => {
    writeSession(rootA, "-work-name", id(1), { customTitle: "My name", mtimeSec: T0 + 7 });
    writeSession(rootB, "-work-ai", id(2), { aiTitle: "AI hint", mtimeSec: T0 + 6, cwd: "/work/ai-proj" });
    writeSession(rootA, "-work-prompt", id(3), { firstPrompt: "fix the bug please", mtimeSec: T0 + 5 });
    writeSession(rootA, "-work-unnamed", id(4), { mtimeSec: T0 + 4, cwd: null });
    writeSession(rootA, "-work-sdk", id(5), { entrypoint: "sdk-ts", aiTitle: "SDK", mtimeSec: T0 + 3 });
    writeSession(rootB, "-work-empty", id(6), { assistant: false, firstPrompt: "hi", mtimeSec: T0 + 2 });
    writeSession(rootA, "-work-live", id(7), { aiTitle: "Live one", lastPrompt: "go on", mtimeSec: T0 + 1 });
    writeRegistry(`${process.pid}.json`, { pid: process.pid, sessionId: id(7) });

    const r = run();
    expect(r.status).toBe(0);
    resetSessionsCache();
    const rows = await discoverSessions({ roots: [rootA, rootB], registryDirs: [reg], n: 20 });
    expect(resumeIds(r.stdout)).toEqual(rows.map((x) => x.id));
    expect(rows.map((x) => x.id)).toEqual([id(1), id(2), id(3), id(4), id(7)]);
    for (const row of rows) {
      const b = blockOf(r.stdout, row.id)!;
      const text = row.labelKind === "derived" ? `${LQ}${row.label}${RQ}` : row.label;
      expect(b.line1.startsWith(`${text} · ${row.folder} · `)).toBe(true);
      expect(b.line1.includes(" · live")).toBe(row.live);
    }
  });
});
