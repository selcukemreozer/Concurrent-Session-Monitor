/**
 * Launch-hold bookkeeping for the OTURUMLAR resume picker (Phase 8, D-16,
 * review CR-01). Pure: no fs, no timers, no clock reads. Every time value is a
 * parameter, so the rules are unit-testable and the caller owns the clock.
 *
 * The D-16 invariant this encodes: "a second process on the same transcript is
 * never started by accident". The panel's `live` flag comes from a scan that
 * can be up to one CSM_RESUME_SCAN_MS interval old, so the panel also holds
 * every id it is launching or has just launched:
 *
 * - A claim is made synchronously, before anything is awaited. While an id is
 *   held, the panel passes live:true for it, so openResume copies and warns
 *   and never launches a second process.
 * - A claim is released by its own launch only when that launch failed
 *   (ok:false, matched by the claiming press's token), so the user can retry.
 * - Otherwise only a scan releases a hold: either a scan reports the id live
 *   (confirmation; from then on the real live flag guards it), or a scan that
 *   STARTED at least LAUNCH_HOLD_MS after the claim reports it not live or
 *   absent. An in-flight claim is never released by a scan, and time alone
 *   never releases a hold, so a slow or paused scan only lengthens a hold.
 *
 * 60 s comfortably exceeds the 20 s OSASCRIPT_TIMEOUT_MS plus a claude process
 * start and its registry write.
 */

/** How long after a claim a not-live scan result may release the hold. */
export const LAUNCH_HOLD_MS = 60_000;

/** One held id: claim time (epoch ms), the claiming press's token, and whether its launch is still pending. */
export type LaunchHold = { at: number; token: number; inFlight: boolean };

/** Held ids, keyed by session id. */
export type LaunchHolds = Map<string, LaunchHold>;

/**
 * Claim `id` for a launch. Returns true and stores an in-flight hold when the
 * id was not held; returns false and changes nothing when it already was.
 */
export function claimLaunch(holds: LaunchHolds, id: string, now: number, token: number): boolean {
  if (holds.has(id)) return false;
  holds.set(id, { at: now, token, inFlight: true });
  return true;
}

/**
 * Settle the launch made by the press holding `token`. A failed launch drops
 * the hold; a successful one keeps it and marks it no longer in flight. A
 * non-matching token or a missing id changes nothing and returns false.
 */
export function settleLaunch(holds: LaunchHolds, id: string, token: number, ok: boolean): boolean {
  const hold = holds.get(id);
  if (hold === undefined || hold.token !== token) return false;
  if (ok) holds.set(id, { ...hold, inFlight: false });
  else holds.delete(id);
  return true;
}

/**
 * Settle holds from an applied scan that started at `scanStartedAt`. A hold
 * that is not in flight is dropped when the scan reports its id live, or when
 * the scan started at least LAUNCH_HOLD_MS after the claim and reports the id
 * not live or absent. Returns true when anything was dropped.
 */
export function settleHolds(
  holds: LaunchHolds,
  rows: ReadonlyArray<{ id: string; live: boolean }>,
  scanStartedAt: number,
): boolean {
  if (holds.size === 0) return false;
  const liveById = new Map<string, boolean>();
  for (const r of rows) liveById.set(r.id, r.live);
  let dropped = false;
  for (const [id, hold] of holds) {
    if (hold.inFlight) continue;
    const confirmed = liveById.get(id) === true;
    const expired = scanStartedAt - hold.at >= LAUNCH_HOLD_MS;
    if (confirmed || expired) {
      holds.delete(id);
      dropped = true;
    }
  }
  return dropped;
}

/**
 * Display overlay: every held row reads as live. Returns the SAME array when
 * no held row needs a change; otherwise a new array where only the changed
 * rows are copies. Never mutates its input.
 */
export function applyHolds<T extends { id: string; live: boolean }>(
  rows: ReadonlyArray<T> | null,
  holds: LaunchHolds,
): ReadonlyArray<T> | null {
  if (rows === null) return null;
  if (holds.size === 0) return rows;
  let out: T[] | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.live || !holds.has(r.id)) continue;
    if (out === null) out = rows.slice();
    out[i] = { ...r, live: true };
  }
  return out ?? rows;
}
