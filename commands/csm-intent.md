---
description: Record what this session is working on
argument-hint: "[task description]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csm-intent.mjs *)
---
<!-- Source: code.claude.com/docs/en/slash-commands (inject-dynamic-context, string substitutions) -->
<!--
  INT-01 declare-intent command (D-02: explicit only, never prompt-derived).
  The `!` line runs the bundled writer at command-expansion time and inlines its
  stdout as a confirmation into context. Substitutions resolve first:
    argv[1] = ${CLAUDE_SESSION_ID}  (session id — re-gated by SAFE_ID in the script)
    argv[2] = $ARGUMENTS            (the intent text — sanitized as untrusted in the script)
  Both are double-quoted (RESEARCH Pitfall 1): the script owns the untrusted-text
  sanitizing; quoting bounds the shell surface (attacker == victim, low severity).
  allowed-tools matches this exact command so no permission prompt fires.
-->
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/csm-intent.mjs" "${CLAUDE_SESSION_ID}" "$ARGUMENTS"`
