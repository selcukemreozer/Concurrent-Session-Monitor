import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HEAD_BYTES,
  MAX_SCAN_LINE,
  MAX_TITLE_LINE,
  PERMISSION_MODE_BYTES,
  SESSION_UUID_PATTERN,
  TAIL_BYTES,
  TRIVIAL_COMMANDS,
  isAllowedTranscriptPath,
  projectRoots,
  projectSlug,
  promptLabel,
  pruneTranscriptTitleCache,
  readFirstPromptAsync,
  readHeadFactsAsync,
  readPermissionModeAsync,
  readTailCustomTitle,
  readTailFactsAsync,
  readTranscriptCard,
  readTranscriptTitle,
  resetTranscriptTitleCache,
  scanCardFacts,
  scanCustomTitle,
  scanFirstPrompt,
  scanHeadFacts,
  scanPermissionMode,
  scanTailFacts,
} from "./transcript.js";

// 07-03 (D-04): bounded, change-gated, path-guarded transcript-tail reader for
// the native `/rename` custom-title line. Every fixture lives under a mkdtemp
// dir exported as CLAUDE_CONFIG_DIR, so `<raw>/projects` is an allowed root.

const NL = String.fromCharCode(10);
const ID = "11111111-2222-3333-4444-555555555555";

let raw: string;
const extraDirs: string[] = [];
const ORIG_HOME = process.env.HOME;

beforeEach(() => {
  raw = fs.mkdtempSync(path.join(os.tmpdir(), "csm-tr-"));
  process.env.CLAUDE_CONFIG_DIR = raw;
});

