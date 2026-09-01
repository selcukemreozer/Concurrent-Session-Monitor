import React from "react";
import { Box, Text } from "ink";
import { sanitize } from "../sanitize.js";
import { fmtUptime } from "../liveness.js";
import type { SessionRow } from "../aggregate.js";
import type { Conflict, ConflictSession } from "../conflicts.js";
import { livePidMap, attribute, type ScannedPort } from "../ports.js";

// ESC (0x1B) and ST (ESC "\") as raw bytes, built without embedding control
// characters in source. These frame an OSC-8 hyperlink.
const ESC = String.fromCharCode(27);
const ST = ESC + "\\";

// Steady filled-circle liveness glyph (D-11): a plain colored character, NEVER
// a spinner/blink — the accessibility stance is a calm, non-animated cue.
const DOT = "●";

/**
 * Read-line leading glyph (PANEL-06 D-08): a hollow diamond `◇` (U+25C7). It is
 * >= 0x00A0 so `sanitize()` preserves it, and it is visually distinct from the
 * liveness `●`, the conflict `⚠`, the swap `↔`, the filled `◆`, and the link
 * `↪` — a read must be unmistakable from a write at a glance.
 */
const READ_GLYPH = "◇";

/**
 * Ink color name for read lines (PANEL-06 D-09): `blue` — deliberately NOT red
 * (conflicts), NOT green/yellow/grey (liveness dots), and NOT cyan (osc8 links +
 * header border). This keeps reads non-colliding with every existing colored cue.
 */
const READ_COLOR = "blue";

/**
 * Leading marker for the card's intent line (PANEL-02 D-10): `»` (U+00BB). It is
 * >= 0x00A0 so `sanitize()` preserves it, and it deliberately avoids every
 * reserved cue — NOT red (conflicts), NOT green/yellow/grey (liveness dots), NOT
 * cyan (osc8 links/header), and NOT the blue read diamond `◇`. Intent is a
 * card-only surface (D-12): this glyph never appears in `CompactRow`.
 */
const INTENT_GLYPH = "»";

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
 * Split a realpath into `{ name, dir }` WITHOUT opening it: `name` is the final
 * `/`-segment (same rule as `basename`), `dir` is the leading segments rejoined
 * by `/` (empty string when the path has no directory segment). Lets the card
 * render file lines as an aligned `name | dir` instead of a long full path. The
 * caller sanitizes `name` and `dir` SEPARATELY — never the joined string — so no
 * OSC/control byte can survive the split (T-3td-01).
 */
