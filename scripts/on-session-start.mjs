#!/usr/bin/env node
// SessionStart capture hook (CAP-02, D-05, D-06).
//
// Self-contained ESM using only Node stdlib (T-1-SC): the store-root
// resolution and the safeId allowlist are inlined here rather than imported
// from src/, so this stays a build-free hot-path script (Open Q3).
//
// Non-negotiable passivity contract (T-1-05): every path — malformed stdin,
// non-repo cwd, an unwritable store dir — is swallowed and the process ALWAYS
// exits 0. A non-zero SessionStart/hook exit could leak stderr into Claude's
// context; that must never happen.
//
// Session title (Phase 7, NAME-01, D-02/D-10): after session.json, this hook
// also records the documented `session_title` payload field (the native
// /rename name) plus a validated `transcript_path` in the separate
// `title.json` snapshot shard (same-dir temp + renameSync) as
// { ts, title?, transcript_path? }, normalized exactly like
// scripts/on-user-prompt.mjs. Every SessionStart (startup, resume, clear)
// rewrites it from the payload; SessionEnd's rm -rf of the session dir removes
// it. session.json's record shape is unchanged. Nothing is ever written to
// stdout, so CSM can never rename the session (D-05 monitor-only).
import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

const SCHEMA_VERSION = 1;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// T-1-01: an untrusted session_id becomes a directory name. Accept only a
// conservative allowlist BEFORE building any path; anything else is ignored
// (no fs touch) and the hook still exits 0.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

// --- mirrors scripts/on-user-prompt.mjs; keep in lockstep (scripts cannot
// import each other: each hook is a self-contained, build-free script).
const MAX_TITLE = 256;
const MAX_TRANSCRIPT_PATH = 4096;

// T-07-06: longest grapheme cluster kept, in code points (RGI skin-toned kiss
// = 10); a longer cluster (piled combining marks) becomes a space.
const MAX_CLUSTER_CP = 10;

// T-07-02 / T-07-06: format and default-ignorable (invisible) code points.
const HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

let segmenter; // lazy: undefined = not probed, null = unavailable

// Split into grapheme clusters; code-point fallback when Intl.Segmenter is absent.
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

function normalizeTitle(raw) {
  if (typeof raw !== "string") return "";
  let out = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      out += " ";
    } else if (cp !== 0x200d && cp !== 0xfe0e && cp !== 0xfe0f && HIDDEN.test(ch)) {
      // Dropped: invisible format/default-ignorable code point (T-07-02/T-07-06).
    } else {
      out += ch;
    }
  }
  let kept = "";
  for (const g of graphemes(out.replace(/\s+/g, " "))) {
    kept += Array.from(g).length > MAX_CLUSTER_CP ? " " : g;
  }
  kept = kept.replace(/\s+/g, " ").trim();
  // Whole clusters only, up to MAX_TITLE code points (never splits a cluster).
  let res = "";
  let n = 0;
  for (const g of graphemes(kept)) {
    const len = Array.from(g).length;
    if (n + len > MAX_TITLE) break;
    res += g;
    n += len;
  }
  res = res.trim();
  return /[^\s\u200d\ufe0e\ufe0f]/u.test(res) ? res : "";
}

function validTranscriptPath(tp, id) {
  return (
    typeof tp === "string" &&
    tp.length <= MAX_TRANSCRIPT_PATH &&
    path.isAbsolute(tp) &&
    path.basename(tp) === id + ".jsonl"
  );
}