afterEach(() => {
  resetTranscriptTitleCache();
  delete process.env.CLAUDE_CONFIG_DIR;
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  fs.rmSync(raw, { recursive: true, force: true });
  while (extraDirs.length > 0) {
    const d = extraDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

/** A compact custom-title line, exactly as Claude Code appends it. */
function ct(title: unknown, sid?: string): string {
  return JSON.stringify({ type: "custom-title", customTitle: title, sessionId: sid });
}

/** A plain user line (no custom-title marker). */
function userLine(text: string): string {
  return JSON.stringify({ type: "user", message: { content: text } });
}

function body(lines: string[]): string {
  return lines.join(NL) + NL;
}

function transcriptPath(id: string, slug = "p"): string {
  return path.join(raw, "projects", slug, `${id}.jsonl`);
}

function writeTranscript(id: string, lines: string[], slug = "p", mtimeSec?: number): string {
  const p = transcriptPath(id, slug);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body(lines));
  if (mtimeSec !== undefined) fs.utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

function appendLines(p: string, lines: string[], mtimeSec?: number): void {
  fs.appendFileSync(p, body(lines));
  if (mtimeSec !== undefined) fs.utimesSync(p, mtimeSec, mtimeSec);
}

function buf(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

describe("constants", () => {
  it("pins the tail budget and the line cap", () => {
    expect(TAIL_BYTES).toBe(262144);
    expect(MAX_TITLE_LINE).toBe(4096);
  });
});

describe("scanCustomTitle", () => {
  it("S1: returns the LAST custom-title in the span", () => {
    const b = buf(body([ct("X", ID), userLine("hello"), ct("Y", ID)]));
    expect(scanCustomTitle(b, true, ID)).toBe("Y");
  });

  it("S2: ignores agent-name and ai-title lines (D-03)", () => {
    const b = buf(
      body([
        JSON.stringify({ type: "agent-name", agentName: "A", sessionId: ID }),
        JSON.stringify({ type: "ai-title", aiTitle: "B", sessionId: ID }),
      ]),
    );
    expect(scanCustomTitle(b, true, ID)).toBeUndefined();
  });

  it("S3: ignores an escaped custom-title mention inside message content", () => {
    const b = buf(body([JSON.stringify({ type: "user", message: { content: ct("evil", ID) } })]));
    expect(scanCustomTitle(b, true, ID)).toBeUndefined();
  });

  it("S4: ignores a foreign sessionId and accepts a missing sessionId", () => {
    expect(scanCustomTitle(buf(body([ct("Z", "other-id")])), true, ID)).toBeUndefined();
    const noSid = JSON.stringify({ type: "custom-title", customTitle: "NoSid" });
    expect(scanCustomTitle(buf(body([noSid])), true, ID)).toBe("NoSid");
    expect(scanCustomTitle(buf(body([ct("Mine", ID), ct("Z", "other-id")])), true, ID)).toBe("Mine");
  });

  it("S5: off-boundary windows drop the leading fragment", () => {
    const frag = "xyz" + ct("Frag", ID);
    expect(scanCustomTitle(buf(frag + NL + ct("Z", ID) + NL), false, ID)).toBe("Z");
    // The fragment is the only title: it must NOT be trusted.
    expect(scanCustomTitle(buf(ct("Frag", ID) + NL + userLine("u") + NL), false, ID)).toBeUndefined();
    // No newline at all and not at a boundary: nothing complete to read.
    expect(scanCustomTitle(buf(ct("Lone", ID)), false, ID)).toBeUndefined();
  });

  it("S6: a torn last line (no trailing newline) is ignored", () => {
    expect(scanCustomTitle(buf(ct("V", ID) + NL + ct("W", ID)), true, ID)).toBe("V");
  });

  it("S7: skips a custom-title line longer than MAX_TITLE_LINE", () => {
    const long = ct("x".repeat(5000), ID);
    expect(long.length).toBeGreaterThan(MAX_TITLE_LINE);
    expect(scanCustomTitle(buf(body([long])), true, ID)).toBeUndefined();
    expect(scanCustomTitle(buf(body([ct("Ok", ID), long])), true, ID)).toBe("Ok");
  });

  it("S8: skips a non-string customTitle", () => {
    expect(scanCustomTitle(buf(body([ct(5, ID)])), true, ID)).toBeUndefined();
  });

  it("skips malformed JSON without throwing", () => {
    const bad = '{"type":"custom-title","customTitle":"Broken"';
    expect(scanCustomTitle(buf(body([ct("Good", ID), bad])), true, ID)).toBe("Good");
  });
});

describe("readTranscriptTitle (cache)", () => {
  it("R1 (WR-01): a value found by the baseline scan has unknown age (changedAtMs -Infinity)", () => {
    const p = writeTranscript(ID, [ct("Alpha", ID)]);
    expect(readTranscriptTitle(ID, p)).toEqual({ title: "Alpha", changedAtMs: Number.NEGATIVE_INFINITY });
  });

  it("R1b (WR-01): a value first seen after the baseline scan carries the file mtime", () => {
    const p = writeTranscript(ID, [userLine("hi")], "p", 1700000000);
    expect(readTranscriptTitle(ID, p)).toBeUndefined();
    appendLines(p, [ct("Alpha", ID)], 1700000100);
    expect(readTranscriptTitle(ID, p)).toEqual({ title: "Alpha", changedAtMs: 1700000100000 });
  });

  it("R1c (WR-01): the first scan after a shrink is a baseline scan again", () => {
    const p = writeTranscript(ID, [userLine("a".repeat(200)), ct("Gone", ID)], "p", 1700000000);
    appendLines(p, [ct("Live", ID)], 1700000050);
    expect(readTranscriptTitle(ID, p)?.changedAtMs).toBe(Number.NEGATIVE_INFINITY);
    writeTranscript(ID, [ct("Rewritten", ID)], "p", 1700000100);
    expect(readTranscriptTitle(ID, p)).toEqual({ title: "Rewritten", changedAtMs: Number.NEGATIVE_INFINITY });
  });

  it("R2: change gate: unchanged (size, mtime) never re-reads the file", () => {
    const p = writeTranscript(ID, [ct("Aaaa", ID)], "p", 1700000000);
    expect(readTranscriptTitle(ID, p)?.title).toBe("Aaaa");
    writeTranscript(ID, [ct("Bbbb", ID)], "p", 1700000000);
    expect(readTranscriptTitle(ID, p)?.title).toBe("Aaaa");
  });

  it("R3: sticky: a changed tail with no custom-title keeps the previous value", () => {
    const p = writeTranscript(ID, [ct("Keep", ID)], "p", 1700000000);
    const first = readTranscriptTitle(ID, p);
    expect(first).toEqual({ title: "Keep", changedAtMs: Number.NEGATIVE_INFINITY });
    const filler: string[] = [];
    for (let i = 0; i < 100; i++) filler.push(userLine("u".repeat(3500)));
    appendLines(p, filler, 1700000050);
    expect(fs.statSync(p).size).toBeGreaterThan(300 * 1024);
    expect(readTranscriptTitle(ID, p)).toEqual({ title: "Keep", changedAtMs: Number.NEGATIVE_INFINITY });
  });

  it("R4: a changed value bumps changedAtMs, a re-append of the same value does not", () => {
    const p = writeTranscript(ID, [ct("First", ID)], "p", 1700000000);
    expect(readTranscriptTitle(ID, p)?.title).toBe("First");
    appendLines(p, [ct("Next", ID)], 1700000100);
    expect(readTranscriptTitle(ID, p)).toEqual({ title: "Next", changedAtMs: 1700000100000 });
    appendLines(p, [ct("Next", ID)], 1700000200);
    expect(readTranscriptTitle(ID, p)).toEqual({ title: "Next", changedAtMs: 1700000100000 });
  });

  it("R5: a shrunk file resets the cached value", () => {
    const p = writeTranscript(ID, [userLine("a".repeat(200)), ct("Gone", ID)], "p", 1700000000);
    expect(readTranscriptTitle(ID, p)?.title).toBe("Gone");
    writeTranscript(ID, [userLine("b")], "p", 1700000100);
    expect(readTranscriptTitle(ID, p)).toBeUndefined();
  });

  it("R6: a changed transcript path for the same id resets and re-reads", () => {
    const p = writeTranscript(ID, [ct("First", ID)], "p", 1700000000);
    expect(readTranscriptTitle(ID, p)?.title).toBe("First");
    const q = writeTranscript(ID, [ct("Other", ID)], "q", 1700000000);
    expect(readTranscriptTitle(ID, q)?.title).toBe("Other");
  });

  it("R7: bounded: the head beyond the budget is never read", () => {
    const filler: string[] = [];
    for (let i = 0; i < 8; i++) filler.push(userLine("f".repeat(500)));
    const p = writeTranscript(ID, [ct("Head", ID), ...filler]);
    expect(fs.statSync(p).size).toBeGreaterThan(4096);
    expect(readTranscriptTitle(ID, p, 1024)).toBeUndefined();
    // Sanity: the same file with the default budget does see the head line.
    resetTranscriptTitleCache();
    expect(readTranscriptTitle(ID, p)?.title).toBe("Head");
  });

  it("returns undefined for an absent file and never throws", () => {
    const p = transcriptPath(ID);
    expect(() => readTranscriptTitle(ID, p)).not.toThrow();
    expect(readTranscriptTitle(ID, p)).toBeUndefined();
  });

  it("drops the cached value once the file disappears", () => {
    const p = writeTranscript(ID, [ct("Here", ID)]);
    expect(readTranscriptTitle(ID, p)?.title).toBe("Here");
    fs.rmSync(p);
    expect(readTranscriptTitle(ID, p)).toBeUndefined();
  });
});

describe("path guards", () => {
  it("G1: rejects a relative path", () => {
    expect(readTranscriptTitle(ID, `projects/p/${ID}.jsonl`)).toBeUndefined();
    expect(isAllowedTranscriptPath(ID, `projects/p/${ID}.jsonl`)).toBeUndefined();
  });

  it("G2: rejects a basename that is not <id>.jsonl", () => {
    const p = path.join(raw, "projects", "p", "other.jsonl");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body([ct("Nope", ID)]));
    expect(readTranscriptTitle(ID, p)).toBeUndefined();
  });

  it("G3: rejects a non-normalized path", () => {
    writeTranscript(ID, [ct("Nope", ID)]);
    fs.mkdirSync(path.join(raw, "projects", "q"), { recursive: true });
    const p = `${raw}/projects/q/../p/${ID}.jsonl`;
    expect(readTranscriptTitle(ID, p)).toBeUndefined();
  });

  it("G4: rejects a file outside every allowed projects root", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "csm-tr-out-"));
    extraDirs.push(outside);
    const p = path.join(outside, "projects", "p", `${ID}.jsonl`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body([ct("Nope", ID)]));
    expect(readTranscriptTitle(ID, p)).toBeUndefined();
  });

  it("G5: rejects a symlink that escapes the root", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "csm-tr-out-"));
    extraDirs.push(outside);
    const target = path.join(outside, `${ID}.jsonl`);
    fs.writeFileSync(target, body([ct("Nope", ID)]));
    const p = transcriptPath(ID);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.symlinkSync(target, p);
    expect(isAllowedTranscriptPath(ID, p)).toBeUndefined();
    expect(readTranscriptTitle(ID, p)).toBeUndefined();
  });

  it("G6: a FIFO never blocks the reader", { timeout: 3000 }, () => {
    const p = transcriptPath(ID);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    execFileSync("mkfifo", [p]);
    expect(readTranscriptTitle(ID, p)).toBeUndefined();
    expect(readTailCustomTitle(p, ID)).toBeUndefined();
  });

  it("G7: rejects a missing or non-string transcript path", () => {
    expect(readTranscriptTitle(ID, undefined)).toBeUndefined();
    expect(readTranscriptTitle(ID, 42)).toBeUndefined();
    expect(isAllowedTranscriptPath(ID, 42)).toBeUndefined();
  });

  it("G8: rejects an unsafe session id", () => {
    const p = path.join(raw, "projects", "p", "x.jsonl");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body([ct("Nope")]));
    expect(readTranscriptTitle("../x", p)).toBeUndefined();
    expect(isAllowedTranscriptPath("..", path.join(raw, "projects", "p", "...jsonl"))).toBeUndefined();
  });

  it("G9: accepts a non-realpath CLAUDE_CONFIG_DIR (macOS /var vs /private/var)", () => {
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(raw);
    const p = writeTranscript(ID, [ct("Real", ID)]);
    const real = isAllowedTranscriptPath(ID, p);
    expect(real).toBe(fs.realpathSync(p));
    expect(readTranscriptTitle(ID, p)?.title).toBe("Real");
  });
});

