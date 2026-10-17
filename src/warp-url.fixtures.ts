// Shared accept/reject table for the strict Warp session focus-URL rule
// (261017-sbh, D-04). Pure data: every copy of the rule (src/warp-url.ts, the
// stdlib copies in scripts/csm-goto.mjs and scripts/on-session-start.mjs) is run
// against this one table by src/warp-url.test.ts, src/warp-url.parity.test.ts
// and scripts/csm-goto.test.ts.

export const HEX32 = "0123456789abcdef0123456789abcdef";

export interface WarpUrlFixture {
  name: string;
  value: unknown;
  ok: boolean;
  /** The value survives JSON.stringify into panel.json unchanged. */
  json: boolean;
  /** A string with no NUL byte, so it can be passed as an environment variable. */
  env: boolean;
}

const ESC = String.fromCharCode(0x1b);
const VALID = "warp://session/" + HEX32;
const H16A = HEX32.slice(0, 16);
const H16B = HEX32.slice(16);

function accept(name: string, value: string): WarpUrlFixture {
  return { name, value, ok: true, json: true, env: true };
}

function reject(
  name: string,
  value: unknown,
  json = true,
  env = true,
): WarpUrlFixture {
  return { name, value, ok: false, json, env };
}

export const WARP_URL_FIXTURES: readonly WarpUrlFixture[] = [
  accept("warp stable session", VALID),
  accept("warp preview session", "warppreview://session/" + HEX32),
  accept("warp oss session", "warposs://session/" + HEX32),

  reject("launch configuration", "warp://launch/x.yaml"),
  reject("action new_tab", "warp://action/new_tab?path=/tmp"),
  reject("file url", "file:///etc/passwd"),
  reject("https url", "https://example.com"),
  reject("uppercase hex", "warp://session/" + HEX32.toUpperCase()),
  reject("31 hex chars", "warp://session/" + HEX32.slice(0, 31)),
  reject("33 hex chars", "warp://session/" + HEX32 + "a"),
  reject("trailing slash", VALID + "/"),
  reject("query string", VALID + "?q=1"),
  reject("fragment", VALID + "#frag"),
  reject("leading space", " " + VALID),
  reject("trailing space", VALID + " "),
  reject("trailing newline", VALID + "\n"),
  reject("embedded newline", "warp://session/" + H16A + "\n" + H16B),
  reject("trailing ESC sequence", VALID + ESC + "[31m"),
  reject("embedded ESC", "warp://session/" + H16A + ESC + H16B),
  reject("trailing NUL", VALID + "\u0000", true, false),
  reject("empty string", ""),
  reject("no double slash", "warp:session/" + HEX32),
  reject("uppercase scheme", "WARP://session/" + HEX32),
  reject("prefixed scheme", "xwarposs://session/" + HEX32),

  reject("undefined", undefined, true, false),
  reject("null", null, true, false),
  reject("number", 42, true, false),
  reject("boolean", true, true, false),
  reject("empty object", {}, true, false),
  reject("array holding a valid url", [VALID], true, false),
  reject("object with toString", { toString: () => VALID }, false, false),
];
