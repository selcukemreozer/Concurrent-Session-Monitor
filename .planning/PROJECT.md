# Concurrent Session Monitor

## What This Is

A Claude Code plugin that gives real-time visibility into multiple parallel Claude Code sessions. Hooks automatically record which files each session is touching, agents annotate what task they are doing, and both are merged into a shared state file. A live terminal panel then shows — across every running session — active files, current activity, conflict warnings, and per-session metadata (uptime, model, and best-effort token usage). It is built for a developer who runs several Claude Code sessions at once and keeps hitting file conflicts.

## Core Value

When multiple sessions run in parallel, every session and the human can see, in real time, **who is touching which files and what work is being done** — so overlapping edits are noticed before they collide.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

(None yet — ship to validate)

### Active

<!-- Current scope. Building toward these. -->

- [ ] Hooks automatically capture file touches (Edit/Write/MultiEdit, etc.) per session into a shared state file
- [ ] Agents write a short task/intent description ("what I'm working on") into the shared state file
- [ ] Shared state file tolerates concurrent writes from many sessions without corruption
- [ ] Live terminal panel shows active files per session (who is holding/editing what)
- [ ] Live terminal panel shows each session's current task/activity
- [ ] Live terminal panel shows conflict warnings when two sessions touch the same file
- [ ] Panel shows per-session uptime and which model each session is running
- [ ] Panel shows token consumption / remaining usage (best-effort — pending feasibility research)
- [ ] Delivered as an installable Claude Code plugin (hooks + slash commands integrated)

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- Active file locking / blocking — user explicitly chose monitor-and-warn only, to keep agent friction low
- Handoff / session-history view — deferred to a later version (not selected as a v1 panel priority)
- Remote / multi-machine session aggregation — v1 targets local sessions on one machine
- Persistent analytics / historical dashboards — v1 is a live view, not a reporting tool

## Context

- The user runs multiple Claude Code sessions in parallel (often across git worktrees/branches) and repeatedly hits file conflicts when two sessions edit the same file.
- Integration target is Claude Code's plugin system: hooks (PreToolUse/PostToolUse on file-editing tools), slash commands, and likely a bundled watcher/panel script.
- Claude Code hooks receive session id, tool name, tool input (file paths), cwd, and model information — the natural source for automatic file-touch capture.
- The "activity/intent" data comes from agents themselves (prompted via plugin guidance or a helper command), complementing the automatic file facts.
- Token-usage / remaining-usage availability is uncertain: the statusline JSON exposes model and cost/token fields, but "remaining usage" against rate limits is less certain. This must be confirmed during research before being promised.

## Constraints

- **Tech stack**: Must integrate as a Claude Code plugin (hooks + slash commands). Implementation language likely Node.js/TypeScript and/or shell, matching Claude Code's hook execution model — to be confirmed in research.
- **Platform**: macOS (darwin) is primary; the terminal panel must run in a standard terminal emulator.
- **Concurrency**: The shared state file must survive simultaneous writes from many sessions without corruption (atomic append and/or file locking).
- **Non-intrusive**: Capturing state must not block or noticeably slow agents' tool calls — monitoring is passive by design.

## Key Decisions

<!-- Decisions that constrain future work. Add throughout project lifecycle. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Monitor-and-warn, no blocking | Keep agent friction low; agents/human decide how to react to overlaps | — Pending |
| Capture via BOTH hooks and agent intent | Hooks are reliable for file facts; agent annotation adds the "why" | — Pending |
| Deliver as a Claude Code plugin | Tight integration, one-step install, hooks + commands ship together | — Pending |
| Panel is a separate long-running terminal process | It needs continuous refresh, outside any interactive session | — Pending |
| Token / usage display is best-effort | Data exposure via Claude Code is uncertain and must be verified | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-26 after initialization*
