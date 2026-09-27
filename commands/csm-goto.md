---
description: Bring the terminal running the CSM panel (csm) to the front — exact pane in Warp, app-level elsewhere
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csm-goto.mjs *)
---
<!-- Source: code.claude.com/docs/en/slash-commands (inject-dynamic-context, string substitutions) -->
<!--
  /csm-goto — jump back to the CSM panel from any chat (260927-59z).
  The command takes NO arguments: the `!` line runs the read-only script at
  command-expansion time with no argv and inlines its stdout into context. The
  script reads panel.json, which the panel writes at the store root when it
  starts (and removes on a clean exit). In Warp it opens the panel's recorded
  warp: focus URL, bringing the exact pane forward; in Terminal, iTerm2,
  Ghostty or VS Code it can only activate the app (not the exact window or
  tab); in any other terminal it reports the panel's pid/tty instead. With no
  live panel it says so. FOCUS-ONLY: nothing is typed or sent anywhere. There
  is no argument substitution — only the fixed, trusted script path is
  invoked, double-quoted to bound the shell surface. No registration in
  plugin.json/hooks.json is required: commands auto-discover from commands/.
-->
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/csm-goto.mjs"`
