import React from "react";
import { Box, Text } from "ink";
import { sanitize } from "../sanitize.js";
import { fmtUptime } from "../liveness.js";
import type { SessionRow } from "../aggregate.js";
import type { Conflict, ConflictSession } from "../conflicts.js";

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

/** Warning glyph leading each band line and the `↔` that joins the labels — both
 * printable code points >= 0x00A0, so `sanitize()` preserves them (ASVS V5). */
const WARN = "⚠";
const JOIN = " ↔ ";

/**
 * Max conflict lines the band renders before collapsing the remainder into a
 * single `+X more` summary (D-11, Claude's discretion = 5). Bounds the band's
 * height regardless of conflict count (T-03-03 render-cost cap).
 */
export const CONFLICT_CAP = 5;

/** Basename of a realpath WITHOUT opening it — the group key is a path string;
 * we only display its final segment (never the full realpath). */
function basename(rp: string): string {
  const parts = String(rp).split("/");
  return parts[parts.length - 1] || String(rp);
}

/**
 * One involved session rendered as `folder·branch·shortid` (D-10), reusing the
 * exact card convention: bold-less here but the same three parts, the same
 * empty-branch `—` dash fallback (Card.tsx:82), and the same first-8 shortId.
 * Every one of the three parts is passed through `sanitize()` before it reaches
 * the terminal (the established render-boundary rule; `osc8` is the sole
 * exemption and is NOT used by the band). T-03-01.
 */
function label(s: ConflictSession): string {
  const folder = sanitize(s.folder);
  const branch = sanitize(s.branch) || "—";
  const id = sanitize(String(s.session_id).slice(0, 8));
  return `${folder} · ${branch} · ${id}`;
}

/**
 * The always-on cross-session conflict band (PANEL-04, D-06/D-07/D-09/D-11).
 *
 * Renders one red `⚠` line per conflict — the shared file's basename followed by
 * every involved `folder·branch·shortid` label joined by ` ↔ ` — grouped by file
 * (D-09), most-recently-active first (the reducer already orders the array,
 * D-11). Past `CONFLICT_CAP` lines it appends a dim `+X more` summary so the
 * band's height stays bounded (T-03-03). It sits OUTSIDE the header box and
 * ABOVE the roster so it shows in BOTH card and compact modes (D-07,
 * mode-independent). When there are no conflicts it renders NOTHING (returns
 * `null`) — the empty state is the absence of a band, never a blank `⚠` line
 * (D-07). It is NOT a card: no `borderStyle`, just a column of `<Text>`.
 *
 * Every displayed segment — the basename and each label part — is passed through
 * `sanitize()` before Ink render; `⚠`/`↔`/`·` are all >= 0x00A0 so sanitize
 * preserves them while stripping any injected C0/C1 control bytes from a crafted
 * `file_path`/`folder`/`branch` (T-03-01, ASVS V5).
 */
export function ConflictBand({ conflicts }: { conflicts: Conflict[] }) {
  if (conflicts.length === 0) return null; // D-07: no empty band
  const shown = conflicts.slice(0, CONFLICT_CAP);
  const more = conflicts.length - shown.length;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {shown.map((c) => (
        <Text key={c.realpath} color="red">
          {`${WARN} ${sanitize(basename(c.realpath))}  ${c.sessions.map(label).join(JOIN)}`}
        </Text>
      ))}
      {more > 0 ? (
        <Text color="red" dimColor>{`  +${more} more`}</Text>
      ) : null}
    </Box>
  );
}
