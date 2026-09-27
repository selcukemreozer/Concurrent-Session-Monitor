import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { numEnv } from "./env.js";
import type { SessionRow } from "./aggregate.js";

/**
 * The reader-side, passive port scanner (PORT-01..04).
 *
 * Every helper here is a small, injectable, Node-stdlib-only function so port
 * introspection + attribution is fully unit-testable with fixture strings and a
 * mocked `execFile` — no real long-lived listener or `lsof`/`ps` spawn required.
 *
 * The scan is passive and non-fatal by construction: any `lsof`/`ps` failure
 * (including `lsof` exit code 1 on no-match) resolves to `[]` and NEVER throws.
 * This module touches no hook, no writer, no capture path — pure reader compute.
 *
 * 260927-8ge: each port also carries an `origin` ("warp" when some ancestor is
 * the Warp terminal app, else "other") plus the nearest real `tty` for warp
 * rows, and `killPort` is the single, guarded, injectable place that may send a
 * signal to a listening process (all refusal logic lives here, never in the UI).
 */

const pexec = promisify(execFile);

/** Where an unattributed listener came from (260927-8ge D-03). */
export type PortOrigin = "warp" | "other";

/** One de-duplicated listening socket the panel renders. */
export interface ScannedPort {
  /** The listening TCP port. */
  port: number;
  /** The owning process's pid (leaf of the ancestry chain). */
  pid: number;
  /** Untruncated command name (from `lsof -F c`), pre-sanitize. */
  command: string;
  /** True when bound to an all-interface / routable address (security signal). */
  exposed: boolean;
  /** pid → ppid → … chain up to (not incl.) launchd(1); [self, …, ancestor]. */
  ancestryPids: number[];
  /** "warp" iff some ANCESTOR (not the listener itself) is the Warp app; else "other". */
  origin: PortOrigin;
  /** Nearest real tty along the ancestry chain — set only on warp rows, pre-sanitize. */
  tty?: string;
}

/**
 * Well-known macOS Apple background-agent command names to exclude (D-01,
 * RESEARCH Pitfall 5 [VERIFIED: local]). These launchd agents run as the
 * console user, so the `-a -u <uid>` filter does NOT drop them — this additive,
 * curated, exact-command-name denylist honors D-01's literal promise to hide
 * them. It never hides a genuine dev server (exact match on the untruncated
 * `-F c` field), and a miss is non-fatal (the row simply renders).
 */
export const APPLE_AGENT_DENYLIST: Set<string> = new Set([
  "rapportd",
  "ControlCenter",
  "sharingd",
  "AirPlayXPCHelper",
  "identityservicesd",
  "remoted",
]);

