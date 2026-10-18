/**
 * The naming rule: what a pull request title and a dataset name may not be (ADR 0107).
 *
 * A dataset is named after its paper (the atlas naming rule, FirstAuthorSurname-year-keyword-paperDOI),
 * and a pull request title says what a change does, so the two are kept apart, and a naming template
 * left unfilled is never a title or a name. The rule is one pure function, used by the CLI before it
 * opens a pull request, by the review job before it asks any model, and by the Worker on a pull
 * request it does not review (an owner's or an administrator's), so all three refuse the same text.
 */

/**
 * Every way the rule refuses a text, as a closed word:
 *  - `author_year`: the text starts with a word of letters directly followed by a year from 1900 to
 *    2099, with an optional hyphen or underscore (`Lee2019`, `Lee-2019-EEG`, `BNCI2014_001`);
 *  - `template_field`: the text still holds a naming-template token or an unfilled template field
 *    (`FirstAuthorSurname`, `paperDOI`, `{{x}}`, `${x}`, `<your title>`, `[describe the change]`).
 */
export const NAMING_PROBLEMS = ["author_year", "template_field"] as const;
export type NamingProblem = (typeof NAMING_PROBLEMS)[number];

/**
 * A template field left where its value belongs. The first three are syntax: the shapes an
 * unfilled template, or a shell that did not expand a variable, leaves behind. The fourth is the
 * one real instance this was written for: a dataset's rename PR was titled with the naming rule
 * "FirstAuthorSurname-year-keyword-paperDOI" instead of the name that rule produces.
 *
 * The two tokens of that rule are matched anywhere in the text, in any case, with no word boundary.
 * A template is filled in by joining its parts, and `_` and digits are word characters, so a
 * boundary would pass `FirstAuthorSurname_year_keyword_paperDOI` and `paperDOI10.1234` untouched.
 *
 * There is deliberately NO rule for "a long CamelCase word". BIDS field names are CamelCase by
 * specification (`PowerLineFrequency`, `DatasetDOI`, `ReferencesAndLinks`), as are task labels
 * (`task-RestingStateEyesClosed`), and they are the vocabulary of an ordinary dataset update.
 *
 * A bracket asks the reader to write something only when its first word is one that asks (your,
 * insert, enter, describe, write, fill in, replace) and more words follow inside it, and it is not
 * the text of a Markdown link. `<your title here>` and `[describe the change]` are refused;
 * `<Enter>`, `[Replace]`, `[Write-up](url)`, `[your lab](url)` and
 * `sub-<label>_task-<label>_eeg.edf` stay ordinary text.
 *
 * The lookahead after the whitespace is not decoration: without it `\s+` and the characters after
 * it overlap on blanks, and an unclosed `[your` followed by a long run of them is tried as every
 * split of the run, which is quadratic. With it the run has one way to match.
 */
export const TEMPLATE_FIELDS: readonly RegExp[] = [
  /\{\{[^{}]*\}\}/, // {{title}}
  /\$\{[^{}]*\}/, // ${TITLE}
  /[<[]\s*(?:your|insert|enter|describe|write|fill in|replace)\s+(?=[^\s<>[\]])[^<>[\]]*[>\]](?![([])/i, // <your title>
  /FirstAuthorSurname|paperDOI/i,
];

/**
 * A word of letters with an apostrophe (straight or curly) or a hyphen allowed inside it, then one
 * optional hyphen or underscore, then a year from 1900 to 2099 that is not the start of a longer
 * number. Each repeated part is set off by a character the part before it cannot match, so a long
 * first word is judged in linear time. That shape is the whole argument, so a test checks it on the
 * pattern itself, which is why the pattern is exported; nothing in the suite is timed.
 */
export const AUTHOR_YEAR_PREFIX =
  /^[\p{L}\p{M}]+(?:[-'\u{2019}][\p{L}\p{M}]+)*[-_]?(?:19|20)\d{2}(?!\d)/u;

/**
 * What no reader sees at the start of a text: control characters, invisible format characters (a
 * zero-width space, a soft hyphen, a byte-order mark, a directional mark, a word joiner) and
 * whitespace. The review's models get the text with each of them replaced by a space (`tidy`,
 * `shared/untrusted-text.ts`), so a title that opens with one reads, to them and to a person, as a
 * title that opens with whatever follows. The run is anchored at the start and is one character
 * class repeated, so it is read once, in linear time.
 */
const LEADING_INVISIBLE = /^[\p{Cf}\p{Cc}\s]+/u;

/**
 * What `text` opens with when that is a name and a year, as it was typed (`Lee-2019` for
 * `Lee-2019-EEG`, `MOVING2024` for `MOVING2024 release`), or null. That is how a dataset is named
 * (the atlas naming rule is FirstAuthorSurname-year-keyword-paperDOI), and a pull request title says
 * what the change does, not what the dataset is called: `Lee2019 EEG dataset`, `Lee-2019-EEG`,
 * `O'Brien_2020` and `MOVING2024 release` are refused. The function is pure and exported so that
 * the pull request review, and any check on a dataset name, ask the same question.
 *
 * The name is the first word: letters of any case, with an apostrophe or a hyphen allowed inside it
 * (`O'Brien`, `Smith-Jones`). The year is four digits from 1900 to 2099 that are not the start of a
 * longer number, and it follows the name directly or after one hyphen or underscore; whatever comes
 * after the year does not matter. A space ends the word, so `Release 2019` and `Add 2019
 * recordings` are ordinary sentences, and a title that begins with the year (`2019 release notes`)
 * has no name before it. Only the start of the text is looked at: `Rename the dataset to
 * Lee-2019-EEG` is a sentence.
 *
 * Nothing here can tell a surname from any other letters, so an acronym such as `BNCI2014_001`, a
 * funding code such as `H2020` and a BIDS label such as `ses-2019` are refused too.
 *
 * What no reader sees before the text is skipped: blanks, control characters and invisible format
 * characters (see {@link LEADING_INVISIBLE}), so `\u200bLee2019 EEG` is refused like `Lee2019 EEG`,
 * and the answer is the same before and after the CLI's `normalizeTitle` (`src/lib/pr-text.ts`).
 * Only the start is cleared: an invisible character inside the text ends the first word, as any
 * character that is not a letter does.
 */
export function findAuthorYearPrefix(text: string): string | null {
  return text.replace(LEADING_INVISIBLE, "").match(AUTHOR_YEAR_PREFIX)?.[0] ?? null;
}

/**
 * The first template field `text` still holds, as it appears there, or null: the first of
 * {@link TEMPLATE_FIELDS}, in their order, that matches anywhere in the text.
 */
export function findTemplateField(text: string): string | null {
  for (const re of TEMPLATE_FIELDS) {
    const field = text.match(re)?.[0];
    if (field !== undefined) return field;
  }
  return null;
}

/**
 * How `text` breaks the naming rule, or null when it does not: a name and a year at its start
 * (`author_year`, {@link findAuthorYearPrefix}), or a naming-template token or unfilled template
 * field anywhere in it (`template_field`, {@link findTemplateField}). The one question the CLI asks
 * of a title, the review job asks of a title and of a changed dataset name before any model, and the
 * Worker asks of an owner's or administrator's pull request.
 */
export function namingProblemOf(text: string): NamingProblem | null {
  if (findAuthorYearPrefix(text) !== null) return "author_year";
  if (findTemplateField(text) !== null) return "template_field";
  return null;
}
