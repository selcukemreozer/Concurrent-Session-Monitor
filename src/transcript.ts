import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Transcript-tail session-name reader (Phase 7, D-04).
 *
 * Best-effort contract: Claude Code appends a compact JSON line
 * `{"type":"custom-title","customTitle":"...","sessionId":"<id>"}` to the
 * session transcript (`<projects>/<slug>/<id>.jsonl`) when the user runs the
 * native `/rename`. That format is UNDOCUMENTED (verified locally 2026-09-29
 * and 2026-10-09) and may change between Claude Code versions. Every failure
 * here (absent or unreadable file, malformed lines, a guard rejection, a
 * format change) falls back silently to `undefined` or the cached value; no
 * function in this module throws to its caller.
 *
 * D-03: only lines whose parsed `type` is exactly `custom-title` count. The
 * `agent-name` and `ai-title` lines are never read.
 *
 * Bounded read (T-07-05): at most `budget` bytes (default TAIL_BYTES, 256 KiB)
 * are read from the END of the file with positional reads; the whole file is
 * never loaded. Lines over MAX_TITLE_LINE chars are skipped before JSON.parse.
 *
 * Change gate + sticky value: readTranscriptTitle caches (size, mtimeMs) per
 * session id and does not open the file while both are unchanged. A changed
 * scan whose window holds no custom-title line keeps the previous title; the
 * cache resets when the file shrinks, when the transcript path changes, or
 * when stat fails. `changedAtMs` is the transcript mtime of the scan where the
 * value CHANGED after the entry's baseline scan (a re-append of the same value
 * does not bump it), the freshness input for the "fresher wins" merge in
 * aggregate. WR-01: a value found by the BASELINE scan (the first successful
 * scan of a fresh entry - cold panel start, a changed path, a stat failure -
 * or the first scan after a shrink) has unknown age: the file's current mtime
 * says nothing about when that line was written, so it gets
 * Number.NEGATIVE_INFINITY and a documented title.json record with a ts wins.
 * Only a change seen after the baseline counts as strictly fresher.
 *
 * Path guard (T-07-03): the path string comes from a store file, so it must be
 * absolute, normalized, named `<id>.jsonl`, and its realpath must lie inside
 * a realpath'd `~/.claude/projects` or `$CLAUDE_CONFIG_DIR/projects` root. The
 * open uses O_NOFOLLOW, and only a customTitle string is ever extracted.
 *
 * Non-blocking (T-07-04): a FIFO or device file at the path must never freeze
 * the panel event loop: the cached path is gated on statSync().isFile(), and
 * the open uses O_NONBLOCK followed by an fstatSync().isFile() check.
 *
 * Hooks never call this module: the transcript read stays off the hook hot
 * path. Only reader-side TypeScript (src/aggregate.ts) imports it.
 *
 * Phase 8 (resume picker, RESUME-01/02): this module is also the single
 * transcript-IO seam for session discovery. One bounded TAIL window
 * (scanTailFacts / readTailFactsAsync) yields entrypoint, cwd, hasAssistant,
 * custom-title, ai-title and last-prompt with last-wins semantics; entrypoint
 * is always classified from the tail, never the head. One bounded HEAD window
 * (scanFirstPrompt / readFirstPromptAsync) yields the first real user prompt
 * (promptLabel). WR-04 / D-10 REVISED: the HEAD window (scanHeadFacts /
 * readHeadFactsAsync) also yields the first cwd (firstCwd) and the first cwd
 * whose Claude Code project slug (projectSlug) equals the transcript's
 * `<projects>/<dir>` name (slugCwd); the TAIL window also yields the first
 * slug-matching cwd (TailFacts.slugCwd) for sessions whose matching cwd only
 * appears after the head window. src/sessions.ts sessionCwd picks among them.
 * LOCKSTEP: scripts/csm-resume.mjs mirrors projectSlug / scanHeadFacts (08-10).
 * Both windows go through one shared reader (readWindowSync /
 * readWindowAsync): O_RDONLY | O_NONBLOCK | O_NOFOLLOW open, fstat isFile,
 * one positional read of at most `budget` bytes, never a whole-file read;
 * the async flavour keeps the panel event loop free and never rejects. Lines
 * over MAX_SCAN_LINE (and metadata lines over MAX_TITLE_LINE) are skipped
 * before JSON.parse. The D-03 note above still holds for the LIVE label
 * surfaces (only custom-title names a running session); ai-title and
 * last-prompt are read only for the resume picker (CONTEXT D-06 / D-07).
 * Extracted strings are raw and untrusted: every consumer must run
 * cleanTitle, then truncateLabel, then sanitize before display.
 */

