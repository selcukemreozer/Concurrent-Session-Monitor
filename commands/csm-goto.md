---
description: Bring a live session's Warp pane to the front (Warp-only, focus-only)
argument-hint: "[folder | session-id]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csm-goto.mjs *)
---
<!-- Source: code.claude.com/docs/en/slash-commands (inject-dynamic-context, string substitutions) -->
<!--
  /csm-goto — the in-chat counterpart of the panel's clickable go-to-pane link.
  The `!` line runs the read-only script at command-expansion time and inlines
  its stdout into context. Substitutions resolve first:
    argv[1] = ${CLAUDE_SESSION_ID}  (caller id — re-gated by SAFE_ID; marks "(you)")
    argv[2] = $ARGUMENTS            (folder name or session id — sanitized as untrusted)
  Both are double-quoted: the script owns the untrusted-text handling; quoting
  bounds the shell surface. The script opens the session's warp.focus_url via
  macOS `open` (execFileSync, no shell). WARP-ONLY: sessions outside Warp have no
  focus handle and are reported as such. FOCUS-ONLY: nothing is typed or sent
  into the target session. With no argument it lists live sessions.
  No registration in plugin.json/hooks.json is required: commands auto-discover
  from commands/.
-->
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/csm-goto.mjs" "${CLAUDE_SESSION_ID}" "$ARGUMENTS"`
