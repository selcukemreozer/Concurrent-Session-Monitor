# Changelog

Notable changes to Concurrent Session Monitor, newest release first.

## v2.0.0 (2026-10-29)

This is a major version because several keys change and break muscle memory.
Read the key list below before you update.

### New

- The new panel is the default: plain `csm` opens it.
  - AGENTS: a card grid, one card per active session (asking, waiting,
    running or subagent) with its folder, branch, uptime, model and last
    prompt, plus selectable 2-row idle strips.
  - Selecting a card or strip opens a detail strip (intent, branch, owned
    ports, uptime, model and the full last prompt) and narrows FILES to that
    session (`FILES · N · esc: all`). A selection drops after 15 s without a
    key.
  - PHASES, SESSIONS and PORTS show live data.
  - Go-to: Enter on a selected card or idle strip brings that session's Warp
    pane to the front and the footer shows `focusing <name>`. When it cannot,
    the footer gives one plain reason (for example `pane not findable`). tmux,
    GNU screen and other multiplexers, IDE terminals and non-Warp apps are
    never focused.
  - The panel redraws as one clean frame on every resize (sidebar toggle,
    edge drag, height change). No repeated `◆ CSM` header or leftover borders
    remain.
  - At 100–164 columns PHASES/SESSIONS and PORTS sit side by side under
    FILES.

### Changed keys and behavior

- `Tab` / `Shift+Tab` now move focus between panes (AGENTS → PHASES/SESSIONS
  → PORTS). They no longer switch the PHASES project.
- PHASES project cycling moved from `Tab` to `←` / `→` while PHASES is
  focused. `↑` / `↓` move through the phases.
- `q` quits. `Ctrl+C` still quits too.
- `Enter` on a selected agent card or idle strip goes to its Warp pane.
  `Enter` in SESSIONS still copies the resume line and `o` still opens it
  (shown as `copied ✓` / `✓ opened`).
- `Esc` clears the agent selection (and the FILES narrowing), or returns
  focus to AGENTS from another pane.
- `PgUp` / `PgDn` are kept. They page the focused list (the AGENTS grid by
  card rows, PHASES, SESSIONS, PORTS); they have no footer hint.
- `↑` / `↓` in PORTS browse by port; the cursor follows the port, not the
  row, and drops when that port goes away.
- The clickable OSC-8 `↪ go to pane` link on cards is removed. Go-to is
  `Enter` only.
- The card grid order is stable: cards keep session start order, so a
  re-sort or a `/compact` never moves the card under the cursor. Attention
  shows through color and the header chips, not through position.
- A scrolled list always says what is hidden: `↑ N more` / `↓ N more`, or one
  `↑ N more · ↓ N more` row when the grid has no room for both.
- The footer shows only keys that work in this release; hints for port
  actions that arrive later are hidden.
- The crash handler now covers the default panel: a crash restores the
  terminal, prints one `csm crashed:` line and writes the stack to
  `crash.log` in the store directory.

### Legacy

- `CSM_UI=legacy csm` opens the previous panel, with its old keys, for this
  release only. 2.1.0 removes it. Any other `CSM_UI` value (including `v2`)
  opens the new panel.
- In the previous panel, `r` (show SESSIONS) followed by `Enter` in the same
  key burst is now ignored until the pane has drawn, so `Enter` never acts on
  a hidden pane.

### Notes

- After updating, run `/plugin update` and then `/csm-setup` so the global
  `csm` command (a version-pinned link) points at 2.0.0.

## v1.8.0 (2026-10-28)

### New (candidate, CSM_UI=v2)

- Every pane of the `CSM_UI=v2` panel now shows live data; the ` sample `
  chips are gone.
  - AGENTS: one card per active session (asking, waiting, running or
    subagent) with its folder, branch, uptime, model (`opus 4.7`) and last
    prompt, plus 2-row idle strips. Cards keep their start order, so a
    re-sort or a `/compact` never moves the card under the cursor.
  - Arrow keys select a card or an idle strip; a selection drops after 15 s
    without a key, and Esc clears it.
  - The selection opens a detail strip (intent, branch, the ports it owns,
    uptime, model and the full last prompt) between the grid and FILES.
  - FILES lists conflicts first, then each session's writes and reads. With a
    selection it narrows to that session (`FILES · N · esc: all`).
  - Enter on a selected card or strip goes to that session's Warp pane. The
    footer shows `focusing <name>`, or one plain reason when it cannot. tmux,
    screen and other multiplexers, IDE terminals and non-Warp apps are never
    focused.
  - PHASES shows your GSD projects; `←`/`→` cycle projects, `↑`/`↓` move
    through the phases.
  - SESSIONS lists resumable sessions: Enter copies the resume line, `o` opens
    it in a new window.
  - PORTS lists listening ports with their owning session; `↑`/`↓` browse
    them by port.
  - PgUp/PgDn page through the grid and every list.
- At 100–164 columns PHASES/SESSIONS and PORTS sit side by side under FILES.
- The panel redraws cleanly on every resize, so no repeated header rows are
  left at the top (the 1.7.0 known issue).

### Changes

- The default panel (`csm` without `CSM_UI=v2`) is unchanged: same look, same
  keys.
- Fixes from the 1.7.0 review, in the v2 panel:
  - a focused PORTS or PHASES pane always shows its content;
  - FILES says `+N more conflicts` when it cannot draw every conflict;
  - unfocused PORTS shows exposed ports first;
  - no pane hides cards, ports or phases without a `↑/↓ N more` row;
  - `crash.log` entries are size-bounded and the file stays at mode 0600.

### Notes

- After updating, run `/plugin update` and then `/csm-setup` so the global
  `csm` command points at 1.8.0.
- v2 becomes the default panel in 2.0.0; `CSM_UI=legacy` will keep the old
  panel for one release after that.

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
