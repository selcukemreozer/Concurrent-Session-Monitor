# Changelog

Notable changes to Concurrent Session Monitor, newest release first.

## v1.7.0 (2026-10-20)

### New (preview)

- `CSM_UI=v2` opens the new panel shell. It has the new layout with sample data
  in the panes, a live header (agent count, asking / waiting / conflict chips,
  clock, update notice) and one focus model:
  - Tab / Shift+Tab move focus (AGENTS → PHASES/SESSIONS → PORTS);
  - Esc returns to AGENTS;
  - `r` toggles PHASES/SESSIONS;
  - space pauses the file list;
  - `q` quits.
- On a non-TTY the v2 shell shows `⌨ keys off — started without a TTY`.
- If the v2 shell crashes, it restores the terminal and prints one line
  pointing to `crash.log` in the store directory (mode 0600, rotated past
  256 KB).

### Changes

- The panel now runs on Ink 8 and React 19.3.
- The default panel (`csm` without `CSM_UI=v2`) is unchanged: same look, same
  keys. No key binding of the default panel changes in this release.
- The crash handler applies to the v2 shell only; the default panel gets it
  when v2 becomes the default (2.0.0).

### Notes

- After updating, run `/plugin update` and then `/csm-setup` so the global
  `csm` command points at 1.7.0.
- If a panel is ever killed with SIGKILL, run `reset` to restore the terminal.
- Known issue in the `CSM_UI=v2` preview: resizing the window (for example,
  toggling Warp's tab sidebar) can leave repeated header rows at the top; this
  is fixed when the new layout becomes the default in 2.0.0.

## v1.6.2 (2026-10-17)

### Security

- `/csm-goto` and the session card's go-to-pane link now accept only a Warp
  session focus URL (`warp://session/<32 lowercase hex>`, or the Warp Preview
  and Warp OSS equivalents). Before, any `warp:` URL was accepted, including
  `warp://launch/…`, which opens a Warp launch configuration that can run
  commands.
- The SessionStart hook and the panel's own registration store a Warp focus URL
  only when it passes the same check.

## v1.6.1 (2026-10-14)

### Improvements

- The copied resume line uses the session's `/rename` name when it is unique in
  its project folder; otherwise the session id.
- The copied resume line adds `--dangerously-skip-permissions` when the session
  ran in bypass-permissions mode (Claude Code does not restore that mode on
  resume), with a warning.

## v1.6.0 (2026-10-14)

### New

- **Native session names.** Names set with `/rename` or `claude -n` now show in
  the panel, in `/csm-status` and in the conflict advisory.
- **Session resume picker.** `/csm-resume` lists recent sessions, crashed ones
  too, each with a ready-to-paste `cd … && claude --resume <id>` line. In the
  panel, `r` opens the sessions pane, Enter copies the line, and `o` opens it in
  a new Terminal, iTerm2 or Warp window.
- **Ports pane grouped as Warp / other.** A port's process can be stopped from
  the panel, with a confirmation step.
- **Update notice.** The panel shows `⬆ vX.Y.Z available` when a newer version
  is published on GitHub.

### Improvements

- An idle session counts as waiting after 1 s (was 10 s).
- "asking" stays until you answer, and "waiting" shows for up to 60 min (was 30).
- Idle session cards shrink to a single header line.
- The panel removes Warp tab files left behind by a crashed panel.
- A clear message when a session folder name is unsafe to open.
- "· live" in the sessions pane is pale green.
- Packaging fixes: a reinstall hint when the panel bundle is missing, a clean
  one-time shutdown, and plugin and package versions kept in lockstep.
