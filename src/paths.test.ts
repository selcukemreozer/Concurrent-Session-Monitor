import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// The D-01b store-location seam MUST resolve identically for every process —
// the capture hooks (writers) and the panel/reader (paths.ts). A regression
// (01-04 verification defect) let the hooks resolve `${CLAUDE_PLUGIN_DATA}/csm`
// while the standalone panel resolved `~/.claude/csm`, because CLAUDE_PLUGIN_DATA
// is set ONLY for plugin-hook processes Claude Code spawns — an
// env-visibility-asymmetric tier that silently split writer and reader.
//
// These tests pin the invariant: storeRoot() ignores CLAUDE_PLUGIN_DATA, and a
// capture hook + paths.ts agree on the same root under identical env.
import { storeRoot, sessionDir } from "./paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const onTool = path.join(repoRoot, "scripts", "on-tool.mjs");

// Save/restore every process.env key these tests mutate (mirrors the
// beforeEach/afterEach CSM_STORE_DIR discipline in store.test.ts, extended to
// CLAUDE_PLUGIN_DATA).
let savedStoreDir: string | undefined;
let savedPluginData: string | undefined;
let tmp: string;

beforeEach(() => {
  savedStoreDir = process.env.CSM_STORE_DIR;
  savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-paths-"));
});

afterEach(() => {
  if (savedStoreDir === undefined) delete process.env.CSM_STORE_DIR;
  else process.env.CSM_STORE_DIR = savedStoreDir;
  if (savedPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("storeRoot store-location seam (D-01b)", () => {
  it("ignores CLAUDE_PLUGIN_DATA: with CSM_STORE_DIR unset it resolves ~/.claude/csm", () => {
    // The exact regression: CLAUDE_PLUGIN_DATA is visible only to plugin-hook
    // processes, so honoring it split the writer's root from the reader's.
    delete process.env.CSM_STORE_DIR;
    process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, "plugin-data");

    expect(storeRoot()).toBe(path.join(os.homedir(), ".claude", "csm"));
  });

  it("CSM_STORE_DIR override still wins over everything (test isolation contract)", () => {
    process.env.CSM_STORE_DIR = tmp;
    process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, "plugin-data");

    expect(storeRoot()).toBe(tmp);
  });

  it("writer/reader agreement: a capture hook and paths.ts resolve the SAME root under identical env", () => {
    // Drive the real on-tool hook with CLAUDE_PLUGIN_DATA SET and CSM_STORE_DIR
    // bound to a throwaway mkdtemp (override wins), then assert paths.ts under
    // the identical env points the reader at exactly the file the writer wrote —
    // proving env parity without ever touching the real ~/.claude/csm.
    const pluginData = path.join(tmp, "plugin-data");
    const id = "agreement-sess";
    const hookEnv = { ...process.env, CSM_STORE_DIR: tmp, CLAUDE_PLUGIN_DATA: pluginData };

    const res = spawnSync(process.execPath, [onTool], {
      input: JSON.stringify({
        session_id: id,
        cwd: "/repo",
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "/repo/x.ts" },
      }),
      env: hookEnv,
      encoding: "utf8",
    });
    expect(res.status).toBe(0);

    // Reader side: same env the hook ran under.
    process.env.CSM_STORE_DIR = tmp;
    process.env.CLAUDE_PLUGIN_DATA = pluginData;

    const readerFile = path.join(sessionDir(id), "files.jsonl");
    expect(fs.existsSync(readerFile)).toBe(true);
    const evt = JSON.parse(fs.readFileSync(readerFile, "utf8").trim().split("\n")[0]);
    expect(evt.file_path).toBe("/repo/x.ts");
  });
});