/** Default tail budget: the last 256 KiB of the transcript. */
export const TAIL_BYTES = 256 * 1024;

/** Lines longer than this are skipped before JSON.parse. */
export const MAX_TITLE_LINE = 4096;

/** Default head budget for the first-prompt scan: the first 256 KiB. */
export const HEAD_BYTES = 256 * 1024;

/** Carrier / user / assistant lines longer than this are never parsed. */
export const MAX_SCAN_LINE = 64 * 1024;

/** A Claude Code session id as accepted by `--resume` (lowercase UUID). */
export const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Built-in slash commands that never make a meaningful session label. */
export const TRIVIAL_COMMANDS: ReadonlySet<string> = new Set([
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
]);

/**
 * Facts gathered from one tail window (all last-wins, except slugCwd).
 * `slugCwd` (WR-04) is the FIRST cwd in the window whose projectSlug equals
 * the slug passed to scanTailFacts; undefined without a slug.
 */
export type TailFacts = {
  entrypoint?: string;
  cwd?: string;
  slugCwd?: string;
  hasAssistant: boolean;
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
};

/** One bounded positional window of a transcript file. */
export type TranscriptWindow = {
  buf: Buffer;
  /** True when the window starts at offset 0 (no torn leading line). */
  atBoundary: boolean;
  /** True when the window reaches the end of the file. */
  reachedEof: boolean;
  size: number;
  mtimeMs: number;
};

export type TranscriptTitle = { title: string; changedAtMs: number };

/** Mirror of src/paths.ts SAFE_ID_PATTERN (this module imports stdlib only). */
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Max accepted transcript path length. */
const MAX_PATH = 4096;

/** The compact marker; an escaped mention inside content has backslashes. */
const MARKER = '"type":"custom-title"';

const NEWLINE = 0x0a;

/** Compact markers for the tail-facts scan (escaped mentions never match). */
const META_MARKERS = ['"type":"custom-title"', '"type":"ai-title"', '"type":"last-prompt"'];
const CARRIER_MARKER = '"entrypoint":"';
const ASSISTANT_MARKER = '"type":"assistant"';
const USER_MARKER = '"type":"user"';
const CWD_MARKER = '"cwd":"';

/**
 * Claude Code's projects-dir slug for a cwd (WR-04 / D-10 REVISED): every
 * UTF-16 code unit outside [A-Za-z0-9] becomes one `-` (no `u` flag, so an
 * astral character becomes two dashes). Very long paths, which Claude Code
 * truncates and hashes, never match; those sessions fall back to the first
 * head cwd.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The complete lines of a window.
 *
 * When `atBoundary` is false the window starts mid-line, so everything up to
 * and including the first newline is discarded (byte-level, before decoding,
 * so a split UTF-8 sequence at the window start never reaches the decoder).
 * Everything after the last newline is a torn line and is ignored. Only the
 * complete span is decoded as UTF-8.
 */
function windowLines(buf: Buffer, atBoundary: boolean): string[] {
  let first = 0;
  if (!atBoundary) {
    const nl = buf.indexOf(NEWLINE);
    if (nl < 0) return [];
    first = nl + 1;
  }
  const last = buf.lastIndexOf(NEWLINE);
  if (last < first) return [];
  return buf.subarray(first, last).toString("utf8").split("\n");
}

/**
 * Return the LAST matching customTitle in the complete-line span of `buf`
 * (torn-line rules: see windowLines).
 */
