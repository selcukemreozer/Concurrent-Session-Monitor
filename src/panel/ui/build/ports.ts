import type { SessionRow } from "../../../aggregate.js";
import { attribute, livePidMap, portKey, type ScannedPort } from "../../../ports.js";
import { labelLead } from "../../../label.js";
import type { PortEntry } from "../models.js";

/**
 * The live PORTS builder (Phase 10 plan 10-15; D-23, KEYS-02).
 *
 *   - D-23: v2 reads the same data layer as the legacy panel. The listeners
 *     come from the shared `usePorts` scan; ownership comes from the existing
 *     scanner helpers (`livePidMap` + `attribute`), so a dead or prune-ready
 *     session never claims a port.
 *   - KEYS-02: every entry carries `portKey(port, pid)` as its identity. The
 *     PORTS cursor tracks that key, never an index, so a re-scan that
 *     re-orders the list cannot move the cursor onto another process.
 *   - Ordered by port, then pid (the same port on two pids is two entries).
 *     The unfocused exposed-first order is a draw concern (visiblePortEntries).
 *   - Pure: no React, no fs, no process access. `proc` stays RAW; the owner is
 *     the session's display lead (`labelLead`, as AGENTS names it). drawPortsPane
 *     makes both cell-safe (T-10-38).
 *   - The guarded kill backend in ../../../ports.js stays unwired here and in
 *     PanelApp until Phase 11's confirm flow (T-10-39).
 */
export function buildPorts(scanned: readonly ScannedPort[], liveRows: readonly SessionRow[]): PortEntry[] {
  const live = livePidMap(liveRows as SessionRow[]);
  return scanned
    .map((p): PortEntry => {
      const owner = attribute(p, live);
      return {
        key: portKey(p.port, p.pid),
        port: p.port,
        proc: p.command,
        pid: p.pid,
        exposed: p.exposed,
        owner: owner ? labelLead({ title: owner.title, folder: owner.folder }) : null,
      };
    })
    .sort((a, b) => a.port - b.port || a.pid - b.pid);
}
