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
