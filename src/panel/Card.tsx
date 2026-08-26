import React from "react";
import { Box, Text } from "ink";
import { sanitize } from "../sanitize.js";
import type { SessionRow } from "../aggregate.js";

// ESC (0x1B) and ST (ESC "\") as raw bytes, built without embedding control
// characters in source. These frame an OSC-8 hyperlink.
const ESC = String.fromCharCode(27);
const ST = ESC + "\\";

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
 * One bordered card per session (D-09), rendered by the panel most-recently
 * -active first. The header shows the folder (bold), then a dim segment with
 * the branch (or a dash when empty) and the first 8 chars of the session id
 * (D-05); a cyan clickable go-to-pane link appears only when Warp supplied a
 * focus_url (D-06). Below the header, each active file path is listed, or a
 * dim "(no active files)" hint when none are within the window.
 *
 * Every displayed string is passed through `sanitize()` before Ink render
 * (T-1-02). No Warp window/tab name is shown (D-07); no scrolling/overflow
 * handling is implemented here (D-10, Phase 2).
 */
export function SessionCard({ s }: { s: SessionRow }) {
  const shortId = String(s.session_id).slice(0, 8);
  const focusUrl = s.warp?.focus_url;
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} marginBottom={1}>
      <Box>
        <Text bold>{sanitize(s.folder)}</Text>
        <Text dimColor>
          {" · "}
          {sanitize(s.branch) || "—"}
          {" · "}
          {shortId}
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
