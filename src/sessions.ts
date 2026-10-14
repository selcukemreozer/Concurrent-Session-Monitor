import * as fsp from "node:fs/promises";
import { constants as FS } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SESSION_UUID_PATTERN,
  TAIL_BYTES,
  isAllowedTranscriptPath,
  projectRoots,
  projectSlug,
  readHeadFactsAsync,
  readPermissionModeAsync,
  readTailFactsAsync,
  readWindowAsync,
  scanCustomTitle,
  type HeadFacts,
  type TailFacts,
} from "./transcript.js";
import { NAME_CAP, UNNAMED, cleanTitle, truncateLabel } from "./label.js";
import { numEnv } from "./env.js";
import { clampOffset } from "./phases.js";

/**
 * Read-only resume-session discovery + label reducer (Phase 8: RESUME-01..04).
 *
 *   - RESUME-01 / D-02: every interactive transcript under every projects root
 *     (`<root>/<slug>/<uuid>.jsonl`, top level only, dirent-based so symlinked
 *     slugs and files are never followed) is listed as ONE list, newest-first
 *     by transcript mtime.
 *   - D-01: a transcript whose tail entrypoint starts with `sdk-` is excluded;
 *     the verdict is sticky per path (never re-read while the file grows).
 *   - D-03: the newest n qualifying sessions (RESUME_LIST_N), no time cutoff;
 *     the walk stops reading once n rows are collected.
 *   - D-04: a session with no assistant line in its tail is hidden unless it
 *     carries a non-empty custom title.
 *   - D-06 / D-09: label = custom-title ("name") > ai-title ("derived") > first
 *     real prompt ("derived") > UNNAMED ("unnamed"); always cleanTitle FIRST,
 *     then truncateLabel at NAME_CAP.
 *   - D-11 / D-12 / RESUME-03: `live` is the only status signal - the union of
 *     the CC registry (`<dir>/<pid>.json`, pid probed alive) and caller-supplied
 *     CSM live ids. Liveness never filters: crashed and frozen sessions are
 *     always listed.
 *   - D-13: fmtAge renders the mtime in the card-uptime short style.
 *   - D-17: reconcileSelection / followOffset keep the pane cursor on the same
 *     session id across refreshes.
 *   - D-19: resumeScanMs (CSM_RESUME_SCAN_MS) is the pane's scan cadence; the
 *     scan is async (fs/promises only) and a warm scan is stat-only thanks to
 *     the per-path (size, mtime) cache. WR-05: the cadence is floored at
 *     MIN_RESUME_SCAN_MS.
 *   - D-10 REVISED / WR-04: the row's cwd (the `o` launch folder and the
 *     copied `cd` line) and its folder column come from sessionCwd: the head
 *     window's first cwd whose project slug equals the `<projects>/<dir>`
 *     name, else the tail window's first slug match, else the first head cwd.
 *     The tail's last-wins cwd drifts with in-session `cd`s and is never used.
 *     Per changed transcript at most one bounded tail and one bounded head
 *     window are read; the head is re-read only while its facts are not final.
 *   - quick-261014-fq8: resumeExtras resolves, ON DEMAND (panel Enter only,
 *     never in the discoverSessions scan, so the 10 s cadence does no new IO
 *     and the facts are the freshest at copy time), two facts for the copied
 *     resume line: the session's full `/rename` name when it is safe
 *     (isSafeResumeName), the row cwd's project slug equals the transcript's
 *     `<projects>/<dir>` name, and no other transcript in that slug folder
 *     under any projects root carries the same resumeNameKey; and `bypass`,
 *     true only when the newest permission-mode record is exactly
 *     bypassPermissions. Every uncertain case gives no name and no bypass.
 *
 * Contract: this module only READS. It writes nothing anywhere and installs no
 * hook. The CC registry dir also holds `<pid>.<hash>.key` peer-secret files;
 * only names matching ^\d+\.json$ are ever opened, so `*.key` files are never
 * read (T-08-08), and only `pid` and `sessionId` are used from a registry file.
 *
 * LOCKSTEP: scripts/csm-resume.mjs is a self-contained stdlib script that
 * cannot import src/; it mirrors this reducer (label chain, filters, caps,
 * liveness, and - from 08-10 - the sessionCwd chain; from quick-261014-fq8
 * also isSafeResumeName, resumeNameKey, the uniqueness rule and the
 * RESUME_NAME_* constants). Any change here must be made there too.
 */

