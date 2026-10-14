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
import type { Instance } from "ink";
import { run } from "./main.js"; // the sole rendering call site stays in main.tsx
import { registerPanel, unregisterPanel } from "./registration.js";
import { cleanupWarpTabConfig, defaultLater, sweepStaleWarpTabConfigs } from "./launch.js";

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

instance = run();
registerPanel();
defaultLater(() => {
  sweepStaleWarpTabConfigs();
}, 0);

// Keep the process alive until Ink exits (unmount on signal, or an internal exit).
await instance.waitUntilExit();
unregisterPanel();
cleanupWarpTabConfig();
