import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FOLDER_CAP,
  LAST_PROMPT_CAP,
  MIN_RESUME_SCAN_MS,
  RESUME_LIST_N,
  RESUME_NAME_MAX_CP,
  RESUME_NAME_SCAN_BUDGET_MS,
  RESUME_NAME_SCAN_MAX_FILES,
  RESUME_VISIBLE_ROWS,
  discoverSessions,
  isSafeResumeName,
  listSlugCandidates,
  resumeExtras,
  resumeNameKey,
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
  /** quick-261014-fq8: extra custom-title lines appended after customTitle (last wins). */
  customTitles?: string[];
  /** quick-261014-fq8: `permission-mode` lines, in order, after the metadata. */
  permissionModes?: string[];
  /** quick-261014-fq8: bytes of attachment padding after the mode lines. */
  padAfter?: number;
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
  for (const t of spec.customTitles ?? []) {
    lines.push(JSON.stringify({ type: "custom-title", customTitle: t, sessionId: sid }));
  }
  for (const m of spec.permissionModes ?? []) {
    lines.push(JSON.stringify({ type: "permission-mode", permissionMode: m, sessionId: sid }));
  }
  if (spec.padAfter !== undefined && spec.padAfter > 0) {
    const chunk = "x".repeat(1000);
    for (let b = 0; b < spec.padAfter; b += 1000) {
      lines.push(JSON.stringify({ type: "attachment", sessionId: sid, attachment: { content: chunk } }));
    }
  }
  const p = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, lines.join(NL) + NL);
  if (spec.mtimeSec !== undefined) fs.utimesSync(p, spec.mtimeSec, spec.mtimeSec);
  return p;
}

type Segment = { cwd: string; padBefore?: number };

/**
 * 08-09 (WR-04): a transcript whose cwd drifts. Each segment writes
 * `padBefore` bytes of cwd-less attachment lines, then one user line (a real
 * prompt) and one assistant line carrying that cwd (entrypoint "cli").
 */
