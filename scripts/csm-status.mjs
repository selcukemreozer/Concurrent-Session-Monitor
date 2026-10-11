#!/usr/bin/env node
// INT-02 cross-session status reader — the on-demand "who is doing what" query.
//
// Self-contained (Node stdlib only, T-1-SC): NO import from src/. It re-derives
// readAll / liveness / resolveRealpath semantics inline and renders PLAIN TEXT
// to stdout — never Ink (D-04). Invoked by commands/csm-status.md as
//   node csm-status.mjs "<caller_session_id>"      (caller id = process.argv[2])
//
// Passivity contract (T-04-09b): cheap liveness only (heartbeat-fresh OR
// kill -0) — the `ps -o lstart=` pid-reuse guard is deliberately SKIPPED so the
// command returns promptly. The whole body is wrapped so it ALWAYS exits 0.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/**
 * Per-run cache for deriveLiveBranch — cwd -> derived live branch (or the snapshot
 * fallback). Deduped so repeated cwds spawn `git` at most once per distinct dir in
 * a single reader invocation (T-LB-03). The process runs once and exits, so a
 * module-level Map is the run scope.
 */
const branchCache = new Map();

/**
 * Derive a session's CURRENT git branch synchronously from its cwd (LB-03,
 * D-LB-05), mirroring the SessionStart hook's git invocation
 * (scripts/on-session-start.mjs): `git -C <cwd> rev-parse --abbrev-ref HEAD` via
 * execFileSync with an args ARRAY (NO shell — a crafted cwd can never inject a
 * command, T-LB-01), a 1000ms timeout, and stderr ignored. Returns the trimmed
 * live branch when non-empty, else the SessionStart `snapshot` on ANY throw
 * (non-repo / git-absent / timeout) or empty output. When cwd is absent, returns
 * the snapshot. Deduped by cwd within the run so git spawns once per distinct dir.
 */
function deriveLiveBranch(cwd, snapshot) {
  if (typeof cwd !== "string" || cwd.length === 0) return snapshot;
  if (branchCache.has(cwd)) return branchCache.get(cwd);
  let branch = snapshot;
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (out.length > 0) branch = out;
  } catch {
    // non-repo / git-absent / timeout -> snapshot fallback (never throws)
  }
  branchCache.set(cwd, branch);
  return branch;
}

// T-04-07: allowlist the untrusted caller session id before any path/(you) use.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

// Internal TEST-ONLY seams (NOT documented — analogous to CSM_TEST_NUM). Let a
// spawnSync-based test point the port scan at fixture scripts (default lsof/ps).
function lsofCmd() {
  return process.env.CSM_LSOF_CMD || "lsof";
}
function psCmd() {
  return process.env.CSM_PS_CMD || "ps";
}

/**
 * D-01b store-location seam — identical precedence to src/paths.ts: 1)
 * CSM_STORE_DIR override, else 2) ~/.claude/csm. CLAUDE_PLUGIN_DATA is
 * deliberately NOT a tier (writer/reader would split) — see src/paths.ts.
 */
function storeRoot() {
  const override = process.env.CSM_STORE_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".claude", "csm");
}
function sessionsDir() {
  return path.join(storeRoot(), "sessions");
}

/** Numeric env tunable with NaN/negative degrade-to-default (mirrors src/env.numEnv). */
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
/**
 * Attention safety-net ceiling (mirrors aggregate.attnWindowMs, 260926-r7n,
 * 261011-or2): the longest a session's "waiting on you" flag can stay shown
 * when no resume signal follows, whatever the pid says. Default 10800000
 * (3 h). It bounds an "asking" flag ONLY when the pid is not alive (absent or
 * exited); while the pid is alive an open question has no time ceiling and
 * clears only via ask-resolved or the lastSeenMs fallback. This is a SAFETY
 * NET, not the primary clear. The primary clears are the resume sidecars (260927-1zw):
 * `resumed` (main-thread PostToolUse / Stop via on-activity, and on-user-prompt)
 * clears waiting; `ask-resolved` (main-thread AskUserQuestion completion or
 * Stop via on-activity, and on-user-prompt) clears asking. The heartbeat is
 * only the fallback clear when a sidecar is absent. Subagent activity never
 * clears a flag, and Esc / reject / approve / deny fire no hook. The ceiling
 * also bounds the WR-01 needs-you keepalive. A NaN/negative override degrades
 * to the 3-hour default.
 */