/** D-03: rows kept per scan. */
export const RESUME_LIST_N = 50;

/** Rows the OTURUMLAR pane shows at once. */
export const RESUME_VISIBLE_ROWS = 10;

/** Folder display cap in grapheme clusters (ellipsis extra). */
export const FOLDER_CAP = 16;

/** last-prompt cap in grapheme clusters (ellipsis extra; parity with /csm-resume). */
export const LAST_PROMPT_CAP = 48;

/** T-08-08: registry files larger than this are ignored. */
const MAX_REGISTRY_BYTES = 65536;

/** Only `<digits>.json` registry names are opened (never `*.key`). */
const REGISTRY_NAME = /^(\d+)\.json$/;

/** quick-261014-fq8 rule (d): longest name (in code points) the resume line may carry. */
export const RESUME_NAME_MAX_CP = 100;

/** quick-261014-fq8 rule (c): more sibling transcripts than this in the slug means "not unique". */
export const RESUME_NAME_SCAN_MAX_FILES = 256;

/** quick-261014-fq8 rule (c): the uniqueness check gives up (not unique) after this long. */
export const RESUME_NAME_SCAN_BUDGET_MS = 1500;

/** The sibling title-key cache is cleared once it holds more entries than this. */
const TITLE_KEY_CACHE_MAX = 4096;

/** Longest accepted slug (one path component). */
const MAX_SLUG_LEN = 255;

export type LabelKind = "name" | "derived" | "unnamed";

export type ResumeRow = {
  id: string;
  /** Cleaned and capped (D-09). */
  label: string;
  labelKind: LabelKind;
  /** Cleaned and capped at FOLDER_CAP. */
  folder: string;
  /**
   * The WR-04 session cwd (sessionCwd), raw and untrusted. launch.ts
   * re-validates it before every use: commandCwd for the copied line,
   * validLaunchCwd for `o`.
   */
  cwd?: string;
  /**
   * quick-261014-fq8: the transcript's `<projects>/<dir>` name, raw. Always
   * set by discovery; resumeExtras re-validates it as one path component.
   */
  slug?: string;
  mtimeMs: number;
  live: boolean;
  /** Cleaned and capped at LAST_PROMPT_CAP (the pane never shows it, D-07). */
  lastPrompt?: string;
};

/** quick-261014-fq8: the extra facts of the copied resume line. */
export type ResumeExtras = { name?: string; bypass: boolean };

export type Candidate = { id: string; path: string; slug: string; size: number; mtimeMs: number };

export type DiscoverOptions = {
  roots?: readonly string[];
  registryDirs?: readonly string[];
  n?: number;
  liveIds?: ReadonlySet<string>;
  probe?: (pid: number) => boolean;
};

