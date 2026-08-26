import React from "react";
import { Box } from "ink";
import { readAll } from "../aggregate.js";
import { SessionCard } from "./Card.js";

/** Poll cadence (Claude's Discretion): ~750ms comfortably meets criterion #1
 * ("a touch appears within about a second") without a file watcher. */
const POLL_MS = 750;

/**
 * The live cross-session panel (PANEL-01, PANEL-05).
 *
 * Seeds its rows from a synchronous `readAll()` on mount, then arms a ~750ms
 * interval that re-reads the FULL store each tick and re-renders. A full
 * re-read (not event deltas) is self-healing across the store's atomic
 * temp+rename writes and any missed touch — a torn/missing shard simply
 * recovers on the next tick (Pattern 7 / Pitfall 4). The interval is cleared
 * on unmount so the process exits cleanly. Rows arrive already ordered
 * most-recently-active first (D-09) from `readAll()`; each becomes one
 * `SessionCard` keyed by session_id.
 */
export function App() {
  const [rows, setRows] = React.useState(() => readAll());

  React.useEffect(() => {
    const timer = setInterval(() => setRows(readAll()), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box flexDirection="column">
      {rows.map((r) => (
        <SessionCard key={r.session_id} s={r} />
      ))}
    </Box>
  );
}
