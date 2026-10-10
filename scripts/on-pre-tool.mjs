#!/usr/bin/env node
// PreToolUse pre-edit advisory hook (CONF-02) — the earliest agent-facing
// collision signal. Monitor-and-warn ONLY.
//
// When the acting session is about to Edit/Write/MultiEdit a file a DIFFERENT
// live session already holds in its active write window, this injects ONE short
// `hookSpecificOutput.additionalContext` line and lets the edit proceed. It
// mirrors CONF-01 `detectConflicts` semantics (realpath match, live-only,
// write-window, self-exclusion — D-06) but re-derives them self-contained here
// to stay inside the synchronous latency budget (D-09).
//
// Hard laws (T-04-08 / D-07): the whole body is wrapped so it ALWAYS exits 0.
// It NEVER exits 2, NEVER emits a `permissionDecision` of deny, and NEVER writes
// any file (D-08). A crafted peer path/branch is control-stripped before it
// reaches the acting agent's context (T-04-10). Node stdlib only, NO import from
// src/ (T-1-SC), synchronous (D-09, NOT async in hooks.json).
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// T-04-11: allowlist the untrusted acting session_id before it is used.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

// D-01b store-location seam — identical precedence to src/paths.ts and the
// capture hooks: 1) CSM_STORE_DIR override, else 2) ~/.claude/csm.
function storeRoot() {
  const override = process.env.CSM_STORE_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".claude", "csm");
}

// Numeric env read that degrades a NaN/negative/unset value to the default
// (mirrors src/env.ts numEnv — a bad "2m" must not silently disable windowing).
function numEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function windowMs() {
  return numEnv("CSM_WINDOW_MS", 5 * 60 * 1000);
}
function staleMs() {
  return numEnv("CSM_STALE_MS", 120000);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Drop C0 (0x00-0x1F) and C1 (0x80-0x9F) controls so a crafted peer path/branch
// cannot inject escape sequences into the acting agent's context (T-04-10,
// mirrors src/sanitize.ts). Printable non-ASCII (>=0xA0) and emoji survive.
function stripControls(s) {
  let out = "";
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || (cp >= 0x80 && cp <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

// ---- Session name (NAME-02, D-08/D-09) -------------------------------------
// mirrors src/label.ts and scripts/csm-status.mjs; keep in lockstep
// (Pitfall 8). Identical to the csm-status block except cleanTitle calls
// stripControls (this script's sanitize). Kept ASCII-only: the ellipsis is an
// escape and bidi code points are compared numerically.

/** D-09: display cap in grapheme clusters (the ellipsis is extra). */
const NAME_CAP = 24;

/** U+2026 horizontal ellipsis (>= 0xA0, so stripControls() keeps it). */
const ELLIPSIS = "\u2026";

/** T-07-02: bidi/format code points that can visually reorder or hide text. */
function isBidiFormat(cp) {
  return (
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
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

/** stripControls() first (D-09 order), drop bidi/format, collapse whitespace, trim. Non-string -> "". */
function cleanTitle(raw) {
  if (typeof raw !== "string") return "";
  let out = "";
  for (const ch of stripControls(raw)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isBidiFormat(cp)) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Cap an ALREADY-cleaned string to `max` grapheme clusters plus ELLIPSIS. */
function truncateLabel(s, max = NAME_CAP) {
  const g = graphemes(s);
  return g.length > max ? g.slice(0, max).join("") + ELLIPSIS : s;
}

/** Display name, or undefined when the cleaned title is empty (unnamed; never "(unnamed)", D-07). */
function displayName(raw) {
  const clean = cleanTitle(raw);
  return clean.length > 0 ? truncateLabel(clean, NAME_CAP) : undefined;
}

/**
 * Read a peer's hook-cached native name (title.json): a non-empty string
 * title, else undefined; absent/torn => undefined (folder fallback). Never
 * opens the transcript (D-04 scope). Read-only: this hook writes no file (D-08).
 */
function readTitle(dir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, "title.json"), "utf8"));
    if (typeof parsed?.title === "string" && parsed.title.length > 0) return parsed.title;
  } catch {
    // absent/torn title.json -> folder fallback
  }
  return undefined;
}

// Resolve a possibly-relative, possibly-deleted file_path to a canonical
// realpath WITHOUT ever throwing (mirrors src/conflicts.ts resolveRealpath):
// lexical absolute anchor, then fold symlinks; ENOENT degrades to the lexical
// path so two sessions on the same intended path still match.
function resolveRealpath(file_path, cwd) {
  const lexical = path.isAbsolute(file_path)
    ? file_path
    : path.resolve(cwd ?? process.cwd(), file_path);
  try {
    return realpathSync(lexical);
  } catch {
    return lexical;
  }
}

// Last-seen ms from the heartbeat sidecar (mirrors src/liveness.ts
// resolveLastSeen): parse ISO content, fall back to mtime, else undefined.
function resolveLastSeen(dir) {
  const hb = path.join(dir, "heartbeat");
  let content;
  try {
    content = readFileSync(hb, "utf8");
  } catch {
    return undefined;
  }
  const parsed = Date.parse(content.trim());
  if (!Number.isNaN(parsed)) return parsed;
  try {
    return statSync(hb).mtimeMs;
  } catch {
    return undefined;
  }
}

// Cheap liveness (RESEARCH Pitfall 3, D-09 budget): heartbeat-fresh within
// staleMs OR a live pid (kill -0). Deliberately SKIPS the `ps -o lstart=`
// pid-reuse guard the panel uses — the synchronous hook trades that precision
// for latency. A missing/invalid pid is simply not a positive liveness signal.
function isLive(dir, state, now) {
  const seen = resolveLastSeen(dir);
  if (seen !== undefined && now - seen < staleMs()) return true;
  const pid = state && state.pid;
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      if (e && e.code === "EPERM") return true; // exists, not ours
    }
  }
  return false;
}

