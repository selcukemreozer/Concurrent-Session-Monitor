import { sanitize } from "./sanitize.js";

/**
 * Panel "update available" check (261014-e2u).
 *
 * Third-party marketplaces do not auto-update plugins by default, so a user
 * has no way to learn that a newer CSM exists. The panel compares its
 * installed version (embedded at build time, see scripts/build.mjs) with the
 * `version` field of the public `.claude-plugin/plugin.json` on GitHub and, if
 * the published one is numerically newer, shows "⬆ vX.Y.Z available" in its
 * title row. That is all it does: it NEVER downloads code, never runs
 * `/plugin` or any other command, and never installs anything. Updating stays
 * a manual Claude Code action.
 *
 * This is the panel's FIRST outbound network surface, so it is deliberately
 * narrow (threat model T-261014-e2u-01..07):
 *  - a constant HTTPS URL (not configurable) fetched with `redirect: "error"`;
 *  - a plain GET with no headers, query string, body or credentials, so no
 *    session id, path, file name or installed version leaves the machine;
 *  - a 5 s abort timeout, a content-length pre-check and a streamed body cap of
 *    16 KiB;
 *  - the only value used from the response is a strictly validated numeric
 *    MAJOR.MINOR.PATCH (≤ 32 chars), and the label is sanitize()d before render;
 *  - every failure resolves to null: nothing here throws, rejects or prints;
 *  - CSM_UPDATE_CHECK=0 (or false/off), a non-TTY stdout, or an unknown
 *    installed version means zero requests and zero timers.
 *
 * Stdlib only (global fetch / AbortSignal / TextDecoder); every network seam is
 * injectable so the tests never touch the network.
 */

/** The published plugin manifest. Constant on purpose: HTTPS-only by construction. */
export const UPDATE_URL =
  "https://raw.githubusercontent.com/selcukemreozer/Concurrent-Session-Monitor/main/.claude-plugin/plugin.json";

/** Check cadence after the first check: every 6 hours. */
export const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

/** Per-request abort timeout. */
export const FETCH_TIMEOUT_MS = 5000;

/** Largest response body read before giving up. */
export const MAX_BODY_BYTES = 16 * 1024;

/** Longest version string accepted. */
export const MAX_VERSION_LEN = 32;

// Each component is 0 or a 1-6 digit number without a leading zero.
const VERSION_RE = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;

/** A plain numeric MAJOR.MINOR.PATCH, or null for anything else. */
export function normalizeVersion(v: unknown): string | null {
  if (typeof v !== "string" || v.length > MAX_VERSION_LEN) return null;
  return VERSION_RE.test(v) ? v : null;
}

/** True when `remote` is numerically greater than `installed`; false if either is invalid. */
export function isNewer(remote: string, installed: string): boolean {
  const r = normalizeVersion(remote);
  const i = normalizeVersion(installed);
  if (r === null || i === null) return false;
  const a = r.split(".").map(Number);
  const b = i.split(".").map(Number);
  for (let k = 0; k < 3; k++) {
    if (a[k] !== b[k]) return a[k] > b[k];
  }
  return false;
}

// Replaced with a string literal by esbuild's `define` in scripts/build.mjs.
// Absent under vitest/tsx, where the typeof guard below yields null.
declare const __CSM_VERSION__: string | undefined;

/** The version this panel was built as, or null when not running from the bundle. */
export function installedVersion(): string | null {
  return typeof __CSM_VERSION__ === "string" ? normalizeVersion(__CSM_VERSION__) : null;
}

/** Whether the panel may run the check at all. */
export function updateCheckEnabled(opts: {
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  installed: string | null;
}): boolean {
  const flag = (opts.env.CSM_UPDATE_CHECK ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  if (!opts.isTTY) return false;
  return opts.installed !== null;
}

/** The title-row label for a newer remote version, or null. */
export function updateLabel(remote: string | null): string | null {
  const v = normalizeVersion(remote);
  return v === null ? null : sanitize("⬆ v" + v + " available");
}

/**
 * Whether brand + label + " · " + clock fit on one title line. The 2 is the
 * title Box's paddingX and the 1 a minimum gap between brand and the right side.
 */
export function updateLabelFits(cols: number, brand: string, label: string, clock: string): boolean {
  const len = (s: string): number => [...s].length;
  return len(brand) + len(label) + 3 + len(clock) + 2 + 1 <= cols;
}

/**
 * One GET of UPDATE_URL. Resolves the published version, or null on any
 * failure (network, timeout, status, size, JSON shape, version format).
 */
export async function fetchLatestVersion(opts?: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<string | null> {
  const timeoutMs = opts?.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? MAX_BODY_BYTES;
  try {
    const f = opts?.fetchImpl ?? globalThis.fetch;
    if (typeof f !== "function") return null;
    const res = await f(UPDATE_URL, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res || !res.ok || res.status !== 200 || !res.body) return null;

    const declared = Number(res.headers?.get?.("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body.cancel?.().catch(() => undefined);
      return null;
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }

    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    const obj: unknown = JSON.parse(new TextDecoder().decode(buf));
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
    return normalizeVersion((obj as { version?: unknown }).version);
  } catch {
    return null;
  }
}

/**
 * Run the check once right after the caller's first render (setTimeout 0) and
 * then every `intervalMs` (default 6 h). Checks never overlap; a failed check
 * keeps the previous result; both timers are unref'd so they never hold the
 * process open. Returns a stop function. When the check is disabled nothing is
 * scheduled and the returned stop is a no-op.
 */
export function startUpdateCheck(opts: {
  installed: string | null;
  isTTY: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  onResult: (newer: string | null) => void;
}): () => void {
  const installed = opts.installed;
  if (installed === null || !updateCheckEnabled({ env: opts.env ?? process.env, isTTY: opts.isTTY, installed })) {
    return () => {};
  }

  let inFlight = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const remote = await fetchLatestVersion({ fetchImpl: opts.fetchImpl });
      if (!stopped && remote !== null) {
        opts.onResult(isNewer(remote, installed) ? remote : null);
      }
    } catch {
      // Defensive: fetchLatestVersion never rejects; an onResult throw stops here.
    } finally {
      inFlight = false;
    }
  };

  const first = setTimeout(() => void tick(), 0);
  const every = setInterval(() => void tick(), opts.intervalMs ?? UPDATE_CHECK_MS);
  first.unref?.();
  every.unref?.();

  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(every);
  };
}
