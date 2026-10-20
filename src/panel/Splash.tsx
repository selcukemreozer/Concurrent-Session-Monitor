import React from "react";
import { Box, Text } from "ink";
import { PALETTE } from "./ui/palette.js";

/**
 * The csm launch splash (quick 260911-lsk): a green ASCII lighthouse emblem echoing
 * assets/logo.png, shown briefly before the live panel. {@link Root} gates it on a
 * TTY; this component is purely presentational. Forest green matches the logo (Ink
 * "green" → ANSI 32). Box-drawing glyphs only (all width-1) so the art never wraps.
 */
const EMBLEM: string = [
  "               ((•))",
  "              ┌─────┐",
  "              │░░░░░│",
  "              ╞═════╡",
  "              │  █  │",
  "              │  █  │",
  "             ╱│  █  │╲",
  "            ╱ │  █  │ ╲",
  "           ▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "            ●    ●    ●",
].join("\n");

export interface SplashProps {
  /**
   * Which palette to draw with (Phase 9 plan 09-13). `"legacy"` (the default)
   * is the 1.6.x green splash, byte-for-byte unchanged (D-23). `"v2"` is the
   * same splash recolored for the v2 shell (D-22): the emblem in the logo
   * gold, the wordmark in the high-contrast token, the tagline in the explicit
   * dim hex, and never the terminal's faint attribute (UI-SPEC Typography).
   */
  palette?: "legacy" | "v2";
}

/** Presentational launch emblem — lighthouse + wordmark + tagline, centered. */
export function Splash({ palette = "legacy" }: SplashProps = {}): React.ReactElement {
  if (palette === "v2") {
    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        paddingY={1}
      >
        <Text color={PALETTE.logo} bold>
          {EMBLEM}
        </Text>
        <Box marginTop={1}>
          <Text color={PALETTE.hi} bold>
            CONCURRENT · SESSION · MONITOR
          </Text>
        </Box>
        <Text color={PALETTE.dim}>the watch never sleeps</Text>
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      paddingY={1}
    >
      <Text color="green" bold>
        {EMBLEM}
      </Text>
      <Box marginTop={1}>
        <Text color="green" bold>
          CONCURRENT · SESSION · MONITOR
        </Text>
      </Box>
      <Text color="green" dimColor>
        the watch never sleeps
      </Text>
    </Box>
  );
}