// Reduce a session's files.jsonl to its active write paths within the window
// (mirrors src/aggregate.ts activeFiles): newest-per-path, drop released, skip
// torn lines. Returns the surviving file_path strings (verbatim, pre-realpath).
function activeWritePaths(dir, now) {
  let raw;
  try {
    raw = readFileSync(path.join(dir, "files.jsonl"), "utf8");
  } catch {
    return [];
  }
  const threshold = now - windowMs();
  const released = new Set();
  const newest = new Map(); // file_path -> newest ts (ms)
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue; // skip a torn/partial trailing line
    }
    if (typeof evt?.file_path !== "string" || typeof evt?.ts !== "string") continue;
    if (evt.released) {
      released.add(evt.file_path);
      continue;
    }
    const tsMs = Date.parse(evt.ts);
    if (Number.isNaN(tsMs) || tsMs < threshold) continue; // outside the active window
    const prev = newest.get(evt.file_path);
    if (prev === undefined || tsMs > prev) newest.set(evt.file_path, tsMs);
  }
  const out = [];
  for (const [fp] of newest) {
    if (released.has(fp)) continue;
    out.push(fp);
  }
  return out;
}

try {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    payload = null;
  }

  const id = payload && payload.session_id;
  const tool_name = payload && payload.tool_name;
  const cwd = (payload && payload.cwd) || process.cwd();
  // Edit/Write carry tool_input.file_path; fall back to the first edit's
  // file_path so an unexpected MultiEdit nesting still resolves (mirror on-tool).
  const toolInput = payload && payload.tool_input;
  const file_path =
    (toolInput && toolInput.file_path) ??
    (toolInput && toolInput.edits && toolInput.edits[0] && toolInput.edits[0].file_path);

  // Silent, passive exits (no output): bad id, non-write tool (Read never
  // triggers — D-06), or missing file_path.
  const isWriteTool =
    tool_name === "Edit" || tool_name === "Write" || tool_name === "MultiEdit";
  if (
    typeof id === "string" &&
    SAFE_ID.test(id) &&
    id !== "." &&
    id !== ".." &&
    isWriteTool &&
    typeof file_path === "string" &&
    file_path
  ) {
    const now = Date.now();
    const root = path.join(storeRoot(), "sessions");

    let dirs;
    try {
      dirs = readdirSync(root);
    } catch {
      dirs = []; // store not created yet
    }

    // Enumerate sessions once: load each snapshot and its liveness verdict.
    const live = []; // { session_id, dir, state }
    for (const dirName of dirs) {
      const dir = path.join(root, dirName);
      let state;
      try {
        state = JSON.parse(readFileSync(path.join(dir, "session.json"), "utf8"));
      } catch {
        continue; // torn/missing snapshot self-heals next tick
      }
      if (!isLive(dir, state, now)) continue;
      const sid = typeof state.session_id === "string" ? state.session_id : dirName;
      live.push({ session_id: sid, dir, state });
    }

    // Early-exit under 2 live sessions — no possible cross-session conflict
    // (D-06/D-09 latency guard).
    if (live.length >= 2) {
      const editRealpath = resolveRealpath(file_path, cwd);

      // Self-exclude by session_id (D-07): only OTHER live sessions can conflict.
      for (const peer of live) {
        if (peer.session_id === id) continue;
        const peerCwd = (peer.state && peer.state.cwd) || undefined;
        let hit = false;
        for (const fp of activeWritePaths(peer.dir, now)) {
          if (resolveRealpath(fp, peerCwd) === editRealpath) {
            hit = true;
            break;
          }
        }
        if (!hit) continue;

        // First live peer holding the same realpath -> emit ONE advisory line.
        // NAME-02 / D-08: lead with the peer's native name when set, else the
        // folder (D-07: never "(unnamed)"). The title is read only here, for the
        // one matched peer, so the no-conflict path pays nothing (D-09 latency).
        // It is the hook-cached title only, never the transcript tail (D-04
        // scope). The 24-grapheme cap plus the control/bidi strip bound the
        // peer-chosen text injected into the acting agent's context (T-07-06).
        const lead = displayName(readTitle(peer.dir)) ?? stripControls(peer.state.folder ?? "");
        const branch = stripControls(peer.state.branch ?? "") || "—";
        const shortId = stripControls(String(peer.session_id).slice(0, 8));
        const label = `${lead} · ${branch} · ${shortId}`;
        const base = stripControls(path.basename(editRealpath));
        const advisory = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: `⚠ ${base} is also held by ${label}`,
          },
        };
        process.stdout.write(JSON.stringify(advisory));
        break; // one advisory is enough; the edit still proceeds
      }
    }
  }
} catch {
  // Swallow every error (T-04-08): NEVER exit non-zero, NEVER deny, NEVER block.
}

process.exit(0);