/** A raw `lsof -FpcLn` socket record before host/port classification. */
interface RawSock {
  pid: number;
  command: string;
  login: string;
  name: string;
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN -FpcLn` field-mode output.
 *
 * Field grammar ([VERIFIED: local] lsof 4.91 on darwin): `p`<pid> starts a
 * process block (resetting command/login); `c`<command> is the UNTRUNCATED
 * command; `L`<login>; each socket contributes an `f`<fd> then `n`<name>.
 * `-sTCP:LISTEN` already constrains state, so every `n` here is a LISTEN socket.
 */
export function parseLsofF(stdout: string): RawSock[] {
  const out: RawSock[] = [];
  let pid = 0;
  let command = "";
  let login = "";
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") {
      pid = Number(val) || 0;
      command = "";
      login = "";
    } else if (tag === "c") {
      command = val; // untruncated in -F mode
    } else if (tag === "L") {
      login = val;
    } else if (tag === "n") {
      out.push({ pid, command, login, name: val });
    }
    // `f` (fd) and any other tag are ignored.
  }
  return out;
}

/**
 * Build a `pid → ppid` map from one `ps -axo pid,ppid,tty,command` snapshot.
 * Skips the header line; COMMAND is the trailing field and may contain spaces,
 * so only the first two whitespace tokens (pid, ppid) are read. Non-integer
 * pairs are dropped.
 */
export function parsePpidMap(stdout: string): Map<number, number> {
  const m = new Map<number, number>();
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

/** One process from a `ps -axo pid,ppid,tty,command` snapshot. */
export interface ProcInfo {
  ppid: number;
  tty: string;
  command: string;
}

/** pid, ppid, a non-space tty token, then the remainder as the command. */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/;

/**
 * Parse a `ps -axo pid,ppid,tty,command` snapshot into pid → ProcInfo. The
 * header (and any malformed line) simply fails the anchored regex, so both
 * header and header-less output parse. COMMAND keeps its internal spaces.
 */
export function parsePsSnapshot(stdout: string): Map<number, ProcInfo> {
  const m = new Map<number, ProcInfo>();
  for (const line of stdout.split("\n")) {
    const mm = PS_LINE.exec(line);
    if (!mm) continue;
    const pid = Number(mm[1]);
    const ppid = Number(mm[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    m.set(pid, { ppid, tty: mm[3], command: mm[4].trimEnd() });
  }
  return m;
}

/** True iff the command path points inside the Warp terminal app bundle. */
export function isWarpCommand(cmd: string): boolean {
  return cmd.includes("/Warp.app/");
}

/** A controlling tty that is an actual terminal (not `??` / `-` / empty). */
function isRealTty(t: string | undefined): t is string {
  return typeof t === "string" && t !== "" && t !== "??" && t !== "-";
}

/**
 * Classify an unattributed listener's origin from its ancestry chain
 * ([self, …, ancestor]). The listener itself being the Warp app → "other"
 * (Warp's own sockets go to Diğer); any Warp ANCESTOR → "warp" with the tty of
 * the first chain pid (self first) whose tty is real; otherwise "other".
 * Pids missing from `procs` simply never match.
 */
export function classifyOrigin(
  chain: number[],
  procs: Map<number, ProcInfo>,
): { origin: PortOrigin; tty?: string } {
  if (chain.length === 0) return { origin: "other" };
  const self = procs.get(chain[0]);
  if (self && isWarpCommand(self.command)) return { origin: "other" };
  const warpAncestor = chain.slice(1).some((pid) => {
    const p = procs.get(pid);
    return p !== undefined && isWarpCommand(p.command);
  });
  if (!warpAncestor) return { origin: "other" };
  for (const pid of chain) {
    const t = procs.get(pid)?.tty;
    if (isRealTty(t)) return { origin: "warp", tty: t };
  }
  return { origin: "warp" };
}

/**
 * Walk from a listening pid to the process root, collecting the chain.
 * Stops when the current pid is undefined, `<= 1` (launchd/ppid 0), or already
 * seen — the `seen` guard makes an induced cycle terminate instead of looping.
 * Returns `[selfPid, …, ancestorPid]`.
 */
export function ancestryChain(pid: number, ppid: Map<number, number>): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  let cur: number | undefined = pid;
  while (cur !== undefined && cur > 1 && !seen.has(cur)) {
    chain.push(cur);
    seen.add(cur);
    cur = ppid.get(cur);
  }
  return chain;
}

/**
 * Split a `lsof` NAME field into host + numeric port. IPv6 uses the bracket
 * form `[host]:port`; IPv4 / wildcard split on the LAST `:`.
 */
export function splitHostPort(name: string): { host: string; port: number } {
  if (name.startsWith("[")) {
    const rb = name.lastIndexOf("]");
    const host = name.slice(1, rb);
    const port = Number(name.slice(rb + 2)); // skip "]:"
    return { host, port };
  }
  const c = name.lastIndexOf(":");
  return { host: name.slice(0, c), port: Number(name.slice(c + 1)) };
}

/** Loopback hosts that are local-only (never exposed). */
const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Classify a bind host as exposed (reachable off-host) vs local-only.
 * `*` / `0.0.0.0` / `::` (all-interfaces) → exposed; the loopback set and the
 * `127.0.0.0/8` block → local-only; any other routable IP defaults to exposed
 * (fail-loud on the security signal).
 */
export function isExposed(host: string): boolean {
  if (host === "*" || host === "0.0.0.0" || host === "::") return true;
  if (LOCAL_HOSTS.has(host)) return false;
  if (host.startsWith("127.")) return false;
  return true;
}

/**
 * The live pid → session map (render-time attribution join). Includes only rows
 * that are `alive && !readyToPrune` with a numeric pid — folding in the
 * pid-reuse / dead-session guard so a reused or dead pid never claims a port
 * (it falls to the user bucket instead).
 */
export function livePidMap(rows: SessionRow[]): Map<number, SessionRow> {
  const m = new Map<number, SessionRow>();
  for (const r of rows) {
    if (r.alive && !r.readyToPrune && typeof r.pid === "number") m.set(r.pid, r);
  }
  return m;
}

/**
 * Attribute a scanned port to the first live session along its ancestry chain,
 * else `null` (the user bucket).
 */
export function attribute(p: ScannedPort, live: Map<number, SessionRow>): SessionRow | null {
  for (const pid of p.ancestryPids) {
    const r = live.get(pid);
    if (r) return r;
  }
  return null;
}

/**
 * The port-scan cadence (D-05), config-adjustable via `CSM_PORT_SCAN_MS`. Read
 * lazily (mirrors `staleMs()` in liveness.ts) so tests can flip the env per-case.
 */
export function portScanMs(): number {
  return numEnv("CSM_PORT_SCAN_MS", 2500);
}

/**
 * Scan the machine's LISTEN TCP ports for the current user, attribute each to a
 * PID ancestry chain, and classify local vs exposed — passively and non-fatally.
 *
 * Contract:
 *  - async `execFile` with an args ARRAY (no shell, uid stringified) — T-04.1-02.
 *  - per-call `{ timeout, maxBuffer }` guards — T-04.1-03.
 *  - ANY `lsof` rejection (exit 1 no-match / spawn fail) resolves `[]` — Pitfall 1.
 *  - a failing `ps` is non-fatal: ancestry falls back to self, every port gets
 *    origin "other" (no tty) and falls to the unattributed "Diğer" group.
 *  - each port carries `origin` (+ `tty` on warp rows) via classifyOrigin over
 *    the same ps snapshot (260927-8ge D-03).
 *  - `(port,pid)` twins (IPv4 + IPv6) collapse into one entry, exposed if EITHER
 *    twin is exposed.
 *  - sockets whose untruncated command is in APPLE_AGENT_DENYLIST are excluded.
 */
export async function scanPorts(uid = process.getuid?.()): Promise<ScannedPort[]> {
  let lsofOut = "";
  let psOut = "";
  try {
    const args = ["-nP", "-iTCP", "-sTCP:LISTEN", "-FpcLn"];
    if (uid !== undefined) args.push("-a", "-u", String(uid)); // D-01 user filter
    ({ stdout: lsofOut } = await pexec("lsof", args, { timeout: 1500, maxBuffer: 1 << 20 }));
  } catch {
    return []; // exit 1 (no match) or spawn failure → empty, never a crash
  }
  try {
    ({ stdout: psOut } = await pexec("ps", ["-axo", "pid,ppid,tty,command"], {
      timeout: 1500,
      maxBuffer: 1 << 21,
    }));
  } catch {
    psOut = ""; // no ancestry snapshot → every port is origin "other"
  }

  const ppid = parsePpidMap(psOut);
  const procs = parsePsSnapshot(psOut);
  const socks = parseLsofF(lsofOut);
  const byKey = new Map<string, ScannedPort>(); // (port,pid) de-dup
  for (const s of socks) {
    if (APPLE_AGENT_DENYLIST.has(s.command)) continue; // D-01 Apple-agent exclusion
    const { host, port } = splitHostPort(s.name);
    if (!Number.isInteger(port)) continue;
    const key = `${port} ${s.pid}`;
    const exposed = isExposed(host);
    const prev = byKey.get(key);
    if (prev) {
      prev.exposed = prev.exposed || exposed; // twin → keep exposed if either is
      continue;
    }
    const chain = ancestryChain(s.pid, ppid);
    const { origin, tty } = classifyOrigin(chain, procs);
    const entry: ScannedPort = {
      port,
      pid: s.pid,
      command: s.command,
      exposed,
      ancestryPids: chain,
      origin,
    };
    if (tty !== undefined) entry.tty = tty;
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Guarded per-port kill (260927-8ge D-05 / D-06)
// ---------------------------------------------------------------------------

/** The two signals the panel may send (SIGTERM first, SIGKILL on escalation). */
export type KillSignal = "SIGTERM" | "SIGKILL";

/** The stable (port,pid) identity used to track a sent SIGTERM across scans. */
export function portKey(port: number, pid: number): string {
  return `${port} ${pid}`;
}

/**
 * Pick the signal for a (port,pid): SIGKILL only when a SIGTERM was already
 * sent for this key AND a strictly LATER scan generation still lists it
 * (D-05: escalate only after the pair survived a re-scan); else SIGTERM.
 */
export function chooseSignal(
  sent: ReadonlyMap<string, number>,
  key: string,
  gen: number,
): KillSignal {
  const at = sent.get(key);
  return at !== undefined && gen > at ? "SIGKILL" : "SIGTERM";
}

/** What the user asked to stop. */
export interface KillTarget {
  port: number;
  pid: number;
  command: string;
  signal: KillSignal;
}

/** Protected-process context supplied by the panel. */
export interface KillContext {
  /** Exact pids of live Claude sessions (their children stay killable). */
  livePids: ReadonlySet<number>;
  /** The panel's own pid (process.pid). */
  selfPid: number;
}

/** Injectable side effects so the guard matrix is testable with no real spawn/kill. */
export interface KillDeps {
  exec(
    cmd: string,
    args: string[],
    opts: { timeout: number; maxBuffer: number },
  ): Promise<{ stdout: string }>;
  kill(pid: number, signal: KillSignal): void;
}

/** Outcome shown as the panel's transient status line. */
export interface KillResult {
  ok: boolean;
  message: string;
}

/** Real deps: execFile with an args array (no shell) and process.kill. */
const defaultKillDeps: KillDeps = {
  async exec(cmd, args, opts) {
    const { stdout } = await pexec(cmd, args, opts);
    return { stdout: String(stdout) };
  },
  kill(pid, signal) {
    process.kill(pid, signal);
  },
};

const PS_ARGS = ["-axo", "pid,ppid,tty,command"];

/**
 * Send `target.signal` to the process listening on `target.port` — but only
 * after every guard passes. Never throws / rejects; every refusal is
 * `{ ok: false, message }` with NO signal sent.
 *
 * Guards in order: pid integer > 1; port integer 1..65535; not the panel
 * itself; not an exact live Claude session pid; a fresh ps snapshot must be
 * obtainable (fail-closed); not an ancestor of the panel; not the Warp app;
 * and — immediately before signalling — `lsof … -a -p <pid> -t` must confirm
 * that pid still listens on that port (pid-reuse / stale-scan guard).
 */
export async function killPort(
  target: KillTarget,
  ctx: KillContext,
  deps: KillDeps = defaultKillDeps,
): Promise<KillResult> {
  try {
    const { port, pid, signal } = target;
    if (!Number.isInteger(pid) || pid <= 1) return { ok: false, message: "reddedildi: geçersiz pid" };
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, message: "reddedildi: geçersiz port" };
    }
    if (pid === ctx.selfPid) return { ok: false, message: "reddedildi: panelin kendisi" };
    if (ctx.livePids.has(pid)) return { ok: false, message: `reddedildi: Claude oturumu (pid ${pid})` };

    let psOut: string;
    try {
      ({ stdout: psOut } = await deps.exec("ps", PS_ARGS, { timeout: 1500, maxBuffer: 1 << 21 }));
    } catch {
      return { ok: false, message: "reddedildi: süreç ağacı doğrulanamadı" };
    }
    const procs = parsePsSnapshot(psOut);
    if (procs.size === 0) return { ok: false, message: "reddedildi: süreç ağacı doğrulanamadı" };
    const ppid = new Map<number, number>();
    for (const [p, info] of procs) ppid.set(p, info.ppid);
    if (ancestryChain(ctx.selfPid, ppid).includes(pid)) {
      return { ok: false, message: `reddedildi: panelin üst süreci (pid ${pid})` };
    }
    const info = procs.get(pid);
    if (info && isWarpCommand(info.command)) return { ok: false, message: "reddedildi: Warp uygulaması" };

    const stale = { ok: false, message: "port artık bu pid'de değil" };
    let lsofOut: string;
    try {
      ({ stdout: lsofOut } = await deps.exec(
        "lsof",
        ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-a", "-p", String(pid), "-t"],
        { timeout: 1500, maxBuffer: 1 << 16 },
      ));
    } catch {
      return stale; // lsof exit 1 = that pid no longer listens on that port
    }
    const listed = lsofOut
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    if (!listed.includes(String(pid))) return stale;

    try {
      deps.kill(pid, signal);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "ESRCH") return { ok: false, message: `süreç zaten sonlanmış (pid ${pid})` };
      if (code === "EPERM") return { ok: false, message: `izin yok (EPERM): pid ${pid}` };
      return { ok: false, message: `sinyal gönderilemedi (pid ${pid})` };
    }
    return { ok: true, message: `${signal} → :${port} gönderildi` };
  } catch {
    return { ok: false, message: "sinyal gönderilemedi" };
  }
}
