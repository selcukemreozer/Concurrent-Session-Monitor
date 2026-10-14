# Changelog

Notable changes to Concurrent Session Monitor, newest release first.

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