function attnWindowMs() {
  return numEnv("CSM_ATTN_WINDOW_MS", 10800000);
}
/**
 * Running-state safety net (mirrors aggregate.runWindowMs, 260927-46l): a turn
 * marker older than this, measured from the newer of the turn ts and the
 * heartbeat, stops counting as running. Bounds the Esc case (no Stop hook on
 * interrupt) and the running keepalive. Default 1800000 (30 min); a
 * NaN/negative override degrades to the default.
 */
function runWindowMs() {
  return numEnv("CSM_RUN_WINDOW_MS", 1800000);
}
/**
 * Idle-waiting threshold (mirrors aggregate.idleWaitMs, 260927-4tv,
 * 261011-or2): once a main-thread Stop has left turn.json "idle" for at least
 * this long (default 1000 ms / 1 s), the session is waiting on the human and
 * shows ◉ waiting, without waiting for Claude Code's ~60 s idle_prompt
 * Notification. Bounded above by attnWindowMs() (the 3 h waiting ceiling). A
 * NaN/negative override degrades to the default (0 is accepted).
 */
function idleWaitMs() {
  return numEnv("CSM_IDLE_WAIT_MS", 1000);
}

/**
 * Render-boundary control-character strip (T-04-06, ASVS V5). Drops C0
 * (0x00-0x1F) and C1 (0x80-0x9F) so a crafted intent/branch/path cannot inject
 * terminal escapes into the caller's context. Code-point iteration (not a regex
 * literal) keeps this source free of literal control bytes (mirrors src/sanitize.ts).
 */
function sanitize(s) {
  let out = "";
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || (cp >= 0x80 && cp <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

// ---- Session name (NAME-02, D-07/D-08/D-09) --------------------------------
// mirrors src/label.ts cleanTitle / truncateLabel / displayName; keep in
// lockstep (Pitfall 8). This script is stdlib-only and cannot import src/.
// Kept ASCII-only: the ellipsis is an escape and invisible code points are
// matched by \p{...} / \u escapes or compared numerically, never as literals.

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

/** Display name, or undefined when the cleaned title is empty (unnamed; never "(unnamed)", D-07). */
function displayName(raw) {
  const clean = cleanTitle(raw);
  return clean.length > 0 ? truncateLabel(clean, NAME_CAP) : undefined;
}

/** Basename of a path string WITHOUT opening it (mirrors Card.tsx basename). */
function basename(p) {
  const parts = String(p).split("/");
  return parts[parts.length - 1] || String(p);
}

/** Compact uptime (mirrors src/liveness.fmtUptime): "45s" / "42m" / "1h 2m". */
function fmtUptime(startMs, now) {
  const s = Math.max(0, Math.floor((now - startMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Reduce a session's files.jsonl into currently-active writes within the window
 * (mirrors aggregate.activeFiles): newest-per-path, drop `released`, skip torn
 * lines. Returns { files:[{file_path,ts}], lastActiveMs }. Reads (reads.jsonl)
 * are NEVER consulted here — the roster is writes-only (D-05).
 */
function activeWrites(dir, now) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, "files.jsonl"), "utf8");
  } catch {
    return { files: [], lastActiveMs: -Infinity };
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
      continue; // torn/partial line self-heals next read
    }
    if (typeof evt?.file_path !== "string" || typeof evt?.ts !== "string") continue;
    if (evt.released) {
      released.add(evt.file_path);
      continue;
    }
    const tsMs = Date.parse(evt.ts);
    if (Number.isNaN(tsMs) || tsMs < threshold) continue;
    const prev = newest.get(evt.file_path);
    if (prev === undefined || tsMs > prev) newest.set(evt.file_path, tsMs);
  }
  const files = [];
  let lastActiveMs = -Infinity;
  for (const [file_path, tsMs] of newest) {
    if (released.has(file_path)) continue;
    files.push({ file_path, tsMs });
    if (tsMs > lastActiveMs) lastActiveMs = tsMs;
  }
  return { files, lastActiveMs };
}

/** Read the declared intent shard (mirrors aggregate.readIntent): absent/torn => undefined. */
function readIntent(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "intent.txt"), "utf8"));
    if (typeof parsed?.intent === "string" && parsed.intent.length > 0) return parsed.intent;
  } catch {
    // absent/torn intent.txt self-heals (D-11)
  }
  return undefined;
}

/**
 * Read the hook-cached native session name (title.json, NAME-02): a non-empty
 * string title, else undefined; absent/torn => undefined (folder fallback).
 *
 * D-04 scope (RESEARCH Open Question 1): /csm-status reads ONLY this
 * hook-cached title, never the transcript tail. A peer's mid-session /rename
 * therefore shows here after that peer's next prompt (when on-user-prompt
 * refreshes title.json), whereas the panel also reads the transcript tail.
 */