describe("readTailCustomTitle", () => {
  it("is stateless and reports size and mtime", () => {
    const p = writeTranscript(ID, [ct("Tail", ID)], "p", 1700000000);
    const st = fs.statSync(p);
    expect(readTailCustomTitle(p, ID)).toEqual({ title: "Tail", size: st.size, mtimeMs: 1700000000000 });
  });

  it("returns undefined for an absent file", () => {
    expect(readTailCustomTitle(transcriptPath(ID), ID)).toBeUndefined();
  });
});

describe("cache pruning", () => {
  function primeStale(): string {
    const p = writeTranscript(ID, [ct("Aaaa", ID)], "p", 1700000000);
    expect(readTranscriptTitle(ID, p)?.title).toBe("Aaaa");
    writeTranscript(ID, [ct("Bbbb", ID)], "p", 1700000000);
    return p;
  }

  it("P1: pruning an id drops its cache entry", () => {
    const p = primeStale();
    pruneTranscriptTitleCache(new Set());
    expect(readTranscriptTitle(ID, p)?.title).toBe("Bbbb");
  });

  it("P2: resetTranscriptTitleCache clears every entry", () => {
    const p = primeStale();
    resetTranscriptTitleCache();
    expect(readTranscriptTitle(ID, p)?.title).toBe("Bbbb");
  });

  it("P3: pruning keeps ids in the keep set", () => {
    const p = primeStale();
    pruneTranscriptTitleCache(new Set([ID]));
    expect(readTranscriptTitle(ID, p)?.title).toBe("Aaaa");
  });
});

// ---------------------------------------------------------------------------
// 08-01 (RESUME-01/02 inputs): tail facts, prompt label, first prompt, and the
// bounded + guarded async window readers.
// ---------------------------------------------------------------------------

/** One padding line: an attachment line with no entrypoint, under 4096 chars. */
const PAD_LINE = JSON.stringify({ type: "attachment", sessionId: ID, attachment: { x: "x".repeat(1000) } });

function padding(kib: number): string[] {
  const out: string[] = [];
  let bytes = 0;
  while (bytes < kib * 1024) {
    out.push(PAD_LINE);
    bytes += PAD_LINE.length + 1;
  }
  return out;
}

/** A carrier line (user/assistant/attachment/system) with entrypoint + cwd. */
function carrier(type: string, entrypoint: string, cwd: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, entrypoint, cwd, sessionId: ID, ...extra });
}

/** A metadata line such as ai-title / last-prompt / custom-title. */
function meta(type: string, field: string, value: unknown, sid: string = ID): string {
  return JSON.stringify({ type, [field]: value, sessionId: sid });
}

/** A user prompt line with string content. */
function userText(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "user", message: { content: text }, sessionId: ID, ...extra });
}

/** Write raw/projects/<slug>/<ID>.jsonl from lines plus optional padding. */
function file(
  lines: unknown[],
  opts: { slug?: string; padKiB?: number; padAt?: "head" | "tail"; trailingNewline?: boolean } = {},
): string {
  const strs = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l)));
  const pad = opts.padKiB ? padding(opts.padKiB) : [];
  const all = opts.padAt === "tail" ? [...strs, ...pad] : [...pad, ...strs];
  const p = transcriptPath(ID, opts.slug ?? "p");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, all.join(NL) + (opts.trailingNewline === false ? "" : NL));
  return p;
}

function wrapper(parts: Array<"name" | "message" | "args">, name: string, args?: string, trailing = ""): string {
  const tag: Record<string, string> = {
    name: `<command-name>${name}</command-name>`,
    message: `<command-message>${name.replace(/^\//, "")}</command-message>`,
    args: `<command-args>${args ?? ""}</command-args>`,
  };
  return parts.map((p) => tag[p]).join(NL) + trailing;
}

describe("phase 8 constants", () => {
  it("pins the head budget and the scan line cap", () => {
    expect(HEAD_BYTES).toBe(262144);
    expect(MAX_SCAN_LINE).toBe(65536);
  });
});

