import React from "react";
import { App } from "./App.js";
import { PanelApp } from "./PanelApp.js";
import { Splash } from "./Splash.js";
import { uiVariant, type UiVariant } from "./ui/variant.js";

/** Default splash duration (ms) before the live panel takes over. */
export const DEFAULT_SPLASH_MS = 1500;

export interface RootProps {
  /** Show the launch splash before the panel. Defaults to whether stdout is a TTY. */
  enableSplash?: boolean;
  /** How long the splash stays up before the panel mounts (ms). */
  splashMs?: number;
  /**
   * Which UI tree to mount (Phase 9 plan 09-13). Defaults to `uiVariant()`,
   * which reads `CSM_UI` once per mount.
   */
  variant?: UiVariant;
}

/**
 * Panel root (quick 260911-lsk): shows the launch {@link Splash} briefly on an
 * interactive TTY, then swaps to the live panel. Kept as a thin phase-switch so
 * main.tsx stays the SOLE ink render() call site (single-ink-instance invariant — see
 * the comment in main.tsx). In a non-TTY / piped run `enableSplash` defaults false, so
 * the panel mounts immediately and piped / bundle-smoke behavior is unchanged.
 *
 * Phase 9 plan 09-13: the UI variant is chosen HERE, inside the single render tree,
 * so main.tsx stays the sole render site and bin/csm.mjs is untouched.
 * Phase 10 plan 10-17 (D-22, 2.0.0): the new panel is the default.
 *   - `legacy` (CSM_UI, trimmed, exactly `legacy`; or the `variant` prop): the
 *     unchanged previous pair, legacy {@link Splash} then {@link App}. Kept for one
 *     release; removed in 2.1.0.
 *   - anything else, unset included (or the `v2` prop): the same splash recolored
 *     for v2, then {@link PanelApp}.
 * The variant sits in a useState initializer so it is read once per mount; a later
 * env change never swaps trees under a running panel (T-09-13).
 */
export function Root({
  enableSplash = process.stdout.isTTY === true,
  splashMs = DEFAULT_SPLASH_MS,
  variant,
}: RootProps = {}): React.ReactElement {
  const [ui] = React.useState<UiVariant>(() => variant ?? uiVariant());
  const [showSplash, setShowSplash] = React.useState(enableSplash);
  React.useEffect(() => {
    if (!showSplash) return;
    const timer = setTimeout(() => setShowSplash(false), splashMs);
    return () => clearTimeout(timer);
  }, [showSplash, splashMs]);
  if (ui === "v2") return showSplash ? <Splash palette="v2" /> : <PanelApp />;
  return showSplash ? <Splash /> : <App />;
}
