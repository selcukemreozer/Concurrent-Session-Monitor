import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Text } from "ink";
import type { SessionRow } from "../../aggregate.js";
import { renderCapture } from "../ui/test-harness.js";

/**
 * usePhases contract (Phase 10 plan 10-05, D-23, KEYS-05). The phase scan is
 * mocked the way App.test.tsx mocks it (resolvePlanningRoots / scanProgress /
 * resolveGsdTools / phaseScanMs), keeping the pure buildFocusSet real. Only
 * setInterval/clearInterval are faked, so the scan cadence is driven by
 * advanceTimersByTime and never by wall-clock sleeps.
 */

const { PROGRESS_A, PROGRESS_B } = vi.hoisted(() => {
  const mk = (name: string, n: number, percent: number) => ({
    milestone_name: name,
    milestone_version: "v1",
    percent,
    phases: Array.from({ length: n }, (_, i) => ({
      number: String(i).padStart(2, "0"),
      name: `phase-${i}`,
      plans: 1,
      summaries: 0,
      status: "Pending",
    })),
  });
  return { PROGRESS_A: mk("MILE-A", 4, 25), PROGRESS_B: mk("MILE-B", 7, 70) };
});

vi.mock("../../phases.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../phases.js")>();
  return {
    ...actual,
    scanProgress: vi.fn(async (root: string) => (root === "/projB" ? PROGRESS_B : PROGRESS_A)),
    resolvePlanningRoots: vi.fn(async () => new Set(["/projA", "/projB"])),
    phaseScanMs: vi.fn(() => 3000),
    resolveGsdTools: vi.fn(() => "/dummy/gsd-tools.cjs"),
  };
});

import { scanProgress, resolvePlanningRoots, type Progress } from "../../phases.js";
import { usePhases, type PhasesState } from "./usePhases.js";

const CADENCE = 3000;

function row(id: string, folder: string, cwd: string): SessionRow {
  return { session_id: id, folder, cwd, alive: true } as unknown as SessionRow;
}
const ROWS = [row("s-a", "alpha", "/projA"), row("s-b", "beta", "/projB")];

function Probe({ focus, rows = ROWS }: { focus: number | string; rows?: SessionRow[] }) {
  const ref = React.useRef(rows);
  ref.current = rows;
  const s: PhasesState = usePhases(ref, focus);
  const pct = s.focusProgress ? s.focusProgress.percent : "-";
  return (
    <Text>{`idx=${s.idx} root=${s.focusRoot ?? "none"} n=${s.focusSet.length} total=${s.totalPhases} pct=${pct}`}</Text>
  );
}

const mounted: Array<{ unmount: () => void }> = [];
function mount(el: React.ReactElement) {
  const cap = renderCapture(el);
  mounted.push(cap.inst);
  return cap;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.mocked(scanProgress).mockClear();
  vi.mocked(resolvePlanningRoots).mockClear();
});

afterEach(() => {
  for (const inst of mounted.splice(0)) {
    try {
      inst.unmount();
    } catch {
      // already unmounted
    }
  }
  vi.useRealTimers();
});

describe("usePhases", () => {
  it("index focus 0: two projects, idx 0, root A, then A's progress and phase count", async () => {
    const cap = mount(<Probe focus={0} />);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain("idx=0 root=/projA n=2 total=4 pct=25"));
    expect(scanProgress).toHaveBeenCalledWith("/projA", "/dummy/gsd-tools.cjs");
  });

  it("index focus wraps modulo the set size (legacy Tab behavior)", async () => {
    const cap = mount(<Probe focus={3} />);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain("idx=1 root=/projB n=2 total=7 pct=70"));
  });

  it("root focus \"/projB\": idx 1, root B, and the scan scans B", async () => {
    const cap = mount(<Probe focus="/projB" />);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain("idx=1 root=/projB n=2 total=7 pct=70"));
    expect(scanProgress).toHaveBeenCalledWith("/projB", "/dummy/gsd-tools.cjs");
    expect(scanProgress).not.toHaveBeenCalledWith("/projA", expect.anything());
  });

  it("an unknown root falls back to the first project", async () => {
    const cap = mount(<Probe focus="missing-root" />);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain("idx=0 root=/projA n=2 total=4 pct=25"));
  });

  it("no live project with .planning/: empty set, idx 0, no root, no scanProgress", async () => {
    vi.mocked(resolvePlanningRoots).mockResolvedValueOnce(new Set());
    const cap = mount(<Probe focus="/projB" rows={[]} />);
    await vi.waitFor(() => expect(resolvePlanningRoots).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(cap.lastFrame()).toContain("idx=0 root=none n=0 total=0 pct=-"));
    expect(scanProgress).not.toHaveBeenCalled();
  });

  it("changing the focus re-runs the scan for the new root", async () => {
    const cap = mount(<Probe focus="/projA" />);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain("root=/projA n=2 total=4"));
    cap.inst.rerender(<Probe focus="/projB" />);
    await vi.waitFor(() => expect(scanProgress).toHaveBeenCalledWith("/projB", "/dummy/gsd-tools.cjs"));
    await vi.waitFor(() => expect(cap.lastFrame()).toContain("idx=1 root=/projB n=2 total=7 pct=70"));
  });

  it("the interval re-scans at phaseScanMs() cadence", async () => {
    mount(<Probe focus={0} />);
    await vi.waitFor(() => expect(scanProgress).toHaveBeenCalledTimes(1));
    vi.advanceTimersByTime(CADENCE);
    await vi.waitFor(() => expect(scanProgress).toHaveBeenCalledTimes(2));
  });

  it("unmount clears the interval and drops a late resolve", async () => {
    let release: (p: Progress) => void = () => {};
    vi.mocked(scanProgress).mockImplementationOnce(
      () => new Promise<Progress>((resolve) => (release = resolve)),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cap = mount(<Probe focus={0} />);
      await vi.waitFor(() => expect(scanProgress).toHaveBeenCalledTimes(1));
      expect(cap.lastFrame()).toContain("pct=-");
      cap.inst.unmount();
      const roots = vi.mocked(resolvePlanningRoots).mock.calls.length;
      vi.advanceTimersByTime(CADENCE * 5);
      release(PROGRESS_A as Progress);
      await Promise.resolve();
      await Promise.resolve();
      expect(vi.mocked(resolvePlanningRoots).mock.calls.length).toBe(roots);
      expect(cap.frames().some((f) => f.includes("pct=25"))).toBe(false);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
