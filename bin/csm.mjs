#!/usr/bin/env node
// csm — Concurrent Session Monitor panel launcher (Phase-1 launch surface).
//
// Thin ESM entrypoint: `node bin/csm.mjs` renders the live Ink panel in its own
// terminal. All logic lives in src/panel/App.tsx (poll + render) and
// src/aggregate.ts (store read) — this file only boots them.
//
// The panel sources are TypeScript/TSX. There is no build step in Phase 1, so we
// transpile-on-import via tsx's programmatic API (`tsImport`), which handles the
// whole main -> App -> Card -> aggregate graph. Ink 7 is ESM-only, so this is a
// `.mjs` with `"type":"module"` — never `require()` (Pitfall 3).
//
// SINGLE-INK-INSTANCE INVARIANT: this launcher deliberately imports ONLY tsx and
// must NOT pull in the ink or react modules directly. The launcher runs under
// Node's native ESM loader while the panel sources run under tsx's loader — two
// separate module graphs. If the launcher imported ink/react and also loaded App
// through tsx, ink would be instantiated twice; render's stdin-context provider
// would come from one copy while App's useStdin/useInput hooks read the other
// copy's unprovided context, so isRawModeSupported goes false and the FAZLAR
// keyboard dies on every TTY. So render() lives ONLY inside
// src/panel/main.tsx#run() — one tsx-loaded ink instance shared by render and
// App's hooks. See src/panel/launcher.test.ts for the source-level guard.
import { tsImport } from "tsx/esm/api";

// D-07 reconciliation: as of Phase 04.2 the panel enters raw mode WHEN A TTY IS
// PRESENT (App's TTY-guarded FAZLAR keyboard via useInput). In that case Ink's
// default exitOnCtrlC intercepts the raw \x03 and cleanly unmounts the
// alt-screen on Ctrl+C. On a non-TTY (piped) run raw mode is never entered, so
// we still register these manual SIGINT/SIGTERM handlers ourselves (Pitfall 3) —
// they remain the non-TTY / `kill` fallback and are idempotent with Ink's own
// unmount. We register BEFORE the (slow) transpile-on-import below so a
// SIGINT/SIGTERM that lands mid-boot still exits 0 rather than being killed by
// the default signal action. `instance?.unmount()` runs Ink's alt-screen exit +
// showCursor once the panel is up, restoring the normal buffer.
let instance;
const shutdown = () => {
  try {
    instance?.unmount();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Resolve main.tsx relative to this file so `node bin/csm.mjs` works from any
// cwd. main.tsx owns the sole render() call (D-14 alternate-screen takeover) and
// exports run(), keeping render and App's hooks on ONE tsx-loaded ink instance.
const { run } = await tsImport("../src/panel/main.tsx", import.meta.url);
instance = run();

// Keep the process alive until Ink exits (unmount on signal, or an internal exit).
await instance.waitUntilExit();
