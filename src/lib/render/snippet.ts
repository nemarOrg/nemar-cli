/**
 * Rendering helpers for `nemar dataset search`'s result table (epic #1144
 * phase 6, issue #1150).
 *
 * Two independent concerns share this module because both exist to make a
 * dataset-supplied string safe and readable on one table row:
 *
 * - D2: the FTS5 `snippet` field (`backend/src/services/dataset-search.ts`)
 *   is `<mark>`-wrapped, arbitrary README prose -- untrusted text reaching a
 *   terminal, same class as Phase 5b's completion-candidate sanitisation
 *   (`src/lib/completion/run.ts`). Unlike that path, a snippet is dropped
 *   character-by-character (sanitised), not dropped whole: it is a display
 *   extra, and losing one bad byte should not blank out an otherwise
 *   readable line.
 * - D3: the comma-joined token list (`modalities`) that a
 *   fixed-width column used to cut mid-token (`.substring(0, modWidth)`
 *   rendered `anat,eeg,fmap` as `anat,eeg,f`).
 *
 * D7: presentation must never fail a command that already has its data. A
 * snippet is a garnish on a search result the backend already returned --
 * malformed input here (a non-string value from an API/schema drift, an
 * unbalanced `<mark>`, a pathologically long README excerpt) degrades to
 * "no snippet line" for that one row, never to a thrown exception that
 * turns a successful search into a failed command.
 */

import { theme } from "../theme.js";

/**
 * ANSI CSI escape sequences -- the shape chalk and every other terminal
 * colouriser emit: the escape byte (code 27) or the single-byte C1 CSI
 * (code 155), optional intermediate bytes, then a final byte in the
 * 0x40-0x7E range. This does not attempt to recognise every ECMA-48 escape
 * shape (OSC hyperlinks, DCS, ...), only the CSI form that a terminal
 * actually acts on for colour and cursor control -- which is the threat
 * this function defends against. An escape byte this misses is still removed
 * by {@link OTHER_CONTROL_CHAR_PATTERN} below, which covers C0, DEL AND C1 --
 * the last of those specifically so the 0x9B introducer this pattern accepts
 * cannot survive as a lone byte. Do not narrow that range to C0 on the
 * reasoning that "an escape byte is a C0 control character": it is true of
 * 0x1B and false of 0x9B (#1174 review).
 *
 * Note the final-byte class below is deliberately WIDER than 0x40-0x7E in one
 * direction and narrower in another: it accepts digits and `=`/`>` so a
 * truncated colour sequence is still consumed whole, at the cost of eating a
 * digit that directly follows a stray introducer. That trade favours never
 * leaking a live escape over preserving one character of prose.
 */
