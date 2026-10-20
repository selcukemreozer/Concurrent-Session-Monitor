import React from "react";
import { scanPorts, portScanMs, type ScannedPort } from "../../ports.js";
import { usePoll } from "./usePoll.js";

/**
 * The cached last-good port scan (D-05, PORT-06).
 *
 * A SECOND, slower timer: spawn scanPorts() asynchronously off the render thread
 * at portScanMs() cadence — independent of and NEVER inside the 750ms poll. An
 * in-flight scan is skipped (usePoll's overlap guard); the resolved
 * ScannedPort[] is cached in state and rendered between scans. Scans once on
 * mount. On unmount the interval is cleared and a late resolve is ignored
 * (alive()). scanPorts() never rejects, but a rejection still resets to []
 * defensively.
 */
export function usePorts(): ScannedPort[] {
  const [ports, setPorts] = React.useState<ScannedPort[]>([]);
  usePoll(
    (alive) =>
      scanPorts().then(
        (p) => {
          if (alive()) setPorts(p);
        },
        () => {
          if (alive()) setPorts([]);
        },
      ),
    () => portScanMs(),
    { immediate: true },
  );
  return ports;
}