describe("scanTailFacts", () => {
  it("F1: extracts every fact from one tail window", () => {
    const b = buf(
      body([
        carrier("user", "cli", "/a/proj"),
        carrier("assistant", "cli", "/a/proj"),
        meta("custom-title", "customTitle", "Name"),
        meta("ai-title", "aiTitle", "AI"),
        meta("last-prompt", "lastPrompt", "lp1"),
        JSON.stringify({ type: "last-prompt", leafUuid: "abc", sessionId: ID }),
      ]),
    );
    expect(scanTailFacts(b, true, ID)).toEqual({
      entrypoint: "cli",
      cwd: "/a/proj",
      hasAssistant: true,
      customTitle: "Name",
      aiTitle: "AI",
      lastPrompt: "lp1",
    });
  });

  it("F2: entrypoint and cwd are last-wins", () => {
    const b = buf(body([carrier("user", "cli", "/a"), carrier("attachment", "sdk-cli", "/b")]));
    const f = scanTailFacts(b, true, ID);
    expect(f.entrypoint).toBe("sdk-cli");
    expect(f.cwd).toBe("/b");
  });

  it("F3: hasAssistant needs a top-level assistant type, not an escaped mention", () => {
    expect(scanTailFacts(buf(body([carrier("user", "cli", "/a")])), true, ID).hasAssistant).toBe(false);
    const escaped = userText(carrier("assistant", "cli", "/a"));
    expect(scanTailFacts(buf(body([carrier("user", "cli", "/a"), escaped])), true, ID).hasAssistant).toBe(false);
  });

  it("F4: last ai-title wins, foreign sessionId ignored, missing sessionId accepted", () => {
    const b1 = buf(body([meta("ai-title", "aiTitle", "One"), meta("ai-title", "aiTitle", "Two")]));
    expect(scanTailFacts(b1, true, ID).aiTitle).toBe("Two");
    const b2 = buf(body([meta("ai-title", "aiTitle", "Mine"), meta("ai-title", "aiTitle", "Theirs", "other-id")]));
    expect(scanTailFacts(b2, true, ID).aiTitle).toBe("Mine");
    const noSid = JSON.stringify({ type: "ai-title", aiTitle: "NoSid" });
    expect(scanTailFacts(buf(body([noSid])), true, ID).aiTitle).toBe("NoSid");
  });

  it("F5: skips an over-long metadata line and an over-long carrier line", () => {
    const longMeta = meta("ai-title", "aiTitle", "a".repeat(5000));
    expect(longMeta.length).toBeGreaterThan(MAX_TITLE_LINE);
    expect(scanTailFacts(buf(body([longMeta])), true, ID).aiTitle).toBeUndefined();
    const longCarrier = carrier("user", "sdk-cli", "/x", { message: { content: "y".repeat(70000) } });
    expect(longCarrier.length).toBeGreaterThan(MAX_SCAN_LINE);
    const f = scanTailFacts(buf(body([carrier("user", "cli", "/a"), longCarrier])), true, ID);
    expect(f.entrypoint).toBe("cli");
    expect(f.cwd).toBe("/a");
  });

  it("F6: torn lines and junk are ignored", () => {
    const frag = "xx" + carrier("user", "frag", "/frag");
    const b = buf(frag + NL + carrier("user", "cli", "/a") + NL + carrier("user", "torn", "/t"));
    const f = scanTailFacts(b, false, ID);
    expect(f.entrypoint).toBe("cli");
    expect(f.cwd).toBe("/a");
    const junk = buf(
      body([meta("ai-title", "aiTitle", 5), "null", '{"type":"ai-title","aiTitle":"Broken"', carrier("user", "cli", "/a")]),
    );
    const j = scanTailFacts(junk, true, ID);
    expect(j.aiTitle).toBeUndefined();
    expect(j.entrypoint).toBe("cli");
  });
});

describe("promptLabel", () => {
  it("L1: string content, first text part, and the non-prompt cases", () => {
    expect(promptLabel({ type: "user", message: { content: "fix the bug" } })).toBe("fix the bug");
    expect(
      promptLabel({ type: "user", message: { content: [{ type: "image" }, { type: "text", text: "look" }] } }),
    ).toBe("look");
    expect(
      promptLabel({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } }),
    ).toBeUndefined();
    expect(promptLabel({ type: "user", isMeta: true, message: { content: "meta" } })).toBeUndefined();
    expect(promptLabel({ type: "assistant", message: { content: "hi" } })).toBeUndefined();
    expect(promptLabel("user")).toBeUndefined();
    expect(promptLabel(null)).toBeUndefined();
  });

  it("L2: noise prefixes yield no label", () => {
    const prefixes = [
      "<local-command-stdout>",
      "<local-command-stderr>",
      "<command-caveat>",
      "<system-reminder>",
      "<bash-input>",
      "<bash-stdout>",
      "<bash-stderr>",
    ];
    for (const pre of prefixes) {
      expect(promptLabel({ type: "user", message: { content: `${pre}x` } })).toBeUndefined();
      expect(promptLabel({ type: "user", message: { content: `  ${NL}${pre}x` } })).toBeUndefined();
    }
  });

  it("L3: a slash-command wrapper renders as /name args in every tag order", () => {
    const u = (text: string) => ({ type: "user", message: { content: text } });
    expect(promptLabel(u(wrapper(["name", "message", "args"], "/gsd-discuss-phase", "8")))).toBe("/gsd-discuss-phase 8");
    expect(promptLabel(u(wrapper(["message", "name", "args"], "/gsd-discuss-phase", "8")))).toBe("/gsd-discuss-phase 8");
    expect(
      promptLabel(u(wrapper(["message", "name", "args"], "/gsd-discuss-phase", "8", `${NL}more text`))),
    ).toBe("/gsd-discuss-phase 8");
    expect(promptLabel(u(wrapper(["message", "name"], "/gsd-discuss-phase")))).toBe("/gsd-discuss-phase");
    expect(promptLabel(u(wrapper(["name", "message"], "gsd-discuss-phase")))).toBe("/gsd-discuss-phase");
  });

  it("L4: trivial built-in commands yield no label", () => {
    const u = (text: string) => ({ type: "user", message: { content: text } });
    for (const name of ["clear", "reload-plugins", "model"]) {
      expect(promptLabel(u(wrapper(["name", "message", "args"], `/${name}`, "")))).toBeUndefined();
    }
    expect([...TRIVIAL_COMMANDS].sort()).toEqual(
      [
        "clear",
        "reload-plugins",
        "model",
        "effort",
        "compact",
        "resume",
        "exit",
        "config",
        "help",
        "status",
        "cost",
        "login",
        "logout",
      ].sort(),
    );
  });
});

