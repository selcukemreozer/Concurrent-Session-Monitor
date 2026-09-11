#!/usr/bin/env node
// /csm-setup — install a global `csm` command on the user's PATH (D-02).
//
// Self-contained ESM using only Node stdlib: it symlinks the plugin's panel
// launcher (${CLAUDE_PLUGIN_ROOT}/bin/csm.mjs) to ~/.local/bin/csm so the user
// can run the live panel as a bare `csm` from any separate terminal (SC-1/SC-2).
// Invoked from commands/csm-setup.md as:  node csm-setup.mjs   (takes NO args).
//
// TOCTOU-safe, non-clobbering symlink contract (threat T-05-01, ASVS V12):
//   - lstat/readlink the target BEFORE acting — never `ln -sf`, never an
//     unconditional unlink.
//   - target ABSENT            -> create the symlink.
//   - target is the CORRECT    -> idempotent no-op ("already set up").
//     symlink already
//   - target is a real file or -> DO NOT overwrite; print an actionable warning
//     a foreign symlink            telling the user to remove it manually.
// It acts only on the two fixed, trusted paths (${CLAUDE_PLUGIN_ROOT}/bin/csm.mjs
// and ~/.local/bin/csm) and takes no untrusted arguments.
//
// Unlike the passive capture hooks this command surfaces actionable stdout, but
// it still ALWAYS exits 0 on the create / idempotent-skip / non-clobber-abort
// paths so it never leaks a failing status into the slash-command surface.
//
// The launcher file stays bin/csm.mjs (05-RESEARCH open-question #2); the
// user-facing global command is the extensionless ~/.local/bin/csm symlink.
import {
  mkdirSync,
  existsSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function main() {
  const home = os.homedir();
  const localBin = path.join(home, ".local", "bin");
  const target = path.join(localBin, "csm");

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) {
    console.error(
      "csm: CLAUDE_PLUGIN_ROOT is not set — run /csm-setup from inside Claude Code so the plugin path resolves.",
    );
    return;
  }
  const launcher = path.join(pluginRoot, "bin", "csm.mjs");

  // Don't create a dangling link if the launcher is missing (bad plugin root).
  if (!existsSync(launcher)) {
    console.error(
      `csm: plugin launcher not found at ${launcher} — is the plugin installed correctly? Nothing was changed.`,
    );
    return;
  }

  // ~/.local/bin must exist for the symlink; safe to create unconditionally.
  mkdirSync(localBin, { recursive: true });

  // TOCTOU-safe inspection: lstat does NOT follow the link, so we see the target
  // itself (symlink vs real file) before deciding — we never blindly write.
  let existing;
  try {
    existing = lstatSync(target);
  } catch {
    existing = null; // ENOENT -> target absent
  }

  if (existing === null) {
    // ABSENT: create the symlink.
    symlinkSync(launcher, target);
    console.log(`csm: linked ${target} -> ${launcher}`);
    console.log("Now run `csm` in a separate terminal.");
  } else if (existing.isSymbolicLink() && readlinkSync(target) === launcher) {
    // CORRECT symlink already present: idempotent no-op.
    console.log(
      `csm: already set up — ${target} already points at the plugin launcher.`,
    );
  } else {
    // FOREIGN real file or foreign symlink: never clobber. Warn and abort.
    const kind = existing.isSymbolicLink()
      ? `a symlink to ${readlinkSync(target)}`
      : "a real file";
    console.error(
      `csm: WARNING — ${target} already exists (${kind}) and is not the plugin symlink.`,
    );
    console.error(
      `csm: refusing to overwrite it. Remove it manually (rm "${target}") and re-run /csm-setup.`,
    );
    return;
  }

  // PATH guidance (fallback — ~/.local/bin is on PATH on most macOS setups).
  const pathEntries = (process.env.PATH || "").split(path.delimiter);
  if (!pathEntries.includes(localBin)) {
    console.log(
      `csm: note — ${localBin} is not on your PATH. Add this to ~/.zshrc, then open a new terminal:`,
    );
    console.log('  export PATH="$HOME/.local/bin:$PATH"');
  }
}

try {
  main();
} catch (err) {
  // Never leak a failing status into the slash-command surface.
  console.error(`csm: setup could not complete — ${err?.message ?? err}`);
}

process.exit(0);
