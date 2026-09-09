#!/usr/bin/env node
// csm — Concurrent Session Monitor panel launcher (Phase-1 launch surface).
//
// Thin ESM entrypoint: `node bin/csm.mjs` renders the live Ink panel in its own
// terminal. All logic lives in src/panel/App.tsx (poll + render) and
// src/aggregate.ts (store read) — this file only boots them.
//
// The panel sources are TypeScript/TSX. There is no build step in Phase 1, so we
// transpile-on-import via tsx's programmatic API (`tsImport`), which handles the
// whole App -> Card -> aggregate graph. Ink 7 is ESM-only, so this is a `.mjs`
// with `"type":"module"` — never `require()` (Pitfall 3).
import { tsImport } from "tsx/esm/api";
import { createElement } from "react";
import { render } from "ink";

// D-07 reconciliation: as of Phase 04.2 the panel enters raw mode WHEN A TTY IS
// PRESENT (App's TTY-guarded FAZLAR keyboard via `useInput`). In that case Ink's
// default `exitOnCtrlC` (left untouched at the render call below) intercepts the
// raw \x03 and cleanly unmounts the alt-screen on Ctrl+C. On a non-TTY (piped)
// run raw mode is never entered, so we still register these manual SIGINT/SIGTERM
// handlers ourselves (Pitfall 3) — they remain the non-TTY / `kill` fallback and
// are idempotent with Ink's own unmount. We register BEFORE the (slow)
// transpile-on-import below so a SIGINT/SIGTERM that lands mid-boot still exits 0
// rather than being killed by the default signal action. `instance?.unmount()`
// runs Ink's alt-screen exit + showCursor once the panel is up, restoring the
// normal buffer.
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

// Resolve App.tsx relative to this file so `node bin/csm.mjs` works from any cwd.
const { App } = await tsImport("../src/panel/App.tsx", import.meta.url);

// Full-screen takeover (D-14): render into the alternate screen so the panel
// owns the whole terminal like Claude Code. Ink gates alt-screen behind
// interactive + TTY, so a piped / non-TTY run (e.g. tests, `| cat`) degrades
// cleanly to inline output — no hand-rolled alternate-screen escapes (Anti-Pattern).
instance = render(createElement(App), { alternateScreen: true });

// Keep the process alive until Ink exits (unmount on signal, or an internal exit).
await instance.waitUntilExit();
