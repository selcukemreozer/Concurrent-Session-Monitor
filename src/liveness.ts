import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The pure read-side liveness spine (LIFE-01 read half).
 *
 * Every helper here is a small, injectable, Node-stdlib-only function so the
 * panel's live/dead verdict is fully unit-testable with a deterministic clock
 * and a stub pid probe — no real long-lived processes required.
 */

/** A pid probe: reports whether an OS process currently exists. */
export type Probe = (pid: number) => "alive" | "dead";

/**
 * The default probe: `kill -0` semantics verified locally.
 *   - success            -> "alive"
 *   - EPERM (exists, not ours) -> "alive"
 *   - anything else (ESRCH — no such process) -> "dead"
 */
export function defaultProbe(pid: number): "alive" | "dead" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EPERM") return "alive";
    return "dead";
  }
}

/**
 * Layered liveness primary signal (D-01): `kill -0` is an *accelerator*, never
 * the sole authority. Guards the pid before probing so an attacker-influenced
 * or transient pid cannot crash or mislead the reader (threat T-02-01).
 *
 * A non-integer, `<= 0`, or `undefined` pid returns "unknown" WITHOUT calling
 * the probe — the caller then defers entirely to the TTL.
 */
export function isProcessAlive(
  pid: number | undefined,
  probe: Probe = defaultProbe,
): "alive" | "dead" | "unknown" {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "unknown";
  return probe(pid);
}

/**
 * Resolve the last-seen time (ms) for a shard from its `heartbeat` sidecar.
 *
 * On-disk contract (FROZEN, shared with the 02-02 writer):
 *   - file name: `heartbeat` in the shard dir (no extension)
 *   - content:   `new Date().toISOString()` — parsed via `Date.parse`
 *   - fallback:  `statSync(heartbeat).mtimeMs` when content is unparseable
 *   - absent:    returns `undefined`
 *
 * Wrapped in try/catch so a torn read never throws — the panel self-heals next
 * tick.
 */
export function resolveLastSeen(dir: string): number | undefined {
  const hb = path.join(dir, "heartbeat");
  let content: string;
  try {
    content = fs.readFileSync(hb, "utf8");
  } catch {
    return undefined; // no heartbeat sidecar yet
  }

  const parsed = Date.parse(content.trim());
  if (!Number.isNaN(parsed)) return parsed;

  try {
    return fs.statSync(hb).mtimeMs; // unparseable content -> mtime fallback
  } catch {
    return undefined;
  }
}

/**
 * The liveness TTL (D-07), config-adjustable via `CSM_STALE_MS`. A session is
 * "fresh" only if its last_seen is within this many ms of `now`. Read lazily
 * (mirrors `windowMs()` in aggregate.ts) so tests can flip the env per-case.
 *
 * DISTINCT from `CSM_WINDOW_MS` (the active-file window) — do not conflate.
 */
export function staleMs(): number {
  return Number(process.env.CSM_STALE_MS ?? 120000);
}

/**
 * The green/yellow dot threshold (D-12), config-adjustable via `CSM_ACTIVE_MS`.
 * A live session whose newest touch is within this many ms reads "active"
 * (green); otherwise "idle" (yellow). Read lazily like `staleMs()`.
 */
export function activeMs(): number {
  return Number(process.env.CSM_ACTIVE_MS ?? 30000);
}

/**
 * Compact uptime formatting (D-10), no dependency. Sub-minute keeps seconds
 * ("45s"); past a minute drops seconds ("42m"); past an hour is "Xh Ym".
 */
export function fmtUptime(startMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - startMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
