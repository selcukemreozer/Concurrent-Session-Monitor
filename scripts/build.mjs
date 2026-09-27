#!/usr/bin/env node
// Panel bundle build (`npm run build`) — dev-only; installs never run it.
//
// Bundles src/panel/entry.ts into the committed, zero-dependency dist/panel.mjs
// via esbuild's JS API. This replaces the former inline CLI recipe, whose
// shebang/createRequire banner relied on bash-only ANSI-C `$'...'` quoting and
// so produced a different bundle under a strict POSIX /bin/sh such as dash
// (05-REVIEW WR-03). Here the banner is a plain JS string with real escapes, so
// the build no longer depends on any shell.
//
// Usage:  node scripts/build.mjs [outfile]
//   outfile defaults to dist/panel.mjs (relative to the repo root). The
//   bundle-freshness test passes a temp outfile so it never clobbers the
//   committed bundle while byte-diffing against it.
//
// Options mirror the previous CLI recipe exactly, so the output is
// byte-identical to the committed bundle.
import { build } from "esbuild";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// createRequire shim: bundled CJS deps (e.g. signal-exit) call require() for
// Node builtins, which an ESM bundle otherwise lacks.
const BANNER =
  "#!/usr/bin/env node\n" +
  'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);';

const outfile = process.argv[2] ?? "dist/panel.mjs";

await build({
  absWorkingDir: REPO_ROOT,
  entryPoints: ["src/panel/entry.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile,
  alias: { "react-devtools-core": "./scripts/rdc-stub.mjs" },
  banner: { js: BANNER },
  jsx: "automatic",
  logLevel: "info",
});