/** D-13: relative age in the card-uptime short style; the future clamps to 0s. */
export function fmtAge(thenMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - thenMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** WR-05: the lowest accepted scan cadence. */
export const MIN_RESUME_SCAN_MS = 1000;

/**
 * D-19: the pane's scan cadence, read lazily so tests can flip the env.
 * WR-05: floored at MIN_RESUME_SCAN_MS so a 0 or tiny value cannot busy-loop
 * the projects walk while OTURUMLAR is visible.
 */
export function resumeScanMs(): number {
  return Math.max(MIN_RESUME_SCAN_MS, numEnv("CSM_RESUME_SCAN_MS", 10000));
}

/**
 * WR-04 / D-10 REVISED session cwd chain:
 *   1. the head window's first slug-matching cwd (the user's "prefer the head
 *      (first) occurrence");
 *   2. else the tail window's first slug-matching cwd (a matching cwd that
 *      only appears after the head window);
 *   3. else the first head cwd;
 *   4. else undefined.
 * The tail's last-wins cwd is deliberately never used: it drifts when a
 * session `cd`s into a subfolder or another repository.
 */
export function sessionCwd(head: HeadFacts | undefined, tailSlugCwd: string | undefined): string | undefined {
  return head?.slugCwd ?? tailSlugCwd ?? head?.firstCwd;
}

/**
 * D-06 / D-09 label chain. Each candidate is cleaned first; the first
 * non-empty one is capped at NAME_CAP. The AI title is only a derived hint.
 */
export function resumeLabel(src: {
  customTitle?: string;
  aiTitle?: string;
  firstPrompt?: string;
}): { label: string; labelKind: LabelKind } {
  const custom = cleanTitle(src.customTitle);
  if (custom.length > 0) return { label: truncateLabel(custom, NAME_CAP), labelKind: "name" };
  const ai = cleanTitle(src.aiTitle);
  if (ai.length > 0) return { label: truncateLabel(ai, NAME_CAP), labelKind: "derived" };
  const prompt = cleanTitle(src.firstPrompt);
  if (prompt.length > 0) return { label: truncateLabel(prompt, NAME_CAP), labelKind: "derived" };
  return { label: UNNAMED, labelKind: "unnamed" };
}

/** CC registry dirs: ~/.claude/sessions plus $CLAUDE_CONFIG_DIR/sessions, deduplicated. */
export function registryDirs(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string): void => {
    const r = path.resolve(p);
    if (seen.has(r)) return;
    seen.add(r);
    out.push(r);
  };
  add(path.join(os.homedir(), ".claude", "sessions"));
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (typeof cfg === "string" && cfg.length > 0) add(path.join(cfg, "sessions"));
  return out;
}

/** kill -0 semantics: success or EPERM means the pid exists. */
function defaultAliveProbe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Guarded open flags: never follow a symlink, never block on a FIFO. */
function openFlags(): number {
  return FS.O_RDONLY | FS.O_NONBLOCK | (FS.O_NOFOLLOW ?? 0);
}

/** One registry file's sessionId when it is well-formed and its pid is alive. */
async function readRegistryEntry(
  file: string,
  stemPid: number,
  probe: (pid: number) => boolean,
): Promise<string | undefined> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(file, openFlags());
    const st = await fh.stat();
    if (!st.isFile() || st.size > MAX_REGISTRY_BYTES) return undefined;
    const text = await fh.readFile({ encoding: "utf8" });
    if (text.length > MAX_REGISTRY_BYTES) return undefined;
    const o = JSON.parse(text) as unknown;
    if (o === null || typeof o !== "object") return undefined;
    const { pid, sessionId } = o as { pid?: unknown; sessionId?: unknown };
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid !== stemPid) return undefined;
    if (typeof sessionId !== "string" || !SESSION_UUID_PATTERN.test(sessionId)) return undefined;
    return probe(pid) ? sessionId : undefined;
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/**
 * D-11 (A): session ids whose CC registry entry names a live pid. Only
 * `<digits>.json` files are opened (T-08-08). Never rejects.
 */
export async function readLiveRegistry(
  dirs: readonly string[],
  probe: (pid: number) => boolean = defaultAliveProbe,
): Promise<Set<string>> {
  const live = new Set<string>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = REGISTRY_NAME.exec(name);
      if (m === null) continue;
      const sid = await readRegistryEntry(path.join(dir, name), Number(m[1]), probe);
      if (sid !== undefined) live.add(sid);
    }
  }
  return live;
}

/**
 * Top-level `<root>/<slug>/<uuid>.jsonl` regular files (T-08-05). Dirent
 * types are used so symlinked slugs and symlinked files are skipped; nested
 * dirs (subagents/, tool-results/) and non-UUID names never qualify. Every
 * failure contributes nothing.
 */