function readTitle(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "title.json"), "utf8"));
    if (typeof parsed?.title === "string" && parsed.title.length > 0) return parsed.title;
  } catch {
    // absent/torn title.json self-heals: the lead falls back to the folder
  }
  return undefined;
}

/** Read the declared target-branch shard (mirrors aggregate.readTargetBranch, TB-03): absent/torn => undefined. */
function readTargetBranch(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "target-branch.txt"), "utf8"));
    if (typeof parsed?.target_branch === "string" && parsed.target_branch.length > 0)
      return parsed.target_branch;
  } catch {
    // absent/torn target-branch.txt self-heals (D-11)
  }
  return undefined;
}

/**
 * Read the attention snapshot shard {type, ts} written by on-notification.mjs
 * (06-02), mirroring readTargetBranch's try/catch self-heal (T-06-07): returns
 * the parsed object only when it has a non-empty string `type` and a string
 * `ts`; any throw / torn / absent file returns undefined. NEVER the message.
 */
function readAttention(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "attention.json"), "utf8"));
    if (typeof parsed?.type === "string" && parsed.type.length > 0 && typeof parsed?.ts === "string")
      return parsed;
  } catch {
    // absent/torn attention.json self-heals (D-11) — the row still renders
  }
  return undefined;
}

/**
 * Read the asking snapshot shard {ts} written by on-ask.mjs on PreToolUse
 * AskUserQuestion (260926-vfm, AQ-03), mirroring aggregate.readAsking and
 * readAttention's try/catch self-heal (T-vfm-07): returns the ts string only
 * when parsed.ts is a non-empty string; any throw / torn / absent file returns
 * undefined. NEVER returns any other key (T-vfm-03, detail-free).
 */
function readAsking(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "asking.json"), "utf8"));
    if (typeof parsed?.ts === "string" && parsed.ts.length > 0) return parsed.ts;
  } catch {
    // absent/torn asking.json self-heals — the row still renders
  }
  return undefined;
}

/**
 * Read the turn-state snapshot {state, ts, agents?} written by on-user-prompt
 * ("running") and on-activity on a main-thread Stop ("idle") (260927-46l),
 * mirroring aggregate.readTurn (incl. its turn_agents, 260927-73b): returns
 * { state, ts, agents } only when state is exactly "running" or "idle" and ts
 * is a non-empty string; `agents` is the file's count when it is a
 * non-negative safe integer, else 0. Any throw / torn / absent / unknown file
 * returns undefined. NEVER returns any other key.
 */
function readTurn(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "turn.json"), "utf8"));
    const state = parsed?.state;
    if ((state === "running" || state === "idle") && typeof parsed.ts === "string" && parsed.ts.length > 0) {
      const agents = Number.isSafeInteger(parsed.agents) && parsed.agents >= 0 ? parsed.agents : 0;
      return { state, ts: parsed.ts, agents };
    }
  } catch {
    // absent/torn turn.json self-heals — the row still renders
  }
  return undefined;
}

/**
 * Resolve an ISO-text timestamp sidecar (`heartbeat`, `resumed`,
 * `ask-resolved`) to ms (mirrors liveness.resolveSidecarMs): Date.parse of the
 * trimmed content, else the file mtime, else undefined. Never throws.
 */
function resolveSidecarMs(dir, name) {
  const file = path.join(dir, name);
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const parsed = Date.parse(content.trim());
  if (!Number.isNaN(parsed)) return parsed;
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Resolve the heartbeat sidecar last-seen ms (mirrors liveness.resolveLastSeen). */
function resolveLastSeen(dir) {
  return resolveSidecarMs(dir, "heartbeat");
}

/** Cheap pid liveness (mirrors liveness.defaultProbe) — kill -0; no lstart guard. */
function pidAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM"; // exists but not ours
  }
}

/**
 * Resolve a possibly-relative/deleted file_path to a canonical realpath WITHOUT
 * throwing (mirrors conflicts.resolveRealpath): lexical absolute anchor, then
 * realpathSync (folds symlinks + /var->/private/var), degrade to lexical on throw.
 */
function resolveRealpath(file_path, cwd) {
  const lexical = path.isAbsolute(file_path)
    ? file_path
    : path.resolve(cwd ?? process.cwd(), file_path);
  try {
    return fs.realpathSync(lexical);
  } catch {
    return lexical; // ENOENT (file gone) -> lexical, never throw
  }
}

// ---- Port scan (PORT-05 mirror of src/ports.ts; stdlib only, T-1-SC) --------

