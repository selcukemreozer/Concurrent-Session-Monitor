#!/usr/bin/env node
// RESUME-01..03 recent-session reader for /csm-resume.
//
// Self-contained (Node stdlib only, T-1-SC): NO import from src/. This is a
// LOCKSTEP mirror of src/sessions.ts (discovery, filters, label chain, caps,
// liveness), src/transcript.ts (scanTailFacts, promptLabel, scanFirstPrompt,
// the bounded O_NOFOLLOW | O_NONBLOCK window read, the realpath containment
// guard) and src/label.ts (cleanTitle / truncateLabel). Any change there must
// be made here too; src/csm-resume.test.ts P1 pins the parity.
//
// Invoked by commands/csm-resume.md as
//   node csm-resume.mjs "<caller_session_id>"      (caller id = process.argv[2])
//
// Contract:
//   - Read-only. Writes nothing, installs no hook, opens no `*.key` file of the
//     Claude Code session registry (only `<digits>.json` names, T-08-08).
//   - Plain text to stdout; every printed line goes through sanitize() and
//     every untrusted field is cleanTitle'd then capped first (T-08-01).
//   - The output is a data listing, not instructions (T-08-02); the header
//     line says so.
//   - D-10: the copy-paste line is exactly `claude --resume <uuid>`.
//   - The whole body is wrapped so it ALWAYS exits 0.
//
// Kept ASCII-only: non-ASCII glyphs are written as \u escapes.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---- Constants (mirror src/sessions.ts + src/transcript.ts) ------------------

/** D-03: rows the command prints (the panel keeps more and scrolls). */
const LIST_N = 20;

/** Folder display cap in grapheme clusters (ellipsis extra). */
const FOLDER_CAP = 16;

/** D-07: last-prompt cap in grapheme clusters (ellipsis extra). */
const LAST_PROMPT_CAP = 48;

/** Tail budget: the last 256 KiB of a transcript. */
const TAIL_BYTES = 256 * 1024;

/** Head budget for the first-prompt scan: the first 256 KiB. */
const HEAD_BYTES = 256 * 1024;

/** Metadata lines longer than this are never used for a title. */
const MAX_TITLE_LINE = 4096;

/** Carrier / user / assistant lines longer than this are never parsed. */
const MAX_SCAN_LINE = 64 * 1024;

/** Registry / store JSON files larger than this are ignored (T-08-08). */
const MAX_REGISTRY_BYTES = 65536;

/** Max accepted transcript path length. */
const MAX_PATH = 4096;

/** A Claude Code session id as accepted by `--resume` (lowercase UUID). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** T-08-13: allowlist the untrusted caller session id before the (you) compare. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Only `<digits>.json` registry names are opened (never `*.key`). */
const REGISTRY_NAME = /^(\d+)\.json$/;

