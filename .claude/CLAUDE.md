<!-- GSD:project-start source:PROJECT.md -->

## Project

**Concurrent Session Monitor**

A Claude Code plugin that gives real-time visibility into multiple parallel Claude Code sessions. Hooks automatically record which files each session is touching, agents annotate what task they are doing, and both are merged into a shared state file. A live terminal panel then shows — across every running session — active files, current activity, conflict warnings, and per-session metadata (uptime, model, and best-effort token usage). It is built for a developer who runs several Claude Code sessions at once and keeps hitting file conflicts.

**Core Value:** When multiple sessions run in parallel, every session and the human can see, in real time, **who is touching which files and what work is being done** — so overlapping edits are noticed before they collide.

### Constraints

- **Tech stack**: Must integrate as a Claude Code plugin (hooks + slash commands). Implementation language likely Node.js/TypeScript and/or shell, matching Claude Code's hook execution model — to be confirmed in research.
- **Platform**: macOS (darwin) is primary; the terminal panel must run in a standard terminal emulator.
- **Concurrency**: The shared state file must survive simultaneous writes from many sessions without corruption (atomic append and/or file locking).
- **Non-intrusive**: Capturing state must not block or noticeably slow agents' tool calls — monitoring is passive by design.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## Headline finding (resolves the open feasibility question)

- **Hooks do NOT expose model or token data.** The hook stdin payload has `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, and tool fields — but no tokens, no cost, and no reliable `model` (only `SessionStart` *may* include `model`, explicitly "not guaranteed"; there is no `$CLAUDE_MODEL` env var).
- **The `statusLine` command DOES expose all of it.** Its stdin JSON includes `model.id`/`model.display_name`, `cost.total_cost_usd`, `cost.total_duration_ms` (session uptime), full `context_window.*` token counts, and — critically — `rate_limits.five_hour.{used_percentage,resets_at}` and `rate_limits.seven_day.{used_percentage,resets_at}`, which is exactly the "remaining usage against quota" the project wanted.
- `rate_limits.*` is present **only for Claude.ai Pro/Max subscribers**, and only **after the first API response** in a session. API-key/Console users won't have it. → mark quota display "best-effort" exactly as PROJECT.md already does.
- A plugin's bundled `settings.json` supports **only** the `agent` and `subagentStatusLine` keys — **it cannot set the main `statusLine`**. The plugin must ship a **setup slash-command** that writes the `statusLine` entry into the user's `~/.claude/settings.json` (and must **wrap/chain any pre-existing statusline** rather than clobber it).

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Node.js** | **22 LTS+** (verified: v25 present locally) | Runtime for panel, statusline emitter, and hook scripts | Claude Code itself is Node/Ink; Claude Code auto-installs plugin Node deps (`npm ci`/`bun install`) and runs lifecycle scripts, so Node tooling is a safe assumption inside the CC ecosystem. One language for all three processes. |
| **TypeScript** | **5.6+** | Static types for the multi-file panel + shared state schema | The shared-state record shape (session_id, files[], tokens, model, rate_limits) is the core contract between 3 processes; types prevent drift. Compile with `tsc` or run via `tsx`. |
| **Ink** | **7.1.1** (npm `latest`, requires **Node ≥22**, ESM-only) | The live terminal panel (React component model for CLIs) | De-facto standard for rich, continuously-redrawing terminal UIs. Battle-tested by **Claude Code itself**, Gemini CLI, GitHub Copilot CLI, Shopify CLI, Wrangler, Prisma. Flexbox layout (Yoga), color, `<Static>`, alternate-screen buffer, focus/input — everything a multi-panel live dashboard needs. |
| **Claude Code hooks** | CC ≥ 2.1.x | Automatic file-touch capture | `PreToolUse`/`PostToolUse` with `matcher: "Edit|Write|MultiEdit"`; `tool_input.file_path` is the touched file. Reliable, zero-token, non-blocking. |
| **Claude Code statusLine** | CC ≥ 2.1.153 (for `COLUMNS`/`LINES`); ≥2.1.205 for subagent model | Per-session token/model/cost/quota heartbeat | The ONLY tap that carries tokens + `rate_limits` + `model`. Runs on session start, every assistant message, and on a `refreshInterval` timer. Does not consume API tokens. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **ink** ecosystem: `ink-spinner`, `ink-table`, `ink-text-input` | current | Prebuilt panel widgets (spinners, tabular session list, filter box) | Only pull the ones a given panel row actually needs — keep the dependency surface small. |
| **chokidar** | **5.0.0** | Cross-platform file watching in the panel to react to state changes instantly | Use to watch the shared-state directory (`sessions/*/`) instead of busy-polling; falls back gracefully on APFS. Optional — a `setInterval` poll of ~500ms–1s is a valid simpler alternative for a local single-user tool. |
| **jq** | 1.6+ (**ships with macOS 14+**, present at `/usr/bin/jq`) | Zero-runtime JSON extraction in a shell fallback for the hook/statusline | Use if you want the file-touch hook to be a dependency-free shell one-liner instead of a Node process (lowest latency). Claude Code's own docs assume jq for statusline scripts. |
| **proper-lockfile** | **4.1.2** | Advisory lock **only if** you ever consolidate to a single shared writer file | The recommended design shards state per-session (one writer per file) so **no lock is needed**. Keep this on the bench as a fallback, NOT the default. |
| **date-fns** | 4.x | Human-friendly uptime / "resets in 42m" formatting from `total_duration_ms` and `resets_at` epochs | Panel formatting only. Optional (Intl.RelativeTimeFormat covers most needs with zero deps). |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| **tsx** | Run TS directly for the panel/scripts without a build step | Great for dev; for distribution, precompile or bundle so end users never need TS. |
| **esbuild / tsup** | Bundle each entrypoint (panel, statusline, hook) into a single zero-dep-at-runtime JS file | Ship self-contained files under the plugin so you don't rely on `node_modules` resolution at hook time. Put any unavoidable `node_modules` under `${CLAUDE_PLUGIN_DATA}` (survives plugin updates). |
| **claude --plugin-dir ./plugin** + **/reload-plugins** | Local plugin dev + hot reload | Primary test loop. `claude plugin validate ./plugin` before publishing. |
| **claude --debug** | Surface hook match/exit-code/stderr and statusline errors | Essential for debugging silent hook/statusline failures. |

