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
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

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

/** Resolve the heartbeat sidecar last-seen ms (mirrors liveness.resolveLastSeen). */
function resolveLastSeen(dir) {
  const hb = path.join(dir, "heartbeat");
  let content;
  try {
    content = fs.readFileSync(hb, "utf8");
  } catch {
    return undefined;
  }
  const parsed = Date.parse(content.trim());
  if (!Number.isNaN(parsed)) return parsed;
  try {
    return fs.statSync(hb).mtimeMs;
  } catch {
    return undefined;
  }
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
      const heading = `${sanitize(owner.folder ?? "")} · ${sanitize(owner.branch ?? "") || "—"} · ${sanitize(String(owner.session_id).slice(0, 8))}`;
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

    // Cheap liveness (T-04-09b): heartbeat-fresh OR pid alive. No lstart guard.
    const heartbeatMs = resolveLastSeen(dir);
    const lastSeenMs =
      heartbeatMs ?? (lastActiveMs !== -Infinity ? lastActiveMs : Date.parse(state.start_time));
    const fresh = !Number.isNaN(lastSeenMs) && now - lastSeenMs < staleMs();
    const alive = fresh || pidAlive(state.pid);
    if (!alive) continue; // live-only roster (D-04)

    const startMs = Date.parse(state.start_time);
    const sortMs = lastActiveMs !== -Infinity ? lastActiveMs : Number.isNaN(startMs) ? 0 : startMs;

    rows.push({
      session_id: typeof state.session_id === "string" ? state.session_id : id,
      folder: state.folder,
      branch: state.branch,
      // Numeric pid used ONLY for port-ancestry attribution (not liveness).
      pid: typeof state.pid === "number" ? state.pid : undefined,
      cwd: typeof state.cwd === "string" ? state.cwd : undefined,
      intent: readIntent(dir),
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
    const folder = sanitize(r.folder ?? "");
    const branch = sanitize(r.branch ?? "") || "—";
    const shortId = sanitize(String(r.session_id).slice(0, 8));

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

    out.push(`${folder} · ${branch} · ${shortId} · ${intentCol} · ${filesCol} · ${uptime}${you}`);
  }

  // ---- Conflicts relevant to you (self-excluded) --------------------------
  // Group live sessions' active-write realpaths; keep groups with >=2 distinct
  // sessions that INCLUDE the caller (D-04). Mirror conflicts.detectConflicts.
  const groups = new Map(); // realpath -> Map<session_id, {label, lastTouch}>
  for (const r of rows) {
    const label = `${sanitize(r.folder ?? "")} · ${sanitize(r.branch ?? "") || "—"} · ${sanitize(String(r.session_id).slice(0, 8))}`;
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
