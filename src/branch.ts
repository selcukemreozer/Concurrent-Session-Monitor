import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { numEnv } from "./env.js";
import type { SessionRow } from "./aggregate.js";

/**
 * The reader-side, passive LIVE git-branch derivation module (LB-01), a sibling
 * to src/ports.ts. It derives each live session's CURRENT checkout from its cwd
 * so the panel + `/csm-status` no longer show only the SessionStart snapshot
 * (`session.json.branch`), which goes stale the moment a session checks out a
 * different branch.
 *
 * Passive and non-fatal by construction: any per-cwd git failure (not a repo /
 * git slow / git absent / empty output) OMITS that cwd from the resolved Map and
 * NEVER rejects. This module touches no hook, no writer, no capture path — pure
 * reader compute. `readAll` stays a subprocess-free fs reducer; derivation lives
 * ONLY here (panel side) and inline in scripts/csm-status.mjs (D-LB-06).
 */

const pexec = promisify(execFile);

/**
 * The live-branch-scan cadence (D-LB-01), config-adjustable via
 * `CSM_BRANCH_SCAN_MS`. Read lazily (mirrors portScanMs/phaseScanMs) so tests can
 * flip the env per-case. Intentionally FASTER than the phase scan (a branch
 * checkout changes far more often than roadmap progress) but still well slower
 * than the ~750ms render poll — the scan runs off the render tick.
 */
export function branchScanMs(): number {
  return numEnv("CSM_BRANCH_SCAN_MS", 1500);
}

/**
 * Derive the CURRENT git branch of each live session's cwd — passively and
 * non-fatally (LB-01, D-LB-01).
 *
 * Contract:
 *  - DEDUPED by cwd: the distinct string cwds are collected first, so multiple
 *    sessions sharing a cwd derive a single git call.
 *  - async `execFile` with an args ARRAY (`git -C <cwd> rev-parse --abbrev-ref
 *    HEAD`) — NO shell, so a crafted cwd can never inject a command even though
 *    cwd originates from our own SessionStart hook (`-C <cwd>` is one argv elem).
 *  - a per-call `{ timeout: 1000, maxBuffer: 1<<20 }` guard (T-LB-03).
 *  - ANY per-cwd failure (non-repo / git-absent / timeout / empty output) OMITS
 *    that cwd from the Map and never rejects the overall Promise (T-LB-01).
 *  - returns a `Map<cwd, liveBranch>` whose values are trimmed, non-empty branch
 *    names; consumers fall back to the snapshot for any absent cwd (see liveBranch).
 */
export async function scanBranches(rows: SessionRow[]): Promise<Map<string, string>> {
  // Distinct cwds only — the dedupe: sessions sharing a cwd derive once.
  const cwds = new Set<string>();
  for (const r of rows) {
    if (typeof r.cwd === "string" && r.cwd.length > 0) cwds.add(r.cwd);
  }

  const out = new Map<string, string>();
  await Promise.all(
    [...cwds].map(async (cwd) => {
      try {
        const { stdout } = await pexec(
          "git",
          ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
          { timeout: 1000, maxBuffer: 1 << 20 },
        );
        const branch = stdout.trim();
        if (branch.length > 0) out.set(cwd, branch);
      } catch {
        // non-fatal: a non-repo / git-absent / timeout cwd is simply omitted
      }
    }),
  );
  return out;
}

/**
 * The SINGLE fallback rule (D-LB-02): return the live-derived branch for a row's
 * cwd when it is a non-empty string, else the SessionStart `row.branch` snapshot
 * (also the snapshot when the row has no cwd). This keeps the display from
 * regressing before the first scan resolves — the panel/csm-status always show a
 * branch, live when available and the snapshot otherwise. Pure and non-throwing.
 */
export function liveBranch(row: SessionRow, branches: ReadonlyMap<string, string>): string {
  const live = typeof row.cwd === "string" ? branches.get(row.cwd) : undefined;
  return typeof live === "string" && live.length > 0 ? live : row.branch;
}
