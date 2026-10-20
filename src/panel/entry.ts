// csm bundle entry — compiled by esbuild into dist/panel.mjs.
//
// This module owns the process lifecycle (signals + waitUntilExit) that used to
// live in bin/csm.mjs. The sole rendering call still lives ONLY inside main.tsx,
// and this entry imports run() from there — so after bundling there is exactly
// ONE ink instance in one module graph. tsx is gone from the runtime path, so
// the historical dual-loader / dual-ink bug class is structurally impossible.
// This entry never mounts ink itself; it only drives run() + the signal exit.
//
// 260927-59z D-01 registration lifecycle: right after run() the panel records
// its terminal identity in <storeRoot>/panel.json (registerPanel) so the no-arg
// /csm-goto can focus it; doing it after run() means the tty probe never delays
// the first frame. On a clean exit (Ink Ctrl+C unmount, SIGINT, SIGTERM, SIGHUP)
// unregisterPanel removes the file only if it still holds our pid. Both never
// throw.
//
// Phase 8 (RESUME-04): on the same clean exit cleanupWarpTabConfig removes every
// per-launch Warp tab config (~/.warp/tab_configs/csm-resume-<shortid>-<pid>-<nonce>.toml)
// that THIS panel wrote for an `o` launch and still holds (marker-checked by pid
// and nonce, never throws), and nothing else.
//
// 261014-d54 start-up sweep (WR-01 problem 2 / T-08-34): right after
// the registerPanel call an unref'd defaultLater(…, 0) runs sweepStaleWarpTabConfigs,
// so a panel killed inside the 30 s TTL has its leftover tab config removed by
// the next panel start once that panel's pid is gone (ESRCH only; the file's
// first line must be that pid's exact marker). Deferred so the readdir never
// delays the first frame and never keeps the process alive; bounded to
// WARP_SWEEP_MAX_ENTRIES names; never throws.
import * as fs from "node:fs";
import type { Instance } from "ink";
import { run } from "./main.js"; // the sole rendering call site stays in main.tsx
import { registerPanel, unregisterPanel } from "./registration.js";
import { cleanupWarpTabConfig, defaultLater, sweepStaleWarpTabConfigs } from "./launch.js";
import {
  appendCrashLog,
  crashLogDisplayPath,
  createCrashHandler,
  installCrashHandlers,
  restoreTerminal,
} from "./crash.js";
import { uiVariant } from "./ui/variant.js";

// D-07 reconciliation: as of Phase 04.2 the panel enters raw mode WHEN A TTY IS
// PRESENT (App's TTY-guarded FAZLAR keyboard via useInput). In that case Ink's
// default exitOnCtrlC intercepts the raw \x03 and cleanly unmounts the
// alt-screen on Ctrl+C. On a non-TTY (piped) run raw mode is never entered, so
// we still register these manual SIGINT/SIGTERM handlers ourselves — they remain
// the non-TTY / `kill` fallback and are idempotent with Ink's own unmount. We
// register BEFORE run() below so a SIGINT/SIGTERM that lands mid-boot still exits
// 0 rather than being killed by the default signal action. `instance?.unmount()`
// runs Ink's alt-screen exit + showCursor, restoring the normal buffer (D-14).
// SIGHUP (terminal tab closed) joins them so panel.json is cleaned up too.
let instance: Instance | undefined;
let shuttingDown = false; // several signals may arrive; unmount + exit runs at most once
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    instance?.unmount();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
// Synchronous fs in an exit listener is allowed; unregisterPanel never throws.
process.on("exit", () => {
  unregisterPanel();
  cleanupWarpTabConfig();
});

// Plan 09-14 (D-25, KEYS-04): the v2 crash path. Any crash runs one fixed
// sequence: restore the terminal (unmount Ink, raw-mode / alt-screen fallback)
// -> write ONE `csm crashed: ... details in .../crash.log` line -> append the
// stack to crash.log under the store root -> exit 1. The stderr write is
// synchronous on fd 2 (Pitfall 4: stderr to a pipe is async on macOS, so an
// async write can be lost when exit(1) runs). A render-phase error never reaches
// uncaughtException: Ink's error boundary unmounts and waitUntilExit() rejects
// (Pitfall 3), so the catch around that await routes it to the same handler.
// restoreTerminal(instance) is safe there: Ink's unmount() returns early once
// the instance is already unmounted, so the restore bytes are never doubled.
// RESEARCH Open Question 1: the handlers are v2-only in 1.7.0 (legacy keeps
// today's crash behavior, D-23) and become universal at the Phase 10 flip.
// Installed BEFORE run(), like the signal handlers, so a boot-time crash is
// covered too; `instance` is read when the handler runs, not now.
const onCrash: ((err: unknown) => void) | null =
  uiVariant() === "v2"
    ? createCrashHandler({
        restore: () => restoreTerminal(instance),
        writeErr: (line: string) => {
          fs.writeSync(2, line);
        },
        appendLog: (entry: string) => appendCrashLog(entry),
        exit: (code: number) => process.exit(code),
        displayLogPath: crashLogDisplayPath(),
        now: () => new Date(),
      })
    : null;
if (onCrash !== null) installCrashHandlers(onCrash);

instance = run();
registerPanel();
defaultLater(() => {
  sweepStaleWarpTabConfigs();
}, 0);

// Keep the process alive until Ink exits (unmount on signal, or an internal exit).
// A rejection here is a render-phase error (Pitfall 3): legacy re-throws it
// unchanged (D-23); v2 sends it through the crash handler, which exits 1 (the
// exit listener above still runs both cleanups).
try {
  await instance.waitUntilExit();
} catch (err) {
  if (onCrash === null) throw err;
  onCrash(err);
}
unregisterPanel();
cleanupWarpTabConfig();
