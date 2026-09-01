/**
 * Semantic colour palette for CLI table/summary rendering (epic #1144 phase
 * 6, issue #1150, D5).
 *
 * Before this, call sites reached for `chalk.cyan`/`chalk.magenta`/
 * `chalk.dim` directly, so "what does cyan mean here" had to be re-derived
 * from context at every site. Naming the six roles once means a palette
 * change is a single edit here instead of a grep-and-replace, and a reader
 * sees WHY a value is coloured, not just which colour it happens to be.
 *
 * Deliberately narrow: only `nemar dataset search`'s result renderer uses
 * this so far (#1150's plan, D5). Do not sweep the rest of the CLI's
 * existing chalk usage onto this module in the same change that introduces
 * it -- a rendering phase that also recolours every unrelated command is
 * unreviewable.
 *
 * No `NO_COLOR`/TTY handling lives here: `src/lib/help.ts` sets
 * `chalk.level = 0` when `--no-color` is passed, and chalk 5 independently
 * disables colour under `NO_COLOR=1` and non-TTY stdout on its own. That
 * chalk-5 behaviour is verified (not merely assumed) by
 * `test/search-color.unit.test.ts`.
 *
 * Presentation must never fail a command (#1150 D7): every export here is
 * wrapped so that if resolving a colour ever throws -- an unexpected input
 * shape, a future chalk change, a terminal capability chalk mis-detects --
 * the text still prints, uncoloured, rather than the whole command dying on
 * a table row it was only trying to decorate.
 */
import chalk from "chalk";

/** Apply `colorFn`, falling back to the plain (`String(text)`-coerced) text
 *  if colouring throws for any reason (#1150 D7). Exported for unit testing:
 *  every `theme.*` function below is built from this, so testing it
 *  directly with a deliberately-throwing `colorFn` covers all six without
 *  needing to reach into chalk's internals to make a real colour function
 *  throw. */
export function safe(colorFn: (text: string) => string): (text: string) => string {
  return (text: string): string => {
    try {
      return colorFn(text);
    } catch {
      return String(text);
    }
  };
}

export const theme = {
  /** A dataset (or other record) identifier the user copies into the next
   *  command. Never dim -- it must stay easy to spot and select. */
  id: safe(chalk.cyan),
  /** A dataset attribute worth calling out (e.g. the HED annotation badge). */
  metric: safe(chalk.magenta),
  /** Section titles. NOT the table header row, which renders with
   * {@link muted} -- verified at the call site (#1174 review); an earlier
   * version of this line claimed both. */
  label: safe(chalk.bold),
  /** Non-fatal warnings and "nothing found" messages. */
  warn: safe(chalk.yellow),
  /** De-emphasized text: separators, footnotes, absent-value placeholders. */
  muted: safe(chalk.dim),
  /** A term inside a search-result snippet that matched the query. */
  match: safe(chalk.green),
} as const;
