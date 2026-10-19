import React from "react";
import { Box, Text } from "ink";
import type { Line } from "./screen.js";

/**
 * Ink presentation of a Screen's lines (Phase 9, plan 09-02; RESEARCH Pattern 1).
 *
 * Ink only PAINTS here: layout already happened in the cell grid, so each Line
 * becomes exactly one non-shrinking row (`flexShrink={0}`, no Yoga squash,
 * Pitfall 1) holding one nested <Text> per Seg with the Seg's colors as element
 * props (tests assert colors on the element tree, never on ANSI). An empty Line
 * renders a single space so the row keeps its height.
 *
 * Dim text is always an explicit hex fg from the token table; the faint-text
 * attribute is never used (it renders inconsistently across terminals).
 */
export function ScreenView({ lines }: { lines: Line[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i} flexShrink={0}>
          <Text wrap="truncate-end">
            {line.length === 0
              ? " "
              : line.map((s, j) => (
                  <Text key={j} color={s.fg} backgroundColor={s.bg} bold={s.bold}>
                    {s.text}
                  </Text>
                ))}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
