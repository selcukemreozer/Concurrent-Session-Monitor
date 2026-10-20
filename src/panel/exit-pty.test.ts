import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Plan 09-14: PTY end-to-end tests for the exit and crash lifecycle (KEYS-04;
// Phase 9 SC3: "after `q`, Ctrl+C and a forced crash, the terminal's cursor,
// raw mode and screen are back to normal"). Each case runs a real program under
// a real pseudo-terminal (/usr/bin/script), records every byte it wrote, and
// asserts on those bytes:
//   (a) v2 `q`        -> exit 0, alt screen left (CSI ?1049l) and cursor shown
//                        (CSI ?25h) after the last frame, panel.json removed;
//   (b) v2 Ctrl+C     -> the same;
//   (c) legacy `q`    -> ignored (legacy does not gain q, D-23); Ctrl+C exits 0;
//   (d-f) crash fixture in modes timer / reject / render -> the alt-screen exit
//                        comes BEFORE the one `csm crashed:` line, exit 1,
//                        crash.log holds the stack, no raw stack on the
//                        primary screen (D-25).
//
// darwin only: BSD script(1) is the harness, so the file is skipped where it is
// absent. PTY timing can flake under heavy load (spawn + splash); re-run this
// file alone before calling a failure a regression.
//
// Stdin plumbing: BSD script(1) calls tcgetattr/ioctl on its stdin and aborts
// on anything but ENOTTY. Node's piped stdio is a socketpair on macOS, and a
// Darwin FIFO is socket-backed too, so both fail with EOPNOTSUPP. bash process
// substitution gives script a REAL pipe(2) fed by `cat` from our piped stdin;
// `exec` makes script the spawned process, so its exit is the child's exit.
//
// The crash fixture is a TEST-ONLY bundle built at runtime from the string
// below (esbuild JS API, written to a temp dir). It is never a source file, so
// the single-render-site invariant (dep-policy scans non-test src only, and
// launcher.test pins main.tsx as the one render site) stays intact.
//
// Every store write (panel.json, crash.log) goes to a temp CSM_STORE_DIR.

const ESC = String.fromCharCode(27);
const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;
const CURSOR_ON = `${ESC}[?25h`;
const CTRL_C = String.fromCharCode(3);

const SCRIPT = "/usr/bin/script";
const BASH = "/bin/bash";
const CAN_PTY = process.platform === "darwin" && existsSync(SCRIPT) && existsSync(BASH);

const PANEL_DIR = fileURLToPath(new URL(".", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../../dist/panel.mjs", import.meta.url));
const RDC_STUB = fileURLToPath(new URL("../../scripts/rdc-stub.mjs", import.meta.url));

// KEEP IN SYNC with BANNER in scripts/build.mjs (not imported: that script
// builds dist/panel.mjs on import).
const BANNER =
  "#!/usr/bin/env node\n" +
  'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);';

const TEST_TIMEOUT = 30_000;
const WAIT_TIMEOUT = 10_000;

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    c.stdin?.destroy();
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

interface Step {
  /** Wait until this text is in the transcript (WAIT_TIMEOUT) before acting. */
  waitFor?: string;
  /** Then wait this long. */
  delayMs?: number;
  /** Then write these bytes to the PTY. */
  keys?: string;
}

interface PtyResult {
  code: number | null;
  transcript: string;
  /** Per step: was the program still running right before its keys were written? */
  aliveBeforeKeys: boolean[];
  stderr: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readTranscript(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Run `node ...argv` under /usr/bin/script, play `steps`, and resolve with the
 * exit code and the full transcript once the program exits (or reject after
 * WAIT_TIMEOUT on a step marker / on the final exit).
 */
async function runInPty(
  argv: string[],
  env: NodeJS.ProcessEnv,
  steps: Step[],
  cwd: string,
): Promise<PtyResult> {
  const transcriptFile = join(cwd, "transcript.txt");
  const child = spawn(
    BASH,
    [
      "-c",
      'exec /usr/bin/script -q -F "$@" < <(exec /bin/cat)',
      "bash",
      transcriptFile,
      process.execPath,
      ...argv,
    ],
    { cwd, env, stdio: ["pipe", "ignore", "pipe"] },
  );
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  let exited = false;
  const exit = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      exited = true;
      child.stdin?.end(); // lets the feeding `cat` see EOF and exit
      resolve(code);
    });
  });

  const aliveBeforeKeys: boolean[] = [];
  for (const step of steps) {
    if (step.waitFor !== undefined) {
      const deadline = Date.now() + WAIT_TIMEOUT;
      while (!readTranscript(transcriptFile).includes(step.waitFor)) {
        if (exited || Date.now() > deadline) {
          throw new Error(
            `marker ${JSON.stringify(step.waitFor)} never appeared (exited=${exited}); ` +
              `stderr: ${stderr}; transcript tail: ${JSON.stringify(readTranscript(transcriptFile).slice(-400))}`,
          );
        }
        await sleep(50);
      }
    }
    if (step.delayMs !== undefined) await sleep(step.delayMs);
    aliveBeforeKeys.push(!exited);
    if (step.keys !== undefined && !exited) child.stdin?.write(step.keys);
  }

  const code = await Promise.race([
    exit,
    sleep(WAIT_TIMEOUT).then(() => {
      throw new Error(`program did not exit; stderr: ${stderr}`);
    }),
  ]);
  return { code, transcript: readTranscript(transcriptFile), aliveBeforeKeys, stderr };
}

/** A copy of the shipped bundle in a node_modules-free temp dir, plus a store dir. */
function bundleRun(): { runDir: string; storeDir: string; copy: string } {
  const runDir = tempDir("csm-pty-run-");
  const storeDir = tempDir("csm-pty-store-");
  const copy = join(runDir, "panel.mjs");
  copyFileSync(BUNDLE, copy);
  return { runDir, storeDir, copy };
}

function panelEnv(storeDir: string, v2: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CSM_STORE_DIR: storeDir,
    CSM_UPDATE_CHECK: "0",
    TERM: "xterm-256color",
  };
  delete env.CSM_UI;
  if (v2) env.CSM_UI = "v2";
  return env;
}

