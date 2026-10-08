/**
 * Showing a file name to a person.
 *
 * A name is data from the user's directory, and printing it raw lets a newline split a
 * one-name-per-line list and an ESCAPE start a terminal control sequence. Everything that
 * lists names in a message goes through {@link displayName}.
 */

/**
 * Characters that must not reach a terminal or break a one-name-per-line list: C0 and C1
 * controls (a newline, an ESCAPE that starts a terminal sequence) and the Unicode line
 * separators and bidirectional overrides that reorder or split what is displayed.
 */
const UNSAFE_NAME_CHARACTERS = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/**
 * A file name as it is shown to a person: control characters written out as escapes
 * (`\n`, `\x1b`), everything else as it is.
 */
export function displayName(name: string): string {
  return name.replace(UNSAFE_NAME_CHARACTERS, (c) => {
    if (c === "\n") return "\\n";
    if (c === "\r") return "\\r";
    if (c === "\t") return "\\t";
    const code = c.codePointAt(0) ?? 0;
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/** Names as shown, joined for one line of a message. */
export function displayNames(names: readonly string[], separator = ", "): string {
  return names.map(displayName).join(separator);
}
