import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Text } from "ink";
import type { SessionRow } from "../../aggregate.js";
import { renderCapture } from "../ui/test-harness.js";

/**
 * useResume contract (Phase 10 plan 10-05, D-23; Phase 8 D-14..D-19, CR-01,
 * T-08-11). The scan and the launcher are mocked the way App.test.tsx mocks
 * them, keeping every pure helper (reconcileSelection / followOffset / RESUME_*)
 * real. Only setInterval/clearInterval are faked, so the scan cadence is driven
 * by advanceTimersByTime and never by wall-clock sleeps.
 */

vi.mock("../../sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions.js")>();
  return {
    ...actual,
    discoverSessions: vi.fn(async () => []),
    resumeScanMs: vi.fn(() => 4000),
    readLiveRegistry: vi.fn(async () => new Set<string>()),
    resumeExtras: vi.fn(async () => ({ bypass: false })),
  };
});
vi.mock("../launch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../launch.js")>();
  return {
    ...actual,
    copyResume: vi.fn(async () => ({ ok: true, copied: true, message: "copied ✓" })),
    openResume: vi.fn(async () => ({
      ok: true,
      copied: true,
      message: "opened a new Terminal window · command copied",
    })),
  };
});

import { discoverSessions, readLiveRegistry, resumeExtras, type ResumeRow } from "../../sessions.js";
import { copyResume, openResume, type LaunchResult } from "../launch.js";
import { useResume, type ResumeState } from "./useResume.js";

const CADENCE = 4000;

function rr(id: string, label: string, live = false): ResumeRow {
  return { id, label, labelKind: "name", folder: "proj", cwd: `/work/${label}`, slug: "-work", mtimeMs: 1, live };
}
const A = rr("aaaaaaaa-0000-4000-8000-000000000001", "alpha");
const B = rr("bbbbbbbb-0000-4000-8000-000000000002", "beta");
const C = rr("cccccccc-0000-4000-8000-000000000003", "gamma");

const NO_ROWS: SessionRow[] = [];

function Probe({ visible, api }: { visible: boolean; api: { current: ResumeState | null } }) {
  const ref = React.useRef(NO_ROWS);
  const s = useResume(ref, visible);
  api.current = s;
  const st = s.status ? `${s.status.text}/${s.status.ok}` : "-";
  return <Text>{`rows=${s.rows ? s.rows.length : "null"} sel=${s.selId ?? "none"} off=${s.offset} status=${st}`}</Text>;
}

const mounted: Array<{ unmount: () => void }> = [];
function mount(visible: boolean) {
  const api: { current: ResumeState | null } = { current: null };
  const cap = renderCapture(<Probe visible={visible} api={api} />);
  mounted.push(cap.inst);
  return { cap, api, show: (v: boolean) => cap.inst.rerender(<Probe visible={v} api={api} />) };
}

/** Let pending promise callbacks run (a macrotask turn, not a wall-clock wait). */
const flush = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.mocked(discoverSessions).mockReset().mockResolvedValue([A, B, C]);
  vi.mocked(readLiveRegistry).mockReset().mockResolvedValue(new Set<string>());
  vi.mocked(resumeExtras).mockReset().mockResolvedValue({ bypass: false });
  vi.mocked(copyResume).mockClear();
  vi.mocked(openResume)
    .mockReset()
    .mockResolvedValue({ ok: true, copied: true, message: "opened a new Terminal window · command copied" });
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