function writeDrift(
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
    const base = { sessionId, entrypoint: "cli", cwd: seg.cwd };
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
    // quick-261014-fq8: rows also carry the candidate slug (deliberate key-set change).
    const allowed = new Set(["id", "label", "labelKind", "folder", "cwd", "mtimeMs", "live", "lastPrompt", "slug"]);
    for (const k of Object.keys(rows[0]!)) expect(allowed.has(k)).toBe(true);
    expect(rows[0]!.slug).toBe("p");
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

  it("D18 (WR-04) a drifting session keeps the slug-matched head cwd as folder and cwd", async () => {
    writeDrift("-work-alpha", id(1), [{ cwd: "/work/alpha" }, { cwd: "/work/alpha/frontend" }, { cwd: "/work/other-repo" }], {
      mtimeSec: 100,
    });
    const rows = await scan();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: id(1), cwd: "/work/alpha", folder: "alpha", label: "step 1" });
  });

  it("D19 (WR-04) a slug-matching cwd seen only beyond the head window comes from the tail", async () => {
    writeDrift("-work-real", id(1), [{ cwd: "/scratch/ws-1" }, { cwd: "/work/real", padBefore: 300 * 1024 }], {
      mtimeSec: 200,
    });
    // The tail's first slug match wins over a later drift inside the tail.
    writeDrift(
      "-work-real",
      id(2),
      [{ cwd: "/scratch/ws-1" }, { cwd: "/work/real", padBefore: 300 * 1024 }, { cwd: "/work/real/docs" }],
      { mtimeSec: 100 },
    );
    const rows = await scan();
    expect(rows[0]).toMatchObject({ id: id(1), cwd: "/work/real", folder: "real" });
    expect(rows[1]).toMatchObject({ id: id(2), cwd: "/work/real", folder: "real" });
  });

  it("D20 (WR-04) with no slug match anywhere the first head cwd is used", async () => {
    writeDrift("proj", id(1), [{ cwd: "/elsewhere/a" }, { cwd: "/elsewhere/b" }], { mtimeSec: 100 });
    const rows = await scan();
    expect(rows[0]).toMatchObject({ cwd: "/elsewhere/a", folder: "a" });
  });

  it("D21 (WR-04) among several slug-matching cwds the head-first occurrence wins", async () => {
    writeDrift("-work-a-b", id(1), [{ cwd: "/work/a/b" }, { cwd: "/work/a-b" }], { mtimeSec: 100 });
    const rows = await scan();
    expect(rows[0]).toMatchObject({ cwd: "/work/a/b", folder: "b" });
  });

  it("D22 (WR-04) a later drift appended after a final head scan keeps the cached head cwd", async () => {
    const p = writeDrift("-work-alpha", id(1), [{ cwd: "/work/alpha" }, { cwd: "/work/alpha/frontend" }], {
      mtimeSec: 100,
    });
    expect((await scan())[0]).toMatchObject({ cwd: "/work/alpha", folder: "alpha" });
    const base = { sessionId: id(1), entrypoint: "cli", cwd: "/work/other-repo" };
    fs.appendFileSync(
      p,
      JSON.stringify({ ...base, type: "user", message: { role: "user", content: "later" } }) +
        NL +
        JSON.stringify({ ...base, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) +
        NL,
    );
    fs.utimesSync(p, 200, 200);
    const rows = await scan();
    expect(rows[0]).toMatchObject({ cwd: "/work/alpha", folder: "alpha", mtimeMs: 200_000, label: "step 1" });
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

describe("resumeScanMs floor (WR-05)", () => {
  const ORIG = process.env.CSM_RESUME_SCAN_MS;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.CSM_RESUME_SCAN_MS;
    else process.env.CSM_RESUME_SCAN_MS = ORIG;
  });

  it("F3 never returns less than MIN_RESUME_SCAN_MS", () => {
    expect(MIN_RESUME_SCAN_MS).toBe(1000);
    const cases: Array<[string | undefined, number]> = [
      ["0", 1000],
      ["500", 1000],
      ["999", 1000],
      ["1000", 1000],
      ["2500", 2500],
      [undefined, 10000],
      ["abc", 10000],
    ];
    for (const [value, want] of cases) {
      if (value === undefined) delete process.env.CSM_RESUME_SCAN_MS;
      else process.env.CSM_RESUME_SCAN_MS = value;
      expect(resumeScanMs()).toBe(want);
    }
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

// quick-261014-fq8: rule (d) name safety and the rule (c) comparison key.
describe("isSafeResumeName / resumeNameKey", () => {
  it("N1 accepts plain names up to RESUME_NAME_MAX_CP code points", () => {
    expect(RESUME_NAME_MAX_CP).toBe(100);
    for (const ok of ["My name", "auth-fix_v2", "\u00f6deme ak\u0131\u015f\u0131", "a".repeat(100), "\u00e9t\u00e9 2026"]) {
      expect(isSafeResumeName(ok)).toBe(true);
    }
  });

  it("N2 rejects everything that is not plain, clean, short and paste-safe", () => {
    const bad: unknown[] = [
      undefined,
      null,
      42,
      {},
      "",
      " lead",
      "trail ",
      "double  space",
      "it's",
      'say "hi"',
      "back\\slash",
      "tick`x",
      "bang!",
      "$HOME",
      "-x",
      "a\u0001b",
      "a\u001bb",
      "a\u007fb",
      "a\u0085b",
      "a\u009bb",
      "a\u200bb",
      "a\u200db",
      "a\ufe0fb",
      "a\u202eb",
      "a\ufeffb",
      "a\u00a0b",
      "a\u2028b",
      "a\ue000b",
      "a\ud800b",
      "e\u0301",
      "a".repeat(101),
      "11111111-2222-3333-4444-555555555555",
      "ABCDEF12-2222-3333-4444-555555555555",
    ];
    for (const b of bad) expect(isSafeResumeName(b), JSON.stringify(b)).toBe(false);
  });

  it("N3 resumeNameKey trims, collapses, NFKC-folds and lower-cases", () => {
    expect(resumeNameKey("  Auth  Fix ")).toBe(resumeNameKey("auth fix"));
    expect(resumeNameKey("  Auth  Fix ")).toBe("auth fix");
    expect(resumeNameKey("\uff21\uff35\uff34\uff28")).toBe(resumeNameKey("auth"));
    expect(resumeNameKey(undefined)).toBe("");
    expect(resumeNameKey(7)).toBe("");
  });
});

// quick-261014-fq8: on-demand name + bypass facts for the copied resume line.
describe("resumeExtras", () => {
  const SLUG = "-work-proj";
  const CWD = "/work/proj";
  let root2: string;

  beforeEach(() => {
    root2 = path.join(tmp, "projects2");
    fs.mkdirSync(root2, { recursive: true });
  });

  const extras = (n: number, over: { slug?: string; cwd?: string | undefined } = {}, opts: { now?: () => number } = {}) =>
    resumeExtras(
      { id: id(n), slug: "slug" in over ? over.slug : SLUG, cwd: "cwd" in over ? over.cwd : CWD },
      { roots: [root, root2], ...opts },
    );

  it("E1 a unique safe custom title gives the FULL name; the latest title wins", async () => {
    const name = "Session " + "n".repeat(32);
    expect(Array.from(name)).toHaveLength(40);
    writeSession(SLUG, id(1), { cwd: CWD, customTitle: name, mtimeSec: 200 });
    expect(await extras(1)).toEqual({ name, bypass: false });
    writeSession(SLUG, id(2), { cwd: CWD, customTitle: "Old name", customTitles: ["New name"], mtimeSec: 100 });
    expect((await extras(2)).name).toBe("New name");
    const rows = await scan();
    expect(rows.map((r) => r.slug)).toEqual([SLUG, SLUG]);
    expect(rows[0]!.label).not.toBe(name); // the panel label is capped; the line uses the full name
  });

  it("E2 a case/space duplicate in the slug (either root, sdk included) drops the name; another slug does not", async () => {
    writeSession(SLUG, id(1), { cwd: CWD, customTitle: "Auth fix" });
    writeSession("-work-other", id(9), { cwd: "/work/other", customTitle: "Auth fix" });
    expect((await extras(1)).name).toBe("Auth fix");

    writeSession(SLUG, id(2), { cwd: CWD, customTitle: "auth  FIX" });
    resetSessionsCache();
    expect((await extras(1)).name).toBeUndefined();
    expect((await extras(2)).name).toBeUndefined();
    fs.rmSync(path.join(root, SLUG, `${id(2)}.jsonl`));

    writeSession(SLUG, id(3), { cwd: CWD, customTitle: "AUTH FIX", dir: root2 });
    expect((await extras(1)).name).toBeUndefined();
    fs.rmSync(path.join(root2, SLUG, `${id(3)}.jsonl`));

    writeSession(SLUG, id(4), { cwd: CWD, customTitle: "Auth fix", entrypoint: "sdk-cli" });
    expect((await extras(1)).name).toBeUndefined();
    fs.rmSync(path.join(root, SLUG, `${id(4)}.jsonl`));

    expect((await extras(1)).name).toBe("Auth fix");
  });

  it("E3 unsafe titles, ai-title only, no cwd and a slug-mismatched cwd give no name", async () => {
    writeSession(SLUG, id(1), { cwd: CWD, customTitle: "it's" });
    writeSession(SLUG, id(2), { cwd: CWD, customTitle: "$HOME" });
    writeSession(SLUG, id(3), { cwd: CWD, customTitle: "-x" });
    writeSession(SLUG, id(4), { cwd: CWD, aiTitle: "Derived only" });
    writeSession(SLUG, id(5), { cwd: CWD, customTitle: "Fine name" });
    for (const n of [1, 2, 3, 4]) expect(await extras(n)).toEqual({ bypass: false });
    expect((await extras(5)).name).toBe("Fine name");
    expect(await extras(5, { cwd: undefined })).toEqual({ bypass: false });
    expect(await extras(5, { cwd: "/work/elsewhere" })).toEqual({ bypass: false });
    expect(await extras(5, { cwd: "/work/proj/" })).toEqual({ bypass: false });
  });

  it("E4 more than RESUME_NAME_SCAN_MAX_FILES siblings or an exhausted budget gives no name", async () => {
    expect(RESUME_NAME_SCAN_MAX_FILES).toBe(256);
    expect(RESUME_NAME_SCAN_BUDGET_MS).toBe(1500);
    writeSession(SLUG, id(1), { cwd: CWD, customTitle: "Crowded" });
    const dir = path.join(root, SLUG);
    const tiny = (n: number): void =>
      fs.writeFileSync(path.join(dir, `${id(n)}.jsonl`), JSON.stringify({ type: "user", sessionId: id(n) }) + NL);
    for (let i = 0; i < RESUME_NAME_SCAN_MAX_FILES; i++) tiny(1000 + i);
    expect((await extras(1, {}, { now: () => 0 })).name).toBe("Crowded");
    tiny(5000);
    expect((await extras(1, {}, { now: () => 0 })).name).toBeUndefined();
    fs.rmSync(path.join(dir, `${id(5000)}.jsonl`));

    let calls = 0;
    const jump = (): number => (calls++ === 0 ? 0 : RESUME_NAME_SCAN_BUDGET_MS + 1);
    resetSessionsCache();
    expect((await extras(1, {}, { now: jump })).name).toBeUndefined();
  });

  it("E5 bypass follows the newest mode record, also behind 300 KiB of padding", async () => {
    writeSession(SLUG, id(1), { cwd: CWD, permissionModes: ["default", "bypassPermissions"] });
    writeSession(SLUG, id(2), { cwd: CWD, permissionModes: ["bypassPermissions", "default"] });
    writeSession(SLUG, id(3), { cwd: CWD });
    writeSession(SLUG, id(4), { cwd: CWD, permissionModes: ["bypassPermissions"], padAfter: 300 * 1024 });
    expect(await extras(1)).toEqual({ bypass: true });
    expect(await extras(2)).toEqual({ bypass: false });
    expect(await extras(3)).toEqual({ bypass: false });
    expect(await extras(4)).toEqual({ bypass: true });
    writeSession(SLUG, id(5), { cwd: CWD, customTitle: "Named bypass", permissionModes: ["bypassPermissions"] });
    expect(await extras(5)).toEqual({ name: "Named bypass", bypass: true });
  });

  it("E6 invalid ids, bad slugs, missing transcripts and symlinked slug dirs resolve { bypass: false }", async () => {
    writeSession(SLUG, id(1), { cwd: CWD, customTitle: "Real", permissionModes: ["bypassPermissions"] });
    const outside = path.join(tmp, "outside");
    writeSession("-work-link", id(2), {
      cwd: "/work/link",
      customTitle: "Linked",
      permissionModes: ["bypassPermissions"],
      dir: outside,
    });
    fs.symlinkSync(path.join(outside, "-work-link"), path.join(root, "-work-link"));
    const opts = { roots: [root, root2] };
    const cases: Array<{ id: string; slug?: string; cwd?: string }> = [
      { id: "not-a-uuid", slug: SLUG, cwd: CWD },
      { id: id(1).toUpperCase(), slug: SLUG, cwd: CWD },
      { id: id(1), slug: "..", cwd: CWD },
      { id: id(1), slug: ".", cwd: CWD },
      { id: id(1), slug: "a/b", cwd: CWD },
      { id: id(1), slug: "", cwd: CWD },
      { id: id(1), slug: undefined, cwd: CWD },
      { id: id(1), slug: "x\u0000y", cwd: CWD },
      { id: id(1), slug: "x".repeat(256), cwd: CWD },
      { id: id(7), slug: SLUG, cwd: CWD },
      { id: id(2), slug: "-work-link", cwd: "/work/link" },
    ];
    for (const c of cases) await expect(resumeExtras(c, opts)).resolves.toEqual({ bypass: false });
    await expect(resumeExtras(undefined as never, opts)).resolves.toEqual({ bypass: false });
    expect(await resumeExtras({ id: id(1), slug: SLUG, cwd: CWD }, opts)).toEqual({ name: "Real", bypass: true });
  });

  it("E7 a second call on unchanged siblings reuses the cached title keys", async () => {
    writeSession(SLUG, id(1), { cwd: CWD, customTitle: "Cached" });
    const sib = writeSession(SLUG, id(2), { cwd: CWD, customTitle: "Other" });
    expect((await extras(1)).name).toBe("Cached");
    fs.chmodSync(sib, 0o000);
    try {
      expect((await extras(1)).name).toBe("Cached"); // cache hit: the unreadable sibling is never opened
      resetSessionsCache();
      expect((await extras(1)).name).toBeUndefined(); // a miss must read it, fails, and drops the name
    } finally {
      fs.chmodSync(sib, 0o644);
    }
  });

  it("E8 listSlugCandidates lists the slug's regular <uuid>.jsonl files only", async () => {
    writeSession(SLUG, id(1), { cwd: CWD });
    fs.writeFileSync(path.join(root, SLUG, "notes.jsonl"), "x\n");
    fs.mkdirSync(path.join(root, SLUG, id(1)), { recursive: true });
    const list = await listSlugCandidates(root, SLUG);
    expect(list.map((c) => c.id)).toEqual([id(1)]);
    expect(list[0]!.slug).toBe(SLUG);
    expect(await listSlugCandidates(root, "-missing")).toEqual([]);
  });
});
