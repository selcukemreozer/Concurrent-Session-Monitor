// The one session go-to action (Phase 10 plan 10-10; GOTO-01, GOTO-04,
// GOTO-05, D-11, D-12, D-13).
//
//   - D-12: this is the ONLY place in src/panel that opens a Warp URL. Enter on
//     a selected card or idle strip routes here; Phase 11 routes the port
//     go-to through the same `runGoto` instead of adding a second call site.
//   - GOTO-05: only a URL that fully matches the strict session rule
//     (`isWarpSessionUrl`, src/warp-url.ts) is ever passed to `open`. It is
//     checked in the verdict AND again right before `deps.open(url)`.
//   - D-13 hard rule: a session whose process ancestry runs through a
//     multiplexer (tmux, screen, zellij, byobu, dtach, abduco), an IDE
//     terminal, a non-Warp app or no app at all is never focused. RESEARCH Q1
//     probed this live: GNU screen inside Warp keeps the INHERITED
//     WARP_FOCUS_URL, so it stores a valid-looking URL that may belong to a
//     different pane. Store data alone is not enough; the Enter-time ancestry
//     of the stored pid decides. Older tmux (< 3.2) is caught the same way.
//   - The action never guesses or picks a pane from the terminal device or
//     the working directory. It only confirms or refuses the stored URL.
//   - Liveness is re-probed at Enter: kill -0 plus the async lstart compare
//     against `pid_started` (pid reuse). An empty lstart is a soft miss, the
//     same rule as liveness.isProcessAlive.
//   - Pitfall 6: nothing here blocks the key path. `ps` runs through async
//     execFile with a 1000 ms timeout (1 MiB buffer); `open` runs through
//     launch.defaultRun (argv array, absolute /usr/bin/open, no shell, SIGKILL
//     after 3000 ms). The shell option is never set.
//   - Copy (UI-SPEC, D-11): success reads `focusing <name>` in the neutral
//     footer color (`ok: false`; never "focused": `open` exits 0 even when
//     the pane is gone, assumption A3). Every refusal is exactly one of four
//     plain reasons.
//   - Assumptions A1 (Preview / OSS bundles live in `Warp*.app/Contents/
//     MacOS/`) and A2 (IDE terminals pass through a matching `.app` bundle)
//     both fail closed: a miss reads `pane not findable` or `not a Warp
//     session`, never a wrong pane. The URL scheme is NOT paired with the
//     bundle name here (RESEARCH Q1, an open question for Phase 11).
//   - `runGoto` never throws; every probe and the opener are injected through
//     `GotoDeps`, so tests never spawn a process.

import { execFile } from "node:child_process";
import { isWarpSessionUrl } from "../../warp-url.js";
import { ancestryChain } from "../../ports.js";
import { defaultProbe } from "../../liveness.js";
import { OPEN_BIN, defaultRun } from "../launch.js";
import { nameText } from "../ui/text.js";

export type Host = "warp" | "mux" | "ide" | "otherApp" | "none" | "unknown";
export type Alive = "alive" | "dead" | "unknown";
/** The four plain reasons (UI-SPEC copy, verbatim). */
export type GotoReason = "no Warp pane recorded" | "not a Warp session" | "process gone" | "pane not findable";
export type Verdict = { kind: "open"; url: string } | { kind: "refuse"; reason: GotoReason };

/** What the action needs to know about one session row. */
export interface GotoTarget {
  /** The raw card / strip name (cleaned by focusingText). */
  name: string;
  pid?: number;
  pid_started?: string;
  warp?: unknown;
  ended?: boolean;
}

/** The injected probes and opener (tests pass fakes). */
export interface GotoDeps {
  /** kill -0 semantics: EPERM counts as alive. */
  probe(pid: number): "alive" | "dead";
  /** `ps -o lstart=` for the pid; "" when it cannot be derived. */
  startedProbe(pid: number): Promise<string>;
  /** `ps -axo pid=,ppid=,comm=` stdout, or null when ps failed. */
  procTable(): Promise<string | null>;
  /** Opens the URL; true when the opener exited 0. */
  open(url: string): Promise<boolean>;
}

/** The footer flash the caller raises (`ok: false` = neutral color). */
export interface GotoFlash {
  text: string;
  ok: boolean;
}

/** Process table: pid → ppid and pid → command path. */
export interface ProcTable {
  ppid: Map<number, number>;
  comm: Map<number, string>;
}

function refuse(reason: GotoReason): Verdict {
  return { kind: "refuse", reason };
}

function focusUrlOf(warp: unknown): unknown {
  if (typeof warp !== "object" || warp === null || Array.isArray(warp)) return undefined;
  return (warp as { focus_url?: unknown }).focus_url;
}

/**
 * The RESEARCH Q1 verdict matrix, first match wins (rows 2-7; row 1, a
 * vanished selection, is the caller's, and rows 8-9 are runGoto's open step).
 */
export function gotoVerdict(t: { warp?: unknown; ended?: boolean }, alive: Alive, host: Host): Verdict {
  if (t.ended === true || alive === "dead") return refuse("process gone");
  if (t.warp === null) {
    // D-13: a recorded "not Warp" under a mux / IDE / Warp ancestor is still a pane we cannot find
    return host === "mux" || host === "ide" || host === "warp"
      ? refuse("pane not findable")
      : refuse("not a Warp session");
  }
  const url = focusUrlOf(t.warp);
  if (!isWarpSessionUrl(url)) return refuse("no Warp pane recorded");
  if (alive === "unknown") return refuse("pane not findable");
  if (host !== "warp") return refuse("pane not findable");
  return { kind: "open", url };
}