## Plugin packaging (how this ships)

- **`${CLAUDE_PLUGIN_ROOT}`** = absolute path to the plugin install dir. Reference bundled scripts in `hooks.json` as `"\"${CLAUDE_PLUGIN_ROOT}\"/scripts/hook.mjs"` (quote to survive spaces).
- **`${CLAUDE_PLUGIN_DATA}`** = persistent dir surviving updates — put `node_modules`/caches here.
- **`bin/`** executables are on the Bash `PATH` while enabled, callable as bare commands. A single `csm` multi-command binary keeps hooks.json/commands terse.
- Hook config schema in `hooks/hooks.json` is identical to `settings.json`: `{ "hooks": { "PostToolUse": [ { "matcher": "Write|Edit|MultiEdit", "hooks": [ { "type": "command", "command": "…" } ] } ] } }`.
- Distribute via a marketplace (`marketplace.json`); community marketplace is `anthropics/claude-plugins-community`.

## Concurrency-safe shared state (the make-or-break design)

- **Snapshot files (`heartbeat.json`, `intent.txt`): write-to-temp + atomic `rename()`** onto the same filesystem. `rename(2)` is atomic; readers never see a torn file. Single writer, so no lock.
- **Event log (`files.jsonl`): append-only, one small JSON object per line, `O_APPEND`.** Because only that session writes its own `files.jsonl`, there is no multi-writer contention to reason about.
- **Conflict detection happens on the READ side.** The panel reduces across all `sessions/*/files.jsonl` (+ recent window) and flags any `file_path` currently claimed by ≥2 live sessions. This keeps the write path trivial and lock-free — exactly matching the "non-intrusive / monitor-and-warn" constraint.
- **Liveness/cleanup:** `SessionEnd` hook removes the session dir; the panel also treats a `heartbeat.json` with a stale mtime (no update in N minutes) as inactive. `SessionStart` can create/reset the dir.
- No lock contention, no corruption window, no reader/writer coordination.
- A crashed session can't hold a lock or leave a half-written shared file.
- Naturally parallel: N sessions = N independent writers, zero coupling.