describe("scanFirstPrompt", () => {
  it("H1: returns the first real prompt after attachments, meta and noise", () => {
    const b = buf(
      body([
        PAD_LINE,
        PAD_LINE,
        userText("caveat", { isMeta: true }),
        userText(wrapper(["name", "message", "args"], "/clear", "")),
        userText("<local-command-stdout>ok</local-command-stdout>"),
        userText("real prompt"),
        userText("second"),
      ]),
    );
    expect(scanFirstPrompt(b, ID)).toBe("real prompt");
  });

  it("H2: foreign sessionId, over-long lines and a torn last line are skipped", () => {
    const foreign = JSON.stringify({ type: "user", message: { content: "theirs" }, sessionId: "other-id" });
    expect(scanFirstPrompt(buf(body([foreign, userText("mine")])), ID)).toBe("mine");
    const long = userText("z".repeat(70000));
    expect(long.length).toBeGreaterThan(MAX_SCAN_LINE);
    expect(scanFirstPrompt(buf(body([long, userText("after")])), ID)).toBe("after");
    expect(scanFirstPrompt(buf(userText("torn")), ID)).toBeUndefined();
  });
});

describe("async window readers", () => {
  it("A1: readTailFactsAsync classifies from the tail and reports size and mtime", async () => {
    const p = file([carrier("user", "sdk-cli", "/sdk")], { padKiB: 300, padAt: "head" });
    const real = fs.realpathSync(p);
    const st = fs.statSync(real);
    expect(st.size).toBeGreaterThan(300 * 1024);
    const r = await readTailFactsAsync(real, ID);
    expect(r?.entrypoint).toBe("sdk-cli");
    expect(r?.cwd).toBe("/sdk");
    expect(r?.size).toBe(st.size);
    expect(r?.mtimeMs).toBe(st.mtimeMs);
  });

  it("A2: bounded: a fact outside the tail window is never seen", async () => {
    const p = file([meta("ai-title", "aiTitle", "Head")], { padKiB: 310, padAt: "tail" });
    const r = await readTailFactsAsync(fs.realpathSync(p), ID);
    expect(r).toBeDefined();
    expect(r?.aiTitle).toBeUndefined();

    const q = file([meta("ai-title", "aiTitle", "Near")], { padKiB: 2, padAt: "tail" });
    const real = fs.realpathSync(q);
    expect((await readTailFactsAsync(real, ID))?.aiTitle).toBe("Near");
    const small = await readTailFactsAsync(real, ID, 1024);
    expect(small).toBeDefined();
    expect(small?.aiTitle).toBeUndefined();
  });

  it("A3: readFirstPromptAsync reads one bounded head window", async () => {
    const p1 = file([userText("hello there")], { padKiB: 100, padAt: "head" });
    expect(await readFirstPromptAsync(fs.realpathSync(p1), ID)).toEqual({ prompt: "hello there", final: true });

    const p2 = file([userText("too late")], { padKiB: 300, padAt: "head" });
    expect(await readFirstPromptAsync(fs.realpathSync(p2), ID)).toEqual({ prompt: undefined, final: true });

    const p3 = file([userText("meta only", { isMeta: true })]);
    expect(await readFirstPromptAsync(fs.realpathSync(p3), ID)).toEqual({ prompt: undefined, final: false });
  });

  it("A4: a FIFO never blocks either async reader", { timeout: 3000 }, async () => {
    const p = transcriptPath(ID);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    execFileSync("mkfifo", [p]);
    const real = fs.realpathSync(p);
    expect(await readTailFactsAsync(real, ID)).toBeUndefined();
    expect(await readFirstPromptAsync(real, ID)).toBeUndefined();
  });

  it("A5: symlink, directory and missing paths resolve undefined without rejecting", async () => {
    const target = file([userText("hi"), carrier("user", "cli", "/a")]);
    const link = path.join(raw, "projects", "p", "link.jsonl");
    fs.symlinkSync(target, link);
    await expect(readTailFactsAsync(link, ID)).resolves.toBeUndefined();
    await expect(readFirstPromptAsync(link, ID)).resolves.toBeUndefined();

    const dir = path.join(raw, "projects", "dir");
    fs.mkdirSync(dir, { recursive: true });
    await expect(readTailFactsAsync(dir, ID)).resolves.toBeUndefined();
    await expect(readFirstPromptAsync(dir, ID)).resolves.toBeUndefined();

    const missing = path.join(raw, "projects", "p", "missing.jsonl");
    await expect(readTailFactsAsync(missing, ID)).resolves.toBeUndefined();
    await expect(readFirstPromptAsync(missing, ID)).resolves.toBeUndefined();
  });

  it("A6: explicit roots replace the default allowed roots", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "csm-tr-roots-"));
    extraDirs.push(other);
    const otherRoot = path.join(other, "projects");
    const inOther = path.join(otherRoot, "p", `${ID}.jsonl`);
    fs.mkdirSync(path.dirname(inOther), { recursive: true });
    fs.writeFileSync(inOther, body([userText("x")]));
    expect(isAllowedTranscriptPath(ID, inOther, [otherRoot])).toBe(fs.realpathSync(inOther));

    const inDefault = file([userText("y")]);
    expect(isAllowedTranscriptPath(ID, inDefault)).toBe(fs.realpathSync(inDefault));
    expect(isAllowedTranscriptPath(ID, inDefault, [otherRoot])).toBeUndefined();
  });

  it("A7: projectRoots deduplicates the realpath'd roots", () => {
    process.env.HOME = raw;
    process.env.CLAUDE_CONFIG_DIR = path.join(raw, ".claude");
    fs.mkdirSync(path.join(raw, ".claude", "projects"), { recursive: true });
    expect(projectRoots()).toEqual([fs.realpathSync(path.join(raw, ".claude", "projects"))]);
  });

  it("A8: SESSION_UUID_PATTERN accepts only a lowercase UUID", () => {
    expect(SESSION_UUID_PATTERN.test(ID)).toBe(true);
    expect(SESSION_UUID_PATTERN.test("-1111111-2222-3333-4444-555555555555")).toBe(false);
    expect(SESSION_UUID_PATTERN.test(ID.toUpperCase().replace(/1/g, "A"))).toBe(false);
    expect(SESSION_UUID_PATTERN.test("notes")).toBe(false);
    expect(SESSION_UUID_PATTERN.test(ID + NL)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 08-09 (WR-04 / D-10 REVISED): slug-matched session cwds from the bounded
// head and tail windows.
// ---------------------------------------------------------------------------

describe("projectSlug", () => {
  it("S-slug: every UTF-16 code unit outside [A-Za-z0-9] becomes one dash", () => {
    expect(projectSlug("/Users/x/Concurrent Session Monitor")).toBe("-Users-x-Concurrent-Session-Monitor");
    expect(projectSlug("/a/b.c_d")).toBe("-a-b-c-d");
    expect(projectSlug("/a/\u00f6")).toBe("-a--");
    expect(projectSlug("/a/\u{1F600}")).toBe("-a---");
    expect(projectSlug("/A9z")).toBe("-A9z");
  });
});

describe("scanHeadFacts", () => {
  it("H1: firstCwd is the first cwd, slugCwd the first slug-matching cwd", () => {
    const b = buf(
      body([
        PAD_LINE,
        carrier("user", "cli", "/other"),
        carrier("assistant", "cli", "/work/a/b"),
        carrier("user", "cli", "/work/a-b"),
      ]),
    );
    const f = scanHeadFacts(b, ID, "-work-a-b");
    expect(f.firstCwd).toBe("/other");
    expect(f.slugCwd).toBe("/work/a/b");
    expect(f.prompt).toBeUndefined();
    expect(scanHeadFacts(b, ID, "-nomatch")).toEqual({ firstCwd: "/other" });
  });

  it("H2: foreign, over-long, empty-cwd and unparseable lines are skipped", () => {
    const foreign = JSON.stringify({
      type: "user",
      cwd: "/work/a/b",
      message: { content: "theirs" },
      sessionId: "other-id",
    });
    const long = carrier("user", "cli", "/work.a.b", { message: { content: "z".repeat(70000) } });
    expect(long.length).toBeGreaterThan(MAX_SCAN_LINE);
    const empty = carrier("user", "cli", "", { message: { content: "blank cwd" } });
    const broken = '{"type":"user","cwd":"/work_a_b","message":{"content":"broken"}';
    const good = carrier("user", "cli", "/work-a-b", { message: { content: "mine" } });
    const f = scanHeadFacts(buf(body([foreign, long, broken, empty, good])), ID, "-work-a-b");
    expect(f.slugCwd).toBe("/work-a-b");
    expect(f.firstCwd).toBe("/work-a-b");
    expect(f.prompt).toBe("blank cwd");
    const g = scanHeadFacts(buf(body([foreign, long, broken, good])), ID, "-work-a-b");
    expect(g).toEqual({ prompt: "mine", firstCwd: "/work-a-b", slugCwd: "/work-a-b" });
  });

  it("H3: prompt equals scanFirstPrompt on the same window", () => {
    const foreign = JSON.stringify({ type: "user", message: { content: "theirs" }, sessionId: "other-id" });
    const fixtures = [
      body([
        PAD_LINE,
        PAD_LINE,
        userText("caveat", { isMeta: true }),
        userText(wrapper(["name", "message", "args"], "/clear", "")),
        userText("<local-command-stdout>ok</local-command-stdout>"),
        userText("real prompt"),
        userText("second"),
      ]),
      body([userText(wrapper(["message", "name", "args"], "/gsd-discuss-phase", "8"))]),
      body([foreign, userText("mine")]),
      body([userText("z".repeat(70000)), userText("after")]),
      userText("torn"),
      body([userText("meta only", { isMeta: true })]),
    ];
    for (const text of fixtures) {
      const b = buf(text);
      expect(scanHeadFacts(b, ID, "-x").prompt).toBe(scanFirstPrompt(b, ID));
    }
    expect(scanHeadFacts(buf(fixtures[0]!), ID, "-x").prompt).toBe("real prompt");
    expect(scanHeadFacts(buf(fixtures[1]!), ID, "-x").prompt).toBe("/gsd-discuss-phase 8");
  });
});

describe("readHeadFactsAsync", () => {
  it("H4: one bounded head window; final when the file exceeds the budget or both facts are known", async () => {
    const both = file([carrier("user", "cli", "/work/a-b", { message: { content: "hello" } })], { padKiB: 50 });
    expect(await readHeadFactsAsync(fs.realpathSync(both), ID, "-work-a-b")).toEqual({
      prompt: "hello",
      firstCwd: "/work/a-b",
      slugCwd: "/work/a-b",
      final: true,
    });

    const noSlug = file([carrier("user", "cli", "/elsewhere", { message: { content: "hello" } })]);
    expect(await readHeadFactsAsync(fs.realpathSync(noSlug), ID, "-work-a-b")).toEqual({
      prompt: "hello",
      firstCwd: "/elsewhere",
      final: false,
    });

    const noPrompt = file([carrier("assistant", "cli", "/work/a-b")]);
    expect(await readHeadFactsAsync(fs.realpathSync(noPrompt), ID, "-work-a-b")).toEqual({
      firstCwd: "/work/a-b",
      slugCwd: "/work/a-b",
      final: false,
    });

    const late = file([carrier("user", "cli", "/work/a-b", { message: { content: "late" } })], {
      padKiB: 300,
      padAt: "head",
    });
    expect(await readHeadFactsAsync(fs.realpathSync(late), ID, "-work-a-b")).toEqual({ final: true });

    const near = file([carrier("user", "cli", "/work/a-b", { message: { content: "near" } })], {
      padKiB: 4,
      padAt: "head",
    });
    expect(await readHeadFactsAsync(fs.realpathSync(near), ID, "-work-a-b", 1024)).toEqual({ final: true });
  });

  it("H4b: missing files and FIFOs resolve undefined without rejecting", { timeout: 3000 }, async () => {
    await expect(
      readHeadFactsAsync(path.join(raw, "projects", "p", "missing.jsonl"), ID, "-p"),
    ).resolves.toBeUndefined();
    const p = transcriptPath(ID);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    execFileSync("mkfifo", [p]);
    await expect(readHeadFactsAsync(fs.realpathSync(p), ID, "-p")).resolves.toBeUndefined();
  });
});

describe("tail slugCwd", () => {
  it("T-slug: slugCwd is the first slug-matching tail cwd; cwd stays last-wins", () => {
    const b = buf(
      body([
        carrier("user", "cli", "/a"),
        carrier("user", "cli", "/work/a/b"),
        carrier("assistant", "cli", "/work/a-b"),
        carrier("user", "cli", "/z"),
      ]),
    );
    const f = scanTailFacts(b, true, ID, "-work-a-b");
    expect(f.slugCwd).toBe("/work/a/b");
    expect(f.cwd).toBe("/z");
    expect(scanTailFacts(b, true, ID).slugCwd).toBeUndefined();
    expect(scanTailFacts(b, true, ID, "-nomatch").slugCwd).toBeUndefined();
    const withEmpty = buf(body([carrier("user", "cli", ""), carrier("user", "cli", "/q")]));
    expect(scanTailFacts(withEmpty, true, ID, "-q").slugCwd).toBe("/q");
  });

  it("T-slug async: readTailFactsAsync passes the slug through", async () => {
    const p = file([carrier("user", "cli", "/work/a/b"), carrier("user", "cli", "/z")], { padKiB: 300 });
    const real = fs.realpathSync(p);
    const r = await readTailFactsAsync(real, ID, TAIL_BYTES, "-work-a-b");
    expect(r?.slugCwd).toBe("/work/a/b");
    expect(r?.cwd).toBe("/z");
    expect((await readTailFactsAsync(real, ID))?.slugCwd).toBeUndefined();
  });
});

// quick-261014-fq8: the newest permission-mode record (bypass flag source).
describe("scanPermissionMode / readPermissionModeAsync", () => {
  const pm = (mode: string, sid: string | undefined = ID): string =>
    JSON.stringify({ type: "permission-mode", permissionMode: mode, sessionId: sid });
  const userMode = (mode: string, sid: string = ID): string =>
    JSON.stringify({ type: "user", permissionMode: mode, sessionId: sid, message: { content: "hi" } });
  const pad = (kib: number): string[] => {
    const chunk = "x".repeat(1000);
    const out: string[] = [];
    for (let b = 0; b < kib * 1024; b += 1000) {
      out.push(JSON.stringify({ type: "attachment", sessionId: ID, attachment: { content: chunk } }));
    }
    return out;
  };

  it("PM0: pins the wide window at 4 MiB", () => {
    expect(PERMISSION_MODE_BYTES).toBe(4 * 1024 * 1024);
  });

  it("PM1: the last permission-mode line wins", () => {
    expect(scanPermissionMode(buf(body([pm("default"), pm("bypassPermissions")])), true, ID)).toEqual({
      decided: true,
      mode: "bypassPermissions",
    });
    expect(scanPermissionMode(buf(body([pm("bypassPermissions"), pm("default")])), true, ID)).toEqual({
      decided: true,
      mode: "default",
    });
  });

  it("PM2: a newer user line with a top-level permissionMode wins", () => {
    expect(scanPermissionMode(buf(body([pm("bypassPermissions"), userMode("acceptEdits")])), true, ID)).toEqual({
      decided: true,
      mode: "acceptEdits",
    });
    expect(scanPermissionMode(buf(body([userMode("default"), pm("bypassPermissions")])), true, ID)).toEqual({
      decided: true,
      mode: "bypassPermissions",
    });
  });

  it("PM3: foreign sessions, nested markers and escaped mentions are skipped", () => {
    const other = "99999999-2222-3333-4444-555555555555";
    expect(scanPermissionMode(buf(body([pm("default"), pm("bypassPermissions", other)])), true, ID)).toEqual({
      decided: true,
      mode: "default",
    });
    const nested = JSON.stringify({
      type: "assistant",
      sessionId: ID,
      message: { permissionMode: "bypassPermissions" },
    });
    const attachment = JSON.stringify({
      type: "attachment",
      sessionId: ID,
      attachment: { permissionMode: "bypassPermissions" },
    });
    expect(scanPermissionMode(buf(body([pm("default"), nested, attachment])), true, ID)).toEqual({
      decided: true,
      mode: "default",
    });
    const escaped = JSON.stringify({
      type: "user",
      sessionId: ID,
      message: { content: '{"type":"permission-mode","permissionMode":"bypassPermissions"}' },
    });
    expect(escaped.includes('"permissionMode":"')).toBe(false);
    expect(scanPermissionMode(buf(body([pm("default"), escaped])), true, ID)).toEqual({
      decided: true,
      mode: "default",
    });
    expect(scanPermissionMode(buf(body([escaped])), true, ID)).toEqual({ decided: false });
  });

  it("PM4: a window with no marker is undecided", () => {
    expect(scanPermissionMode(buf(body([userLine("hello"), ct("x", ID)])), true, ID)).toEqual({ decided: false });
    expect(scanPermissionMode(buf(""), true, ID)).toEqual({ decided: false });
  });

  it("PM5: an over-long or malformed newest marker line is decided with no mode", () => {
    const long = JSON.stringify({
      type: "user",
      permissionMode: "default",
      sessionId: ID,
      message: { content: "y".repeat(MAX_SCAN_LINE) },
    });
    expect(long.length).toBeGreaterThan(MAX_SCAN_LINE);
    expect(scanPermissionMode(buf(body([pm("bypassPermissions"), long])), true, ID)).toEqual({ decided: true });
    const broken = '{"type":"permission-mode","permissionMode":"default","sessionId":';
    expect(scanPermissionMode(buf(body([pm("bypassPermissions"), broken])), true, ID)).toEqual({ decided: true });
    // A non-string mode is not a record: the older line decides.
    const numeric = JSON.stringify({ type: "permission-mode", permissionMode: 1, sessionId: ID });
    expect(numeric.includes('"permissionMode":"')).toBe(false);
    expect(scanPermissionMode(buf(body([pm("bypassPermissions"), numeric])), true, ID)).toEqual({
      decided: true,
      mode: "bypassPermissions",
    });
  });

  it("PM6: readPermissionModeAsync widens to PERMISSION_MODE_BYTES, then gives up; never rejects", async () => {
    const near = fs.realpathSync(writeTranscript(ID, [pm("bypassPermissions"), ...pad(300)]));
    expect(fs.statSync(near).size).toBeGreaterThan(TAIL_BYTES);
    expect(await readPermissionModeAsync(near, ID)).toBe("bypassPermissions");

    const id2 = "22222222-2222-3333-4444-555555555555";
    const far = fs.realpathSync(writeTranscript(id2, [pm("bypassPermissions", id2), ...pad(4 * 1024 + 64)]));
    expect(fs.statSync(far).size).toBeGreaterThan(PERMISSION_MODE_BYTES);
    expect(await readPermissionModeAsync(far, id2)).toBeUndefined();

    const id3 = "33333333-2222-3333-4444-555555555555";
    const tail = fs.realpathSync(writeTranscript(id3, [pm("bypassPermissions", id3), pm("plan", id3)]));
    expect(await readPermissionModeAsync(tail, id3)).toBe("plan");

    await expect(readPermissionModeAsync(path.join(raw, "missing", `${ID}.jsonl`), ID)).resolves.toBeUndefined();
  });
});

// 10-06 (D-07, 09 D-11): the card facts (last assistant model + last prompt)
// come from the SAME cached tail window as the custom title.

/** An assistant line in the verified RESEARCH Q3 shape. */
function asst(model: unknown, extra: Record<string, unknown> = {}, text = ""): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    message: { model, role: "assistant", content: [{ type: "text", text }] },
    type: "assistant",
    sessionId: ID,
    ...extra,
  });
}

