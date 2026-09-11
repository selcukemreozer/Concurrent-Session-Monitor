---
description: Install the global `csm` command so you can launch the panel from any terminal
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csm-setup.mjs *)
---
<!-- Source: code.claude.com/docs/en/slash-commands (inject-dynamic-context, string substitutions) -->
<!--
  SC-1 launch-surface setup command (D-02: idempotent, non-clobbering symlink).
  The `!` line runs the setup helper at command-expansion time and inlines its
  stdout (link created / already set up / non-clobber warning + optional PATH
  guidance) into context. The command takes NO arguments — only the fixed,
  trusted ${CLAUDE_PLUGIN_ROOT}/scripts/csm-setup.mjs path is invoked.
  The substitution is double-quoted (RESEARCH Pitfall 1) to bound the shell
  surface even though there is no untrusted input; the helper itself does the
  TOCTOU-safe lstat/readlink before ever touching ~/.local/bin/csm. allowed-tools
  matches this exact command so no permission prompt fires. Panel launch is a
  bare `csm` in a separate terminal — there is intentionally no /csm-panel (D-03).
-->
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/csm-setup.mjs"`