export async function listCandidates(root: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  let slugs;
  try {
    slugs = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    await collectSlugFiles(path.join(root, slug.name), slug.name, out);
  }
  return out;
}

/**
 * The one transcript-file filter shared by discovery (listCandidates) and the
 * resume-name uniqueness check (listSlugCandidates), so they can never drift:
 * dirent isFile, `.jsonl`, a SESSION_UUID_PATTERN stem, and lstat isFile.
 * Every failure contributes nothing.
 */
async function collectSlugFiles(dir: string, slug: string, out: Candidate[]): Promise<void> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const id = e.name.slice(0, -".jsonl".length);
    if (!SESSION_UUID_PATTERN.test(id)) continue;
    const p = path.join(dir, e.name);
    try {
      const st = await fsp.lstat(p);
      if (!st.isFile()) continue;
      out.push({ id, path: p, slug, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // vanished between readdir and lstat: skip
    }
  }
}

/** True when `slug` is one safe path component (no separator, no NUL, not `.` / `..`). */
function isSlugComponent(slug: unknown): slug is string {
  return (
    typeof slug === "string" &&
    slug.length > 0 &&
    slug.length <= MAX_SLUG_LEN &&
    !slug.includes("/") &&
    !slug.includes(path.sep) &&
    !slug.includes("\0") &&
    slug !== "." &&
    slug !== ".."
  );
}

/**
 * quick-261014-fq8: the `<root>/<slug>/<uuid>.jsonl` files of ONE slug folder,
 * with exactly the listCandidates filter. The slug dir must lstat as a real
 * directory (a symlinked slug contributes nothing). Never rejects.
 */
export async function listSlugCandidates(root: string, slug: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  try {
    if (!isSlugComponent(slug)) return out;
    const dir = path.join(root, slug);
    const st = await fsp.lstat(dir);
    if (!st.isDirectory()) return out;
    await collectSlugFiles(dir, slug, out);
  } catch {
    // absent or unreadable: nothing
  }
  return out;
}

type CacheEntry = {
  size: number;
  mtimeMs: number;
  realPath: string;
  sdk: boolean;
  facts?: TailFacts;
  /** Head-window facts (first prompt, first cwd, slug-matching cwd). */
  head?: HeadFacts;
  /** True once the head facts cannot change as the file grows. */
  headFinal: boolean;
  /** File size at the last head read; the head is re-read only on a change. */
  headSize?: number;
};

/** Per candidate path; survives pane toggles so a reopen is a warm scan. */
const cache = new Map<string, CacheEntry>();

/** quick-261014-fq8: sibling path -> (size, mtimeMs, resumeNameKey of its latest custom title). */
const titleKeyCache = new Map<string, { size: number; mtimeMs: number; key: string }>();

/** Drop every cached verdict (tests; also lifts the sticky sdk verdict). */
export function resetSessionsCache(): void {
  cache.clear();
  titleKeyCache.clear();
}

/** Folder = capped basename of the WR-04 session cwd, else the capped slug. */
function folderOf(cwd: string | undefined, slug: string): string {
  if (typeof cwd === "string" && cwd.length > 0) {
    const base = cleanTitle(path.basename(cwd));
    if (base.length > 0) return truncateLabel(base, FOLDER_CAP);
  }
  return truncateLabel(cleanTitle(slug), FOLDER_CAP);
}

