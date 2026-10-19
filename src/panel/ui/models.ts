import type { AgentState } from "./palette.js";

/**
 * The v2 view-model contract (Phase 9, plan 09-05; D-09, D-11, D-20).
 *
 *   - This is the Phase 9 -> 10 seam. The v2 draw functions take ONLY these
 *     models; they never read sessions, transcripts or the port scanner.
 *   - Phase 9 fills every model from the English sample fixture (sample.ts)
 *     under the ` sample ` chip. Phase 10 builds them from live data pane by
 *     pane, replacing the sample as each pane goes live (D-20).
 *   - `AgentCard.prompt` is the last user prompt, which Phase 10 reads from the
 *     transcript with a bounded tail read (D-11). The AskUserQuestion text is
 *     never a field: the asking card shows the last prompt like every other card.
 *   - The card model deliberately has no task-annotation, skill or
 *     target-branch field: D-09 moved the task annotation to the Phase 10
 *     detail strip.
 *
 * Types only: no runtime code lives here.
 */

/** A pane's drawing rectangle in absolute cells. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One active agent card (D-09: 7 rows). */
export interface AgentCard {
  // identity and placement
  id: string;
  name: string;
  dir: string;
  branch: string;
  uptime: string;
  // content
  model: string | null;
  prompt: string | null;
  // state
  state: AgentState;
  waitFor: string | null;
  subagents: number;
  // counts
  conflicts: number;
  writes: number;
  reads: number;
  inConflict: boolean;
}

/** One idle session strip under the card grid. */
export interface IdleStrip {
  id: string;
  name: string;
  ago: string;
}

/** Two sessions touching the same path. */
export interface FileConflict {
  a: string;
  b: string;
  path: string;
}

export interface FileEntry {
  path: string;
  kind: "write" | "read";
}

/** One agent's files in the FILES pane (writes first, then reads). */
export interface FileGroup {
  agentId: string;
  name: string;
  state: AgentState | "idle";
  files: FileEntry[];
}

export type PhaseStatus = "done" | "current" | "pending";

export interface PhaseEntry {
  number: string;
  name: string;
  status: PhaseStatus;
  plansDone: number | null;
  plansTotal: number | null;
}

export interface Project {
  name: string;
  dir: string;
  phases: PhaseEntry[];
}

export interface SessionEntry {
  id: string;
  name: string;
  ago: string;
  live: boolean;
}

export interface PortEntry {
  key: string;
  port: number;
  proc: string;
  pid: number;
  exposed: boolean;
  owner: string | null;
}

/** The live header (row 0). Never carries the sample chip (D-20). */
export interface HeaderModel {
  agents: number;
  asking: number;
  waiting: number;
  conflicts: number;
  clock: string;
  update: string | null;
}

/** A transient footer / pane message; `ok` draws it as a success (green). */
export interface Flash {
  text: string;
  ok: boolean;
}

/** Everything the v2 panes draw. */
export interface PanesModel {
  // agents
  agents: AgentCard[];
  idle: IdleStrip[];
  // files
  conflicts: FileConflict[];
  groups: FileGroup[];
  // phases
  projects: Project[];
  projectIndex: number;
  // sessions
  sessions: SessionEntry[];
  sessionStatus: Flash | null;
  // ports
  ports: PortEntry[];
}
