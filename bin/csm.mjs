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

import { fileURLToPath } from "node:url"; // stdlib only — never ink/react/tsx

// Resolve the bundle relative to THIS file so `csm` works from any cwd.
const bundle = new URL("../dist/panel.mjs", import.meta.url);
try {
  await import(bundle.href);
} catch (err) {
  // 05 IN-02: a broken/partial install (no dist/panel.mjs) gets a one-line
  // actionable message instead of a raw stack trace. ONLY the bundle itself
  // being absent is translated: a module missing INSIDE the bundle also throws
  // ERR_MODULE_NOT_FOUND with "imported from .../dist/panel.mjs" in its
  // message, so we match the missing module's own url/path, never a substring.
  // Everything else (real panel boot errors) is re-thrown with its full stack.
  const bundleMissing =
    err?.code === "ERR_MODULE_NOT_FOUND" &&
    (err.url === bundle.href ||
      String(err.message).startsWith(`Cannot find module '${fileURLToPath(bundle)}'`));
  if (!bundleMissing) throw err;
  process.stderr.write(
    `csm: panel bundle not found at ${fileURLToPath(bundle)}; reinstall the plugin (/plugin install concurrent-session-monitor@concurrent-session-monitor), then re-run /csm-setup.\n`,
  );
  process.exit(1);
}