export function scanCustomTitle(buf: Buffer, atBoundary: boolean, sessionId: string): string | undefined {
  let found: string | undefined;
  for (const line of windowLines(buf, atBoundary)) {
    if (line.length === 0 || line.length > MAX_TITLE_LINE) continue;
    if (!line.includes(MARKER)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const o = parsed as { type?: unknown; customTitle?: unknown; sessionId?: unknown };
    if (o.type !== "custom-title") continue;
    if (typeof o.customTitle !== "string") continue;
    if (o.sessionId !== undefined && o.sessionId !== sessionId) continue;
    found = o.customTitle;
  }
  return found;
}

/**
 * Scan one tail window for the resume-picker facts (all last-wins).
 * Only lines carrying a compact marker are parsed; lines over MAX_SCAN_LINE
 * are skipped, and metadata values come only from lines of at most
 * MAX_TITLE_LINE chars. Lines with a different sessionId are ignored.
 */
export function scanTailFacts(buf: Buffer, atBoundary: boolean, sessionId: string, slug?: string): TailFacts {
  const f: TailFacts = { hasAssistant: false };
  for (const line of windowLines(buf, atBoundary)) {
    if (line.length === 0 || line.length > MAX_SCAN_LINE) continue;
    const isMeta = META_MARKERS.some((m) => line.includes(m));
    const isCarrier = line.includes(CARRIER_MARKER);
    const isAssistant = line.includes(ASSISTANT_MARKER);
    if (!isMeta && !isCarrier && !isAssistant) continue;
    const metaOk = line.length <= MAX_TITLE_LINE;
    if (isMeta && !metaOk && !isCarrier && !isAssistant) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const o = parsed as {
      type?: unknown;
      sessionId?: unknown;
      customTitle?: unknown;
      aiTitle?: unknown;
      lastPrompt?: unknown;
      entrypoint?: unknown;
      cwd?: unknown;
    };
    if (o.sessionId !== undefined && o.sessionId !== sessionId) continue;
    if (metaOk) {
      if (o.type === "custom-title" && typeof o.customTitle === "string") f.customTitle = o.customTitle;
      else if (o.type === "ai-title" && typeof o.aiTitle === "string") f.aiTitle = o.aiTitle;
      else if (o.type === "last-prompt" && typeof o.lastPrompt === "string") f.lastPrompt = o.lastPrompt;
    }
    if (o.type === "assistant") f.hasAssistant = true;
    if (typeof o.entrypoint === "string") f.entrypoint = o.entrypoint;
    if (typeof o.cwd === "string") {
      f.cwd = o.cwd;
      if (slug !== undefined && f.slugCwd === undefined && o.cwd.length > 0 && projectSlug(o.cwd) === slug) {
        f.slugCwd = o.cwd;
      }
    }
  }
  return f;
}

/** Leading wrappers that are tool / command output, never a user prompt. */
const NOISE = /^<(local-command-(stdout|stderr)|command-caveat|system-reminder|bash-(input|stdout|stderr))>/;
const COMMAND_NAME = /<command-name>\/?([^<]{1,80})<\/command-name>/;
const COMMAND_ARGS = /<command-args>([^<]{0,200})<\/command-args>/;

/**
 * The raw label text of one parsed transcript line when it is a real user
 * prompt, else undefined. A slash-command wrapper renders as `/name args`
 * (tag order independent); trivial built-ins and command / tool output give
 * undefined. The caller cleans and caps the result.
 */
export function promptLabel(o: unknown): string | undefined {
  if (o === null || typeof o !== "object") return undefined;
  const line = o as { type?: unknown; isMeta?: unknown; message?: unknown };
  if (line.type !== "user" || line.isMeta === true) return undefined;
  const message = line.message;
  if (message === null || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  let text: string | undefined;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const part of content as unknown[]) {
      if (part === null || typeof part !== "object") continue;
      const pt = part as { type?: unknown; text?: unknown };
      if (pt.type === "text" && typeof pt.text === "string") {
        text = pt.text;
        break;
      }
    }
  }
  if (text === undefined) return undefined;
  const t = text.trim();
  if (t.length === 0 || NOISE.test(t)) return undefined;
  if (t.includes("<command-name>")) {
    const name = COMMAND_NAME.exec(t)?.[1]?.trim();
    if (name === undefined || name.length === 0) return undefined;
    if (TRIVIAL_COMMANDS.has(name)) return undefined;
    const args = COMMAND_ARGS.exec(t)?.[1]?.trim();
    return args !== undefined && args.length > 0 ? `/${name} ${args}` : `/${name}`;
  }
  return t;
}

