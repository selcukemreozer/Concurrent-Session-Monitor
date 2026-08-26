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

// Resolve App.tsx relative to this file so `node bin/csm.mjs` works from any cwd.
const { App } = await tsImport("../src/panel/App.tsx", import.meta.url);

render(createElement(App));