describe("useResume", () => {
  it("not visible: no scan and rows stay null", async () => {
    const { cap } = mount(false);
    await flush();
    vi.advanceTimersByTime(CADENCE * 3);
    await flush();
    expect(discoverSessions).not.toHaveBeenCalled();
    expect(cap.lastFrame()).toContain("rows=null sel=none");
  });

  it("visible: one immediate scan, then interval scans; rows populate; cursor on the first row", async () => {
    const { cap } = mount(true);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain(`rows=3 sel=${A.id} off=0`));
    expect(discoverSessions).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CADENCE);
    await vi.waitFor(() => expect(discoverSessions).toHaveBeenCalledTimes(2));
  });

  it("hiding clears the interval (D-19)", async () => {
    const { cap, show } = mount(true);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain("rows=3"));
    show(false);
    await flush();
    const n = vi.mocked(discoverSessions).mock.calls.length;
    vi.advanceTimersByTime(CADENCE * 5);
    await flush();
    expect(vi.mocked(discoverSessions).mock.calls.length).toBe(n);
    // Last-good rows stay cached across the hide.
    expect(cap.lastFrame()).toContain("rows=3");
  });

  it("a reordering scan keeps the cursor on the same id; a scan that drops it moves to the nearest row (D-17)", async () => {
    const { cap, api } = mount(true);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain(`sel=${A.id}`));
    api.current!.move(1);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain(`sel=${B.id}`));

    vi.mocked(discoverSessions).mockResolvedValueOnce([C, B, A]);
    vi.advanceTimersByTime(CADENCE);
    await vi.waitFor(() => expect(discoverSessions).toHaveBeenCalledTimes(2));
    await flush();
    expect(cap.lastFrame()).toContain(`sel=${B.id}`);

    vi.mocked(discoverSessions).mockResolvedValueOnce([A, C]);
    vi.advanceTimersByTime(CADENCE);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain(`rows=2 sel=${C.id}`));
  });

  it("move clamps to the list and clears the status", async () => {
    const { cap, api } = mount(true);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain(`sel=${A.id}`));
    api.current!.move(10);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain(`sel=${C.id}`));
    api.current!.move(-1);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain(`sel=${B.id}`));
    api.current!.enter();
    await vi.waitFor(() => expect(cap.lastFrame()).toContain("status=copied ✓/true"));
    api.current!.move(-10);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain(`sel=${A.id} off=0 status=-`));
  });

  it("enter copies the selected row through copyResume and shows the ok result", async () => {
    const { cap, api } = mount(true);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain(`sel=${A.id}`));
    api.current!.enter();
    await vi.waitFor(() => expect(cap.lastFrame()).toContain("status=copied ✓/true"));
    expect(copyResume).toHaveBeenCalledTimes(1);
    expect(copyResume).toHaveBeenCalledWith({ id: A.id, cwd: A.cwd, live: false, name: undefined, bypass: false });
  });

  it("enter and open do nothing while not visible", async () => {
    const { cap, api, show } = mount(true);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain(`sel=${A.id}`));
    show(false);
    await flush();
    api.current!.enter();
    api.current!.open();
    await flush();
    expect(copyResume).not.toHaveBeenCalled();
    expect(openResume).not.toHaveBeenCalled();
  });

  it("open shows opening… at once, then the launch result", async () => {
    let release: (r: LaunchResult) => void = () => {};
    vi.mocked(openResume).mockImplementationOnce(() => new Promise<LaunchResult>((r) => (release = r)));
    const { cap, api } = mount(true);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain(`sel=${A.id}`));
    api.current!.open();
    await vi.waitFor(() => expect(cap.lastFrame()).toContain("status=opening…/false"));
    await vi.waitFor(() => expect(openResume).toHaveBeenCalledTimes(1));
    expect(openResume).toHaveBeenCalledWith({ id: A.id, cwd: A.cwd, live: false });
    release({ ok: true, copied: true, message: "opened ✓" });
    await vi.waitFor(() => expect(cap.lastFrame()).toContain("status=opened ✓/true"));
  });

  it("a second open on the same id while the first is pending launches nothing new (CR-01 claim)", async () => {
    const { cap, api } = mount(true);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain(`sel=${A.id}`));
    api.current!.open(); // claims A, then awaits the registry re-check
    api.current!.open(); // same tick: A is already held, so it only copies and warns
    await vi.waitFor(() => expect(openResume).toHaveBeenCalledTimes(2));
    const launches = vi.mocked(openResume).mock.calls.filter(([t]) => t.live === false);
    expect(launches).toHaveLength(1);
    // The second press ran synchronously, before the first press's launch.
    expect(vi.mocked(openResume).mock.calls[0]![0]).toEqual({ id: A.id, cwd: A.cwd, live: true });
    // A successful launch stays held: the row reads live at once (D-11, D-16).
    await flush();
    expect(api.current!.isLive(A)).toBe(true);
    expect(api.current!.rows!.find((r) => r.id === A.id)!.live).toBe(true);
  });

  it("unmount clears the interval", async () => {
    const { cap } = mount(true);
    await vi.waitFor(() => expect(cap.lastFrame()).toContain("rows=3"));
    cap.inst.unmount();
    const n = vi.mocked(discoverSessions).mock.calls.length;
    vi.advanceTimersByTime(CADENCE * 5);
    await flush();
    expect(vi.mocked(discoverSessions).mock.calls.length).toBe(n);
  });
});