/** Max port rows rendered before collapsing the remainder into `+N more`. */
const PORTS_CAP = 12;
/** Exposed-bind security badge glyph (U+21C5); >= 0x00A0 so sanitize keeps it. */
const EXPOSED_GLYPH = "⇅";
/** Declared-target-branch marker (U+2387) and mismatch flag (U+2260), TB-03; both >= 0x00A0 so sanitize keeps them. */
const BRANCH_GLYPH = "⎇";
const NEQ_GLYPH = "≠";
/** Detail-free "needs you" marker glyph (U+25C9 fisheye); leads both the " ◉ asking" and " ◉ waiting" markers (260926-vfm). >= 0x00A0 so sanitize keeps it. Matches the panel label. */
const ATTENTION_GLYPH = "◉";
/** Detail-free running marker glyph (U+25B6, 260927-46l); >= 0x00A0 so sanitize keeps it. Matches the panel label. */
const RUN_GLYPH = "▶";
/** Detail-free subagent marker glyph (U+21BB, 260927-73b); >= 0x00A0 so sanitize keeps it. Matches the panel label. */
const SUBAGENT_GLYPH = "↻";
/** User-bucket heading literal (mirror Card.tsx:494 / D-02) — ASCII, constant. */
const USER_BUCKET = "Sen (kullanici)";

/** Curated Apple background-agent command names to exclude (mirror src/ports.ts D-01). */
const APPLE_AGENT_DENYLIST = new Set([
  "rapportd",
  "ControlCenter",
  "sharingd",
  "AirPlayXPCHelper",
  "identityservicesd",
  "remoted",
]);

/** Parse `lsof -nP -iTCP -sTCP:LISTEN -FpcLn` field-mode output into raw sockets. */
function parseLsofF(stdout) {
  const out = [];
  let pid = 0;
  let command = "";
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") {
      pid = Number(val) || 0;
      command = "";
    } else if (tag === "c") {
      command = val; // untruncated in -F mode
    } else if (tag === "n") {
      out.push({ pid, command, name: val });
    }
    // `f` (fd), `L` (login), and any other tag are ignored.
  }
  return out;
}

/** Build a pid -> ppid map from `ps -axo pid,ppid,user,command` (skip header). */
function parsePpidMap(stdout) {
  const m = new Map();
  const lines = stdout.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim().split(/\s+/);
    if (t.length < 2) continue;
    const pid = Number(t[0]);
    const ppid = Number(t[1]);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) m.set(pid, ppid);
  }
  return m;
}

/** Walk a listening pid to the process root, seen-guarded against cycles. */
function ancestryChain(pid, ppid) {
  const chain = [];
  const seen = new Set();
  let cur = pid;
  while (cur !== undefined && cur > 1 && !seen.has(cur)) {
    chain.push(cur);
    seen.add(cur);
    cur = ppid.get(cur);
  }
  return chain;
}