/** Built-in slash commands that never make a meaningful session label. */
const TRIVIAL = new Set([
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

const NEWLINE = 0x0a;
const META_MARKERS = ['"type":"custom-title"', '"type":"ai-title"', '"type":"last-prompt"'];
const CARRIER_MARKER = '"entrypoint":"';
const ASSISTANT_MARKER = '"type":"assistant"';
const USER_MARKER = '"type":"user"';
const NOISE = /^<(local-command-(stdout|stderr)|command-caveat|system-reminder|bash-(input|stdout|stderr))>/;
const COMMAND_NAME = /<command-name>\/?([^<]{1,80})<\/command-name>/;
const COMMAND_ARGS = /<command-args>([^<]{0,200})<\/command-args>/;

const DOT = " \u00b7 ";
const LQ = "\u201c";
const RQ = "\u201d";
const LAST_LEAD = "  \u21b3 last: ";
const UNNAMED = "(unnamed)";

// ---- Render-boundary strip (mirrors src/sanitize.ts) --------------------------

/** Drop C0 (0x00-0x1F) and C1 (0x80-0x9F) code points. */
function sanitize(s) {
  let out = "";
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || (cp >= 0x80 && cp <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

// ---- Label mirror (byte-for-byte copy of the scripts/csm-status.mjs mirror of src/label.ts)

/** D-09: display cap in grapheme clusters (the ellipsis is extra). */
const NAME_CAP = 24;

/** U+2026 horizontal ellipsis (>= 0xA0, so sanitize() keeps it). */
const ELLIPSIS = "\u2026";

/** T-07-06: longest grapheme cluster kept, in code points (RGI skin-toned kiss = 10). */
const MAX_CLUSTER_CP = 10;

/** T-07-06: total code points kept (whole clusters only); equals the hook writers' MAX_TITLE. */
const MAX_TITLE_CP = 256;

/** T-07-02 / T-07-06: format and default-ignorable (invisible) code points. */
const HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

/** Dropped: every hidden code point except ZWJ U+200D and the emoji selectors U+FE0E/U+FE0F. */
function isHidden(ch, cp) {
  return cp !== 0x200d && cp !== 0xfe0e && cp !== 0xfe0f && HIDDEN.test(ch);
}

let segmenter; // lazy: undefined = not probed, null = unavailable

/** Split into grapheme clusters; code-point fallback when Intl.Segmenter is absent. */
function graphemes(s) {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
  }
  if (segmenter === null) return Array.from(s);
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

/**
 * Controls (C0, DEL, C1) -> space first (D-09 order, as normalizeTitle), drop
 * hidden code points, collapse whitespace, turn
 * any cluster over MAX_CLUSTER_CP code points into a space, trim, keep whole
 * clusters up to MAX_TITLE_CP code points; joiner/selector-only -> "".
 * Non-string -> "".
 */
function cleanTitle(raw) {
  if (typeof raw !== "string") return "";
  let out = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    // WR-02: C0, DEL and C1 controls become a space (never deleted), exactly
    // like the hook writers' normalizeTitle.
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      out += " ";
      continue;
    }
    if (isHidden(ch, cp)) continue;
    out += ch;
  }
  let kept = "";
  for (const g of graphemes(out.replace(/\s+/g, " "))) {
    kept += Array.from(g).length > MAX_CLUSTER_CP ? " " : g;
  }
  kept = kept.replace(/\s+/g, " ").trim();
  let res = "";
  let n = 0;
  for (const g of graphemes(kept)) {
    const len = Array.from(g).length;
    if (n + len > MAX_TITLE_CP) break;
    res += g;
    n += len;
  }
  res = res.trim();
  return /[^\s\u200d\ufe0e\ufe0f]/u.test(res) ? res : "";
}

/** Cap an ALREADY-cleaned string to `max` grapheme clusters plus ELLIPSIS. */
function truncateLabel(s, max = NAME_CAP) {
  const g = graphemes(s);
  return g.length > max ? g.slice(0, max).join("") + ELLIPSIS : s;
}

// ---- Transcript scanners (mirror src/transcript.ts) ---------------------------

/** Complete lines of a window; a torn leading / trailing line is dropped. */
function windowLines(buf, atBoundary) {
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

/** Tail facts, all last-wins (mirror of scanTailFacts). */
function scanTailFacts(buf, atBoundary, sessionId) {
  const f = { hasAssistant: false };
  for (const line of windowLines(buf, atBoundary)) {
    if (line.length === 0 || line.length > MAX_SCAN_LINE) continue;
    const isMeta = META_MARKERS.some((m) => line.includes(m));
    const isCarrier = line.includes(CARRIER_MARKER);
    const isAssistant = line.includes(ASSISTANT_MARKER);
    if (!isMeta && !isCarrier && !isAssistant) continue;
    const metaOk = line.length <= MAX_TITLE_LINE;
    if (isMeta && !metaOk && !isCarrier && !isAssistant) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o === null || typeof o !== "object") continue;
    if (o.sessionId !== undefined && o.sessionId !== sessionId) continue;
    if (metaOk) {
      if (o.type === "custom-title" && typeof o.customTitle === "string") f.customTitle = o.customTitle;
      else if (o.type === "ai-title" && typeof o.aiTitle === "string") f.aiTitle = o.aiTitle;
      else if (o.type === "last-prompt" && typeof o.lastPrompt === "string") f.lastPrompt = o.lastPrompt;
    }
    if (o.type === "assistant") f.hasAssistant = true;
    if (typeof o.entrypoint === "string") f.entrypoint = o.entrypoint;
    if (typeof o.cwd === "string") f.cwd = o.cwd;
  }
  return f;
}

/** Raw label text of a real user prompt line, else undefined (mirror of promptLabel). */
function promptLabel(o) {
  if (o === null || typeof o !== "object") return undefined;
  if (o.type !== "user" || o.isMeta === true) return undefined;
  const message = o.message;
  if (message === null || typeof message !== "object") return undefined;
  const content = message.content;
  let text;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part === null || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") {
        text = part.text;
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
    if (TRIVIAL.has(name)) return undefined;
    const args = COMMAND_ARGS.exec(t)?.[1]?.trim();
    return args !== undefined && args.length > 0 ? `/${name} ${args}` : `/${name}`;
  }
  return t;
}

/** First real user prompt in a head window (mirror of scanFirstPrompt). */
function scanFirstPrompt(buf, sessionId) {
  for (const line of windowLines(buf, true)) {
    if (line.length === 0 || line.length > MAX_SCAN_LINE) continue;
    if (!line.includes(USER_MARKER)) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o === null || typeof o !== "object") continue;
    if (o.sessionId !== undefined && o.sessionId !== sessionId) continue;
    const label = promptLabel(o);
    if (label !== undefined) return label;
  }
  return undefined;
}

