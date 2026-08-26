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
 * Returns `id` unchanged iff it is a string matching the safe allowlist,
 * otherwise throws. This is the single guard every session_id -> dir-name
 * join must pass through.
 */
export function safeId(id: unknown): string {
  if (typeof id !== "string" || !SAFE_ID_PATTERN.test(id)) {
    throw new Error(`Unsafe session id: ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * The D-01b store-location seam. Precedence (highest first):
 *   1. process.env.CSM_STORE_DIR            (test + power-user override)
 *   2. ${CLAUDE_PLUGIN_DATA}/csm            (persistent plugin data dir)
 *   3. ~/.claude/csm                        (per-user default)
 *
 * This is the single seam every hook and the panel resolve identically so all
 * processes agree on where the shards live.
 */
export function storeRoot(): string {
  const override = process.env.CSM_STORE_DIR;
  if (override) return override;

  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) return path.join(pluginData, "csm");

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
