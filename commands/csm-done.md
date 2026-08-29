---
description: Mark this session done with its current task — clears the intent and releases its held files
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csm-done.mjs *)
---
<!-- Source: code.claude.com/docs/en/slash-commands (inject-dynamic-context, string substitutions) -->
<!--
  INT-01 done-gesture command (D-03): one gesture clears this session's intent
  AND releases the write files it is currently holding. It does NOT end the
  session — session.json is untouched; the panel task line falls back to the
  D-11 recent-file/idle indicator.
  The `!` line runs the bundled writer at command-expansion time and inlines its
  stdout as a confirmation into context. The only substitution resolves to:
    argv[1] = ${CLAUDE_SESSION_ID}  (session id — re-gated by SAFE_ID in the script)
  No positional args: /csm-done takes no arguments. The substitution is double-quoted
  to bound the shell surface; allowed-tools matches this exact command so no
  permission prompt fires.
-->
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/csm-done.mjs" "${CLAUDE_SESSION_ID}"`
