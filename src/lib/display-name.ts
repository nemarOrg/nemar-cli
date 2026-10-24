/**
 * Showing a file name to a person.
 *
 * A name is data from the user's directory, and printing it raw lets a newline split a
 * one-name-per-line list and an ESCAPE start a terminal control sequence. The messages of
 * the upload steps list names through {@link displayName}.
 */

/**
 * Characters that must not reach a terminal or break a one-name-per-line list: C0 and C1
 * controls (a newline, an ESCAPE that starts a terminal sequence), the Unicode line and
 * paragraph separators (U+2028, U+2029), and the bidirectional embeddings, overrides and
 * isolates (U+202A to U+202E, U+2066 to U+2069) that reorder what is displayed, and every
 * other format character (Unicode category Cf: the direction marks LRM, RLM and ALM, zero-width
 * U+200B to U+200D, the word joiner and invisible operators U+2060 to U+2064, the soft hyphen,
 * the byte order mark, and the tag characters U+E0000 to U+E007F that can carry a hidden ASCII
 * payload). Also the invisible characters outside Cf that make two different strings look alike:
 * the combining grapheme joiner U+034F, the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), and
 * the variation selectors (U+FE00 to U+FE0F, U+E0100 to U+E01EF).
 */
const UNSAFE_NAME_CHARACTERS =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: each listed code point is matched on its own (the u flag), which is the intent: a combining joiner or selector is escaped, never joined.
  /[\p{Cc}\p{Cf}\u2028\u2029\u034f\u115f\u1160\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;

/**
 * A file name as it is shown to a person: each character above written out as an escape
 * (a newline as `\n`, an ESCAPE as `\x1b`, a right-to-left override as `\u202e`),
 * everything else as it is.
 */
export function displayName(name: string): string {
  return name.replace(UNSAFE_NAME_CHARACTERS, escapeCharacter);
}

function escapeCharacter(c: string): string {
  if (c === "\n") return "\\n";
  if (c === "\r") return "\\r";
  if (c === "\t") return "\\t";
  const code = c.codePointAt(0) ?? 0;
  return code <= 0xff
    ? `\\x${code.toString(16).padStart(2, "0")}`
    : code <= 0xffff
      ? `\\u${code.toString(16).padStart(4, "0")}`
      : `\\u{${code.toString(16)}}`;
}

/**
 * Multi-line text from outside (a ticket's subject, addresses and body) as it is shown to a
 * person. Newlines and tabs are kept; every other control character (the carriage return, an
 * ESCAPE that starts a terminal sequence, DEL, the C1 controls), the line and paragraph
 * separators and the bidirectional overrides and isolates are written out as escapes, exactly as
 * {@link displayName} writes them.
 */
export function terminalSafeText(text: string): string {
  return text.replace(UNSAFE_NAME_CHARACTERS, (c) =>
    c === "\n" || c === "\t" ? c : escapeCharacter(c),
  );
}

/** Names as shown, joined for one line of a message. */
export function displayNames(names: readonly string[], separator = ", "): string {
  return names.map(displayName).join(separator);
}

/**
 * Whether a name can be put in a command a person will copy and run. A character
 * {@link displayName} would escape would reach the terminal raw (an ESCAPE) or split the
 * command across lines (a newline), and no quoting that works in every shell fixes that,
 * so such a name is not printed in a command at all.
 */
export const isPrintableInCommand = (name: string): boolean => displayName(name) === name;
