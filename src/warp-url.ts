// Strict Warp session focus-URL rule (261017-sbh, D-01/D-02).
//
// Threat: Warp registers several URL forms under its schemes. `warp://session/
// <id>` only focuses an existing pane, but `warp://launch/<path>` opens a launch
// configuration, which can run commands, and `warp://action/…` opens tabs or
// paths. The focus URL comes from a same-user-writable store (panel.json,
// sessions/*/session.json) and from an inherited $WARP_FOCUS_URL, so it must be
// checked before it is opened or turned into a clickable link.
//
// The rule accepts only a full-string match of a session URL on one of the three
// Warp channels: Stable (`warp:`), Preview (`warppreview:`) and OSS
// (`warposs:`), with exactly 32 lowercase hex characters. No query, fragment or
// trailing slash. No flags: `g` would make .test() stateful through lastIndex,
// `i` would admit uppercase, and `m` would let a newline split the match. No
// length cap is needed: the anchored pattern matches at most 54 characters and
// fails in linear time.
//
// scripts/csm-goto.mjs and scripts/on-session-start.mjs are stdlib-only and may
// not import from src/ (T-1-SC), so each carries a byte-identical copy of the
// literal below, pinned by src/warp-url.parity.test.ts. Any edit must touch all
// three copies.

export const WARP_SESSION_URL_RE = /^(warp|warppreview|warposs):\/\/session\/[0-9a-f]{32}$/;

/** True only for a string that fully matches the strict Warp session rule. */
export function isWarpSessionUrl(raw: unknown): raw is string {
  return typeof raw === "string" && WARP_SESSION_URL_RE.test(raw);
}
