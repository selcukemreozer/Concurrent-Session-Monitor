import * as fs from "node:fs";
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
 */

/** Default tail budget: the last 256 KiB of the transcript. */
export const TAIL_BYTES = 256 * 1024;

/** Lines longer than this are skipped before JSON.parse. */
export const MAX_TITLE_LINE = 4096;

export type TranscriptTitle = { title: string; changedAtMs: number };

/** Mirror of src/paths.ts SAFE_ID_PATTERN (this module imports stdlib only). */
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Max accepted transcript path length. */
const MAX_PATH = 4096;

/** The compact marker; an escaped mention inside content has backslashes. */
const MARKER = '"type":"custom-title"';

const NEWLINE = 0x0a;

/**
 * Return the LAST matching customTitle in the complete-line span of `buf`.
 *
 * When `atBoundary` is false the window starts mid-line, so everything up to
 * and including the first newline is discarded (byte-level, before decoding,
 * so a split UTF-8 sequence at the window start never reaches the decoder).
 * Everything after the last newline is a torn line and is ignored.
 */
export function scanCustomTitle(buf: Buffer, atBoundary: boolean, sessionId: string): string | undefined {
  let first = 0;
  if (!atBoundary) {
    const nl = buf.indexOf(NEWLINE);
    if (nl < 0) return undefined;
    first = nl + 1;
  }
  const last = buf.lastIndexOf(NEWLINE);
  if (last < first) return undefined;
  const text = buf.subarray(first, last + 1).toString("utf8");
  let found: string | undefined;
  for (const line of text.split("\n")) {
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

function safeSessionId(sessionId: unknown): sessionId is string {
  return (
    typeof sessionId === "string" &&
    SAFE_ID_PATTERN.test(sessionId) &&
    sessionId !== "." &&
    sessionId !== ".."
  );
}

/** Realpath'd allowed projects roots; read the env lazily on every call. */
function allowedRoots(): string[] {
  const candidates = [path.join(os.homedir(), ".claude", "projects")];
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (typeof cfg === "string" && cfg.length > 0) candidates.push(path.join(cfg, "projects"));
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

function isInside(root: string, real: string): boolean {
  const rel = path.relative(root, real);
  if (rel.length === 0 || path.isAbsolute(rel)) return false;
  return rel.split(path.sep)[0] !== "..";
}

/**
 * Validate an untrusted transcript path for `sessionId` (T-07-03).
 * Returns the realpath when every check passes, else undefined. Never throws.
 */
export function isAllowedTranscriptPath(sessionId: string, p: unknown): string | undefined {
  try {
    if (!safeSessionId(sessionId)) return undefined;
    if (typeof p !== "string" || p.length === 0 || p.length > MAX_PATH) return undefined;
    if (!path.isAbsolute(p)) return undefined;
    if (path.normalize(p) !== p) return undefined;
    const expected = `${sessionId}.jsonl`;
    if (path.basename(p) !== expected) return undefined;
    const real = fs.realpathSync(p);
    if (path.basename(real) !== expected) return undefined;
    for (const root of allowedRoots()) {
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
    const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(realPath, flags);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return undefined;
      const start = Math.max(0, st.size - Math.max(0, budget));
      const want = st.size - start;
      const out = Buffer.alloc(want);
      let filled = 0;
      while (filled < want) {
        const n = fs.readSync(fd, out, filled, want - filled, start + filled);
        if (n <= 0) break;
        filled += n;
      }
      const title = scanCustomTitle(out.subarray(0, filled), start === 0, sessionId);
      return { title, size: st.size, mtimeMs: st.mtimeMs };
    } finally {
      fs.closeSync(fd);
    }
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
