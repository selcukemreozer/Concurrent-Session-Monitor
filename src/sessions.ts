import * as fsp from "node:fs/promises";
import { constants as FS } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SESSION_UUID_PATTERN,
  isAllowedTranscriptPath,
  projectRoots,
  readFirstPromptAsync,
  readTailFactsAsync,
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
 *     the per-path (size, mtime) cache.
 *
 * Contract: this module only READS. It writes nothing anywhere and installs no
 * hook. The CC registry dir also holds `<pid>.<hash>.key` peer-secret files;
 * only names matching ^\d+\.json$ are ever opened, so `*.key` files are never
 * read (T-08-08), and only `pid` and `sessionId` are used from a registry file.
 *
 * LOCKSTEP: scripts/csm-resume.mjs is a self-contained stdlib script that
 * cannot import src/; it mirrors this reducer (label chain, filters, caps,
 * liveness). Any change here must be made there too.
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

export type LabelKind = "name" | "derived" | "unnamed";

export type ResumeRow = {
  id: string;
  /** Cleaned and capped (D-09). */
  label: string;
  labelKind: LabelKind;
  /** Cleaned and capped at FOLDER_CAP. */
  folder: string;
  /** Raw tail cwd (launch.ts re-validates it before use). */
  cwd?: string;
  mtimeMs: number;
  live: boolean;
  /** Cleaned and capped at LAST_PROMPT_CAP (the pane never shows it, D-07). */
  lastPrompt?: string;
};

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

/** D-19: the pane's scan cadence, read lazily so tests can flip the env. */
export function resumeScanMs(): number {
  return numEnv("CSM_RESUME_SCAN_MS", 10000);
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
    const dir = path.join(root, slug.name);
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const id = e.name.slice(0, -".jsonl".length);
      if (!SESSION_UUID_PATTERN.test(id)) continue;
      const p = path.join(dir, e.name);
      try {
        const st = await fsp.lstat(p);
        if (!st.isFile()) continue;
        out.push({ id, path: p, slug: slug.name, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // vanished between readdir and lstat: skip
      }
    }
  }
  return out;
}

type CacheEntry = {
  size: number;
  mtimeMs: number;
  realPath: string;
  sdk: boolean;
  facts?: TailFacts;
  prompt?: string;
  promptFinal: boolean;
};

/** Per candidate path; survives pane toggles so a reopen is a warm scan. */
const cache = new Map<string, CacheEntry>();

/** Drop every cached verdict (tests; also lifts the sticky sdk verdict). */
export function resetSessionsCache(): void {
  cache.clear();
}

/** Folder = capped basename of the tail cwd, else the capped slug. */
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
    const read = await readTailFactsAsync(realPath, c.id);
    if (read === undefined) return undefined;
    const { size, mtimeMs, ...facts } = read;
    const shrank = entry !== undefined && size < entry.size;
    const next: CacheEntry = {
      size,
      mtimeMs,
      realPath,
      sdk: false,
      facts,
      prompt: shrank ? undefined : entry?.prompt,
      promptFinal: shrank ? false : (entry?.promptFinal ?? false),
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
  if (custom.length === 0 && cleanTitle(facts.aiTitle).length === 0 && !entry.promptFinal) {
    const head = await readFirstPromptAsync(entry.realPath, c.id);
    if (head !== undefined) {
      entry.prompt = head.prompt;
      entry.promptFinal = head.final;
    }
  }
  const { label, labelKind } = resumeLabel({
    customTitle: facts.customTitle,
    aiTitle: facts.aiTitle,
    firstPrompt: entry.prompt,
  });
  const lp = cleanTitle(facts.lastPrompt);
  return {
    id: c.id,
    label,
    labelKind,
    folder: folderOf(facts.cwd, c.slug),
    cwd: facts.cwd,
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
