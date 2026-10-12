import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// P1/P2 parity only: the panel reducer and resume line, compared against the /csm-resume script.
import { discoverSessions, resetSessionsCache } from "./sessions.js";
import { resumeCommand } from "./panel/launch.js";

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

type Segment = { cwd: string | null; padBefore?: number };

/**
 * 08-10 (WR-04 parity): same shape as the 08-09 sessions.test.ts helper. Each
 * segment writes `padBefore` bytes of cwd-less attachment lines, then one user
 * line (a real prompt) and one assistant line carrying that cwd (null omits it).
 */
function writeDrift(
  root: string,
  slug: string,
  sessionId: string,
  segments: Segment[],
  extra: { aiTitle?: string; mtimeSec?: number } = {},
): string {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  segments.forEach((seg, i) => {
    const chunk = "x".repeat(1000);
    for (let b = 0; b < (seg.padBefore ?? 0); b += 1000) {
      lines.push(JSON.stringify({ type: "attachment", sessionId, attachment: { content: chunk } }));
    }
    const base: Record<string, unknown> = { sessionId, entrypoint: "cli" };
    if (seg.cwd !== null) base.cwd = seg.cwd;
    lines.push(JSON.stringify({ ...base, type: "user", message: { role: "user", content: `step ${i + 1}` } }));
    lines.push(
      JSON.stringify({ ...base, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
    );
  });
  if (extra.aiTitle !== undefined) {
    lines.push(JSON.stringify({ type: "ai-title", aiTitle: extra.aiTitle, sessionId }));
  }
  const p = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, lines.join(NL) + NL);
  if (extra.mtimeSec !== undefined) fs.utimesSync(p, extra.mtimeSec, extra.mtimeSec);
  return p;
}

/**
 * D-10 REVISED resume line: `  cd '<cwd>' && claude --resume <uuid>` (each `'`
 * written as `'\''`) or the plain `  claude --resume <uuid>`. Group 1 = id.
 */
const RESUME_LINE =
  /^ {2}(?:cd '(?:[^']|'\\'')*' && )?claude --resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

type Block = { line1: string; last?: string; id?: string; cmd?: string; lastIdx?: number; line1Idx: number };

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
    } else {
      const m = RESUME_LINE.exec(l);
      if (m !== null) {
        b.id = m[1];
        b.cmd = l.slice(2);
      }
    }
  }
  return { header, blocks, lines };
}

function blockOf(stdout: string, sid: string): Block | undefined {
  return parse(stdout).blocks.find((b) => b.id === sid);
}

