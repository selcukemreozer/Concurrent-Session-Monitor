<p align="center">
  <img src="assets/logo.png" alt="Concurrent Session Monitor logo" width="200">
</p>

<h1 align="center">Concurrent Session Monitor</h1>

<p align="center"><em>The watch never sleeps.</em></p>

<p align="center">
  <img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-2f5d3f?style=flat-square">
  <img alt="platform: macOS" src="https://img.shields.io/badge/platform-macOS-2f5d3f?style=flat-square">
  <img alt="node &gt;= 22" src="https://img.shields.io/badge/node-%3E%3D22-2f5d3f?style=flat-square">
  <img alt="version 1.0.1" src="https://img.shields.io/badge/version-1.0.1-2f5d3f?style=flat-square">
  <img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-2f5d3f?style=flat-square">
</p>

A Claude Code plugin that gives you real-time visibility into multiple parallel
Claude Code sessions. Hooks silently record which files each session is touching,
slash commands let a session annotate what it is working on, and a live terminal
panel shows, across every running session, active files, current activity,
conflict warnings, and per-session metadata (uptime, model, port and GSD-phase
context). Built for a developer who runs several sessions at once and keeps
hitting file conflicts: when sessions run in parallel, everyone can see **who is
touching which files and what work is being done**, so overlapping edits are
noticed before they collide.

## Highlights

- **Live file map**: every file each session is touching, updated within about a second, with no manual refresh.
- **Conflict warnings**: the instant two sessions claim the same file, the panel flags it, before the edits collide.
- **Session context**: per-session uptime, model, current intent, listening ports, and GSD-phase progress at a glance.
- **Zero-config and non-intrusive**: capture hooks are async and never slow your tools; there is nothing to configure.

## Install

Install directly from the git repository in two steps, run inside Claude Code:

1. Add this repo as a plugin marketplace:

   ```
   /plugin marketplace add https://github.com/selcukemreozer/Concurrent-Session-Monitor
   ```

2. Install the plugin. Use the **qualified** name; `@concurrent-session-monitor`
   names the marketplace and disambiguates the install:

   ```
   /plugin install concurrent-session-monitor@concurrent-session-monitor
   ```

That's it. No build step. The panel ships as a committed, self-contained bundle,
and the file-touch hooks start capturing automatically once the plugin is enabled.

## Enable the global `csm` command

Run this once inside Claude Code:

```
/csm-setup
```

It symlinks a global `csm` command into `~/.local/bin` (idempotent and
non-clobbering: it never overwrites an existing file or a symlink it did not
create). If `~/.local/bin` is not on your `PATH`, the command tells you exactly
what line to add to your shell profile.

## Launch the panel

Open a **separate terminal** (not the one running Claude Code) and run the bare
command:

```
csm
```

This opens a live, full-screen panel that redraws as sessions come and go. Press
`Ctrl+C` to exit cleanly; it restores your terminal and leaves no residue.

Keep the panel running in its own terminal while you work in one or more Claude
Code sessions elsewhere.

## Slash commands

Use these from inside any Claude Code session:

- `/csm-intent <task>`: record what this session is working on (shows up on the
  session's row in the panel and in `/csm-status`).
- `/csm-done`: mark the current task done, which clears this session's intent and
  releases the files it was holding. It does **not** end the session.
- `/csm-status`: print the live cross-session roster plus any conflicts relevant
  to you, as plain text, right in the conversation.

## Configuration

Everything works with zero configuration. For tuning, the panel and hooks read
these environment variables. Each is optional; an unset or invalid value falls
back to the default. Times are in milliseconds.

| Variable | Default | Meaning |
|----------|---------|---------|
| `CSM_STORE_DIR` | `~/.claude/csm` | Root directory for the per-session state shards. Override to relocate the shared store (writers and the panel must agree). |
| `CSM_WINDOW_MS` | `300000` (5 min) | Rolling window for a session's "active files": files touched within this window count as currently held. |
| `CSM_READ_WINDOW_MS` | `30000` (30 s) | Shorter window for read activity; reads decay ~10x faster than writes. |
| `CSM_SKILL_WINDOW_MS` | `300000` (5 min) | Window for the most-recently-invoked skill shown on a session row. |
| `CSM_STALE_MS` | `120000` (2 min) | Liveness TTL: a session with no heartbeat for this long is treated as inactive. |
| `CSM_ACTIVE_MS` | `30000` (30 s) | Recency threshold for the green/yellow activity dot. |
| `CSM_GRACE_MS` | `1200` (1.2 s) | Grace window: a vanished session is shown dim-grey as "ended" for this long before it is pruned, so you see it die rather than blink out. |
| `CSM_CONFLICT_MS` | tracks `CSM_WINDOW_MS` | Conflict-detection window. Not independently wired in v1; the effective window equals the active-file window (`CSM_WINDOW_MS`). |
| `CSM_PORT_SCAN_MS` | `2500` (2.5 s) | Cadence of the listening-port scan feeding the PORTS pane. |
| `CSM_PHASE_SCAN_MS` | `4000` (4 s) | Cadence of the GSD phase-progress scan feeding the FAZLAR pane. |
| `CSM_GSD_TOOLS` | auto-detected | Absolute path to the `gsd-tools` binary used by the phases pane. Set it to override auto-detection. |

## Platform and caveats

- **macOS is the primary, supported platform.** The panel expects a standard
  terminal emulator. Other Unix-likes may work but are not the target.
- **The model shown per session is best-effort.** It comes from the Claude Code
  `SessionStart` hook, which may not always include the model; when it is
  unavailable the panel simply omits it.
- **Live token usage and rate-limit/quota display are not in v1.** Those depend on
  the `statusLine` data source and are deferred to a future (v2) release. The
  panel focuses on file/activity visibility and conflict detection today.