## Language & runtime guidance for each process

| Process | Recommended | Rationale | Latency budget |
|---------|-------------|-----------|----------------|
| **Panel** | Node + TypeScript + Ink 7 | Long-running, rich redraw, React model | N/A (long-lived) |
| **statusLine emitter** | Small **Node** script, zero deps (stdlib only), OR shell+`jq` | Must stay fast (300ms debounce; in-flight runs get cancelled). Piggybacks heartbeat write onto its normal "print a status line" job. | Keep < ~150ms |
| **File-touch hook** | shell + `jq` one-liner **or** tiny Node script; append one JSONL line | "Non-intrusive" constraint. `jq` is fastest (no runtime boot); Node is fine and more structured. Set the hook `async` where the event allows so the tool call doesn't wait. | Keep < ~100ms |

- `jq` present at `/usr/bin/jq` (macOS 14+). ✅
- `python3` present (3.14). ✅ (viable alternative — see variants)
- Node present (v25 via Homebrew); Claude Code manages plugin npm installs. ✅
- POSIX `rename`, `O_APPEND` available. ✅

## Installation

# Panel + emitter (Node/TS/Ink)

# Optional supporting

# jq is preinstalled on macOS 14+; no install needed for the shell-fallback hook

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Node + Ink 7 panel | **Python + Textual (5.x) / Rich** | Choose if the team is Python-first. Textual is an excellent full-screen TUI framework and `fcntl.flock` gives real advisory locking on macOS. Trade-off: leaves the Node/Claude-Code ecosystem and adds a second language/runtime for a plugin whose host is Node. |
| Node + Ink 7 panel | **Go + Bubble Tea** | Choose if you want a single static binary with no runtime deps and the fastest possible hook. Trade-off: heavier build toolchain, further from the CC ecosystem, more code for JSON plumbing. |
| Per-session file sharding (no lock) | **Single shared JSONL + advisory lock** | Only if you must have one canonical append log. Then lock via `proper-lockfile`/`fcntl`, keep lines small, and accept crash-safety complexity. |
| statusLine as token/quota source | **Parsing `transcript_path` JSONL** | The transcript path is in every hook payload and contains per-message usage; you *could* parse it for tokens. But it's undocumented-shape, heavier, and gives no `rate_limits`. Use statusLine. |
| chokidar watching | **`setInterval` polling (500ms–1s)** | Perfectly adequate for a local single-user tool; drop chokidar entirely to cut a dependency. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **The `flock` CLI for locking** | **Not present on macOS** (it's a Linux util-linux tool — verified absent on this machine). A hook/script calling `flock` fails silently on the primary target platform. | Per-session file sharding (no lock) as the default; if a lock is unavoidable, `proper-lockfile` (Node) or `fcntl.flock` (Python). |
| **Reading model/tokens from hook payloads** | Hooks carry no tokens and no reliable `model`; `$CLAUDE_MODEL` does not exist. Building token display on hooks is a dead end. | Get model/tokens/quota from the **statusLine** stdin JSON. |
| **Setting the main `statusLine` from the plugin's `settings.json`** | Plugin `settings.json` honors **only** `agent` + `subagentStatusLine`. The main statusLine can't be shipped that way. | Ship a **setup slash-command** that writes (and chains any existing) `statusLine` into the user's `~/.claude/settings.json`. |
| **Overwriting the user's existing statusline** | Many users already run ccstatusline/starship-claude; clobbering it is hostile. | The setup command should **wrap** the existing command (invoke it, capture stdout, re-print it) while side-writing the heartbeat. |
| **blessed / neo-blessed** | Effectively unmaintained; imperative API; poor fit next to a React/Ink codebase. | Ink 7. |
| **A single shared `state.json` rewritten by every session** | Guaranteed torn-read / lost-update window under many concurrent writers; the exact corruption PROJECT.md warns about. | Per-session sharded files + atomic temp-rename. |
| **Assuming `PIPE_BUF`-sized atomic appends to a shared file** | `PIPE_BUF` is **512 on macOS** (verified) and governs pipes, not shared-file write atomicity across writers. Don't lean on it. | One-writer-per-file sharding removes the question entirely. |
| **Blocking/slow hooks or a slow statusLine** | Violates the "non-intrusive" constraint; a slow statusLine gets cancelled mid-run and the row goes blank. | Keep hook < ~100ms, statusLine < ~150ms; `async` hooks where possible. |

## Stack Patterns by Variant

- `rate_limits.five_hour` / `seven_day` are populated → render true remaining-quota bars + reset countdowns.
- Because it only appears after the first API response, show "—" until the first heartbeat arrives.
- `rate_limits.*` is absent → fall back to `cost.total_cost_usd` + `context_window.used_percentage` only; hide the quota row.
- Implement the file-touch hook as a shell one-liner: `jq -r '.tool_input.file_path' >> "$dir/files.jsonl"` wrapped to add session_id + timestamp. macOS ships `jq`.
- Panel: Textual 5.x + Rich; hook/emitter: `python3` stdlib (`json`, `os.replace` for atomic rename, `fcntl.flock` if ever needed). Everything above still holds; only the panel/emitter language changes.
- Drop chokidar; the panel polls `sessions/*/` every 500ms–1s. For a local single-user tool this is imperceptible and removes a dep.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| ink@7.1.1 | Node ≥ 22, React 18/19 | **ESM-only** (`"type":"module"`) — use `.mjs`/ESM TS output, not CommonJS `require`. |
| chokidar@5.0.0 | Node ≥ 20 | v5 dropped older Node; fine on 22+. |
| statusLine `COLUMNS`/`LINES` env | Claude Code ≥ 2.1.153 | Needed to size panel-adjacent output; older CC won't set them. |
| statusLine `rate_limits.*` | Claude Code recent + Pro/Max plan | Absent for API-key users; guard with `// empty` (jq) or optional chaining. |
| statusLine subagent `model`/`contextWindowSize` | Claude Code ≥ 2.1.205 | Only relevant if you also render subagent rows via `subagentStatusLine`. |
| hook `prompt_id` | Claude Code ≥ 2.1.196 | Optional correlation id; don't hard-depend. |

## Sources

- `code.claude.com/docs/en/hooks` — hook stdin payload fields, event list, `Edit|Write|MultiEdit` matching, `tool_input.file_path`, no-model/no-token confirmation, settings.json hook schema. **HIGH** (official docs).
- `code.claude.com/docs/en/plugins` + `.../plugins-reference` — plugin layout, `plugin.json`, `hooks/hooks.json`, `bin/`, `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}`, settings.json only-`agent`+`subagentStatusLine`, marketplaces, `--plugin-dir`/`/reload-plugins`. **HIGH** (official docs).
- `code.claude.com/docs/en/statusline` — full statusLine stdin JSON schema incl. `context_window.*`, `cost.*`, `rate_limits.*`, `model.*`, update triggers, `refreshInterval`, `COLUMNS`/`LINES`, session_id-keyed cache pattern. **HIGH** (official docs) — resolves the token/quota feasibility question.
- npm registry (live) — ink@7.1.1 (engines node ≥22, ESM), chokidar@5.0.0, proper-lockfile@4.1.2. **HIGH**.
- Local macOS verification — `flock` absent, `jq` at `/usr/bin/jq`, `python3` 3.14, node v25, `getconf PIPE_BUF /` = 512. **HIGH**.
- Ink readme — adopters (Claude Code, Gemini CLI, Copilot CLI, Shopify CLI, Wrangler, Prisma), Yoga/flexbox feature set. **HIGH**.

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