// WR-05 atomic write: unique temp in the same dir + renameSync over the target
// (rename(2) atomicity). Never throws: on any error the temp is removed on a
// best-effort basis.
function writeAtomic(dir, name, content) {
  const tmp = path.join(
    dir,
    `.${name}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    writeFileSync(tmp, content, { mode: FILE_MODE });
    renameSync(tmp, path.join(dir, name));
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // Temp was never created or is already gone.
    }
  }
}
// --- end mirror

// D-01b store-location seam — identical precedence to src/paths.ts so every
// process agrees on where the shards live: 1) CSM_STORE_DIR override, else
// 2) ~/.claude/csm. CLAUDE_PLUGIN_DATA is deliberately NOT a tier — it is set
// only for plugin-hook processes, so honoring it would split this writer's root
// from the standalone panel's reader root.
function storeRoot() {
  const override = process.env.CSM_STORE_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".claude", "csm");
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// D-04 durable pid capture (RESEARCH Pattern 3): the transient shell ppid dies
// long before the session does, so walk the ancestry to the persistent
// `claude` process and record it plus a `ps -o lstart=` identity token the
// 02-01 reader cross-checks against pid reuse (T-02-12). One ps snapshot, max
// ~10 hops, hard 1000ms timeouts (T-02-13).
//
// WR-01: only persist a pid we can stand behind. When the walk positively
// confirms a `claude` ancestor, that pid is durable. When it does NOT (comm
// often reads `node`, or the hook is spawned under a short-lived `sh -c`
// wrapper), `process.ppid` may be a transient shell that exits moments later —
// persisting it would make the 02-01 reader probe a dead pid and mislabel a
// live session "stale". So for an unconfirmed pid we verify it is still alive
// at capture time; if it is already gone we record a SENTINEL (pid undefined)
// and let the reader fall back to TTL-only for the dot. The TTL is always the
// liveness safety net.
function captureDurablePid() {
  try {
    const out = execFileSync("ps", ["-Ao", "pid=,ppid=,comm="], {
      encoding: "utf8",
      timeout: 1000,
    });
    const tbl = new Map();
    for (const ln of out.split("\n")) {
      const m = ln.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (m) tbl.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
    }
    let pid = process.ppid;
    let hops = 0;
    let chosen = process.ppid;
    let confirmed = false;
    while (pid > 1 && hops++ < 10) {
      const n = tbl.get(pid);
      if (!n) break;
      if (/claude/i.test(n.comm)) {
        chosen = pid;
        confirmed = true;
        break;
      }
      pid = n.ppid;
    }
    // Unconfirmed pid: never persist an already-dead wrapper. kill -0 verifies
    // liveness at capture; if it throws the pid is gone -> record the sentinel.
    if (!confirmed) {
      try {
        process.kill(chosen, 0);
      } catch {
        return { pid: undefined, pid_started: "" };
      }
    }
    let started = "";
    try {
      started = execFileSync("ps", ["-o", "lstart=", "-p", String(chosen)], {
        encoding: "utf8",
        timeout: 1000,
      }).trim();
    } catch {
      started = "";
    }
    return { pid: chosen, pid_started: started };
  } catch {
    // No trustworthy pid available -> sentinel; the reader defers to the TTL.
    return { pid: undefined, pid_started: "" };
  }
}

try {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    payload = null;
  }

  const id = payload && payload.session_id;
  // Strict allowlist gate before any path is built (T-1-01).
  if (typeof id === "string" && SAFE_ID.test(id) && id !== "." && id !== "..") {
    const cwd = (payload && payload.cwd) || process.cwd();

    // Best-effort branch: "" when cwd is not a git repo or git is slow/absent.
    let branch = "";
    try {
      branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }).trim();
    } catch {
      branch = "";
    }

    // D-06 Warp enrichment: an object only inside Warp, else null. No window/tab
    // name is ever read (D-07). Absent env vars degrade to "" — no failure path.
    const warp =
      process.env.TERM_PROGRAM === "WarpTerminal"
        ? {
            focus_url: process.env.WARP_FOCUS_URL || "",
            session_uuid: process.env.WARP_TERMINAL_SESSION_UUID || "",
          }
        : null;

    // D-04: durable claude-ancestor pid + identity token, captured off the hot
    // path (this hook is async, WR-05).
    const { pid, pid_started } = captureDurablePid();

    const record = {
      schema_version: SCHEMA_VERSION,
      session_id: id,
      cwd,
      folder: path.basename(cwd), // D-05 human-friendly label
      branch,
      // Best-effort model — the SessionStart payload MAY carry it ("not
      // guaranteed"); there is no $CLAUDE_MODEL. WR-02/D-09: use the "unknown"
      // sentinel (never null) so the 02-01 reader has a single missing-value form.
      model: (payload && payload.model) ?? "unknown",
      source: payload && payload.source,
      // ISO-8601 to match the cross-process reader contract (aggregate.ts sorts
      // via Date.parse(start_time)); NOT epoch ms.
      start_time: new Date().toISOString(),
      // D-04 durable claude-ancestor pid for Phase 2 liveness (kill -0). Omitted
      // entirely (WR-01 sentinel) when no trustworthy pid could be captured, so
      // the reader sees no pid and defers to the TTL rather than probing a
      // possibly-transient wrapper.
      ...(typeof pid === "number" ? { pid } : {}),
      pid_started, // D-04 `ps -o lstart=` identity token; "" when unavailable
      warp,
    };

    // Atomic snapshot: unique temp in the same dir + renameSync over target
    // (rename(2) atomicity — no torn reads).
    const dir = path.join(storeRoot(), "sessions", id);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const tmp = path.join(
      dir,
      `.session.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    writeFileSync(tmp, JSON.stringify(record), { mode: FILE_MODE });
    renameSync(tmp, path.join(dir, "session.json"));

    // Phase 7 NAME-01 (D-02): native session title + transcript path shard.
    // WR-03 / D-10: ALWAYS written, even as a bare { ts } ("currently
    // unnamed"), so a stale title.json never outlives the payload.
    const title = normalizeTitle(payload.session_title);
    const tpOk = validTranscriptPath(payload.transcript_path, id);
    writeAtomic(
      dir,
      "title.json",
      JSON.stringify({
        ts: new Date().toISOString(),
        ...(title ? { title } : {}),
        ...(tpOk ? { transcript_path: payload.transcript_path } : {}),
      }),
    );
  }
} catch {
  // Swallow everything (T-1-05): monitoring is passive, never blocks the agent.
}

process.exit(0);
