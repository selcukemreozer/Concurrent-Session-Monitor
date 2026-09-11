import React from "react";
import { App } from "./App.js";
import { Splash } from "./Splash.js";

/** Default splash duration (ms) before the live panel takes over. */
export const DEFAULT_SPLASH_MS = 1500;

export interface RootProps {
  /** Show the launch splash before the panel. Defaults to whether stdout is a TTY. */
  enableSplash?: boolean;
  /** How long the splash stays up before the panel mounts (ms). */
  splashMs?: number;
}

/**
 * Panel root (quick 260911-lsk): shows the launch {@link Splash} briefly on an
 * interactive TTY, then swaps to the live {@link App}. Kept as a thin phase-switch so
 * main.tsx stays the SOLE ink render() call site (single-ink-instance invariant — see
 * the comment in main.tsx). In a non-TTY / piped run `enableSplash` defaults false, so
 * the App mounts immediately and piped / bundle-smoke behavior is unchanged.
 */
export function Root({
  enableSplash = process.stdout.isTTY === true,
  splashMs = DEFAULT_SPLASH_MS,
}: RootProps = {}): React.ReactElement {
  const [showSplash, setShowSplash] = React.useState(enableSplash);
  React.useEffect(() => {
    if (!showSplash) return;
    const timer = setTimeout(() => setShowSplash(false), splashMs);
    return () => clearTimeout(timer);
  }, [showSplash, splashMs]);
  return showSplash ? <Splash /> : <App />;
}
