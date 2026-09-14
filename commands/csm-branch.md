---
description: Declare the git branch this session intends to work on
argument-hint: "[branch name]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csm-branch.mjs *)
---
<!-- Source: code.claude.com/docs/en/slash-commands (inject-dynamic-context, string substitutions) -->
<!--
  TB-01 declare-target-branch command (D-BR-01: dedicated target-branch.txt shard).
  The `!` line runs the bundled writer at command-expansion time and inlines its
  stdout as a confirmation into context. Substitutions resolve first:
    argv[1] = ${CLAUDE_SESSION_ID}  (session id — re-gated by SAFE_ID in the script)
    argv[2] = $ARGUMENTS            (the branch name — sanitized as untrusted in the script)
  Both are double-quoted (RESEARCH Pitfall 1): the script owns the untrusted-text
  sanitizing; quoting bounds the shell surface (attacker == victim, low severity).
  allowed-tools matches this exact command so no permission prompt fires.
  No registration in plugin.json/hooks.json is required (D-BR-06): commands
  auto-discover from commands/.
-->
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/csm-branch.mjs" "${CLAUDE_SESSION_ID}" "$ARGUMENTS"`
