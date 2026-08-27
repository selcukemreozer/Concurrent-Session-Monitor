import { rmSync } from "node:fs";
import { sessionDir } from "./paths.js";

/**
 * Reader-side shard prune (LIFE-02 / D-06) — the phase's single security-critical
 * reader write.
 *
 * Security (T-02-20, WR-01, ASVS V4): the rm target MUST be resolved ONLY through
 * `sessionDir(id)`, which runs `safeId` BEFORE `path.join`. A crafted `session_id`
 * (e.g. `../../etc`) is therefore collapsed to a single sanitized segment inside the
 * sessions root, so `rmSync` can never escape it. This function must NEVER build the
 * rm path from a raw id and must NOT re-implement its own allowlist — it reuses the
 * exact `safeId` seam the writers use (the WR-01 unification).
 *
 * Idempotency (T-02-21): `force: true` already makes a missing shard a no-op, and the
 * surrounding try/catch swallows any residual error so a second prune (or a shard a
 * live session re-creates mid-prune) never throws. A genuinely dead session stays
 * pruned; a live one self-heals its shard on its next write (readAll picks it up on
 * the next tick).
 */
export function pruneSession(id: string): void {
  try {
    rmSync(sessionDir(id), { recursive: true, force: true });
  } catch {
    // Self-heal: an already-gone or racing-recreate shard is not an error.
  }
}