const PROC_LINE = /^\s*(\d+)\s+(\d+)\s+(.*)$/;

/**
 * Parse `ps -axo pid=,ppid=,comm=`. A header or malformed line fails the
 * anchored regex; the command keeps its inner spaces, trailing space trimmed.
 */
export function parseProcTable(stdout: string): ProcTable {
  const ppid = new Map<number, number>();
  const comm = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const m = PROC_LINE.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const parent = Number(m[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
    ppid.set(pid, parent);
    comm.set(pid, m[3].trimEnd());
  }
  return { ppid, comm };
}

const MUX = /^(tmux|screen|zellij|byobu|dtach|abduco)$/i;
/** Stable is verified locally; the Preview / OSS bundle names are A1. */
const WARP_APP = /\/Warp[A-Za-z]*\.app\/Contents\/MacOS\//;
const IDE_APP = /(Visual Studio Code|Code Helper|Cursor|Windsurf|VSCodium|IntelliJ|PyCharm|WebStorm|GoLand|JetBrains|Zed)/;

/**
 * Classify the ancestors of `chain[0]` (from ports.ancestryChain, self first;
 * self is skipped). The first multiplexer or app bundle met decides.
 */
export function classifyHost(chain: readonly number[], comm: ReadonlyMap<number, string>): Host {
  for (const pid of chain.slice(1)) {
    const c = comm.get(pid);
    if (c === undefined) continue;
    const base = c.split("/").pop() ?? c;
    if (MUX.test(base)) return "mux";
    if (c.includes(".app/Contents/")) {
      if (WARP_APP.test(c)) return "warp";
      return IDE_APP.test(c) ? "ide" : "otherApp";
    }
  }
  return "none";
}

/** The neutral success copy; the name goes through the NAME-02 pipeline. */
export function focusingText(name: string): string {
  return `focusing ${nameText(name, 40) || "session"}`;
}

/**
 * WR-03: the D-13 ancestry gate and the pid-reuse check read `ps` by absolute
 * path (like OPEN_BIN), so a project-local `ps` early on the panel's PATH can
 * never forge a Warp ancestry or a matching start time.
 */
export const PS_BIN = "/bin/ps";

function execText(cmd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, [...args], { encoding: "utf8", timeout: 1000, maxBuffer: 1 << 20 }, (err, stdout) => {
        resolve(err ? null : String(stdout));
      });
    } catch {
      resolve(null);
    }
  });
}

/** The real probes and opener: async, bounded, argv arrays only. */
export function defaultGotoDeps(): GotoDeps {
  return {
    probe: defaultProbe,
    startedProbe: (pid) =>
      execText(PS_BIN, ["-o", "lstart=", "-p", String(pid)]).then((s) => (s === null ? "" : s.trim())),
    procTable: () => execText(PS_BIN, ["-axo", "pid=,ppid=,comm="]),
    open: (url) => defaultRun(OPEN_BIN, [url], { timeoutMs: 3000 }).then((r) => r.ok),
  };
}

function validPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1;
}

async function liveness(t: GotoTarget, deps: GotoDeps): Promise<Alive> {
  if (!validPid(t.pid)) return "unknown";
  let base: "alive" | "dead";
  try {
    base = deps.probe(t.pid);
  } catch {
    return "dead"; // cannot confirm the process exists: fail closed
  }
  if (base !== "alive") return "dead";
  if (typeof t.pid_started === "string" && t.pid_started !== "") {
    let now = "";
    try {
      now = await deps.startedProbe(t.pid);
    } catch {
      now = ""; // soft miss, as isProcessAlive
    }
    if (typeof now === "string" && now !== "" && now !== t.pid_started) return "dead"; // pid reused
  }
  return "alive";
}

async function hostOf(pid: number | undefined, deps: GotoDeps): Promise<Host> {
  if (!validPid(pid)) return "unknown";
  let out: string | null;
  try {
    out = await deps.procTable();
  } catch {
    return "unknown";
  }
  if (typeof out !== "string") return "unknown";
  const table = parseProcTable(out);
  return classifyHost(ancestryChain(pid, table.ppid), table.comm);
}

/**
 * Decide focus-or-reason from fresh liveness, process ancestry and the strict
 * URL rule, then open the URL. Never throws.
 */
export async function runGoto(t: GotoTarget, deps: GotoDeps = defaultGotoDeps()): Promise<GotoFlash> {
  const no = (reason: GotoReason): GotoFlash => ({ text: reason, ok: false });
  try {
    const alive = await liveness(t, deps);
    if (t.ended === true || alive === "dead") return no("process gone");
    // the host only matters for a recorded null or a valid URL (matrix rows 3 and 7)
    const needHost = t.warp === null || isWarpSessionUrl(focusUrlOf(t.warp));
    const host: Host = needHost ? await hostOf(t.pid, deps) : "unknown";
    const v = gotoVerdict(t, alive, host);
    if (v.kind === "refuse") return no(v.reason);
    // GOTO-05: the second check, right before the only open call
    if (!isWarpSessionUrl(v.url)) return no("no Warp pane recorded");
    let opened = false;
    try {
      opened = (await deps.open(v.url)) === true;
    } catch {
      opened = false;
    }
    return opened ? { text: focusingText(t.name), ok: false } : no("pane not findable");
  } catch {
    return no("pane not findable");
  }
}