/** The first real user prompt in a head window (offset 0), else undefined. */
export function scanFirstPrompt(buf: Buffer, sessionId: string): string | undefined {
  for (const line of windowLines(buf, true)) {
    if (line.length === 0 || line.length > MAX_SCAN_LINE) continue;
    if (!line.includes(USER_MARKER)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const sid = (parsed as { sessionId?: unknown }).sessionId;
    if (sid !== undefined && sid !== sessionId) continue;
    const label = promptLabel(parsed);
    if (label !== undefined) return label;
  }
  return undefined;
}

/** Facts gathered from one head window (WR-04 / D-06). */
export type HeadFacts = { prompt?: string; firstCwd?: string; slugCwd?: string };

/**
 * One pass over a head window (offset 0): the first real user prompt (same
 * answer as scanFirstPrompt), the first non-empty cwd, and the first cwd
 * whose projectSlug equals `slug`. Lines over MAX_SCAN_LINE, unparseable
 * lines and lines with a different sessionId are skipped; empty cwd values
 * are ignored. Stops once both the prompt and slugCwd are known.
 */
export function scanHeadFacts(buf: Buffer, sessionId: string, slug: string): HeadFacts {
  const f: HeadFacts = {};
  for (const line of windowLines(buf, true)) {
    if (line.length === 0 || line.length > MAX_SCAN_LINE) continue;
    const isUser = line.includes(USER_MARKER);
    if (!isUser && !line.includes(CWD_MARKER)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const o = parsed as { sessionId?: unknown; cwd?: unknown };
    if (o.sessionId !== undefined && o.sessionId !== sessionId) continue;
    if (f.prompt === undefined && isUser) {
      const label = promptLabel(parsed);
      if (label !== undefined) f.prompt = label;
    }
    if (typeof o.cwd === "string" && o.cwd.length > 0) {
      if (f.firstCwd === undefined) f.firstCwd = o.cwd;
      if (f.slugCwd === undefined && projectSlug(o.cwd) === slug) f.slugCwd = o.cwd;
    }
    if (f.prompt !== undefined && f.slugCwd !== undefined) break;
  }
  return f;
}

/** Guarded open flags: never follow a symlink, never block on a FIFO. */
function openFlags(): number {
  return fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0);
}

function windowRange(size: number, from: "head" | "tail", budget: number): { start: number; want: number } {
  const b = Math.max(0, budget);
  const start = from === "tail" ? Math.max(0, size - b) : 0;
  return { start, want: Math.min(b, size - start) };
}

/**
 * Read one bounded window (head or tail) of a validated transcript path.
 * Synchronous flavour (one-shot callers and the Phase 7 title reader).
 * Returns undefined on any failure, including a non-regular file.
 */
export function readWindowSync(
  realPath: string,
  from: "head" | "tail",
  budget: number,
): TranscriptWindow | undefined {
  try {
    const fd = fs.openSync(realPath, openFlags());
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return undefined;
      const { start, want } = windowRange(st.size, from, budget);
      const out = Buffer.alloc(want);
      let filled = 0;
      while (filled < want) {
        const n = fs.readSync(fd, out, filled, want - filled, start + filled);
        if (n <= 0) break;
        filled += n;
      }
      return {
        buf: out.subarray(0, filled),
        atBoundary: start === 0,
        reachedEof: start + filled >= st.size,
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * Asynchronous flavour of readWindowSync for the panel (fs/promises, never
 * blocks the event loop, never rejects).
 */
export async function readWindowAsync(
  realPath: string,
  from: "head" | "tail",
  budget: number,
): Promise<TranscriptWindow | undefined> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(realPath, openFlags());
    const st = await fh.stat();
    if (!st.isFile()) return undefined;
    const { start, want } = windowRange(st.size, from, budget);
    const out = Buffer.alloc(want);
    let filled = 0;
    while (filled < want) {
      const { bytesRead } = await fh.read(out, filled, want - filled, start + filled);
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    return {
      buf: out.subarray(0, filled),
      atBoundary: start === 0,
      reachedEof: start + filled >= st.size,
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  } catch {
    return undefined;
  } finally {
    if (fh !== undefined) {
      try {
        await fh.close();
      } catch {
        // already closed or unclosable: nothing to do
      }
    }
  }
}

/**
 * One guarded tail window scanned for TailFacts, plus the file size and
 * mtime. `realPath` must already be validated. Never rejects.
 */
export async function readTailFactsAsync(
  realPath: string,
  sessionId: string,
  budget = TAIL_BYTES,
  slug?: string,
): Promise<(TailFacts & { size: number; mtimeMs: number }) | undefined> {
  try {
    const w = await readWindowAsync(realPath, "tail", budget);
    if (w === undefined) return undefined;
    return { ...scanTailFacts(w.buf, w.atBoundary, sessionId, slug), size: w.size, mtimeMs: w.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * One guarded head window scanned for the first real prompt. `final` is true
 * when the answer cannot change as the file grows: a prompt was found, or the
 * file already exceeds the head budget. Never rejects.
 */
export async function readFirstPromptAsync(
  realPath: string,
  sessionId: string,
  budget = HEAD_BYTES,
): Promise<{ prompt?: string; final: boolean } | undefined> {
  try {
    const w = await readWindowAsync(realPath, "head", budget);
    if (w === undefined) return undefined;
    const prompt = scanFirstPrompt(w.buf, sessionId);
    const final = prompt !== undefined || w.size > Math.max(0, budget);
    return prompt === undefined ? { final } : { prompt, final };
  } catch {
    return undefined;
  }
}

/**
 * One guarded head window scanned for HeadFacts (WR-04). `final` is true when
 * the answer cannot change as the file grows: the file already exceeds the
 * head budget, or both the prompt and the slug-matching cwd were found. Only
 * defined fact keys are returned. `realPath` must already be validated.
 * Never rejects.
 */
export async function readHeadFactsAsync(
  realPath: string,
  sessionId: string,
  slug: string,
  budget = HEAD_BYTES,
): Promise<(HeadFacts & { final: boolean }) | undefined> {
  try {
    const w = await readWindowAsync(realPath, "head", budget);
    if (w === undefined) return undefined;
    const h = scanHeadFacts(w.buf, sessionId, slug);
    const final = w.size > Math.max(0, budget) || (h.prompt !== undefined && h.slugCwd !== undefined);
    const out: HeadFacts & { final: boolean } = { final };
    if (h.prompt !== undefined) out.prompt = h.prompt;
    if (h.firstCwd !== undefined) out.firstCwd = h.firstCwd;
    if (h.slugCwd !== undefined) out.slugCwd = h.slugCwd;
    return out;
  } catch {
    return undefined;
  }
}

function safeSessionId(sessionId: unknown): sessionId is string {
  return (
    typeof sessionId === "string" &&
    SAFE_ID_PATTERN.test(sessionId) &&
    sessionId !== "." &&
    sessionId !== ".."
  );
}

/** Realpath each candidate root, skipping absent ones. */
function realRoots(candidates: readonly string[]): string[] {
  const roots: string[] = [];
  for (const c of candidates) {
    try {
      roots.push(fs.realpathSync(c));
    } catch {
      // root absent: skip it
    }
  }
  return roots;
}

/** Realpath'd allowed projects roots; read the env lazily on every call. */
function allowedRoots(): string[] {
  const candidates = [path.join(os.homedir(), ".claude", "projects")];
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (typeof cfg === "string" && cfg.length > 0) candidates.push(path.join(cfg, "projects"));
  return realRoots(candidates);
}

/** The deduplicated realpath'd projects roots (discovery walks these). */
export function projectRoots(): string[] {
  return [...new Set(allowedRoots())];
}

function isInside(root: string, real: string): boolean {
  const rel = path.relative(root, real);
  if (rel.length === 0 || path.isAbsolute(rel)) return false;
  return rel.split(path.sep)[0] !== "..";
}

/**
 * Validate an untrusted transcript path for `sessionId` (T-07-03).
 * Returns the realpath when every check passes, else undefined. Never throws.
 * `roots` (Phase 8), when given, replaces the default allowed roots; each is
 * realpath'd and absent ones are skipped.
 */
export function isAllowedTranscriptPath(
  sessionId: string,
  p: unknown,
  roots?: readonly string[],
): string | undefined {
  try {
    if (!safeSessionId(sessionId)) return undefined;
    if (typeof p !== "string" || p.length === 0 || p.length > MAX_PATH) return undefined;
    if (!path.isAbsolute(p)) return undefined;
    if (path.normalize(p) !== p) return undefined;
    const expected = `${sessionId}.jsonl`;
    if (path.basename(p) !== expected) return undefined;
    const real = fs.realpathSync(p);
    if (path.basename(real) !== expected) return undefined;
    for (const root of roots === undefined ? allowedRoots() : realRoots(roots)) {
      if (isInside(root, real)) return real;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stateless bounded tail read (the entry point Phase 8 reuses for cold
 * transcripts). `realPath` must already be validated by the caller.
 * Returns the newest custom title (if any) plus the file size and mtime, or
 * undefined on any failure, including a non-regular file.
 */
export function readTailCustomTitle(
  realPath: string,
  sessionId: string,
  budget = TAIL_BYTES,
): { title?: string; size: number; mtimeMs: number } | undefined {
  try {
    const window = readWindowSync(realPath, "tail", budget);
    if (window === undefined) return undefined;
    const title = scanCustomTitle(window.buf, window.atBoundary, sessionId);
    return { title, size: window.size, mtimeMs: window.mtimeMs };
  } catch {
    return undefined;
  }
}

type Entry = {
  rawPath: string;
  realPath: string;
  size: number;
  mtimeMs: number;
  title?: string;
  changedAtMs?: number;
};

const cache = new Map<string, Entry>();

function valueOf(e: Entry | undefined): TranscriptTitle | undefined {
  if (e === undefined || e.title === undefined || e.changedAtMs === undefined) return undefined;
  return { title: e.title, changedAtMs: e.changedAtMs };
}

/**
 * Change-gated, sticky, per-session custom-title reader. Never throws.
 */
export function readTranscriptTitle(
  sessionId: string,
  transcriptPath: unknown,
  budget = TAIL_BYTES,
): TranscriptTitle | undefined {
  try {
    if (typeof transcriptPath !== "string") {
      cache.delete(sessionId);
      return undefined;
    }
    let entry = cache.get(sessionId);
    if (entry === undefined || entry.rawPath !== transcriptPath) {
      const real = isAllowedTranscriptPath(sessionId, transcriptPath);
      if (real === undefined) {
        cache.delete(sessionId);
        return undefined;
      }
      entry = { rawPath: transcriptPath, realPath: real, size: -1, mtimeMs: -1 };
      cache.set(sessionId, entry);
    }

    let st: fs.Stats;
    try {
      st = fs.statSync(entry.realPath);
    } catch {
      cache.delete(sessionId);
      return undefined;
    }
    if (!st.isFile()) {
      cache.delete(sessionId);
      return undefined;
    }

    if (st.size === entry.size && st.mtimeMs === entry.mtimeMs) return valueOf(entry);

    if (st.size < entry.size) {
      // Shrink (rewrite): forget the value AND the baseline, so the next
      // successful scan is a baseline scan again (WR-01).
      entry.title = undefined;
      entry.changedAtMs = undefined;
      entry.size = -1;
      entry.mtimeMs = -1;
    }

    const r = readTailCustomTitle(entry.realPath, sessionId, budget);
    if (r === undefined) return valueOf(entry);

    // WR-01: size < 0 marks an entry that has never completed a scan.
    const baseline = entry.size < 0;
    if (r.title !== undefined && r.title !== entry.title) {
      entry.title = r.title;
      entry.changedAtMs = baseline ? Number.NEGATIVE_INFINITY : r.mtimeMs;
    }
    entry.size = r.size;
    entry.mtimeMs = r.mtimeMs;
    return valueOf(entry);
  } catch {
    return valueOf(cache.get(sessionId));
  }
}

/** Drop every cached session id not in `keep` (per-pass pruning). */
export function pruneTranscriptTitleCache(keep: ReadonlySet<string>): void {
  for (const id of [...cache.keys()]) {
    if (!keep.has(id)) cache.delete(id);
  }
}

/** Clear the whole cache (tests). */
export function resetTranscriptTitleCache(): void {
  cache.clear();
}