/** Build one row for a candidate, or undefined when it does not qualify. */
async function rowFor(
  c: Candidate,
  roots: readonly string[],
  live: ReadonlySet<string>,
): Promise<ResumeRow | undefined> {
  let entry = cache.get(c.path);
  if (entry?.sdk === true) return undefined; // D-01 sticky: no IO
  if (entry === undefined || entry.facts === undefined || entry.size !== c.size || entry.mtimeMs !== c.mtimeMs) {
    const realPath = isAllowedTranscriptPath(c.id, c.path, roots);
    if (realPath === undefined) return undefined;
    const read = await readTailFactsAsync(realPath, c.id, TAIL_BYTES, c.slug);
    if (read === undefined) return undefined;
    const { size, mtimeMs, ...facts } = read;
    const shrank = entry !== undefined && size < entry.size;
    const next: CacheEntry = {
      size,
      mtimeMs,
      realPath,
      sdk: false,
      facts,
      head: shrank ? undefined : entry?.head,
      headFinal: shrank ? false : (entry?.headFinal ?? false),
      headSize: shrank ? undefined : entry?.headSize,
    };
    if (typeof facts.entrypoint === "string" && facts.entrypoint.startsWith("sdk-")) {
      next.sdk = true;
      delete next.facts;
      cache.set(c.path, next);
      return undefined;
    }
    entry = next;
    cache.set(c.path, entry);
  }
  const facts = entry.facts;
  if (facts === undefined) return undefined;
  const custom = cleanTitle(facts.customTitle);
  if (!facts.hasAssistant && custom.length === 0) return undefined; // D-04
  // WR-04: the head is read for every qualifying row (it carries the session
  // cwd), but only while its facts are not final and the size changed.
  if (!entry.headFinal && entry.headSize !== entry.size) {
    const head = await readHeadFactsAsync(entry.realPath, c.id, c.slug);
    if (head !== undefined) {
      const { final, ...headFacts } = head;
      entry.head = headFacts;
      entry.headFinal = final;
      entry.headSize = entry.size;
    }
  }
  const { label, labelKind } = resumeLabel({
    customTitle: facts.customTitle,
    aiTitle: facts.aiTitle,
    firstPrompt: entry.head?.prompt,
  });
  const lp = cleanTitle(facts.lastPrompt);
  const cwd = sessionCwd(entry.head, facts.slugCwd);
  return {
    id: c.id,
    label,
    labelKind,
    folder: folderOf(cwd, c.slug),
    cwd,
    slug: c.slug,
    mtimeMs: c.mtimeMs,
    live: live.has(c.id),
    lastPrompt: lp.length > 0 ? truncateLabel(lp, LAST_PROMPT_CAP) : undefined,
  };
}

/**
 * RESUME-01..04: the newest n interactive sessions across every root, newest
 * first, with D-06 labels, folder, mtime and the D-11 live flag. Async-only
 * IO; never rejects (resolves the rows gathered so far on any failure).
 */