/** Split a lsof NAME field into host + numeric port (IPv6 bracket vs last colon). */
function splitHostPort(name) {
  if (name.startsWith("[")) {
    const rb = name.lastIndexOf("]");
    const host = name.slice(1, rb);
    const port = Number(name.slice(rb + 2)); // skip "]:"
    return { host, port };
  }
  const c = name.lastIndexOf(":");
  return { host: name.slice(0, c), port: Number(name.slice(c + 1)) };
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Classify a bind host as exposed (off-host reachable) vs local-only. */
function isExposed(host) {
  if (host === "*" || host === "0.0.0.0" || host === "::") return true;
  if (LOCAL_HOSTS.has(host)) return false;
  if (host.startsWith("127.")) return false;
  return true;
}

/**
 * Passive, non-fatal LISTEN-TCP scan (mirror src/ports.ts scanPorts). Runs lsof
 * and ps CONCURRENTLY; ANY lsof failure/timeout resolves to [] and a ps failure
 * yields an empty ancestry map (every port then falls to the user bucket). Never
 * throws. Each entry: { port, pid, command, exposed, ancestryPids }.
 */
async function scanPorts(uid = process.getuid?.()) {
  try {
    const lsofArgs = ["-nP", "-iTCP", "-sTCP:LISTEN", "-FpcLn"];
    if (uid !== undefined) lsofArgs.push("-a", "-u", String(uid)); // D-01 user filter
    const [lsofOut, psOut] = await Promise.all([
      pexec(lsofCmd(), lsofArgs, { timeout: 1500, maxBuffer: 1 << 20 }).then(
        (r) => r.stdout,
        () => null, // exit 1 (no match) / spawn failure / timeout -> sentinel
      ),
      pexec(psCmd(), ["-axo", "pid,ppid,user,command"], { timeout: 1500, maxBuffer: 1 << 21 }).then(
        (r) => r.stdout,
        () => "", // no ancestry snapshot -> every port to the user bucket
      ),
    ]);
    if (lsofOut === null) return []; // lsof unusable -> no ports (passive)

    const ppid = parsePpidMap(psOut);
    const socks = parseLsofF(lsofOut);
    const byKey = new Map(); // (port,pid) de-dup across IPv4/IPv6 twins
    for (const s of socks) {
      if (APPLE_AGENT_DENYLIST.has(s.command)) continue; // D-01 Apple-agent exclusion
      const { host, port } = splitHostPort(s.name);
      if (!Number.isInteger(port)) continue;
      const key = `${port} ${s.pid}`;
      const exposed = isExposed(host);
      const prev = byKey.get(key);
      if (prev) {
        prev.exposed = prev.exposed || exposed; // twin -> exposed if either is
        continue;
      }
      byKey.set(key, { port, pid: s.pid, command: s.command, exposed, ancestryPids: ancestryChain(s.pid, ppid) });
    }
    return [...byKey.values()];
  } catch {
    return []; // belt-and-suspenders: the scan NEVER throws (passivity)
  }
}

/**
 * Render the "Ports:" block: group each scanned port under the first live session
 * along its ancestry chain (folder · branch · shortid), unattributed ports under
 * the `Sen (kullanici)` bucket LAST. Total rows capped at PORTS_CAP with `+N more`.
 * Returns the block string (leading newline). `rows` carry a numeric `pid`.
 */
function renderPorts(ports, rows) {
  if (ports.length === 0) return "\nPorts:\n  no listening ports\n";

  // Live pid -> owning row (attribution join); only rows with a numeric pid.
  const live = new Map();
  for (const r of rows) {
    if (typeof r.pid === "number") live.set(r.pid, r);
  }

  // Group attributed ports by owning session (stable insertion order); the rest
  // collect into the user bucket.
  const sessionGroups = new Map(); // session_id -> { heading, ports:[] }
  const userPorts = [];
  for (const p of ports) {
    let owner = null;
    for (const pid of p.ancestryPids) {
      const r = live.get(pid);
      if (r) {
        owner = r;
        break;
      }
    }
    if (owner === null) {
      userPorts.push(p);
      continue;
    }
    let g = sessionGroups.get(owner.session_id);
    if (!g) {
      const heading = `${displayName(owner.title) ?? sanitize(owner.folder ?? "")} · ${sanitize(owner.branch ?? "") || "—"} · ${sanitize(String(owner.session_id).slice(0, 8))}`;
      g = { heading, ports: [] };
      sessionGroups.set(owner.session_id, g);
    }
    g.ports.push(p);
  }

  const groups = [...sessionGroups.values()];
  if (userPorts.length > 0) groups.push({ heading: USER_BUCKET, ports: userPorts });

  const total = ports.length;
  const more = Math.max(0, total - PORTS_CAP);
  let budget = PORTS_CAP;
  const lines = [];
  for (const g of groups) {
    if (budget <= 0) break;
    const shown = g.ports.slice(0, budget);
    budget -= shown.length;
    lines.push(g.heading);
    for (const p of shown) {
      const badge = p.exposed ? `${EXPOSED_GLYPH} exposed` : "local";
      lines.push(`  ${sanitize(String(p.port))} · ${sanitize(p.command)} · ${badge} · pid ${sanitize(String(p.pid))}`);
    }
  }
  if (more > 0) lines.push(`  +${more} more`);
  return "\nPorts:\n" + lines.join("\n") + "\n";
}

async function main() {
  const now = Date.now();

  // Caller session id (argv[2]); gate through SAFE_ID before any (you) compare.
  const rawCaller = process.argv[2];
  const callerId =
    typeof rawCaller === "string" && SAFE_ID.test(rawCaller) && rawCaller !== "." && rawCaller !== ".."
      ? rawCaller
      : undefined;

  let ids;
  try {
    ids = fs.readdirSync(sessionsDir());
  } catch {
    // Store not created yet — passive no-op (still exit 0).
    process.stdout.write("No live sessions.\n");
    return;
  }

  const rows = [];
  for (const id of ids) {
    const dir = path.join(sessionsDir(), id);
    let state;
    try {
      state = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
    } catch {
      continue; // torn/missing snapshot self-heals next tick
    }

    const { files, lastActiveMs } = activeWrites(dir, now);

    // Last activity (heartbeat -> newest write -> start_time). Liveness input and
    // the legacy fallback clear for the needs-you gates.
    const heartbeatMs = resolveLastSeen(dir);
    const lastSeenMs =
      heartbeatMs ?? (lastActiveMs !== -Infinity ? lastActiveMs : Date.parse(state.start_time));

    // Resume signals (260927-1zw CR-01 / WR-02) — mirrors aggregate.readAll
    // exactly. `resumed` (main-thread only) clears waiting; `ask-resolved`
    // (answer-specific) clears asking. DISC-1: a session without the sidecars
    // (hooks that predate them) falls back to lastSeenMs, so it behaves as before.
    const resumedMs = resolveSidecarMs(dir, "resumed") ?? lastSeenMs;
    const askResolvedMs = resolveSidecarMs(dir, "ask-resolved") ?? lastSeenMs;

    // ATTN-04 reader gate — within the 3 h window (even for a live pid) AND
    // strictly newer than the main-thread resume signal. NaN ts self-heals to
    // false. Computed before the keepalive because an active marker is liveness
    // evidence (WR-01).
    const attn = readAttention(dir);
    const attnMs = attn ? Date.parse(attn.ts) : NaN;
    const rawWaiting =
      !Number.isNaN(attnMs) && now - attnMs < attnWindowMs() && attnMs > resumedMs;

    // asking.json is read here; the asking GATE follows the pid probe below
    // because its ceiling depends on it (261011-or2).
    const askTs = readAsking(dir);
    const askMs = askTs !== undefined ? Date.parse(askTs) : NaN;

    // Cheap liveness (T-04-09b): heartbeat-fresh OR keepalive OR pid alive. No
    // lstart guard. WR-01 / D-03: a session blocked on the human emits no
    // heartbeat, so an active marker keeps it listed; the marker gate bounds
    // waiting by attnWindowMs() (idle-waiting included, 260927-4tv D-05), and
    // asking too unless the pid is alive (261011-or2), which already keeps the
    // row listed on its own.
    // 260927-46l D-03: a running turn (a long Bash, a
    // web fetch, thinking) emits no heartbeat either, so the raw running gate
    // keeps it listed too, bounded by runWindowMs(). DISC-4: a known pid that
    // probes dead gets no keepalive, so a crashed session still drops off.
    const heartbeatFresh = !Number.isNaN(lastSeenMs) && now - lastSeenMs < staleMs();
    const pidValid = typeof state.pid === "number" && Number.isInteger(state.pid) && state.pid > 0;
    const procAlive = pidAlive(state.pid);
    const procDead = pidValid && !procAlive;

    // AQ-03 asking gate (260926-vfm, 260927-1zw WR-02, 261011-or2) — mirrors
    // aggregate.readAll: strictly newer than the answer-specific ask-resolved
    // signal, and asking WINS over attention (a Notification can fire while a
    // question is open; the question is the more specific signal). Sibling
    // tools cannot clear it. The ceiling is pid-dependent, so this follows the
    // probe: a live pid has NO ceiling; an absent or exited pid is bounded by
    // attnWindowMs(). One unavoidable difference: procAlive here is the cheap
    // kill -0 probe WITHOUT the pid_started reuse guard (passivity contract
    // T-04-09b), so a recycled pid that readAll would call "dead" counts as
    // alive here and keeps an old question flagged. The panel (readAll) is the
    // authority; do not add an lstart probe.
    const asking =
      !Number.isNaN(askMs) &&
      askMs > askResolvedMs &&
      (procAlive || now - askMs < attnWindowMs());

    // Running gate (260927-46l D-02) — mirrors aggregate.readAll exactly: turn
    // "running", ts parses, pid not dead, and now minus the newer of the turn
    // ts and the heartbeat (NOT the start_time fallback) under runWindowMs().
    // `running` is pre-gated: asking > waiting > running (one marker).
    const turn = readTurn(dir);
    const turnMs = turn ? Date.parse(turn.ts) : NaN;
    const runRefMs = Math.max(turnMs, heartbeatMs ?? -Infinity);
    // Subagent gate (260927-73b D-03) — mirrors aggregate.readAll exactly: turn
    // "idle" with a background-agent count > 0, ts parses, pid not dead, and
    // now minus the newer of the turn ts and the heartbeat under runWindowMs().
    const turnAgents = turn?.agents ?? 0;
    const rawSubagent =
      turn?.state === "idle" &&
      turnAgents > 0 &&
      !Number.isNaN(turnMs) &&
      !procDead &&
      now - runRefMs < runWindowMs();
    // Idle-waiting gate (260927-4tv D-02) — mirrors aggregate.readAll exactly:
    // turn "idle" (main-thread Stop), ts parses, pid not dead, and idle for at
    // least idleWaitMs() but under attnWindowMs(). The next prompt (turn
    // "running") is the clear; no resumed-sidecar comparison (the same Stop
    // writes both in the same instant).
    const rawIdleWaiting =
      turn?.state === "idle" &&
      !Number.isNaN(turnMs) &&
      !procDead &&
      now - turnMs >= idleWaitMs() &&
      now - turnMs < attnWindowMs() &&
      // mirrors aggregate.readAll (260927-73b D-03): agents still working.
      !rawSubagent;
    // mirrors aggregate.readAll (260927-73b D-03): an idle_prompt Notification
    // is suppressed while the subagent gate holds; any other type still wins.
    const notifWaiting = rawWaiting && !(rawSubagent && attn?.type === "idle_prompt");
    // D-03 / D-04: waiting = (Notification gate OR idle-waiting), asking wins.
    const attention = (notifWaiting || rawIdleWaiting) && !asking;
    const rawRunning =
      turn?.state === "running" && !Number.isNaN(turnMs) && !procDead && now - runRefMs < runWindowMs();
    const running = rawRunning && !asking && !attention;
    // mirrors aggregate.readAll (260927-73b D-03): asking > waiting > running > subagent.
    const subagent = rawSubagent && !asking && !attention;

    // mirrors aggregate.readAll (260927-73b D-03): the subagent gate is liveness evidence.
    // 261011-or2: asking keepalive is unbounded only while the pid is alive
    // (procAlive already lists the row); waiting keepalive keeps the 3 h ceiling.
    const keepalive = ((asking || rawWaiting || rawIdleWaiting) && !procDead) || rawRunning || rawSubagent;
    const alive = heartbeatFresh || keepalive || procAlive;
    if (!alive) continue; // live-only roster (D-04)

    const startMs = Date.parse(state.start_time);
    const sortMs = lastActiveMs !== -Infinity ? lastActiveMs : Number.isNaN(startMs) ? 0 : startMs;

    rows.push({
      session_id: typeof state.session_id === "string" ? state.session_id : id,
      folder: state.folder,
      // LIVE branch derived from the session's cwd (LB-03), falling back to the
      // SessionStart snapshot. Because the roster heading, the target-mismatch
      // token (sanitize(target) vs sanitize(r.branch)), and the conflict labels
      // all read r.branch, this single swap makes every one reflect the live checkout.
      branch: deriveLiveBranch(state.cwd, state.branch),
      // Numeric pid used ONLY for port-ancestry attribution (not liveness).
      pid: typeof state.pid === "number" ? state.pid : undefined,
      cwd: typeof state.cwd === "string" ? state.cwd : undefined,
      intent: readIntent(dir),
      title: readTitle(dir), // NAME-02 hook-cached native name (raw; rendered via displayName)
      target_branch: readTargetBranch(dir), // TB-03 declared target (current branch is state.branch)
      attention, // ATTN-04 pre-gated boolean: waiting on the human (detail-free)
      asking, // AQ-03 pre-gated boolean: an open AskUserQuestion (detail-free, wins over attention)
      running, // 260927-46l pre-gated boolean: working a turn (detail-free)
      subagent, // 260927-73b pre-gated boolean: background agents still running (lowest precedence)
      subagentCount: subagent ? turnAgents : 0, // integer only (detail-free)
      files, // [{file_path, tsMs}]
      startMs: Number.isNaN(startMs) ? now : startMs,
      sortMs,
    });
  }

  // D-09: most-recently-active first.
  rows.sort((a, b) => b.sortMs - a.sortMs);

  if (rows.length === 0) {
    process.stdout.write("No live sessions.\n");
    return;
  }

  // ---- Roster (one terse line per live session, writes-only) --------------
  const out = [];
  for (const r of rows) {
    // D-08: lead with the native name when set, else the folder (D-07: never "(unnamed)").
    const lead = displayName(r.title) ?? sanitize(r.folder ?? "");
    const branch = sanitize(r.branch ?? "") || "—";
    const shortId = sanitize(String(r.session_id).slice(0, 8));

    // Declared-target token (TB-03), inserted immediately after the branch field so
    // the current checkout and the declared target sit adjacent. Empty when no
    // target; otherwise ` ⎇ <target>`, with a trailing ` ≠` mismatch flag when the
    // SEPARATELY-sanitized target differs from the current branch (D-BR-05).
    const targetRaw = r.target_branch;
    let targetToken = "";
    if (typeof targetRaw === "string" && targetRaw.length > 0) {
      const target = sanitize(targetRaw);
      const mismatch = target !== sanitize(r.branch ?? "");
      targetToken = ` ${BRANCH_GLYPH} ${target}` + (mismatch ? ` ${NEQ_GLYPH}` : "");
    }

    // Active WRITE basenames (reads excluded), newest first.
    const sortedFiles = [...r.files].sort((a, b) => b.tsMs - a.tsMs);
    const basenames = sortedFiles.map((f) => sanitize(basename(f.file_path)));
    const newestBasename = basenames[0];

    // Intent column with D-11 recent-file fallback — never blank.
    const intentCol = r.intent
      ? sanitize(r.intent)
      : newestBasename
        ? `~${newestBasename}`
        : "(idle)";

    const filesCol = basenames.length > 0 ? basenames.join(", ") : "—";
    const uptime = fmtUptime(r.startMs, now);
    const you = callerId !== undefined && r.session_id === callerId ? " (you)" : "";

    // ATTN-04 / AQ-03 / 260927-46l / 260927-73b detail-free status markers:
    // asking, waiting, running and subagent are DISTINCT fixed glyph + literal
    // markers (no type text, no ts, no question or prompt text, no task detail —
    // T-06-02/T-06-06/T-vfm-03/T-46l-04/T-73b-06), appended only when the
    // pre-gated flag held. At most one shows, with the precedence asking >
    // waiting > running > subagent (the reader already pre-gates). The subagent
    // count is an integer only, shown as ` ×N` when N > 1.
    const statusMarker = r.asking
      ? ` ${ATTENTION_GLYPH} asking`
      : r.attention
        ? ` ${ATTENTION_GLYPH} waiting`
        : r.running
          ? ` ${RUN_GLYPH} running`
          : r.subagent
            ? ` ${SUBAGENT_GLYPH} subagent` + (r.subagentCount > 1 ? ` ×${r.subagentCount}` : "")
            : "";

    out.push(`${lead} · ${branch}${targetToken} · ${shortId} · ${intentCol} · ${filesCol} · ${uptime}${statusMarker}${you}`);
  }

  // ---- Conflicts relevant to you (self-excluded) --------------------------
  // Group live sessions' active-write realpaths; keep groups with >=2 distinct
  // sessions that INCLUDE the caller (D-04). Mirror conflicts.detectConflicts.
  const groups = new Map(); // realpath -> Map<session_id, {label, lastTouch}>
  for (const r of rows) {
    const label = `${displayName(r.title) ?? sanitize(r.folder ?? "")} · ${sanitize(r.branch ?? "") || "—"} · ${sanitize(String(r.session_id).slice(0, 8))}`;
    for (const f of r.files) {
      const rp = resolveRealpath(f.file_path, r.cwd);
      let g = groups.get(rp);
      if (!g) {
        g = new Map();
        groups.set(rp, g);
      }
      const prev = g.get(r.session_id);
      if (prev) prev.lastTouch = Math.max(prev.lastTouch, f.tsMs);
      else g.set(r.session_id, { label, lastTouch: f.tsMs });
    }
  }

  const conflictLines = [];
  if (callerId !== undefined) {
    const relevant = [];
    for (const [rp, sessions] of groups) {
      if (sessions.size < 2) continue; // >=2 distinct sessions
      if (!sessions.has(callerId)) continue; // relevant to the caller only (D-04)
      const others = [...sessions.entries()]
        .filter(([sid]) => sid !== callerId) // self-exclude
        .sort((a, b) => b[1].lastTouch - a[1].lastTouch)
        .map(([, v]) => v.label);
      if (others.length === 0) continue;
      const lastActive = Math.max(...[...sessions.values()].map((v) => v.lastTouch));
      relevant.push({ rp, others, lastActive });
    }
    relevant.sort((a, b) => b.lastActive - a.lastActive);
    for (const c of relevant) {
      conflictLines.push(`  ${sanitize(basename(c.rp))} ↔ ${c.others.join(" ↔ ")}`);
    }
  }

  process.stdout.write(out.join("\n") + "\n");
  process.stdout.write("\nConflicts relevant to you:\n");
  process.stdout.write(conflictLines.length > 0 ? conflictLines.join("\n") + "\n" : "  none\n");

  // ---- Ports (PORT-05): LISTEN TCP grouped under the owning live session -----
  // scanPorts() never throws (passive); render after the conflicts block.
  const ports = await scanPorts();
  process.stdout.write(renderPorts(ports, rows));
}

// Async invocation: swallow any rejection and ALWAYS exit 0 (passivity, T-04-07);
// the reader never throws into the caller's context and writes no file.
main()
  .catch(() => {})
  .finally(() => process.exit(0));
