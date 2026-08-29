---
description: View the live cross-session roster and conflicts relevant to you
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csm-status.mjs *)
---
<!-- Source: code.claude.com/docs/en/slash-commands (inject-dynamic-context, string substitutions) -->
<!--
  INT-02 cross-session status query (D-04: plain text, read-only, never Ink).
  The `!` line runs the bundled reader at command-expansion time and inlines its
  stdout (a terse live roster + a "conflicts relevant to you" block) into context.
  Substitution resolves first:
    argv[2] = ${CLAUDE_SESSION_ID}  (caller session id — re-gated by SAFE_ID; marks (you))
  Only the session id is passed — the caller args placeholder is intentionally
  omitted (the command takes no arguments).
  The substitution is double-quoted (RESEARCH Pitfall 1): the reader owns all
  untrusted-field sanitizing; quoting bounds the shell surface. allowed-tools
  matches this exact command so no permission prompt fires. Model-invocable so an
  agent can check who is touching which files before editing.
-->
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/csm-status.mjs" "${CLAUDE_SESSION_ID}"`
