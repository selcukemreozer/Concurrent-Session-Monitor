#!/usr/bin/env node
// csm — Concurrent Session Monitor panel launcher.
//
// Thin ESM launcher: `csm` (or `node bin/csm.mjs`) boots the live Ink panel by
// importing the pre-bundled, self-contained dist/panel.mjs. All logic — the
// render() call (src/panel/main.tsx), the poll/render loop (App.tsx), the store
// read (aggregate.ts), and the SIGINT/SIGTERM clean-unmount lifecycle
// (src/panel/entry.ts) — is inlined into that one bundled file at build time.
//
// SINGLE-INK-INSTANCE INVARIANT (now structural): this launcher imports ONLY the
// bundle and must NOT pull in ink, react, or tsx directly. The old dual-loader
// bug (tsx-loaded panel + Node-native-ESM launcher instantiating ink twice, so
// isRawModeSupported went false and the FAZLAR keyboard died on every TTY) is
// impossible now: tsx is gone from the runtime path and dist/panel.mjs contains
// exactly ONE copy of ink in ONE module graph. render() still lives ONLY inside
// src/panel/main.tsx#run(); see src/panel/launcher.test.ts for the source guard.
//
// Resolve the bundle relative to THIS file so `csm` works from any cwd.
await import(new URL("../dist/panel.mjs", import.meta.url).href);
