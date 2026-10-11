import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FOLDER_CAP,
  LAST_PROMPT_CAP,
  RESUME_LIST_N,
  RESUME_VISIBLE_ROWS,
  discoverSessions,
  fmtAge,
  followOffset,
  reconcileSelection,
  registryDirs,
  resetSessionsCache,
  resumeLabel,
  resumeScanMs,
  type DiscoverOptions,
  type ResumeRow,
} from "./sessions.js";
import { NAME_CAP, UNNAMED } from "./label.js";

// 08-03: read-only resume-session discovery. Every fixture lives under a
// realpath'd mkdtemp dir and every scan passes explicit roots / registryDirs,
// so no test ever reads or writes the developer's real ~/.claude tree.

const NL = String.fromCharCode(10);
const ELLIPSIS = "…";

let tmp: string;
let root: string;
let reg: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "csm-sess-")));
  root = path.join(tmp, "projects");
  reg = path.join(tmp, "sessions");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(reg, { recursive: true });
});

afterEach(() => {
  resetSessionsCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Distinct lowercase UUID ids. */
function id(n: number): string {
  return `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
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
  sid?: string;
  mtimeSec?: number;
  padBytes?: number;
  dir?: string;
};

function writeSession(slug: string, sessionId: string, spec: Spec = {}): string {
  const base = spec.dir ?? root;
  const dir = path.join(base, slug);
  fs.mkdirSync(dir, { recursive: true });
  const sid = spec.sid ?? sessionId;
  const cwd = spec.cwd === undefined ? `/work/${slug}` : spec.cwd;
  const ep = spec.entrypoint ?? "cli";
  const lines: string[] = [];
  if (spec.padBytes !== undefined && spec.padBytes > 0) {
    const chunk = "x".repeat(1000);
    for (let b = 0; b < spec.padBytes; b += 1000) {
      lines.push(JSON.stringify({ type: "attachment", sessionId: sid, attachment: { content: chunk } }));
    }
  }
  const carrier = (o: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...o, sessionId: sid, entrypoint: ep };
    if (cwd !== null) out.cwd = cwd;
    return out;
  };
  lines.push(
    JSON.stringify(
      carrier({ type: "user", message: { role: "user", content: spec.firstPrompt ?? CLEAR_WRAPPER } }),
    ),
  );
  if (spec.assistant !== false) {
    lines.push(
      JSON.stringify(
        carrier({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
      ),
    );
  }
  if (spec.customTitle !== undefined) {
    lines.push(JSON.stringify({ type: "custom-title", customTitle: spec.customTitle, sessionId: sid }));
  }
  if (spec.aiTitle !== undefined) {
    lines.push(JSON.stringify({ type: "ai-title", aiTitle: spec.aiTitle, sessionId: sid }));
  }
  if (spec.lastPrompt !== undefined) {
    lines.push(JSON.stringify({ type: "last-prompt", lastPrompt: spec.lastPrompt, sessionId: sid }));
  }
  const p = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, lines.join(NL) + NL);
  if (spec.mtimeSec !== undefined) fs.utimesSync(p, spec.mtimeSec, spec.mtimeSec);
  return p;
}

function scan(extra: Partial<DiscoverOptions> = {}): Promise<ResumeRow[]> {
  return discoverSessions({ roots: [root], registryDirs: [reg], probe: () => false, ...extra });
}

function ids(rows: ResumeRow[]): string[] {
  return rows.map((r) => r.id);
}

describe("constants", () => {
  it("pins the list and cap sizes", () => {
    expect(RESUME_LIST_N).toBe(50);
    expect(RESUME_VISIBLE_ROWS).toBe(10);
    expect(FOLDER_CAP).toBe(16);
    expect(LAST_PROMPT_CAP).toBe(48);
  });
});

describe("discoverSessions", () => {
  it("D1 (D-02) lists every root's transcripts newest-first by mtime", async () => {
    writeSession("alpha", id(1), { mtimeSec: 100 });
    writeSession("alpha", id(2), { mtimeSec: 300 });
    writeSession("beta", id(3), { mtimeSec: 200 });
    const rows = await scan();
    expect(ids(rows)).toEqual([id(2), id(3), id(1)]);
    expect(rows[0]).toMatchObject({ id: id(2), folder: "alpha", cwd: "/work/alpha", mtimeMs: 300_000 });
    expect(rows[1]).toMatchObject({ id: id(3), folder: "beta", cwd: "/work/beta", mtimeMs: 200_000 });
    expect(rows[2]).toMatchObject({ id: id(1), folder: "alpha", cwd: "/work/alpha", mtimeMs: 100_000 });
  });

  it("D2 ignores subagents, tool-results, non-UUID names, symlinked files and symlinked slugs", async () => {
    const slugDir = path.join(root, "proj");
    writeSession(path.join("proj", id(1), "subagents"), id(2));
    writeSession(path.join("proj", "tool-results"), id(3));
    fs.renameSync(path.join(slugDir, "tool-results", `${id(3)}.jsonl`), path.join(slugDir, "tool-results", "x.jsonl"));
    fs.copyFileSync(path.join(slugDir, id(1), "subagents", `${id(2)}.jsonl`), path.join(slugDir, "notes.jsonl"));
    const elsewhere = path.join(tmp, "elsewhere");
    const target = writeSession("e", id(4), { dir: elsewhere });
    fs.symlinkSync(target, path.join(slugDir, `${id(4)}.jsonl`));
    const elsewhere2 = path.join(tmp, "elsewhere2");
    writeSession("real", id(5), { dir: elsewhere2 });
    fs.symlinkSync(path.join(elsewhere2, "real"), path.join(root, "linkslug"));
    const rows = await scan();
    expect(rows).toEqual([]);
  });

  it("D3 (D-01) excludes sdk-* entrypoints read from the tail; cli and claude-desktop are listed", async () => {
    writeSession("p", id(1), { entrypoint: "sdk-cli", padBytes: 100 * 1024, mtimeSec: 300 });
    writeSession("p", id(2), { entrypoint: "cli", mtimeSec: 200 });
    writeSession("p", id(3), { entrypoint: "claude-desktop", mtimeSec: 100 });
    const rows = await scan();
    expect(ids(rows)).toEqual([id(2), id(3)]);
  });

  it("D4 (D-01) the sdk verdict is sticky per path until resetSessionsCache()", async () => {
    writeSession("p", id(1), { entrypoint: "sdk-ts", mtimeSec: 100 });
    expect(await scan()).toEqual([]);
    writeSession("p", id(1), { entrypoint: "cli", mtimeSec: 500 });
    expect(await scan()).toEqual([]);
    resetSessionsCache();
    expect(ids(await scan())).toEqual([id(1)]);
  });

  it("D5 (D-04) hides sessions without an assistant line unless they carry a custom title", async () => {
    writeSession("p", id(1), { assistant: false, mtimeSec: 300 });
    writeSession("p", id(2), { assistant: false, customTitle: "Named", mtimeSec: 200 });
    writeSession("p", id(3), { assistant: false, customTitle: "\u0001\u0002\u0007", mtimeSec: 100 });
    const rows = await scan();
    expect(ids(rows)).toEqual([id(2)]);
    expect(rows[0]).toMatchObject({ label: "Named", labelKind: "name" });
  });

  it("D6 (D-06) label chain: custom-title, ai-title, first prompt, unnamed", async () => {
    writeSession("p", id(1), { customTitle: "Name", aiTitle: "AI", mtimeSec: 400 });
    writeSession("p", id(2), { aiTitle: "GEO servisi", mtimeSec: 300 });
    writeSession("p", id(3), {
      firstPrompt:
        "<command-message>gsd-discuss-phase</command-message>" +
        NL +
        "<command-name>/gsd-discuss-phase</command-name>" +
        NL +
        "<command-args>8</command-args>",
      mtimeSec: 200,
    });
    writeSession("p", id(4), { mtimeSec: 100 });
    const rows = await scan();
    expect(rows.map((r) => [r.label, r.labelKind])).toEqual([
      ["Name", "name"],
      ["GEO servisi", "derived"],
      ["/gsd-discuss-phase 8", "derived"],
      [UNNAMED, "unnamed"],
    ]);
    expect(UNNAMED).toBe("(unnamed)");
  });

  it("D7 (D-09) labels are cleaned then capped at NAME_CAP", async () => {
    writeSession("p", id(1), { aiTitle: "a".repeat(40), mtimeSec: 200 });
    writeSession("p", id(2), { aiTitle: "evil\u001b[31mred‮txt\u0085x", mtimeSec: 100 });
    const rows = await scan();
    expect(rows[0]!.label).toBe("a".repeat(NAME_CAP) + ELLIPSIS);
    const label = rows[1]!.label;
    for (const ch of label) {
      const cp = ch.codePointAt(0)!;
      expect(cp >= 0x20).toBe(true);
      expect(cp >= 0x80 && cp <= 0x9f).toBe(false);
      expect(cp).not.toBe(0x202e);
    }
    expect(label).toContain("red");
  });

  it("D8 (D-03) returns only the newest n with no time cutoff", async () => {
    for (let i = 1; i <= 25; i++) writeSession("p", id(i), { mtimeSec: 1000 + i });
    const rows = await scan({ n: 20 });
    expect(rows).toHaveLength(20);
    expect(ids(rows)).toEqual(Array.from({ length: 20 }, (_, k) => id(25 - k)));
  });

  it("D8b (D-03) a 60-day-old session is listed when it is within the newest n", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    writeSession("p", id(1), { mtimeSec: nowSec - 60 * 86400 });
    writeSession("p", id(2), { mtimeSec: nowSec - 10 });
    const rows = await scan({ n: 5 });
    expect(ids(rows)).toEqual([id(2), id(1)]);
  });

  it("D9 a warm scan reuses cached facts while (size, mtime) is unchanged", async () => {
    writeSession("p", id(1), { aiTitle: "Alpha", mtimeSec: 100 });
    expect((await scan())[0]!.label).toBe("Alpha");
    writeSession("p", id(1), { aiTitle: "Bravo", mtimeSec: 100 });
    expect((await scan())[0]!.label).toBe("Alpha");
    writeSession("p", id(1), { aiTitle: "Bravo", mtimeSec: 200 });
    expect((await scan())[0]!.label).toBe("Bravo");
  });

  it("D10 a deleted transcript drops out of the next scan", async () => {
    const p = writeSession("p", id(1), { mtimeSec: 100 });
    writeSession("p", id(2), { mtimeSec: 200 });
    expect(ids(await scan())).toEqual([id(2), id(1)]);
    fs.rmSync(p);
    expect(ids(await scan())).toEqual([id(2)]);
  });

  it("D11 (D-11) live = registry <pid>.json with a live pid, or a liveIds member; *.key never counts", async () => {
    for (let i = 1; i <= 6; i++) writeSession("p", id(i), { mtimeSec: 100 + i });
    fs.writeFileSync(path.join(reg, "4242.json"), JSON.stringify({ pid: 4242, sessionId: id(1) }));
    fs.writeFileSync(path.join(reg, "4343.json"), JSON.stringify({ pid: 4343, sessionId: id(2) }));
    fs.writeFileSync(path.join(reg, "4242.abc123.key"), JSON.stringify({ pid: 4242, sessionId: id(3) }));
    fs.writeFileSync(path.join(reg, "5000.json"), JSON.stringify({ pid: 4242, sessionId: id(4) }));
    const rows = await scan({ probe: (pid) => pid === 4242, liveIds: new Set([id(5)]) });
    const live = Object.fromEntries(rows.map((r) => [r.id, r.live]));
    expect(live).toEqual({
      [id(1)]: true,
      [id(2)]: false,
      [id(3)]: false,
      [id(4)]: false,
      [id(5)]: true,
      [id(6)]: false,
    });
  });

  it("D12 (RESUME-03 / D-12) a session with no liveness signal is still listed, live false; row keys are fixed", async () => {
    writeSession("p", id(1), { mtimeSec: 100, lastPrompt: "hi" });
    const rows = await scan();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.live).toBe(false);
    const allowed = new Set(["id", "label", "labelKind", "folder", "cwd", "mtimeMs", "live", "lastPrompt"]);
    for (const k of Object.keys(rows[0]!)) expect(allowed.has(k)).toBe(true);
    for (const k of ["id", "label", "labelKind", "folder", "mtimeMs", "live"]) {
      expect(Object.keys(rows[0]!)).toContain(k);
    }
  });

  it("D13 folder = capped basename of cwd, else the slug", async () => {
    writeSession("p", id(1), { cwd: "/Users/x/mvp-dashboard-beta-extra-long", mtimeSec: 200 });
    writeSession("myslug", id(2), { cwd: null, mtimeSec: 100 });
    const rows = await scan();
    expect(rows[0]!.folder).toBe("mvp-dashboard-be" + ELLIPSIS);
    expect(Array.from(rows[0]!.folder)).toHaveLength(FOLDER_CAP + 1);
    expect(rows[1]!.folder).toBe("myslug");
    expect(rows[1]!.cwd).toBeUndefined();
  });

  it("D14 lastPrompt is cleaned and capped at LAST_PROMPT_CAP", async () => {
    writeSession("p", id(1), { lastPrompt: "where did I leave off", mtimeSec: 300 });
    writeSession("p", id(2), { lastPrompt: "b".repeat(100), mtimeSec: 200 });
    writeSession("p", id(3), { mtimeSec: 100 });
    const rows = await scan();
    expect(rows[0]!.lastPrompt).toBe("where did I leave off");
    expect(rows[1]!.lastPrompt).toBe("b".repeat(LAST_PROMPT_CAP) + ELLIPSIS);
    expect(rows[2]!.lastPrompt).toBeUndefined();
  });

  it("D15 lines whose sessionId differs from the filename yield no facts (hidden)", async () => {
    writeSession("p", id(1), { sid: "bbbbbbbb-0000-4000-8000-000000000099", customTitle: "Spoof", mtimeSec: 100 });
    expect(await scan()).toEqual([]);
  });

  it("D16 the same id under two roots is listed once with the newer mtime", async () => {
    const root2 = path.join(tmp, "projects2");
    writeSession("old", id(1), { mtimeSec: 100, cwd: "/work/old" });
    writeSession("new", id(1), { mtimeSec: 500, cwd: "/work/new", dir: root2 });
    const rows = await discoverSessions({ roots: [root, root2], registryDirs: [reg], probe: () => false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: id(1), mtimeMs: 500_000, folder: "new", cwd: "/work/new" });
  });

  it("D17 missing or non-directory roots resolve [] without rejecting", async () => {
    const file = path.join(tmp, "plain.txt");
    fs.writeFileSync(file, "x");
    await expect(
      discoverSessions({ roots: [path.join(tmp, "missing"), file], registryDirs: [path.join(tmp, "nope")] }),
    ).resolves.toEqual([]);
  });
});

describe("resumeLabel", () => {
  it("applies the D-06 chain with clean-then-cap", () => {
    expect(resumeLabel({ customTitle: "  A  ", aiTitle: "B", firstPrompt: "C" })).toEqual({ label: "A", labelKind: "name" });
    expect(resumeLabel({ customTitle: "\u0001", aiTitle: "B" })).toEqual({ label: "B", labelKind: "derived" });
    expect(resumeLabel({ firstPrompt: "C" })).toEqual({ label: "C", labelKind: "derived" });
    expect(resumeLabel({})).toEqual({ label: UNNAMED, labelKind: "unnamed" });
  });
});

describe("fmtAge (D-13)", () => {
  it("F1 renders s, m, h, d and clamps the future to 0s", () => {
    const now = 1_000_000_000;
    expect(fmtAge(now, now)).toBe("0s");
    expect(fmtAge(now - 59_000, now)).toBe("59s");
    expect(fmtAge(now - 60_000, now)).toBe("1m");
    expect(fmtAge(now - 3_599_000, now)).toBe("59m");
    expect(fmtAge(now - 3_600_000, now)).toBe("1h");
    expect(fmtAge(now - 86_399_000, now)).toBe("23h");
    expect(fmtAge(now - 86_400_000, now)).toBe("1d");
    expect(fmtAge(now + 5_000, now)).toBe("0s");
  });
});

describe("resumeScanMs (D-19)", () => {
  const ORIG = process.env.CSM_RESUME_SCAN_MS;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.CSM_RESUME_SCAN_MS;
    else process.env.CSM_RESUME_SCAN_MS = ORIG;
  });

  it("F2 defaults to 10000 and honors a numeric override", () => {
    delete process.env.CSM_RESUME_SCAN_MS;
    expect(resumeScanMs()).toBe(10000);
    process.env.CSM_RESUME_SCAN_MS = "abc";
    expect(resumeScanMs()).toBe(10000);
    process.env.CSM_RESUME_SCAN_MS = "2500";
    expect(resumeScanMs()).toBe(2500);
  });
});

describe("selection helpers (D-17)", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("S1 reconcileSelection keeps the id across reorders and clamps when it vanishes", () => {
    expect(reconcileSelection([], "x", 3)).toEqual({ selId: null, idx: -1 });
    expect(reconcileSelection(rows, null, 0)).toEqual({ selId: "a", idx: 0 });
    expect(reconcileSelection(rows, "c", 0)).toEqual({ selId: "c", idx: 2 });
    expect(reconcileSelection([{ id: "a" }, { id: "b" }], "gone", 1)).toEqual({ selId: "b", idx: 1 });
    expect(reconcileSelection(rows, "gone", 9)).toEqual({ selId: "c", idx: 2 });
  });

  it("S2 followOffset keeps the cursor inside the visible window", () => {
    expect(followOffset(0, 5, 30, 10)).toBe(0);
    expect(followOffset(14, 0, 30, 10)).toBe(5);
    expect(followOffset(29, 25, 30, 10)).toBe(20);
    expect(followOffset(3, 0, 5, 10)).toBe(0);
  });
});

describe("registryDirs", () => {
  const ORIG_HOME = process.env.HOME;
  const ORIG_CFG = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (ORIG_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIG_HOME;
    if (ORIG_CFG === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = ORIG_CFG;
  });

  it("R1 lists ~/.claude/sessions plus $CLAUDE_CONFIG_DIR/sessions, deduplicated", () => {
    process.env.HOME = tmp;
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, ".claude");
    expect(registryDirs()).toEqual([path.join(tmp, ".claude", "sessions")]);
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "cfg");
    expect(registryDirs()).toEqual([path.join(tmp, ".claude", "sessions"), path.join(tmp, "cfg", "sessions")]);
  });
});
