#!/usr/bin/env node
// UserPromptSubmit heartbeat hook (D-03) — the liveness proof for a session
// that is only reading/thinking between edits.
//
// Kept deliberately tiny and self-contained (Node stdlib only, T-1-SC): buffer
// stdin, extract session_id, write the `heartbeat` sidecar, exit 0. Unlike
// on-tool.mjs it does NOT append files.jsonl — a bare prompt touches no file.
//
// Resume signals (260927-1zw CR-01/WR-02): a submitted prompt is always a
// main-thread user action. It resumes the session AND resolves any open
// question, so this hook also writes the `resumed` sidecar (clears ◉ waiting)
// and the `ask-resolved` sidecar (clears ◉ asking). Both are written via a
// same-dir temp file + renameSync (WR-05); the heartbeat keeps its frozen
// plain write. It never touches attention.json or asking.json.
//
// Turn state (260927-46l): a submitted prompt starts a turn, so this hook also
// writes the `turn.json` snapshot with state "running" (same-dir temp +
// renameSync). Detail-free: only the constant state literal and an ISO-8601
// ts are persisted; the prompt text is never read. on-activity writes "idle"
// on a main-thread Stop.
//
// Session title (Phase 7, NAME-01, D-02): Claude Code reports the native
// session name (/rename, claude -n, Ctrl+R) as the documented `session_title`
// payload field. This hook records it, plus a validated `transcript_path`, in
// the `title.json` snapshot shard (same-dir temp + renameSync) as
// { ts, title?, transcript_path? }. The title is normalized before it touches
// disk: C0/C1 controls become a space, invisible format/default-ignorable code
// points are dropped, whitespace collapses, over-long clusters become a space,
// trimmed, capped at MAX_TITLE code points by whole clusters. The record
// mirrors Claude Code exactly: an absent title means "no custom title at ts"
// (D-10, CSM keeps no name memory of its own). The shard is never merged into
// session.json. This hook stays silent on stdout, so it can never emit a
// session-title output that would rename the session (D-05 monitor-only).
//
// Passivity contract (T-1-05 / T-02-11): UserPromptSubmit stdout is
// model-visible, so this hook writes NOTHING to stdout, wraps its whole body so
// it ALWAYS exits 0, and is wired "async" so the prompt never waits on it.
import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// T-02-10: allowlist the untrusted session_id before it becomes a path segment.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

// Phase 7 (NAME-01) title.json bounds (T-07-10): stored title is capped in code
// points; a transcript_path longer than this is not recorded.
const MAX_TITLE = 256;
const MAX_TRANSCRIPT_PATH = 4096;

// T-07-01 / T-07-02 / T-07-06: normalize the untrusted session_title before
// storage. C0 (incl. ESC), DEL and C1 controls become a space so no escape
// sequence ever reaches disk; every format/default-ignorable code point (bidi
// controls incl. U+061C, zero-width spaces, U+FEFF, U+00AD, tag characters,
// variation selectors) is removed except ZWJ and U+FE0E/U+FE0F; whitespace runs
// collapse; a grapheme cluster over MAX_CLUSTER_CP code points becomes a space;
// the result is trimmed and capped at MAX_TITLE code points by whole clusters.
// A result holding only joiners/selectors, or a non-string, yields "" (caller
// omits the title key). Mirrors src/label.ts cleanTitle; keep in lockstep.
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

// T-07-03 write-gate: only an absolute, bounded path whose basename is this
// session's own `<session_id>.jsonl` is recorded (the reader re-validates).
function validTranscriptPath(tp, id) {
  return (
    typeof tp === "string" &&
    tp.length <= MAX_TRANSCRIPT_PATH &&
    path.isAbsolute(tp) &&
    path.basename(tp) === id + ".jsonl"
  );
}

// D-01b store-location seam — identical precedence to src/paths.ts: 1)
// CSM_STORE_DIR override, else 2) ~/.claude/csm. CLAUDE_PLUGIN_DATA is
// deliberately NOT a tier — it is set only for plugin-hook processes, so
// honoring it would split this writer's root from the standalone panel's reader.
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

// WR-05 atomic write: unique temp in the same dir + renameSync over the target
// (rename(2) atomicity). Never throws: on any error the temp is removed on a
// best-effort basis, so each sidecar write is independent of the others.
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

try {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    payload = null;
  }

  const id = payload && payload.session_id;
  // Strict allowlist gate before any path is built (T-02-10).
  if (typeof id === "string" && SAFE_ID.test(id) && id !== "." && id !== "..") {
    const dir = path.join(storeRoot(), "sessions", id);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const iso = new Date().toISOString();
    // Heartbeat sidecar contract (FROZEN, shared with 02-01 resolveLastSeen):
    // file `heartbeat`, content = ISO-8601, plain writeFileSync (a one-line
    // mtime/content file has no torn-read window — no temp+rename needed).
    writeFileSync(path.join(dir, "heartbeat"), iso, { mode: FILE_MODE });
    // CR-01 / WR-02: a prompt resumes the session and resolves any question.
    writeAtomic(dir, "resumed", iso);
    writeAtomic(dir, "ask-resolved", iso);
    // 260927-46l D-01: a prompt starts a turn (the reader shows ▶ running).
    writeAtomic(dir, "turn.json", JSON.stringify({ state: "running", ts: iso }));
    // Phase 7 NAME-01 (D-02): record the native session title + transcript
    // path. WR-03 / D-10: ALWAYS write the snapshot, even as a bare { ts }:
    // that is the only way to say "currently unnamed", so a stale title.json
    // never outlives the payload that dropped the name.
    const title = normalizeTitle(payload.session_title);
    const tpOk = validTranscriptPath(payload.transcript_path, id);
    writeAtomic(
      dir,
      "title.json",
      JSON.stringify({
        ts: iso,
        ...(title ? { title } : {}),
        ...(tpOk ? { transcript_path: payload.transcript_path } : {}),
      }),
    );
  }
} catch {
  // Swallow every error (T-1-05): NEVER exit non-zero, NEVER write stdout.
}

process.exit(0);