/** The clean-exit restore contract on the recorded bytes. */
function expectRestored(transcript: string, lastFrameMarker: string): void {
  const on = transcript.indexOf(ALT_ON);
  const off = transcript.lastIndexOf(ALT_OFF);
  expect(on, "never entered the alt screen").toBeGreaterThan(-1);
  expect(off, "never left the alt screen").toBeGreaterThan(on);
  expect(off, "a frame was drawn after the alt-screen exit").toBeGreaterThan(
    transcript.lastIndexOf(lastFrameMarker),
  );
  expect(transcript.indexOf(CURSOR_ON, off), "cursor not shown after the alt-screen exit").toBeGreaterThan(off);
}

// ---------------------------------------------------------------------------
// The crash fixture: mounts a small Ink tree in the alt screen, wires the crash
// handler exactly as entry.ts does, then crashes 300 ms later in the mode named
// by argv[2]. Built at runtime only (see header).
const FIXTURE_SRC = `
import * as fs from "node:fs";
import { useEffect, useState } from "react";
import { render, Text } from "ink";
import {
  appendCrashLog,
  crashLogDisplayPath,
  createCrashHandler,
  installCrashHandlers,
  restoreTerminal,
} from "./crash.js";

const mode = process.argv[2];
let inst;
const onCrash = createCrashHandler({
  restore: () => restoreTerminal(inst),
  writeErr: (line) => {
    fs.writeSync(2, line);
  },
  appendLog: (entry) => appendCrashLog(entry),
  exit: (code) => process.exit(code),
  displayLogPath: crashLogDisplayPath(),
  now: () => new Date(),
});
installCrashHandlers(onCrash);

function Bomb({ go }) {
  if (go) throw new Error("boom-render");
  return <Text>FIXTURE READY</Text>;
}

function App() {
  const [go, setGo] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (mode === "render") setGo(true);
      else if (mode === "timer") throw new Error("boom-timer");
      else if (mode === "reject") void Promise.reject(new Error("boom-reject"));
    }, 300);
    return () => clearTimeout(t);
  }, []);
  return <Bomb go={go} />;
}

inst = render(<App />, { alternateScreen: true });
try {
  await inst.waitUntilExit();
} catch (err) {
  onCrash(err);
}
`;