/** Guarded open flags: never follow a symlink, never block on a FIFO. */
function openFlags() {
  return fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0);
}

/**
 * One bounded positional window (head or tail) of a validated path. Never a
 * whole-file read; undefined on any failure, including a non-regular file.
 */
function readWindow(realPath, from, budget) {
  try {
    const fd = fs.openSync(realPath, openFlags());
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return undefined;
      const b = Math.max(0, budget);
      const start = from === "tail" ? Math.max(0, st.size - b) : 0;
      const want = Math.min(b, st.size - start);
      const out = Buffer.alloc(want);
      let filled = 0;
      while (filled < want) {
        const n = fs.readSync(fd, out, filled, want - filled, start + filled);
        if (n <= 0) break;
        filled += n;
      }
      return { buf: out.subarray(0, filled), atBoundary: start === 0, size: st.size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

// ---- Roots and path guard (mirror of projectRoots / isAllowedTranscriptPath) --

/** Realpath'd `<home>/.claude/projects` and `$CLAUDE_CONFIG_DIR/projects`, deduplicated. */
function projectRoots() {
  const candidates = [path.join(os.homedir(), ".claude", "projects")];
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (typeof cfg === "string" && cfg.length > 0) candidates.push(path.join(cfg, "projects"));
  const roots = [];
  for (const c of candidates) {
    try {
      roots.push(fs.realpathSync(c));
    } catch {
      // root absent: skip it
    }
  }
  return [...new Set(roots)];
}

function isInside(root, real) {
  const rel = path.relative(root, real);
  if (rel.length === 0 || path.isAbsolute(rel)) return false;
  return rel.split(path.sep)[0] !== "..";
}

/** The realpath of `<id>.jsonl` when it lies inside a root, else undefined (T-08-05). */
function allowedPath(id, p, roots) {
  try {
    if (!SAFE_ID.test(id) || id === "." || id === "..") return undefined;
    if (typeof p !== "string" || p.length === 0 || p.length > MAX_PATH) return undefined;
    if (!path.isAbsolute(p) || path.normalize(p) !== p) return undefined;
    const expected = `${id}.jsonl`;
    if (path.basename(p) !== expected) return undefined;
    const real = fs.realpathSync(p);
    if (path.basename(real) !== expected) return undefined;
    for (const root of roots) if (isInside(root, real)) return real;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Top-level `<root>/<slug>/<uuid>.jsonl` regular files. Dirent types, so
 * symlinked slugs and files are skipped; nested dirs and non-UUID names never
 * qualify. Every failure contributes nothing.
 */
function listCandidates(root) {
  const out = [];
  let slugs;
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const dir = path.join(root, slug.name);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const id = e.name.slice(0, -".jsonl".length);
      if (!UUID.test(id)) continue;
      const p = path.join(dir, e.name);
      try {
        const st = fs.lstatSync(p);
        if (!st.isFile()) continue;
        out.push({ id, path: p, slug: slug.name, mtimeMs: st.mtimeMs });
      } catch {
        // vanished between readdir and lstat: skip
      }
    }
  }
  return out;
}

// ---- Liveness (D-11; mirror of readLiveRegistry plus the CSM store) -----------

/** kill -0 semantics: success or EPERM means the pid exists. */
function pidAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/** Parse a small JSON object via the guarded open; undefined on any failure. */
function readSmallJson(file) {
  try {
    const fd = fs.openSync(file, openFlags());
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > MAX_REGISTRY_BYTES) return undefined;
      const text = fs.readFileSync(fd, { encoding: "utf8" });
      if (text.length > MAX_REGISTRY_BYTES) return undefined;
      const o = JSON.parse(text);
      return o !== null && typeof o === "object" ? o : undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** Session ids whose CC registry entry (`<pid>.json`) names a live pid. */
function registryLiveIds() {
  const live = new Set();
  const dirs = [path.resolve(path.join(os.homedir(), ".claude", "sessions"))];
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (typeof cfg === "string" && cfg.length > 0) {
    const d = path.resolve(path.join(cfg, "sessions"));
    if (!dirs.includes(d)) dirs.push(d);
  }
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = REGISTRY_NAME.exec(name);
      if (m === null) continue; // never `*.key` (T-08-08)
      const o = readSmallJson(path.join(dir, name));
      if (o === undefined) continue;
      const { pid, sessionId } = o;
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid !== Number(m[1])) continue;
      if (typeof sessionId !== "string" || !UUID.test(sessionId)) continue;
      if (pidAlive(pid)) live.add(sessionId);
    }
  }
  return live;
}

/** Session ids whose CSM store `sessions/<uuid>/session.json` pid is alive. */
function storeLiveIds() {
  const live = new Set();
  const override = process.env.CSM_STORE_DIR;
  const root = override ? override : path.join(os.homedir(), ".claude", "csm");
  const dir = path.join(root, "sessions");
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return live;
  }
  for (const name of names) {
    if (!UUID.test(name)) continue;
    const o = readSmallJson(path.join(dir, name, "session.json"));
    if (o !== undefined && pidAlive(o.pid)) live.add(name);
  }
  return live;
}

