import { createElement } from "react";
import { render, type Instance } from "ink";
import { App } from "./App.js";

/**
 * Mount the live panel and return its Ink {@link Instance}.
 *
 * THIS MUST BE THE ONLY render() CALL SITE IN THE WHOLE PROJECT — and it MUST
 * live in a tsx-loaded module (this .tsx), never in the Node-native-ESM
 * launcher. Reason: `bin/csm.mjs` is loaded by Node's native ESM loader, while
 * this module (and App.tsx below it) is loaded by tsx's loader. Those are two
 * DIFFERENT module graphs, so if render() and App were pulled in through
 * different loaders, ink would be instantiated TWICE. render() would then mount
 * its StdinContext provider from ink copy #1, while App's useStdin()/useInput()
 * would read ink copy #2's context — which has no provider above it and falls
 * back to defaults. isRawModeSupported collapses to false and the FAZLAR
 * keyboard (Tab / arrows) goes dead on every TTY.
 *
 * Rendering here keeps render() and App's hooks on ONE tsx-loaded ink instance,
 * so the StdinContext provider and the consuming hooks share the same context.
 *
 * Full-screen takeover (D-14): alternateScreen renders into the terminal's
 * alternate buffer so the panel owns the whole screen like Claude Code. Ink
 * gates the alt-screen behind interactive + TTY, so a piped / non-TTY run
 * degrades cleanly to inline output.
 */
export function run(): Instance {
  return render(createElement(App), { alternateScreen: true });
}
