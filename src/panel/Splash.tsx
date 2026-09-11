import React from "react";
import { Box, Text } from "ink";

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

/** Presentational launch emblem — green lighthouse + wordmark + tagline, centered. */
export function Splash(): React.ReactElement {
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