function resumeIds(stdout: string): string[] {
  const out: string[] = [];
  for (const l of stdout.split(NL)) {
    const m = RESUME_LINE.exec(l);
    if (m !== null) out.push(m[1]!);
  }
  return out;
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
    const want = [
      `  cd '/work/beta' && claude --resume ${id(3)}`,
      `  cd '/work/gamma' && claude --resume ${id(2)}`,
      `  cd '/work/alpha' && claude --resume ${id(1)}`,
    ];
    expect(lines.filter((x) => RESUME_LINE.test(x))).toEqual(want);
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
    // T-08-42: the control-character cwd is never printed; the row gets the plain line.
    expect(blockOf(r.stdout, id(1))!.cmd).toBe(`claude --resume ${id(1)}`);
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
    expect(r.stdout.split(NL).filter((l) => RESUME_LINE.test(l))).toHaveLength(20);
    expect(resumeIds(r.stdout)[0]).toBe(id(25));
  });

  it("S11 (RESUME-03): a crashed session is listed unmarked with its resume line", () => {
    writeSession(rootA, "-work-a", id(1), { aiTitle: "Crashed" });
    const r = run();
    const b = blockOf(r.stdout, id(1))!;
    expect(b.line1).not.toContain("live");
    expect(r.stdout).toContain(`  cd '/work/-work-a' && claude --resume ${id(1)}${NL}`);
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
      expect(b.cmd).toBe(resumeCommand(row.id, row.cwd));
    }
  });

  it("S15 (IN-06): no backtick from transcript text reaches stdout", () => {
    writeSession(rootA, "-work-a", id(1), { customTitle: "```evil", lastPrompt: "run `rm -rf` now", mtimeSec: T0 + 2 });
    writeSession(rootA, "-work-b", id(2), { aiTitle: "a`b", mtimeSec: T0 + 1 });
    const r = run();
    expect(r.status).toBe(0);
    expect(resumeIds(r.stdout)).toEqual([id(1), id(2)]);
    expect(r.stdout).not.toContain("`");
    expect(blockOf(r.stdout, id(1))!.line1.startsWith("\u02cb\u02cb\u02cbevil")).toBe(true);
    expect(blockOf(r.stdout, id(1))!.last).toBe(`  ↳ last: ${LQ}run \u02cbrm -rf\u02cb now${RQ}`);
    expect(blockOf(r.stdout, id(2))!.line1.startsWith(`${LQ}a\u02cbb${RQ} · `)).toBe(true);
  });

  it("S16 (T-08-42): a cwd with a backtick or backslash gets the plain resume line", () => {
    writeSession(rootA, "-work-a-b", id(1), { aiTitle: "Tick", cwd: "/work/a`b", mtimeSec: T0 + 2 });
    writeSession(rootA, "-work-a-c", id(2), { aiTitle: "Slash", cwd: "/work/a\\b", mtimeSec: T0 + 1 });
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("`");
    expect(blockOf(r.stdout, id(1))!.cmd).toBe(`claude --resume ${id(1)}`);
    expect(blockOf(r.stdout, id(2))!.cmd).toBe(`claude --resume ${id(2)}`);
  });

  it("P2 (WR-04): drifted, tail-only, unmatched, quoted, unsafe and cwd-less sessions match the panel", async () => {
    writeDrift(rootA, "-work-alpha", id(1), [{ cwd: "/work/alpha" }, { cwd: "/work/alpha/frontend" }, { cwd: "/work/other-repo" }], {
      mtimeSec: T0 + 8,
    });
    writeDrift(rootA, "-work-real", id(2), [{ cwd: "/scratch/ws-1" }, { cwd: "/work/real", padBefore: 300 * 1024 }], {
      mtimeSec: T0 + 7,
    });
    writeDrift(rootA, "proj", id(3), [{ cwd: "/elsewhere/a" }, { cwd: "/elsewhere/b" }], { mtimeSec: T0 + 6 });
    writeDrift(rootA, "-work-it-s-here", id(4), [{ cwd: "/work/it's here" }], { mtimeSec: T0 + 5 });
    writeDrift(rootA, "-work-a-b", id(5), [{ cwd: "/work/a\\b" }], { mtimeSec: T0 + 4 });
    writeDrift(rootA, "-work-none", id(6), [{ cwd: null }, { cwd: null }], { mtimeSec: T0 + 3 });
    // 08-09 D19 second fixture: the tail's first slug match wins over a later drift into a subfolder.
    writeDrift(
      rootA,
      "-work-real",
      id(7),
      [{ cwd: "/scratch/ws-1" }, { cwd: "/work/real", padBefore: 300 * 1024 }, { cwd: "/work/real/docs" }],
      { mtimeSec: T0 + 2 },
    );
    // 08-08 deviation: a trailing separator (path.normalize keeps it) is unusable.
    writeDrift(rootA, "-work-tr-", id(8), [{ cwd: "/work/tr/" }], { mtimeSec: T0 + 1 });

    const r = run();
    expect(r.status).toBe(0);
    resetSessionsCache();
    const rows = await discoverSessions({ roots: [rootA, rootB], registryDirs: [reg], n: 20 });
    expect(resumeIds(r.stdout)).toEqual(rows.map((x) => x.id));
    expect(rows.map((x) => x.id)).toEqual([id(1), id(2), id(3), id(4), id(5), id(6), id(7), id(8)]);
    for (const row of rows) {
      const b = blockOf(r.stdout, row.id)!;
      expect(b.cmd).toBe(resumeCommand(row.id, row.cwd));
      expect(b.line1).toContain(" · " + row.folder + " · ");
    }
    expect(rows.slice(0, 4).map((x) => x.cwd)).toEqual(["/work/alpha", "/work/real", "/elsewhere/a", "/work/it's here"]);
    expect(rows[6]!.cwd).toBe("/work/real");
    expect(blockOf(r.stdout, id(1))!.cmd).toBe(`cd '/work/alpha' && claude --resume ${id(1)}`);
    expect(blockOf(r.stdout, id(2))!.cmd).toBe(`cd '/work/real' && claude --resume ${id(2)}`);
    expect(blockOf(r.stdout, id(3))!.cmd).toBe(`cd '/elsewhere/a' && claude --resume ${id(3)}`);
    expect(blockOf(r.stdout, id(4))!.cmd).toBe(`cd '/work/it'\\''s here' && claude --resume ${id(4)}`);
    expect(blockOf(r.stdout, id(5))!.cmd).toBe(`claude --resume ${id(5)}`);
    expect(blockOf(r.stdout, id(6))!.cmd).toBe(`claude --resume ${id(6)}`);
    expect(blockOf(r.stdout, id(7))!.cmd).toBe(`cd '/work/real' && claude --resume ${id(7)}`);
    expect(blockOf(r.stdout, id(8))!.cmd).toBe(`claude --resume ${id(8)}`);
    expect(blockOf(r.stdout, id(1))!.line1).toContain(" · alpha · ");
  });
});