/** A compact last-prompt record. */
function lp(text: unknown, sid: string | undefined = ID): string {
  return JSON.stringify({ type: "last-prompt", lastPrompt: text, sessionId: sid });
}

describe("scanCardFacts", () => {
  it("C1: the newest assistant model wins (a /model switch)", () => {
    const b = buf(body([asst("claude-opus-4-7"), userLine("hi"), asst("claude-opus-4-8")]));
    expect(scanCardFacts(b, true, ID).model).toBe("claude-opus-4-8");
  });

  it("C2: a <synthetic> model after a real one keeps the real one", () => {
    const b = buf(body([asst("claude-opus-4-7"), asst("<synthetic>")]));
    expect(scanCardFacts(b, true, ID).model).toBe("claude-opus-4-7");
  });

  it("C3: sidechain and foreign-session assistant lines are ignored", () => {
    const b = buf(
      body([
        asst("claude-opus-4-7"),
        asst("claude-haiku-4-5", { isSidechain: true }),
        asst("claude-sonnet-4-5", { sessionId: "other-id" }),
      ]),
    );
    expect(scanCardFacts(b, true, ID).model).toBe("claude-opus-4-7");
  });

  it("C4: an over-long assistant line yields its model from the 2 KiB prefix", () => {
    const long = asst("claude-opus-5-5", {}, "x".repeat(MAX_SCAN_LINE + 1000));
    expect(long.length).toBeGreaterThan(MAX_SCAN_LINE);
    expect(long.indexOf('"model":"claude-opus-5-5"')).toBeLessThan(2048);
    expect(scanCardFacts(buf(body([asst("claude-opus-4-7"), long])), true, ID).model).toBe("claude-opus-5-5");
  });

  it("C4b: an over-long sidechain, synthetic or foreign-session line is ignored", () => {
    const pad = "x".repeat(MAX_SCAN_LINE + 1000);
    const side = asst("claude-haiku-4-5", { isSidechain: true }, pad);
    const synth = asst("<synthetic>", {}, pad);
    const foreign = asst("claude-sonnet-4-5", { sessionId: "other-id" }, pad);
    const b = buf(body([asst("claude-opus-4-7"), side, synth, foreign]));
    expect(scanCardFacts(b, true, ID).model).toBe("claude-opus-4-7");
  });

  it("C5: the last-prompt record follows the Phase 8 rules", () => {
    expect(scanCardFacts(buf(body([lp("first"), lp("fix the tests")])), true, ID).lastPrompt).toBe("fix the tests");
    expect(scanCardFacts(buf(body([lp("mine"), lp("theirs", "other-id")])), true, ID).lastPrompt).toBe("mine");
    expect(scanCardFacts(buf(body([lp("ok"), lp("y".repeat(MAX_TITLE_LINE))])), true, ID).lastPrompt).toBe("ok");
    expect(scanCardFacts(buf(body([lp(7)])), true, ID).lastPrompt).toBeUndefined();
  });

  it("C6: an escaped assistant mention inside a user line never counts", () => {
    const b = buf(body([JSON.stringify({ type: "user", message: { content: asst("claude-evil-1") }, sessionId: ID })]));
    expect(scanCardFacts(b, true, ID)).toEqual({});
  });
});

