import type React from "react";
import { render } from "ink";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

/**
 * Shared Ink test harness (Phase 9, plan 09-02; RESEARCH Code Examples).
 *
 * TEST-ONLY. Nothing in the bundle graph (entry.ts / main.tsx) imports this
 * file; it is the one file besides main.tsx allowed to import `render` from
 * ink (dep-policy.test.ts RENDER_ALLOWLIST). Later plans use it for focus, `q`
 * and keys-off tests. Works on ink 7.1.1 and 8.x: Ink 8's isRawModeSupported
 * needs `stdin.isTTY === true` AND a `setRawMode` function, which
 * fakeTtyStdin provides.
 */

const ESC = String.fromCharCode(27);

/** Key strings Ink's keypress parser resolves to key.{tab, shift, escape, ...}. */
export const KEYS = {
  tab: "\t",
  shiftTab: ESC + "[Z",
  esc: ESC,
  enter: "\r",
  up: ESC + "[A",
  down: ESC + "[B",
  right: ESC + "[C",
  left: ESC + "[D",
  space: " ",
  ctrlC: String.fromCharCode(3),
  q: "q",
  r: "r",
} as const;

export interface RenderCaptureOptions {
  rows?: number;
  columns?: number;
  stdin?: NodeJS.ReadStream;
  exitOnCtrlC?: boolean;
}

/**
 * Render `el` into a captured sink of the given size. `debug: true` makes Ink
 * unthrottled and write one full frame per render, so the last non-newline
 * chunk is the current frame.
 */
export function renderCapture(el: React.ReactElement, opts: RenderCaptureOptions = {}) {
  const chunks: string[] = [];
  const out = new Writable({
    write(c, _e, cb) {
      chunks.push(c.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  (out as unknown as { columns: number }).columns = opts.columns ?? 80;
  (out as unknown as { rows: number }).rows = opts.rows ?? 24;
  const renderOpts: Parameters<typeof render>[1] = {
    stdout: out,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: opts.exitOnCtrlC ?? true,
  };
  if (opts.stdin) (renderOpts as { stdin?: NodeJS.ReadStream }).stdin = opts.stdin;
  const inst = render(el, renderOpts);
  const frames = (): string[] => chunks.filter((c) => c !== "\n");
  return {
    inst,
    lastFrame: (): string => {
      const f = frames();
      return f.length > 0 ? (f[f.length - 1] as string) : "";
    },
    frames,
    chunks,
  };
}

/** A stdin with `isTTY` unset: Ink reports isRawModeSupported false. */
export function nonTtyStdin(): NodeJS.ReadStream {
  return new PassThrough() as unknown as NodeJS.ReadStream;
}

/**
 * An in-memory fake TTY stdin: `isTTY = true`, a `setRawMode` that reports to
 * `onRaw`, and `ref`/`unref` returning the stream, so useInput engages raw mode
 * without a real terminal.
 */
export function fakeTtyStdin(onRaw?: (mode: boolean) => void): NodeJS.ReadStream {
  const s = new PassThrough() as unknown as NodeJS.ReadStream;
  const t = s as unknown as {
    isTTY: boolean;
    setRawMode: (m: boolean) => unknown;
    ref: () => unknown;
    unref: () => unknown;
  };
  t.isTTY = true;
  t.setRawMode = (m: boolean) => {
    onRaw?.(m);
    return s;
  };
  t.ref = () => s;
  t.unref = () => s;
  return s;
}

/** Write each key string into the stdin. */
export function press(stdin: NodeJS.ReadStream, ...keys: string[]): void {
  for (const k of keys) (stdin as unknown as { write: (s: string) => void }).write(k);
}

/** Split a frame into plain lines (VT sequences stripped, one trailing empty dropped). */
export function frameLines(frame: string): string[] {
  const lines = frame.split("\n").map((l) => stripVTControlCharacters(l));
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
