import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_TITLE_LINE,
  TAIL_BYTES,
  isAllowedTranscriptPath,
  pruneTranscriptTitleCache,
  readTailCustomTitle,
  readTranscriptTitle,
  resetTranscriptTitleCache,
  scanCustomTitle,
} from "./transcript.js";

// 07-03 (D-04): bounded, change-gated, path-guarded transcript-tail reader for
// the native `/rename` custom-title line. Every fixture lives under a mkdtemp
// dir exported as CLAUDE_CONFIG_DIR, so `<raw>/projects` is an allowed root.

const NL = String.fromCharCode(10);
const ID = "11111111-2222-3333-4444-555555555555";

let raw: string;
const extraDirs: string[] = [];

beforeEach(() => {
  raw = fs.mkdtempSync(path.join(os.tmpdir(), "csm-tr-"));
  process.env.CLAUDE_CONFIG_DIR = raw;
});

afterEach(() => {
  resetTranscriptTitleCache();
  delete process.env.CLAUDE_CONFIG_DIR;
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
  it("R1: returns the title and the file mtime as changedAtMs", () => {
    const p = writeTranscript(ID, [ct("Alpha", ID)]);
    expect(readTranscriptTitle(ID, p)).toEqual({ title: "Alpha", changedAtMs: fs.statSync(p).mtimeMs });
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
    expect(first).toEqual({ title: "Keep", changedAtMs: 1700000000000 });
    const filler: string[] = [];
    for (let i = 0; i < 100; i++) filler.push(userLine("u".repeat(3500)));
    appendLines(p, filler, 1700000050);
    expect(fs.statSync(p).size).toBeGreaterThan(300 * 1024);
    expect(readTranscriptTitle(ID, p)).toEqual({ title: "Keep", changedAtMs: 1700000000000 });
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