describe("readTranscriptCard (cache)", () => {
  it("K1: returns the facts cached by readTranscriptTitle without touching the file", () => {
    const p = writeTranscript(ID, [ct("T", ID), asst("claude-opus-4-8"), lp("fix the tests")]);
    expect(readTranscriptTitle(ID, p)?.title).toBe("T");
    // No IO: the values survive the file disappearing.
    fs.rmSync(p);
    expect(readTranscriptCard(ID)).toEqual({ lastPrompt: "fix the tests", model: "claude-opus-4-8" });
  });

  it("K2: no entry gives an empty object", () => {
    expect(readTranscriptCard(ID)).toEqual({});
  });

  it("K3: sticky: a changed scan with no such lines keeps both values", () => {
    const p = writeTranscript(ID, [asst("claude-opus-4-7"), lp("keep me")], "p", 1700000000);
    readTranscriptTitle(ID, p);
    appendLines(p, [userLine("more")], 1700000100);
    readTranscriptTitle(ID, p);
    expect(readTranscriptCard(ID)).toEqual({ lastPrompt: "keep me", model: "claude-opus-4-7" });
    appendLines(p, [asst("claude-opus-4-8")], 1700000200);
    readTranscriptTitle(ID, p);
    expect(readTranscriptCard(ID)).toEqual({ lastPrompt: "keep me", model: "claude-opus-4-8" });
  });

  it("K4: a shrink resets both values", () => {
    const p = writeTranscript(ID, [userLine("a".repeat(200)), asst("claude-opus-4-7"), lp("gone")], "p", 1700000000);
    readTranscriptTitle(ID, p);
    writeTranscript(ID, [userLine("b")], "p", 1700000100);
    readTranscriptTitle(ID, p);
    expect(readTranscriptCard(ID)).toEqual({});
  });

  it("K5: a changed transcript path resets both values", () => {
    const p = writeTranscript(ID, [asst("claude-opus-4-7"), lp("old")], "p");
    readTranscriptTitle(ID, p);
    const q = writeTranscript(ID, [userLine("fresh")], "q");
    readTranscriptTitle(ID, q);
    expect(readTranscriptCard(ID)).toEqual({});
  });

  it("K6: the title semantics are unchanged by the card facts", () => {
    const p = writeTranscript(ID, [ct("Alpha", ID), asst("claude-opus-4-7")], "p", 1700000000);
    expect(readTranscriptTitle(ID, p)).toEqual({ title: "Alpha", changedAtMs: Number.NEGATIVE_INFINITY });
    appendLines(p, [asst("claude-opus-4-8")], 1700000100);
    expect(readTranscriptTitle(ID, p)).toEqual({ title: "Alpha", changedAtMs: Number.NEGATIVE_INFINITY });
  });
});
