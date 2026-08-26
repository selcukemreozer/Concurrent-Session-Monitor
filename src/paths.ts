import * as os from "node:os";
import * as path from "node:path";

/**
 * Path-traversal defense (ASVS V5, threat T-1-01).
 *
 * A session_id is an untrusted string that becomes a directory name. We only
 * accept a conservative allowlist — letters, digits, dot, underscore, hyphen —
 * with a length of 1 to 128, applied BEFORE any path.join. Anything else
 * (`../`, `/`, empty, non-string) throws, so a crafted id can never escape the
 * sessions root into another user's or a system directory.
 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Coerce an untrusted `id` into a single safe path segment (threat T-1-01).
 *
 * The guarantee callers rely on: the returned value contains no path
 * separator and no `..` sequence, so `path.join(sessionsDir(), safeId(id))`
 * can never escape the sessions root. A clean id (allowlist match, and not a
 * bare `.`/`..`) is returned verbatim — the normal case for Claude's UUID-ish
 * session_ids. Anything else is sanitized: out-of-allowlist bytes (including
 * `/`) collapse to `_`, `..` runs collapse to `_`, the result is capped at
 * 128 chars, and an empty/dot-only residue becomes `_`. A non-string is a
 * programming error and throws.
 */
export function safeId(id: unknown): string {
  if (typeof id !== "string") {
    throw new Error(`Unsafe session id: ${JSON.stringify(id)}`);
  }

  // Fast path: an already-safe segment (and not a traversal token) passes through.
  if (SAFE_ID_PATTERN.test(id) && id !== "." && id !== "..") {
    return id;
  }

  let cleaned = id
    .replace(/[^A-Za-z0-9._-]/g, "_") // strip separators and any other unsafe byte
    .replace(/\.\.+/g, "_") // neutralize `..` traversal tokens
    .slice(0, 128);

  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    cleaned = "_";
  }
  return cleaned;
}

/**
 * The D-01b store-location seam. Precedence (highest first):
 *   1. process.env.CSM_STORE_DIR            (test + power-user override)
 *   2. ~/.claude/csm                        (per-user default)
 *
 * This is the single seam every hook and the panel resolve identically so all
 * processes agree on where the shards live. CLAUDE_PLUGIN_DATA is deliberately
 * NOT a tier: it is set only for processes Claude Code spawns as plugin hooks,
 * so honoring it would resolve the store to `${CLAUDE_PLUGIN_DATA}/csm` for the
 * capture hooks while the standalone panel (`node bin/csm.mjs`, no such env)
 * resolved `~/.claude/csm` — writer and reader would never meet. Session shards
 * are ephemeral (SessionEnd removes them; a stale mtime marks a shard inactive),
 * so they do not need the update-surviving persistence CLAUDE_PLUGIN_DATA offers.
 */
export function storeRoot(): string {
  const override = process.env.CSM_STORE_DIR;
  if (override) return override;

  return path.join(os.homedir(), ".claude", "csm");
}

/** The directory holding one subdirectory per live session. */
export function sessionsDir(): string {
  return path.join(storeRoot(), "sessions");
}

/**
 * The per-session shard directory. `safeId` runs BEFORE the join so a
 * traversal id throws rather than escaping the sessions root.
 */
export function sessionDir(sessionId: string): string {
  return path.join(sessionsDir(), safeId(sessionId));
}