const ANSI_ESCAPE_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape byte is the point
  /[\u001b\u009b][\[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]/g;

/**
 * Newline/carriage-return/tab collapse to a single space rather than being
 * dropped outright, so words on either side of a stripped control character
 * don't run together. A carriage return is the concrete case #1150 calls
 * out: left alone, it would move the cursor back to column 0 and let
 * literal text overwrite the row printed above it.
 */
const LINE_BREAK_PATTERN = /[\n\r\t]+/g;

/**
 * Every other control character: C0 (0x00-0x1F), DEL (0x7F), and C1
 * (0x80-0x9F). This is the fallback for a lone or malformed escape byte that
 * {@link ANSI_ESCAPE_PATTERN} did not recognise as a complete sequence.
 * Removed outright rather than collapsed to a space: these have no legitimate
 * appearance in display prose.
 *
 * The C1 range is load-bearing, not defensive breadth (#1174 review). The
 * ANSI pattern above recognises TWO introducers, ESC (0x1B) and the
 * single-byte C1 CSI (0x9B). ESC is C0 so a lone one was always caught here;
 * 0x9B is NOT, and an earlier version of this range stopped at 0x7F while a
 * comment claimed the fallback caught "any escape byte this misses, since the
 * escape byte is itself a C0 control character". That was false for exactly
 * the second introducer the pattern above goes out of its way to handle, and
 * a lone 0x9B reached the terminal verbatim.
 */
const OTHER_CONTROL_CHAR_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control chars is the point
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Strip ANSI escape sequences and control characters from untrusted display
 * text before it ever reaches `console.log` (#1150 D2). Order matters: ANSI
 * sequences are removed as whole units first (so their parameter/final
 * bytes don't get left behind as visual noise), then any remaining raw
 * control byte -- including one escape byte that did not form a recognised
 * sequence -- is mopped up by the second pass.
 */
export function sanitizeSnippetText(input: string): string {
  return input
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(LINE_BREAK_PATTERN, " ")
    .replace(OTHER_CONTROL_CHAR_PATTERN, "")
    .trim();
}

const MARK_SPLIT_PATTERN = /(<mark>[\s\S]*?<\/mark>)/g;
const MARK_WRAP_PATTERN = /^<mark>([\s\S]*)<\/mark>$/;

/**
 * Hard cap on how much of a raw snippet is ever processed/displayed (#1150
 * D7). FTS5's own `snippet()` call is bounded to 12 tokens, so this is not
 * expected to bite in practice -- it exists for whatever the catalog
 * contains tomorrow, not what it contains today (documentation.md's own
 * warning about claims that don't re-derive). A search result row is one
 * line; nothing gains from a garnish several screens long.
 */
const MAX_SNIPPET_INPUT_LENGTH = 400;

/**
 * Render a sanitised FTS5 snippet as one coloured line: `<mark>`-wrapped
 * matched terms emphasised (`theme.match`), the markers themselves stripped,
 * everything else dim (`theme.muted`). Returns `null` for an absent or
 * blank snippet -- callers must print no line at all in that case (not even
 * an empty one): snippets are absent on the exact-id tier and on semantic
 * rows with no FTS match (#1150 D2).
 *
 * Never throws (#1150 D7). Verified by mutation: with the `typeof` check
 * below removed, a non-string `rawSnippet` (an API/schema drift) still does
 * not escape this function -- the surrounding try/catch is what actually
 * catches the resulting `TypeError` from calling a string method on it. The
 * explicit `typeof` guard stays anyway as a fast, self-documenting rejection
 * of that specific shape rather than relying only on the general-purpose
 * catch to paper over it. Either way the result is "no snippet for this
 * row", never a propagated error.
 */
export function renderSnippetLine(rawSnippet: string | undefined | null): string | null {
  if (!rawSnippet || typeof rawSnippet !== "string") return null;
  try {
    const bounded =
      rawSnippet.length > MAX_SNIPPET_INPUT_LENGTH
        ? rawSnippet.slice(0, MAX_SNIPPET_INPUT_LENGTH)
        : rawSnippet;
    const clean = sanitizeSnippetText(bounded);
    if (!clean) return null;
    return clean
      .split(MARK_SPLIT_PATTERN)
      .filter((part) => part.length > 0)
      .map((part) => {
        const marked = part.match(MARK_WRAP_PATTERN);
        return marked ? theme.match(marked[1]) : theme.muted(part);
      })
      .join("");
  } catch {
    return null;
  }
}

/**
 * Truncate a comma-joined token list to fit
 * `maxWidth` without ever cutting a token in half (#1150 D3). Keeps as many
 * complete leading tokens as fit, then reports how many were dropped
 * (`" +N"`) instead of the previous `.substring(0, maxWidth)` behaviour,
 * which rendered `anat,eeg,fmap` as `anat,eeg,f`.
 *
 * When not even the first token fits inside `maxWidth`, that token alone is
 * truncated with an ellipsis so the cell degrades to something rather than
 * nothing.
 *
 * A non-finite or non-positive `maxWidth` (#1150 D7: a terminal-width probe
 * degrading to something absurd must not cascade into a crash here) returns
 * `value` unchanged rather than attempting to truncate to nothing.
 */
export function truncateTokenList(value: string, maxWidth: number): string {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return value;
  if (value.length <= maxWidth) return value;

  const tokens = value.split(",");
  const kept: string[] = [];
  let used = 0;
  for (const token of tokens) {
    const nextLength = kept.length === 0 ? token.length : used + 1 + token.length;
    if (nextLength > maxWidth) break;
    kept.push(token);
    used = nextLength;
  }

  const remaining = tokens.length - kept.length;
  if (kept.length === 0) {
    const first = tokens[0];
    const ellipsisWidth = Math.max(0, maxWidth - 1);
    const truncatedFirst = ellipsisWidth > 0 ? `${first.slice(0, ellipsisWidth)}…` : "…";
    const overflow = tokens.length - 1;
    return overflow > 0 ? `${truncatedFirst} +${overflow}` : truncatedFirst;
  }

  return remaining > 0 ? `${kept.join(",")} +${remaining}` : kept.join(",");
}