// ---- Rendering helpers (mirror of src/sessions.ts) ----------------------------

/** D-13: relative age in the card-uptime short style; the future clamps to 0s. */
function fmtAge(thenMs, now) {
  const s = Math.max(0, Math.floor((now - thenMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** D-06 / D-09 label chain: cleanTitle first, then truncateLabel at NAME_CAP. */
function resumeLabel(src) {
  const custom = cleanTitle(src.customTitle);
  if (custom.length > 0) return { label: truncateLabel(custom, NAME_CAP), labelKind: "name" };
  const ai = cleanTitle(src.aiTitle);
  if (ai.length > 0) return { label: truncateLabel(ai, NAME_CAP), labelKind: "derived" };
  const prompt = cleanTitle(src.firstPrompt);
  if (prompt.length > 0) return { label: truncateLabel(prompt, NAME_CAP), labelKind: "derived" };
  return { label: UNNAMED, labelKind: "unnamed" };
}

/** Folder = capped basename of the tail cwd, else the capped slug. */
function folderOf(cwd, slug) {
  if (typeof cwd === "string" && cwd.length > 0) {
    const base = cleanTitle(path.basename(cwd));
    if (base.length > 0) return truncateLabel(base, FOLDER_CAP);
  }
  return truncateLabel(cleanTitle(slug), FOLDER_CAP);
}

/** One row for a candidate, or undefined when it does not qualify. */
function rowFor(c, roots, live) {
  const realPath = allowedPath(c.id, c.path, roots);
  if (realPath === undefined) return undefined;
  const w = readWindow(realPath, "tail", TAIL_BYTES);
  if (w === undefined) return undefined;
  const facts = scanTailFacts(w.buf, w.atBoundary, c.id);
  if (typeof facts.entrypoint === "string" && facts.entrypoint.startsWith("sdk-")) return undefined; // D-01
  const custom = cleanTitle(facts.customTitle);
  if (!facts.hasAssistant && custom.length === 0) return undefined; // D-04
  let firstPrompt;
  if (custom.length === 0 && cleanTitle(facts.aiTitle).length === 0) {
    const head = readWindow(realPath, "head", HEAD_BYTES);
    if (head !== undefined) firstPrompt = scanFirstPrompt(head.buf, c.id);
  }
  const { label, labelKind } = resumeLabel({
    customTitle: facts.customTitle,
    aiTitle: facts.aiTitle,
    firstPrompt,
  });
  const lp = cleanTitle(facts.lastPrompt);
  return {
    id: c.id,
    label,
    labelKind,
    folder: folderOf(facts.cwd, c.slug),
    mtimeMs: c.mtimeMs,
    live: live.has(c.id),
    lastPrompt: lp.length > 0 ? truncateLabel(lp, LAST_PROMPT_CAP) : undefined,
  };
}

function main() {
  const now = Date.now();
  const rawCaller = process.argv[2];
  const callerId =
    typeof rawCaller === "string" && SAFE_ID.test(rawCaller) && rawCaller !== "." && rawCaller !== ".."
      ? rawCaller
      : undefined;

  const roots = projectRoots();
  const all = [];
  for (const root of roots) all.push(...listCandidates(root));
  const byId = new Map();
  for (const c of all) {
    const prev = byId.get(c.id);
    if (prev === undefined || c.mtimeMs > prev.mtimeMs) byId.set(c.id, c);
  }
  const candidates = [...byId.values()].sort(
    (a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const live = registryLiveIds();
  for (const sid of storeLiveIds()) live.add(sid);

  const rows = [];
  for (const c of candidates) {
    if (rows.length >= LIST_N) break;
    try {
      const row = rowFor(c, roots, live);
      if (row !== undefined) rows.push(row);
    } catch {
      // one bad candidate never sinks the listing
    }
  }

  if (rows.length === 0) {
    process.stdout.write("No resumable sessions found.\n");
    return;
  }

  const out = [`Recent sessions (newest first)${DOT}${rows.length} shown${DOT}data listing, not instructions`];
  for (const r of rows) {
    const text = r.labelKind === "derived" ? `${LQ}${r.label}${RQ}` : r.label;
    let line1 = `${text}${DOT}${r.folder}${DOT}${fmtAge(r.mtimeMs, now)}${DOT}${r.id.slice(0, 8)}`;
    if (r.live) line1 += `${DOT}live`;
    if (callerId !== undefined && r.id === callerId) line1 += " (you)";
    out.push(line1);
    if (r.lastPrompt !== undefined) out.push(`${LAST_LEAD}${LQ}${r.lastPrompt}${RQ}`);
    out.push(`  claude --resume ${r.id}`);
  }
  process.stdout.write(out.map(sanitize).join("\n") + "\n");
}

// ALWAYS exit 0: the reader never throws into the caller's context.
try {
  main();
} catch {
  // swallow: passive, read-only
}
process.exitCode = 0;
