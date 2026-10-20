import React from "react";
import type { SessionRow } from "../../aggregate.js";
import { scanBranches, branchScanMs } from "../../branch.js";
import { usePoll } from "./usePoll.js";

/**
 * The cached live-branch map (cwd -> current checkout) (LB-02, D-LB-04).
 *
 * A slow scan, a sibling of the port scan, NEVER inside the 750ms poll. Each
 * non-overlapping tick derives each LIVE (non-grace) session's CURRENT git
 * branch from its cwd off the render thread at branchScanMs() cadence, caches
 * the resolved Map in state, and the caller merges it into the rows via
 * liveBranch(). It reads `liveRowsRef.current` (the caller's freshest live rows)
 * so it never re-arms every render. Scans once on mount. scanBranches() never
 * rejects, but a rejection still resets to an empty Map defensively; on unmount
 * the interval is cleared and a late resolve is ignored (alive()).
 */
export function useBranches(liveRowsRef: React.RefObject<SessionRow[]>): Map<string, string> {
  const [branches, setBranches] = React.useState<Map<string, string>>(() => new Map());
  usePoll(
    (alive) =>
      scanBranches(liveRowsRef.current).then(
        (m) => {
          if (alive()) setBranches(m);
        },
        () => {
          if (alive()) setBranches(new Map());
        },
      ),
    () => branchScanMs(),
    { immediate: true },
  );
  return branches;
}
