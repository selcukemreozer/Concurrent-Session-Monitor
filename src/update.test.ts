import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  UPDATE_URL,
  UPDATE_CHECK_MS,
  FETCH_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_VERSION_LEN,
  normalizeVersion,
  isNewer,
  installedVersion,
  updateCheckEnabled,
  updateLabel,
  updateLabelFits,
  fetchLatestVersion,
  startUpdateCheck,
} from "./update.js";

/**
 * 261014-e2u: the panel update check. Every test injects `fetchImpl`; the
 * global `fetch` is stubbed with a throwing spy that must never be called, so
 * no test in this file can ever reach the network (T-261014-e2u-07).
 */

let netSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  netSpy = vi.fn(() => {
    throw new Error("network access in test");
  });
  vi.stubGlobal("fetch", netSpy);
});

afterEach(() => {
  expect(netSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const BRAND = "◆ Concurrent Session Monitor";
const CLOCK = "2026-10-14 12:34:56";

/** A JSON response built with Node's global Response. */
function jsonRes(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** fetchImpl resolving to the given response; records calls. */
function fetchReturning(res: Response | (() => Response)) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    typeof res === "function" ? res() : res,
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("constants", () => {
  it("UPDATE_URL is the https raw.githubusercontent.com plugin.json URL", () => {
    expect(UPDATE_URL).toBe(
      "https://raw.githubusercontent.com/selcukemreozer/Concurrent-Session-Monitor/main/.claude-plugin/plugin.json",
    );
    expect(UPDATE_URL.startsWith("https://")).toBe(true);
  });

  it("cadence, timeout and caps", () => {
    expect(UPDATE_CHECK_MS).toBe(21_600_000);
    expect(FETCH_TIMEOUT_MS).toBe(5000);
    expect(MAX_BODY_BYTES).toBe(16 * 1024);
    expect(MAX_VERSION_LEN).toBe(32);
  });
});

describe("normalizeVersion", () => {
  it.each(["1.6.0", "0.0.0", "10.20.30", "999999.0.1"])("accepts %s", (v) => {
    expect(normalizeVersion(v)).toBe(v);
  });

  it.each([
    "v1.6.0",
    "1.6",
    "1.6.0.1",
    "1.6.0-beta.1",
    "1.6.0+b",
    " 1.6.0",
    "1.6.0\n",
    "01.6.0",
    "1.06.0",
    "1.6.00",
    "1.6.0\u001b[2J",
    "1234567.0.0",
    "",
  ])("rejects %j", (v) => {
    expect(normalizeVersion(v)).toBeNull();
  });

  it("rejects strings longer than MAX_VERSION_LEN", () => {
    expect(normalizeVersion("1.2.3" + " ".repeat(40))).toBeNull();
    expect(normalizeVersion("9".repeat(MAX_VERSION_LEN + 1))).toBeNull();
  });

  it.each([1.6, null, undefined, {}, [], true])("rejects non-string %j", (v) => {
    expect(normalizeVersion(v)).toBeNull();
  });
});

describe("isNewer", () => {
  it.each([
    ["1.6.0", "1.5.0", true],
    ["1.10.0", "1.9.0", true],
    ["2.0.0", "1.99.99", true],
    ["1.5.1", "1.5.0", true],
    ["1.5.0", "1.5.0", false],
    ["1.4.9", "1.5.0", false],
    ["0.9.9", "1.0.0", false],
  ])("isNewer(%s, %s) === %s", (r, i, want) => {
    expect(isNewer(r, i)).toBe(want);
  });

  it("any invalid side is false", () => {
    expect(isNewer("v2.0.0", "1.0.0")).toBe(false);
    expect(isNewer("2.0.0", "1.0")).toBe(false);
    expect(isNewer(null as unknown as string, "1.0.0")).toBe(false);
    expect(isNewer("2.0.0", null as unknown as string)).toBe(false);
  });
});

describe("installedVersion", () => {
  it("is null under vitest (no build-time define)", () => {
    expect(installedVersion()).toBeNull();
  });
});

describe("updateCheckEnabled", () => {
  it.each(["0", "false", "off", " OFF ", "False"])("CSM_UPDATE_CHECK=%j disables", (v) => {
    expect(updateCheckEnabled({ env: { CSM_UPDATE_CHECK: v }, isTTY: true, installed: "1.6.0" })).toBe(false);
  });

  it("non-TTY disables", () => {
    expect(updateCheckEnabled({ env: {}, isTTY: false, installed: "1.6.0" })).toBe(false);
  });

  it("unknown installed version disables", () => {
    expect(updateCheckEnabled({ env: {}, isTTY: true, installed: null })).toBe(false);
  });

  it.each([undefined, "1", "yes", "on", ""])("CSM_UPDATE_CHECK=%j stays enabled", (v) => {
    const env = v === undefined ? {} : { CSM_UPDATE_CHECK: v };
    expect(updateCheckEnabled({ env, isTTY: true, installed: "1.6.0" })).toBe(true);
  });
});

describe("updateLabel / updateLabelFits", () => {
  it("formats a valid remote", () => {
    expect(updateLabel("9.9.9")).toBe("⬆ v9.9.9 available");
  });

  it("null / invalid → null", () => {
    expect(updateLabel(null)).toBeNull();
    expect(updateLabel("9.9.9\u001b[2J")).toBeNull();
  });

  it("label carries no control characters", () => {
    const l = updateLabel("1.2.3") ?? "";
    for (const ch of l) {
      const cp = ch.codePointAt(0) ?? 0;
      expect(cp <= 0x1f || (cp >= 0x80 && cp <= 0x9f)).toBe(false);
    }
  });

  it("fits at 80 columns, drops at 60", () => {
    const label = "⬆ v1.6.0 available";
    expect(updateLabelFits(80, BRAND, label, CLOCK)).toBe(true);
    expect(updateLabelFits(60, BRAND, label, CLOCK)).toBe(false);
  });

  it("budget is brand + label + 3 + clock + 2 + 1, by code point", () => {
    const label = "⬆ v1.6.0 available";
    const need = [...BRAND].length + [...label].length + 3 + [...CLOCK].length + 2 + 1;
    expect(need).toBe(71);
    expect(updateLabelFits(need, BRAND, label, CLOCK)).toBe(true);
    expect(updateLabelFits(need - 1, BRAND, label, CLOCK)).toBe(false);
  });
});

describe("fetchLatestVersion", () => {
  it("one plain GET of UPDATE_URL carrying no data", async () => {
    const f = fetchReturning(jsonRes({ name: "x", version: "1.6.0" }));
    await expect(fetchLatestVersion({ fetchImpl: f })).resolves.toBe("1.6.0");
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(UPDATE_URL);
    expect(String(url).startsWith("https://")).toBe(true);
    expect(init.method === undefined || init.method === "GET").toBe(true);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBeUndefined();
    for (const k of Object.keys(init)) expect(["method", "redirect", "signal"]).toContain(k);
  });

  it.each([404, 500])("status %d → null", async (status) => {
    const f = fetchReturning(jsonRes({ version: "9.9.9" }, status));
    await expect(fetchLatestVersion({ fetchImpl: f })).resolves.toBeNull();
  });

  it("ok false → null", async () => {
    const res = { ok: false, status: 200, headers: new Headers(), body: null } as unknown as Response;
    await expect(fetchLatestVersion({ fetchImpl: fetchReturning(res) })).resolves.toBeNull();
  });

  it("status 204 (ok but not 200) → null", async () => {
    const f = fetchReturning(new Response(null, { status: 204 }));
    await expect(fetchLatestVersion({ fetchImpl: f })).resolves.toBeNull();
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["JSON array", "[\"1.6.0\"]"],
    ["JSON null", "null"],
    ["JSON string", "\"1.6.0\""],
    ["missing version", JSON.stringify({ name: "x" })],
    ["prefixed version", JSON.stringify({ version: "v1.6.0" })],
    ["pre-release", JSON.stringify({ version: "1.6.0-rc.1" })],
    ["over-long", JSON.stringify({ version: "1." + "1".repeat(40) + ".0" })],
    ["numeric version", JSON.stringify({ version: 1.6 })],
  ])("%s → null", async (_name, body) => {
    const f = fetchReturning(new Response(body, { status: 200 }));
    await expect(fetchLatestVersion({ fetchImpl: f })).resolves.toBeNull();
  });

  it("streamed body over maxBytes → null (default 16 KiB cap)", async () => {
    const padded = "{" + " ".repeat(20 * 1024) + "\"version\":\"1.6.0\"}";
    // Streamed in chunks with no content-length so the streamed cap is exercised.
    const enc = new TextEncoder().encode(padded);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < enc.length; i += 4096) c.enqueue(enc.slice(i, i + 4096));
        c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const f = fetchReturning(new Response(stream, { status: 200 }));
    await expect(fetchLatestVersion({ fetchImpl: f })).resolves.toBeNull();
    expect(cancelled).toBe(true);
  });

  it("a padded body under the cap still parses", async () => {
    const body = "{" + " ".repeat(1024) + "\"version\":\"1.6.0\"}";
    const f = fetchReturning(new Response(body, { status: 200 }));
    await expect(fetchLatestVersion({ fetchImpl: f })).resolves.toBe("1.6.0");
  });

  it("declared content-length above maxBytes → null without reading", async () => {
    const getReader = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const res = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(MAX_BODY_BYTES + 1) }),
      body: { getReader, cancel },
    } as unknown as Response;
    await expect(fetchLatestVersion({ fetchImpl: fetchReturning(res) })).resolves.toBeNull();
    expect(getReader).not.toHaveBeenCalled();
  });

  it("missing body → null", async () => {
    const res = { ok: true, status: 200, headers: new Headers(), body: null } as unknown as Response;
    await expect(fetchLatestVersion({ fetchImpl: fetchReturning(res) })).resolves.toBeNull();
  });

  it("a fetchImpl that throws synchronously → null", async () => {
    const f = vi.fn(() => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    await expect(fetchLatestVersion({ fetchImpl: f })).resolves.toBeNull();
  });

  it("a fetchImpl that rejects → null", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchLatestVersion({ fetchImpl: f })).resolves.toBeNull();
  });

  it("a hung fetchImpl resolves null once its signal aborts (real timers)", async () => {
    const f = vi.fn(
      (_u: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;
    await expect(fetchLatestVersion({ fetchImpl: f, timeoutMs: 20 })).resolves.toBeNull();
  });

  it("no global fetch → null", async () => {
    vi.stubGlobal("fetch", undefined);
    await expect(fetchLatestVersion()).resolves.toBeNull();
    vi.stubGlobal("fetch", netSpy);
  });
});

describe("startUpdateCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const HOUR = 3_600_000;

  it.each([
    ["CSM_UPDATE_CHECK=0", { installed: "1.6.0", isTTY: true, env: { CSM_UPDATE_CHECK: "0" } }],
    ["non-TTY", { installed: "1.6.0", isTTY: false, env: {} }],
    ["unknown installed", { installed: null, isTTY: true, env: {} }],
  ])("disabled (%s): no fetch, no timers, no-op stop", async (_n, o) => {
    const f = fetchReturning(() => jsonRes({ version: "9.9.9" }));
    const onResult = vi.fn();
    const stop = startUpdateCheck({ ...o, fetchImpl: f, onResult });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(7 * HOUR);
    expect(f).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });

  it("enabled: first check after 0 ms, then every 6 h", async () => {
    const f = fetchReturning(() => jsonRes({ version: "9.9.9" }));
    const onResult = vi.fn();
    const stop = startUpdateCheck({ installed: "1.6.0", isTTY: true, env: {}, fetchImpl: f, onResult });
    expect(f).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenLastCalledWith("9.9.9");
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(f).toHaveBeenCalledTimes(3);
    stop();
  });

  it("remote equal or older → onResult(null)", async () => {
    for (const v of ["1.6.0", "1.5.9"]) {
      const f = fetchReturning(() => jsonRes({ version: v }));
      const onResult = vi.fn();
      const stop = startUpdateCheck({ installed: "1.6.0", isTTY: true, env: {}, fetchImpl: f, onResult });
      await vi.advanceTimersByTimeAsync(0);
      expect(onResult).toHaveBeenCalledTimes(1);
      expect(onResult).toHaveBeenCalledWith(null);
      stop();
    }
  });

  it("a failed check does not call onResult (keeps the last result)", async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      if (n === 1) return jsonRes({ version: "9.9.9" });
      throw new Error("offline");
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const onResult = vi.fn();
    const stop = startUpdateCheck({ installed: "1.6.0", isTTY: true, env: {}, fetchImpl: f, onResult });
    await vi.advanceTimersByTimeAsync(0);
    expect(onResult).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(f).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledTimes(1);
    stop();
  });

  it("checks never overlap: a hung fetch makes the next tick skip", async () => {
    // The injected fetch ignores its abort signal, so it stays in flight.
    const f = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const onResult = vi.fn();
    const stop = startUpdateCheck({ installed: "1.6.0", isTTY: true, env: {}, fetchImpl: f, onResult });
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(f).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
    stop();
  });

  it("after stop(): no further calls and a late resolve is ignored", async () => {
    let release: (r: Response) => void = () => {};
    const f = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const onResult = vi.fn();
    const stop = startUpdateCheck({ installed: "1.6.0", isTTY: true, env: {}, fetchImpl: f, onResult });
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    release(jsonRes({ version: "9.9.9" }));
    await vi.advanceTimersByTimeAsync(13 * HOUR);
    expect(f).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
  });

  it("stop() before the first tick prevents any call", async () => {
    const f = fetchReturning(() => jsonRes({ version: "9.9.9" }));
    const stop = startUpdateCheck({ installed: "1.6.0", isTTY: true, env: {}, fetchImpl: f, onResult: () => {} });
    stop();
    await vi.advanceTimersByTimeAsync(7 * HOUR);
    expect(f).not.toHaveBeenCalled();
  });

  it("both timer handles are unref'd", () => {
    vi.useRealTimers();
    const handles: Array<{ hasRef(): boolean }> = [];
    const realST = globalThis.setTimeout;
    const realSI = globalThis.setInterval;
    const st = vi.spyOn(globalThis, "setTimeout").mockImplementation(((...a: Parameters<typeof setTimeout>) => {
      const h = realST(...a) as unknown as { hasRef(): boolean };
      handles.push(h);
      return h;
    }) as typeof setTimeout);
    const si = vi.spyOn(globalThis, "setInterval").mockImplementation(((...a: Parameters<typeof setInterval>) => {
      const h = realSI(...a) as unknown as { hasRef(): boolean };
      handles.push(h);
      return h;
    }) as typeof setInterval);
    const f = fetchReturning(() => jsonRes({ version: "9.9.9" }));
    const stop = startUpdateCheck({ installed: "1.6.0", isTTY: true, env: {}, fetchImpl: f, onResult: () => {} });
    st.mockRestore();
    si.mockRestore();
    expect(handles.length).toBe(2);
    for (const h of handles) expect(h.hasRef()).toBe(false);
    stop();
    expect(f).not.toHaveBeenCalled();
  });

  it("honours a custom intervalMs", async () => {
    const f = fetchReturning(() => jsonRes({ version: "9.9.9" }));
    const stop = startUpdateCheck({
      installed: "1.6.0",
      isTTY: true,
      env: {},
      fetchImpl: f,
      intervalMs: 1000,
      onResult: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f).toHaveBeenCalledTimes(2);
    stop();
  });
});
