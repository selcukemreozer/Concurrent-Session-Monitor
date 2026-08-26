import * as fs from "node:fs";
import * as path from "node:path";
import type { TouchEvent } from "./schema.js";

// Secure permissions (threat T-1-03): the store lives under the per-user
// directory and must not be world-readable — edited paths/branches leak intent.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Atomically write `data` as JSON to `join(dir, name)`.
 *
 * Strategy (Pitfall 2 — torn read): write the payload to a uniquely-named temp
 * file in the SAME directory, then renameSync it over the target. rename(2) is
 * atomic on a single filesystem, so a concurrent reader either sees the old
 * file or the new file — never a partially written one.
 */
export function writeSnapshot(dir: string, name: string, data: unknown): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });

  const target = path.join(dir, name);
  const tmp = path.join(
    dir,
    `.${name}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );

  fs.writeFileSync(tmp, JSON.stringify(data), { mode: FILE_MODE });
  fs.renameSync(tmp, target);
}

/**
 * Append one TouchEvent as a newline-terminated JSON line to `files.jsonl`.
 *
 * Uses O_APPEND (appendFileSync's "a" flag). Because exactly one session ever
 * writes its own files.jsonl, there is no cross-writer interleave to reason
 * about even though macOS PIPE_BUF is only 512 bytes.
 */
export function appendTouch(dir: string, evt: TouchEvent): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  fs.appendFileSync(path.join(dir, "files.jsonl"), JSON.stringify(evt) + "\n", {
    mode: FILE_MODE,
  });
}
