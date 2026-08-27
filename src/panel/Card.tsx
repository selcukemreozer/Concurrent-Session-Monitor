import React from "react";
import { Box, Text } from "ink";
import { sanitize } from "../sanitize.js";
import { fmtUptime } from "../liveness.js";
import type { SessionRow } from "../aggregate.js";

// ESC (0x1B) and ST (ESC "\") as raw bytes, built without embedding control
// characters in source. These frame an OSC-8 hyperlink.
const ESC = String.fromCharCode(27);
const ST = ESC + "\\";

// Steady filled-circle liveness glyph (D-11): a plain colored character, NEVER
// a spinner/blink — the accessibility stance is a calm, non-animated cue.
const DOT = "●";

/**
 * Wrap a URL + label in an OSC-8 hyperlink escape so terminals like Warp render
 * a clickable go-to-pane affordance (D-06):  ESC ]8;; URL ST label ESC ]8;; ST.
 *
 * This helper intentionally emits raw control bytes and is the SOLE `sanitize()`
 * exemption — but its url/label inputs ARE sanitized first, so untrusted data
 * (a crafted focus_url) cannot inject extra control sequences (T-1-02).
 */
export function osc8(url: string, label: string): string {
  const u = sanitize(url);
  const l = sanitize(label);
  return `${ESC}]8;;${u}${ST}${l}${ESC}]8;;${ST}`;
}

/**
 * Pure map from the computed liveness state to a steady dot color (D-11/D-12).
 * active -> green, idle -> yellow, stale -> grey. No blink, no animation; the
 * compute layer (aggregate.ts) already folded the SC-4 phantom guard into
 * `dotState`, so this is presentation-only.
 */
export function dotColor(dotState: SessionRow["dotState"]): "green" | "yellow" | "grey" {
  switch (dotState) {
    case "active":
      return "green";
    case "idle":
      return "yellow";
    default:
      return "grey";
  }
}

/** Best-effort model label (D-09): "unknown"/empty collapse to an em-dash. */
function modelLabel(model: string): string {
  return sanitize(model && model !== "unknown" ? model : "—");
}

/** First 8 chars of the session id (D-05), sanitized (WR-04). */
function shortId(session_id: string): string {
  return sanitize(String(session_id).slice(0, 8));
}

/**
 * One bordered card per session (D-09), rendered by the panel most-recently
 * -active first. A steady 3-state liveness dot (green=active, yellow=idle,
 * grey=stale, NO blink — D-11/D-12) leads the header, followed by the folder
 * (bold), then a dim segment carrying the branch (or a dash when empty), the
 * first 8 chars of the session id (D-05), the best-effort model (D-09, "—" when
 * unknown), and compact uptime (D-10). A cyan clickable go-to-pane link appears
 * only when Warp supplied a focus_url (D-06). Below the header, each active file
 * path is listed, or a dim "(no active files)" hint when none are in the window.
 *
 * Every displayed string is passed through `sanitize()` before Ink render,
 * INCLUDING the shortId (T-02-30 / WR-04). `osc8()` is the sole exemption and
 * its inputs are pre-sanitized. No Warp window/tab name is shown (D-07).
 */
export function SessionCard({ s }: { s: SessionRow }) {
  const focusUrl = s.warp?.focus_url;
  const uptime = sanitize(fmtUptime(Date.parse(s.start_time), Date.now()));
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} marginBottom={1}>
      <Box>
        <Text color={dotColor(s.dotState)}>{DOT + " "}</Text>
        <Text bold>{sanitize(s.folder)}</Text>
        <Text dimColor>
          {" · "}
          {sanitize(s.branch) || "—"}
          {" · "}
          {shortId(s.session_id)}
          {" · "}
          {modelLabel(s.model)}
          {" · "}
          {uptime}
        </Text>
        {focusUrl ? (
          <Text color="cyan">{" · " + osc8(focusUrl, "↪ go to pane")}</Text>
        ) : null}
      </Box>
      {s.files.length === 0 ? (
        <Text dimColor>{"  (no active files)"}</Text>
      ) : (
        s.files.map((f) => <Text key={f.file_path}>{"  " + sanitize(f.file_path)}</Text>)
      )}
    </Box>
  );
}

/**
 * A single-line session row for the height-driven overflow mode (D-13):
 * `folder · branch · short-id · ● · model · uptime · Nf` where N is the active
 * -file count. Rendered as one flat `<Text>` (the dot is a nested colored
 * `<Text>`) so it never wraps to a second visual line. Every field passes
 * through `sanitize()` (T-02-30); the dot uses the same steady `dotColor` map.
 */
export function CompactRow({ s }: { s: SessionRow }) {
  const uptime = sanitize(fmtUptime(Date.parse(s.start_time), Date.now()));
  return (
    <Text>
      {sanitize(s.folder)}
      {" · "}
      {sanitize(s.branch) || "—"}
      {" · "}
      {shortId(s.session_id)}
      {" · "}
      <Text color={dotColor(s.dotState)}>{DOT}</Text>
      {" · "}
      {modelLabel(s.model)}
      {" · "}
      {uptime}
      {" · "}
      {String(s.files.length) + "f"}
    </Text>
  );
}