export async function discoverSessions(opts: DiscoverOptions = {}): Promise<ResumeRow[]> {
  const rows: ResumeRow[] = [];
  try {
    const roots = opts.roots ?? projectRoots();
    const n = opts.n ?? RESUME_LIST_N;
    if (!(n > 0)) return rows;
    const all: Candidate[] = [];
    for (const root of roots) all.push(...(await listCandidates(root)));
    const seenPaths = new Set(all.map((c) => c.path));
    for (const key of [...cache.keys()]) if (!seenPaths.has(key)) cache.delete(key);
    const byId = new Map<string, Candidate>();
    for (const c of all) {
      const prev = byId.get(c.id);
      if (prev === undefined || c.mtimeMs > prev.mtimeMs) byId.set(c.id, c);
    }
    const candidates = [...byId.values()].sort(
      (a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const live = await readLiveRegistry(opts.registryDirs ?? registryDirs(), opts.probe);
    for (const id of opts.liveIds ?? []) live.add(id);
    for (const c of candidates) {
      if (rows.length >= n) break;
      try {
        const row = await rowFor(c, roots, live);
        if (row !== undefined) rows.push(row);
      } catch {
        // one bad candidate never sinks the scan
      }
    }
  } catch {
    // resolve what was gathered so far
  }
  return rows;
}

/** quick-261014-fq8 rule (d): characters a shell or Claude Code could read specially. */
const RESUME_NAME_FORBIDDEN = /['"\\`!$]/;

/**
 * Code points never allowed in a resume name: format, default-ignorable (this
 * also rejects the ZWJ and FE0E/FE0F that cleanTitle keeps), private-use,
 * unassigned, surrogate, and the line / paragraph separators.
 */
const RESUME_NAME_BAD_CP = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u;

/** A name shaped like a session id (any case) is never used as a name. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * quick-261014-fq8 rule (d): true only for a name that is safe to single-quote
 * into the copied resume line as-is: a string already equal to its cleanTitle
 * (trimmed, single ASCII spaces, no controls), NFC, 1..RESUME_NAME_MAX_CP code
 * points, none of `'` `"` backslash backtick `!` `$`, no leading `-`, no
 * RESUME_NAME_BAD_CP code point, no whitespace other than U+0020, and not
 * UUID-shaped. Never throws (false on any error).
 */
export function isSafeResumeName(raw: unknown): raw is string {
  try {
    if (typeof raw !== "string" || raw.length === 0) return false;
    if (raw !== cleanTitle(raw)) return false;
    if (raw !== raw.normalize("NFC")) return false;
    const cps = Array.from(raw);
    if (cps.length < 1 || cps.length > RESUME_NAME_MAX_CP) return false;
    if (RESUME_NAME_FORBIDDEN.test(raw)) return false;
    if (raw.startsWith("-")) return false;
    for (const ch of cps) {
      if (RESUME_NAME_BAD_CP.test(ch)) return false;
      if (ch !== " " && /\s/u.test(ch)) return false;
    }
    if (UUID_SHAPE.test(raw)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * quick-261014-fq8 rule (c): the uniqueness comparison key, cleanTitle of the
 * NFKC form, lower-cased. Deliberately conservative (trim, space collapse,
 * compatibility fold and case-insensitive), so a near-duplicate counts as a
 * duplicate. Non-strings give "". Never throws.
 */
export function resumeNameKey(raw: unknown): string {
  try {
    if (typeof raw !== "string") return "";
    return cleanTitle(raw.normalize("NFKC")).toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The resumeNameKey of one sibling's latest custom title (TAIL_BYTES tail),
 * cached by path while the listed (size, mtimeMs) still equal the read's
 * fstat. undefined when the guard rejects the path or the read fails.
 */
async function siblingTitleKey(c: Candidate, roots: readonly string[]): Promise<string | undefined> {
  const hit = titleKeyCache.get(c.path);
  if (hit !== undefined && hit.size === c.size && hit.mtimeMs === c.mtimeMs) return hit.key;
  const real = isAllowedTranscriptPath(c.id, c.path, roots);
  if (real === undefined) return undefined;
  const w = await readWindowAsync(real, "tail", TAIL_BYTES);
  if (w === undefined) return undefined;
  const key = resumeNameKey(scanCustomTitle(w.buf, w.atBoundary, c.id));
  if (titleKeyCache.size >= TITLE_KEY_CACHE_MAX) titleKeyCache.clear();
  titleKeyCache.set(c.path, { size: w.size, mtimeMs: w.mtimeMs, key });
  return key;
}

/**
 * The full custom title when rules (a)-(d) hold, else undefined. Never throws.
 * The cwd must also pass launch.ts commandCwd; resumeCommand enforces that
 * when it builds the line (it never uses a name without the cd prefix).
 */
async function uniqueResumeName(
  id: string,
  slug: string,
  cwd: unknown,
  realPath: string,
  gathered: readonly Candidate[],
  roots: readonly string[],
  now: () => number,
): Promise<string | undefined> {
  try {
    const w = await readWindowAsync(realPath, "tail", TAIL_BYTES);
    if (w === undefined) return undefined;
    const title = scanCustomTitle(w.buf, w.atBoundary, id);
    if (!isSafeResumeName(title)) return undefined;
    if (typeof cwd !== "string" || projectSlug(cwd) !== slug) return undefined;
    const key = resumeNameKey(title);
    if (key.length === 0) return undefined;
    const siblings = gathered.filter((c) => c.id !== id);
    if (siblings.length > RESUME_NAME_SCAN_MAX_FILES) return undefined;
    const start = now();
    for (const sib of siblings) {
      if (now() - start > RESUME_NAME_SCAN_BUDGET_MS) return undefined;
      const k = await siblingTitleKey(sib, roots);
      if (k === undefined) return undefined;
      if (k.length > 0 && k === key) return undefined;
    }
    return title;
  } catch {
    return undefined;
  }
}

/**
 * quick-261014-fq8: the name and bypass facts of the copied resume line for
 * one row, resolved on demand (panel Enter; never in discoverSessions).
 *
 *   - Inputs: the id must be a lowercase UUID and the slug one path
 *     component, else `{ bypass: false }`.
 *   - The own transcript is the newest-mtime `<slug>/<id>.jsonl` across every
 *     root (first root on ties, as discoverSessions), validated by
 *     isAllowedTranscriptPath.
 *   - bypass: the newest permission-mode record is exactly bypassPermissions
 *     (readPermissionModeAsync).
 *   - name (rules a-d): the LATEST custom title of the TAIL_BYTES tail (never
 *     the ai-title, the first prompt or the capped label) when it passes
 *     isSafeResumeName, the row cwd's projectSlug equals the slug, and no
 *     other `<uuid>.jsonl` of that slug under ANY root carries the same
 *     resumeNameKey. More than RESUME_NAME_SCAN_MAX_FILES siblings, a guard
 *     rejection or read failure, or RESUME_NAME_SCAN_BUDGET_MS running out
 *     means not unique. Discretion: sdk-* and observer transcripts COUNT for
 *     uniqueness (conservative; Claude Code's name lookup is not known to
 *     skip them).
 *
 * Never rejects: any failure resolves `{ bypass: false }`.
 */
export async function resumeExtras(
  row: { id: string; slug?: string; cwd?: string },
  opts: { roots?: readonly string[]; now?: () => number } = {},
): Promise<ResumeExtras> {
  try {
    const id = row?.id;
    const slug = row?.slug;
    if (typeof id !== "string" || !SESSION_UUID_PATTERN.test(id)) return { bypass: false };
    if (!isSlugComponent(slug)) return { bypass: false };
    const roots = opts?.roots ?? projectRoots();
    const gathered: Candidate[] = [];
    for (const root of roots) gathered.push(...(await listSlugCandidates(root, slug)));
    let own: Candidate | undefined;
    for (const c of gathered) {
      if (c.id === id && (own === undefined || c.mtimeMs > own.mtimeMs)) own = c;
    }
    if (own === undefined) return { bypass: false };
    const realPath = isAllowedTranscriptPath(id, own.path, roots);
    if (realPath === undefined) return { bypass: false };
    const bypass = (await readPermissionModeAsync(realPath, id)) === "bypassPermissions";
    const now = typeof opts?.now === "function" ? opts.now : Date.now;
    const name = await uniqueResumeName(id, slug, row.cwd, realPath, gathered, roots, now);
    return name !== undefined ? { name, bypass } : { bypass };
  } catch {
    return { bypass: false };
  }
}

/**
 * D-17: keep the selection on the same session id across a reorder; when the
 * id drops out, move to the nearest row (the previous index clamped).
 */
export function reconcileSelection(
  rows: ReadonlyArray<{ id: string }>,
  selId: string | null,
  prevIdx: number,
): { selId: string | null; idx: number } {
  if (rows.length === 0) return { selId: null, idx: -1 };
  if (selId !== null) {
    const i = rows.findIndex((r) => r.id === selId);
    if (i >= 0) return { selId, idx: i };
  }
  const idx = Math.min(rows.length - 1, Math.max(0, Number.isFinite(prevIdx) ? Math.trunc(prevIdx) : 0));
  return { selId: rows[idx]!.id, idx };
}

/** Keep the cursor `idx` inside a `visible`-row window starting at `offset`. */
export function followOffset(idx: number, offset: number, total: number, visible: number): number {
  let next = offset;
  if (idx < next) next = idx;
  else if (idx >= next + visible) next = idx - visible + 1;
  return clampOffset(next, total, visible);
}