async function buildFixture(outDir: string): Promise<string> {
  const outfile = join(outDir, "fixture.mjs");
  await build({
    stdin: { contents: FIXTURE_SRC, resolveDir: PANEL_DIR, loader: "tsx", sourcefile: "crash-fixture.tsx" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    alias: { "react-devtools-core": RDC_STUB },
    banner: { js: BANNER },
    jsx: "automatic",
    define: { __CSM_VERSION__: JSON.stringify("0.0.0") },
    logLevel: "silent",
  });
  return outfile;
}

describe.skipIf(!CAN_PTY)("panel exit + crash lifecycle in a real PTY (09-14, KEYS-04)", () => {
  it(
    "(a) v2: q exits 0, leaves the alt screen, shows the cursor and removes panel.json",
    async () => {
      const { runDir, storeDir, copy } = bundleRun();
      const r = await runInPty([copy], panelEnv(storeDir, true), [{ waitFor: "AGENTS", keys: "q" }], runDir);
      expect(r.code, r.stderr).toBe(0);
      expectRestored(r.transcript, "AGENTS");
      expect(existsSync(join(storeDir, "panel.json")), "panel.json survived q").toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "(b) v2: Ctrl+C exits 0, leaves the alt screen, shows the cursor and removes panel.json",
    async () => {
      const { runDir, storeDir, copy } = bundleRun();
      const r = await runInPty([copy], panelEnv(storeDir, true), [{ waitFor: "AGENTS", keys: CTRL_C }], runDir);
      expect(r.code, r.stderr).toBe(0);
      expectRestored(r.transcript, "AGENTS");
      expect(existsSync(join(storeDir, "panel.json")), "panel.json survived Ctrl+C").toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "(c) legacy: q is ignored (D-23), then Ctrl+C exits 0 with the terminal restored",
    async () => {
      const { runDir, storeDir, copy } = bundleRun();
      const r = await runInPty(
        [copy],
        panelEnv(storeDir, false),
        [
          { waitFor: "Concurrent Session Monitor", keys: "q" },
          { delayMs: 800, keys: CTRL_C },
        ],
        runDir,
      );
      expect(r.aliveBeforeKeys[1], "legacy panel exited on q").toBe(true);
      expect(r.code, r.stderr).toBe(0);
      expectRestored(r.transcript, "Concurrent Session Monitor");
      expect(existsSync(join(storeDir, "panel.json")), "panel.json survived Ctrl+C").toBe(false);
    },
    TEST_TIMEOUT,
  );

  for (const mode of ["timer", "reject", "render"] as const) {
    it(
      `(crash ${mode}) restores the screen before the one csm crashed: line, logs the stack, exits 1`,
      async () => {
        const runDir = tempDir("csm-pty-fx-");
        const storeDir = tempDir("csm-pty-fx-store-");
        const fixture = await buildFixture(runDir);
        const r = await runInPty(
          [fixture, mode],
          panelEnv(storeDir, true),
          [{ waitFor: "FIXTURE READY" }],
          runDir,
        );
        const t = r.transcript;
        expect(r.code, r.stderr).toBe(1);

        const crashAt = t.indexOf("csm crashed:");
        expect(crashAt, `no crash line; tail: ${JSON.stringify(t.slice(-400))}`).toBeGreaterThan(-1);
        expect(t.split("csm crashed:").length - 1, "exactly one crash line").toBe(1);
        const off = t.indexOf(ALT_OFF);
        expect(off, "never left the alt screen").toBeGreaterThan(-1);
        expect(off, "the crash line came before the alt-screen exit").toBeLessThan(crashAt);
        expect(t.lastIndexOf(ALT_OFF), "re-entered/left the alt screen after the crash line").toBeLessThan(crashAt);
        expect(t.slice(crashAt)).toContain(`boom-${mode}`);
        expect(t.slice(crashAt)).toContain("crash.log");

        // No raw stack on the primary screen.
        const primary = t.slice(t.lastIndexOf(ALT_OFF));
        expect(primary).not.toMatch(/^\s+at /m);

        const log = join(storeDir, "crash.log");
        expect(existsSync(log), "crash.log was not written").toBe(true);
        expect(readFileSync(log, "utf8")).toContain(`boom-${mode}`);
      },
      TEST_TIMEOUT,
    );
  }
});