function splitPath(rp: string): { name: string; dir: string } {
  const s = String(rp);
  const parts = s.split("/");
  const name = parts[parts.length - 1] || s;
  const dir = parts.slice(0, -1).join("/");
  return { name, dir };
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
 * Below the write lines, each active READ path (`s.reads`, card-only per D-10)
 * is rendered on its own line with a distinct blue `◇` glyph (PANEL-06 D-08/D-09)
 * — purely additive, guarded by `s.reads ?? []`, each path sanitized.
 *
 * Every displayed string is passed through `sanitize()` before Ink render,
 * INCLUDING the shortId (T-02-30 / WR-04). `osc8()` is the sole exemption and
 * its inputs are pre-sanitized. No Warp window/tab name is shown (D-07).
 */
export function SessionCard({ s }: { s: SessionRow }) {
  const focusUrl = s.warp?.focus_url;
  const uptime = sanitize(fmtUptime(Date.parse(s.start_time), Date.now()));
  const reads = s.reads ?? [];

  // Per-card `|` alignment (T-3td-01): the left field is `sanitize(name)` for a
  // write and `READ_GLYPH + " " + sanitize(name)` for a read (so the read's
  // leading `◇ ` counts toward the column). `W` is the widest left field across
  // BOTH writes and reads, so `padEnd(W)` lines up the ` | ` separator on every
  // file line. Basename and directory are sanitized SEPARATELY, never joined.
  const writeParts = s.files.map((f) => splitPath(f.file_path));
  const readParts = reads.map((r) => splitPath(r.file_path));
  const W = Math.max(
    0,
    ...writeParts.map((p) => sanitize(p.name).length),
    ...readParts.map((p) => (READ_GLYPH + " " + sanitize(p.name)).length),
  );

  // Intent line (PANEL-02 D-10): drawn immediately under the header and ABOVE
  // both file lists. When `s.intent` is a non-empty string, render it behind the
  // INTENT_GLYPH (sanitized — untrusted agent text, T-04-05). Otherwise fall back
  // so the line is NEVER blank (D-11): a dim `~ <basename>` derived from the
  // newest active write (max Date.parse(ts)), or a dim `~ (idle)` when there are
  // no active writes either.
  const newestWrite = s.files.reduce<SessionRow["files"][number] | undefined>(
    (best, f) => (best && Date.parse(best.ts) >= Date.parse(f.ts) ? best : f),
    undefined,
  );
  const intentLine =
    typeof s.intent === "string" && s.intent.length > 0 ? (
      <Text>{"  " + INTENT_GLYPH + " " + sanitize(s.intent)}</Text>
    ) : newestWrite ? (
      <Text dimColor>{"  ~ " + sanitize(splitPath(newestWrite.file_path).name)}</Text>
    ) : (
      <Text dimColor>{"  ~ (idle)"}</Text>
    );

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
      {intentLine}
      {s.files.length === 0 ? (
        <Text dimColor>{"  (no active files)"}</Text>
      ) : (
        s.files.map((f, i) => {
          const { name, dir } = writeParts[i];
          const left = sanitize(name);
          const d = sanitize(dir);
          return d === "" ? (
            <Text key={f.file_path}>{"  " + left}</Text>
          ) : (
            <Text key={f.file_path}>
              {"  " + left.padEnd(W) + " | "}
              <Text dimColor>{d}</Text>
            </Text>
          );
        })
      )}
      {reads.map((r, i) => {
        const { name, dir } = readParts[i];
        const left = READ_GLYPH + " " + sanitize(name);
        const d = sanitize(dir);
        return d === "" ? (
          <Text key={"r:" + r.file_path} color={READ_COLOR}>
            {"  " + left}
          </Text>
        ) : (
          <Text key={"r:" + r.file_path} color={READ_COLOR}>
            {"  " + left.padEnd(W) + " | "}
            <Text dimColor>{d}</Text>
          </Text>
        );
      })}
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

/**
 * The exposed-port security badge glyph (PORT-05 D-03): `⇅` (U+21C5). It is
 * >= 0x00A0 so `sanitize()` preserves it, and it is visually distinct from every
 * reserved cue — the liveness `●`, the read `◇`, the filled `◆`, the conflict
 * `⚠`, the swap `↔`, the link `↪`, and the intent `»`. Paired with `magenta`
 * `bold` (a color owned by NO other cue: red=conflict, green/yellow/grey=liveness,
 * cyan=header/links, blue=reads) so an off-host bind stands out as a warning
 * WITHOUT colliding with the conflict-red alarm.
 */
const EXPOSED_GLYPH = "⇅";

/**
 * Max port rows the PORTLAR pane renders before collapsing the remainder into a
 * single dim `+N more` (mirrors CONFLICT_CAP). Bounds the pane's height
 * regardless of how many listeners the machine has (D-06 shows all ports).
 */
export const PORTS_CAP = 6;

/**
 * Build a port-group heading reusing the `folder · branch · shortid` identity
 * convention (Card.tsx label()/shortId): each of the three parts is sanitized
 * SEPARATELY (empty branch collapses to the `—` dash), then — ONLY when a
 * non-empty intent is set — the sanitized intent is appended behind the same
 * `»` INTENT_GLYPH the card uses (D-04). When intent is absent the heading ends
 * at the shortId with NO trailing marker/placeholder (mirrors Card.tsx:143-150).
 */
function portHeading(folder: string, branch: string, session_id: string, intent?: string): string {
  const f = sanitize(folder);
  const b = sanitize(branch) || "—";
  const id = sanitize(String(session_id).slice(0, 8));
  const base = `${f} · ${b} · ${id}`;
  return typeof intent === "string" && intent.length > 0
    ? `${base} ${INTENT_GLYPH} ${sanitize(intent)}`
    : base;
}

/**
 * One listening-socket row: `port · command · <badge> · pid <pid>`. The port,
 * command, and pid are sanitized SEPARATELY before render (T-04.1-01 / T-qt0-01,
 * process-controlled strings). The badge is the sole security signal: an exposed
 * bind gets a `magenta` `bold` `⇅ exposed` (D-03), a local-only bind a dim `local`
 * (no glyph). No reserved palette color is used for the badge. The trailing dim
 * `· pid <pid>` segment gives a directly readable `kill <pid>` target (PORT-05):
 * a numeric pid is inherently injection-safe but still routed through `sanitize()`
 * so every rendered field stays on the established render-boundary path (T-qt0-01).
 */
function PortRow({ p }: { p: ScannedPort }) {
  return (
    <Text>
      {"  " + sanitize(String(p.port)) + " · " + sanitize(p.command) + " · "}
      {p.exposed ? (
        <Text color="magenta" bold>{EXPOSED_GLYPH + " exposed"}</Text>
      ) : (
        <Text dimColor>{"local"}</Text>
      )}
      <Text dimColor>{" · pid " + sanitize(String(p.pid))}</Text>
    </Text>
  );
}

/**
 * The LEFT PORTLAR pane (PORT-05): scanned listening ports grouped under the
 * session that owns them. For each port, the Plan-01 render-time join
 * (`livePidMap` + `attribute`) walks its pid ancestry to the first live session
 * (`alive && !readyToPrune`, numeric pid); a match groups the port under that
 * session's `folder · branch · shortid` heading (intent-enriched, D-04), while an
 * unattributed port falls to a final `Sen (kullanici)` user bucket rendered LAST
 * (D-02). The pane flattens to at most `PORTS_CAP` port rows and appends a dim
 * `+N more` past the cap (mirrors ConflictBand); zero ports render a single dim
 * `no listening ports` empty state.
 *
 * Pure presentation — NO scanning, NO timers, NO keyboard/raw-mode (Phase 04.2).
 * It is NOT a card: no `borderStyle`, just a column of `<Text>`. Every rendered
 * field (port, command, heading parts, intent, badge) is routed through
 * `sanitize()` before Ink render, and the badge glyph `⇅` is >= 0x00A0 so it
 * survives — a crafted process name cannot inject control bytes (T-04.1-01).
 */
export function PortsPane({ ports, rows }: { ports: ScannedPort[]; rows: SessionRow[] }) {
  if (ports.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{"no listening ports"}</Text>
      </Box>
    );
  }

  const live = livePidMap(rows);

  // Group attributed ports by owning session (stable insertion order); collect
  // unattributed ports into the user bucket.
  interface Group {
    key: string;
    heading: string;
    ports: ScannedPort[];
  }
  const sessionGroups = new Map<string, Group>();
  const userPorts: ScannedPort[] = [];
  for (const p of ports) {
    const row = attribute(p, live);
    if (row === null) {
      userPorts.push(p);
      continue;
    }
    let g = sessionGroups.get(row.session_id);
    if (!g) {
      g = {
        key: row.session_id,
        heading: portHeading(row.folder, row.branch, row.session_id, row.intent),
        ports: [],
      };
      sessionGroups.set(row.session_id, g);
    }
    g.ports.push(p);
  }

  // Session groups first, the user bucket (D-02) LAST.
  const groups: Group[] = [...sessionGroups.values()];
  if (userPorts.length > 0) {
    groups.push({ key: " user", heading: "Sen (kullanici)", ports: userPorts });
  }

  // Flatten to at most PORTS_CAP port rows across all groups; a group's heading
  // is shown only if at least one of its rows fits the remaining budget.
  const total = groups.reduce((n, g) => n + g.ports.length, 0);
  const more = Math.max(0, total - PORTS_CAP);
  let budget = PORTS_CAP;

  return (
    <Box flexDirection="column">
      {groups.map((g) => {
        if (budget <= 0) return null;
        const shown = g.ports.slice(0, budget);
        budget -= shown.length;
        return (
          <React.Fragment key={g.key}>
            <Text bold>{g.heading}</Text>
            {shown.map((p) => (
              <PortRow key={`${g.key}:${p.port}:${p.pid}`} p={p} />
            ))}
          </React.Fragment>
        );
      })}
      {more > 0 ? <Text dimColor>{`  +${more} more`}</Text> : null}
    </Box>
  );
}
