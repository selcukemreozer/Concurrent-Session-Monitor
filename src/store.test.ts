import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// RED: these modules do not exist yet. paths.ts + store.ts land in wave 01-02.
// The imports use explicit .js specifiers so the TS ESM build resolves them.
import { sessionDir, sessionsDir, safeId } from "./paths.js";
import { writeSnapshot } from "./store.js";
import type { SessionState } from "./schema.js";

// Every test binds CSM_STORE_DIR to a throwaway mkdtemp directory so the suite
// never reads or writes the real ~/.claude/csm store (T-1-03 isolation).
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-store-"));
  process.env.CSM_STORE_DIR = tmp;
});

afterEach(() => {
  delete process.env.CSM_STORE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeState(id: string): SessionState {
  return {
    schema_version: 1,
    session_id: id,
    folder: "demo",
    branch: "main",
    model: "unknown",
    start_time: new Date().toISOString(),
  } as SessionState;
}

describe("writeSnapshot", () => {
  it("atomic: a reader loop never observes a partial/torn file", async () => {
    const dir = sessionDir("atomic-session");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "session.json");

    let torn = 0;
    let reads = 0;
    let stop = false;

    // Reader spins concurrently while the writer rewrites the snapshot many times.
    const reader = (async () => {
      while (!stop) {
        try {
          const raw = fs.readFileSync(target, "utf8");
          reads++;
          JSON.parse(raw); // a torn write would throw here
        } catch (err: unknown) {
          // ENOENT (rename gap) is fine; a JSON SyntaxError means a torn read.
          if (err instanceof SyntaxError) torn++;
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    for (let i = 0; i < 200; i++) {
      writeSnapshot(dir, "session.json", { ...makeState("atomic-session"), seq: i });
      // Yield to the event loop so the concurrent reader actually observes each
      // freshly-renamed snapshot. Without a yield the writer loop is one
      // uninterruptible synchronous burst and the reader gets zero turns while
      // stop is false — i.e. it never reads a written file at all, which would
      // make the torn===0 atomicity check vacuous. Yielding exercises the real
      // temp+rename atomicity guarantee under concurrent reads.
      await new Promise((r) => setImmediate(r));
    }
    stop = true;
    await reader;

    expect(torn).toBe(0);
    expect(reads).toBeGreaterThan(0);
  });

  it("concurrent: N parallel writers to distinct session dirs all parse", async () => {
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const id = `session-${i}`;
        const dir = sessionDir(id);
        fs.mkdirSync(dir, { recursive: true });
        return Promise.resolve(writeSnapshot(dir, "session.json", makeState(id)));
      }),
    );

    const entries = fs.readdirSync(sessionsDir());
    expect(entries.length).toBe(N);
    for (const entry of entries) {
      const raw = fs.readFileSync(path.join(sessionsDir(), entry, "session.json"), "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });

  it("traversal: safeId rejects a crafted session_id used as a dir name (T-1-01)", () => {
    // A path-traversal session_id must never escape the sessions root.
    expect(safeId("../../etc/passwd")).not.toContain("..");
    expect(safeId("../../etc/passwd")).not.toContain("/");
    const dir = sessionDir("../../evil");
    expect(dir.startsWith(sessionsDir())).toBe(true);
  });
});
