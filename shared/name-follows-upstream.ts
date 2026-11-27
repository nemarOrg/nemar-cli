/**
 * The dataset's Name follows its upstream dataset's title (owner rule of 2026-11-27; ADR 0102 and
 * ADR 0107 as amended that day). A dataset copied from an upstream dataset keeps the upstream's
 * name: its `Name` starts with the title of one upstream dataset source, as the source's registry
 * gives it, and whatever follows is nothing or a suffix of the closed grammar below (an author-year,
 * then optionally a service key).
 *
 * One pure, deterministic function, {@link nameFollowsUpstream}. The review job applies it to the
 * `Name` it reads at the reviewed commit and the sources the Worker served it (the license-lineage
 * resolver's records), and stores the closed word in the evidence (`name_upstream`); the Worker's
 * decision card shows the titles it read ({@link upstreamDatasetTitles}). No other copy exists.
 *
 * **What is compared.** Both texts are normalized the same way ({@link normalizeTitle}): Unicode
 * NFKC, what no reader sees removed (`withoutInvisible`, the naming rule's own), apostrophes
 * removed (`Couple’s` and `Couples` are one word), every other punctuation or symbol character a
 * space, blanks collapsed, case folded. A leading "The" or "A" is NOT ignored: it is part of the
 * title, and the rule is that the name starts with the title, so dropping it would be a guess
 * about which words matter.
 *
 * **The suffix grammar** ({@link NAME_SUFFIX}), on what follows the title in the Name as
 * written (NFKC, invisible characters removed), after any closing punctuation that ends the title
 * (`)`, `]`, `.`, a closing quote):
 *
 *     suffix    = [author-year] [" (" service ":" key ")"]
 *     author-year = sep authors " " year | " (" authors " " year ")"
 *     sep       = "," " "* | " "+ dash " "+ | " "+          (dash: - – —)
 *     authors   = surname | surname " et al." | surname " & " surname
 *     surname   = particle* Capital letters ( ("'" | "-") letters )*
 *     particle  = van | von | de | der | den | del | della | di | da | du | le | la | dos | das | ten | ter, then " "
 *     year      = 19NN | 20NN
 *     service   = a lowercase word ("figshare", "openneuro"); key = up to 64 characters, no blank or parenthesis
 *
 * The service key is the final parenthetical the submission standards already allow after a
 * descriptive name (docs.nemar.org/policies/submission-standards), so a Name that obeys them is
 * never refused here; the owner's rule adds only the author-year.
 *
 * A bare-space separator takes only the two shapes no ordinary title word makes, `et al.` and
 * `&`: `fNIRS data Motor 2019` is not a citation, while `fNIRS data Lee et al. 2019` is. So the
 * shapes `, Lee 2019`, ` (Lee 2019)`, ` - Lee et al. 2019` and ` Lee & Kim 2019` pass, and
 * ` (fNIRS)`, `: Lee 2019`, ` Lee 2019` and `, Lee 2019 EEG` do not.
 *
 * **The results, closed words only** (no title and no name is ever in the result):
 *  - `matches`: the Name follows one dataset source's title.
 *  - `differs`: every declared upstream source was read, at least one is a dataset with a title,
 *    and the Name follows none of them.
 *  - `not_applicable`: no upstream source is declared, or every declared one is a publication.
 *  - `unknown`: what decides it could not be read (the Name, or a declared source whose record was
 *    not read, has no title, or whose lineage is unresolved), and the Name follows no source that
 *    was read. An administrator decides; the rule never guesses.
 *
 * Sources found only in the README are heuristic candidates, not declarations: one can make a
 * `matches`, never a `differs` or an `unknown`. Several sources: the Name passes if it follows any.
 */

import type { LineageOutcome } from "./license-lineage.js";
import { withoutInvisible } from "./naming-rule.js";

/** The closed results, in the order a surface lists them. */
export const NAME_UPSTREAM_RESULTS = ["matches", "differs", "not_applicable", "unknown"] as const;
export type NameUpstreamResult = (typeof NAME_UPSTREAM_RESULTS)[number];

/** The fields of a lineage source the rule reads (`InputSource` and `LineageSource` both have them). */
export interface UpstreamTitleSource {
  title: string | null;
  status: string;
  origin: string;
  outcome: LineageOutcome;
}

/** An apostrophe: removed, so a possessive stays one word. */
const APOSTROPHE = /^['‘’ʼʹ′`´]$/u;
/** Every other punctuation or symbol character, and every blank: a word boundary. */
const SEPARATOR = /^[\p{P}\p{S}\s]$/u;

/**
 * A title or a Name as the rule compares it: NFKC, invisible characters and apostrophes removed,
 * punctuation and symbols as spaces, blanks collapsed and trimmed, lower case (character by
 * character, so a Name and a title are folded alike wherever a letter stands).
 */
export function normalizeTitle(text: string): string {
  return normalizedWithMap(text).norm;
}

const PARTICLE = "(?:(?:van|von|de|der|den|del|della|di|da|du|le|la|dos|das|ten|ter) )";
const SURNAME = `${PARTICLE}*\\p{Lu}[\\p{L}\\p{M}]*(?:['\\u2019-][\\p{L}\\p{M}]+)*`;
const YEAR = "(?:19|20)\\d{2}";
/** Authors after a comma, a dash or a parenthesis: one surname, `et al.`, or two joined by `&`. */
const AUTHORS = `${SURNAME}(?: et al\\.?| & ${SURNAME})?`;
/** Authors after a bare space: only the two shapes no ordinary title word makes. */
const BARE_AUTHORS = `${SURNAME}(?: et al\\.?| & ${SURNAME})`;

/** The four author-year shapes, each a whole alternative. */
const AUTHOR_YEAR = `(?:,\\s*${AUTHORS} ${YEAR}|\\s+[-\\u2013\\u2014]\\s+${AUTHORS} ${YEAR}|\\s*\\(${AUTHORS} ${YEAR}\\)|\\s+${BARE_AUTHORS} ${YEAR})`;

/**
 * The final service-key parenthetical the submission standards allow after a descriptive name,
 * `(service:key)`: a lowercase service word, a colon and a key with no blank or parenthesis
 * (`(figshare:12192405)`, `(openneuro:ds004362)`).
 */
const SERVICE_KEY = "(?:\\s+\\([a-z][a-z0-9-]{0,31}:[^\\s()]{1,64}\\))";

/**
 * The closed suffix grammar (see the file header), anchored at both ends: an optional author-year
 * shape, then an optional service key. It matches the empty text too. Linear: no nested unbounded
 * repetition over the same characters.
 */
export const NAME_SUFFIX = new RegExp(`^${AUTHOR_YEAR}?${SERVICE_KEY}?$`, "u");

/** Closing punctuation that can end a title: never the start of a suffix. */
const TITLE_CLOSERS = /^[\p{Pe}\p{Pf}.!?"'’”]+/u;

/** Whether `rest`, what follows the title in the Name as written, is nothing or a suffix of the grammar. */
export function isNameSuffix(rest: string): boolean {
  const tail = rest.replace(TITLE_CLOSERS, "");
  return tail.trim() === "" || NAME_SUFFIX.test(tail);
}

/**
 * The Name as written (NFKC, invisible characters removed) and, for each character of its
 * normalized form, the index in that text just past the character it came from.
 */
function normalizedWithMap(name: string): { text: string; norm: string; ends: number[] } {
  const text = withoutInvisible(name.normalize("NFKC"));
  let norm = "";
  const ends: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    const next = i + ch.length;
    if (APOSTROPHE.test(ch)) {
      // Removed: `Couple’s` reads `couples`.
    } else if (SEPARATOR.test(ch)) {
      pendingSpace = norm.length > 0;
    } else {
      if (pendingSpace) {
        norm += " ";
        ends.push(i);
        pendingSpace = false;
      }
      // One entry per UTF-16 unit, so `ends[k]` is about `norm[k]` whatever the lower case's length.
      const low = ch.toLowerCase();
      norm += low;
      for (let k = 0; k < low.length; k++) ends.push(next);
    }
    i = next;
  }
  return { text, norm, ends };
}

/** Whether `name` follows `title`: it starts with it at a word boundary, and the rest is a suffix. */
export function followsTitle(name: string, title: string): boolean {
  const t = normalizeTitle(title);
  if (t === "") return false;
  const { text, norm, ends } = normalizedWithMap(name);
  // A title that ends inside a word of the Name leaves a rest that starts with a letter or a digit,
  // which no suffix does, so the grammar alone keeps `SVWMs` from following `SVWM`.
  if (!norm.startsWith(t)) return false;
  return isNameSuffix(text.slice(ends[t.length - 1]));
}

/** A source the lineage read as a dataset (or a data container) whose license it could judge. */
function isReadDataset(s: UpstreamTitleSource): boolean {
  return s.status === "resolved" && s.outcome !== "unresolved";
}

/** A source with a title the rule can compare: read, with a title that normalizes to something. */
function titleOf(s: UpstreamTitleSource): string | null {
  return s.status === "resolved" && s.title !== null && normalizeTitle(s.title) !== ""
    ? s.title
    : null;
}

/**
 * The titles of the upstream dataset sources, each once, in the lineage's order: the titles the
 * rule compares a Name with and the decision card shows.
 */
export function upstreamDatasetTitles(sources: readonly UpstreamTitleSource[]): string[] {
  const out: string[] = [];
  for (const s of sources) {
    const t = titleOf(s);
    if (t !== null && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Whether `name` follows one upstream dataset source's title (the file header has the rule and
 * the results). `name` is the `Name` of `dataset_description.json` (null when it could not be
 * read); `sources` are the lineage's sources as the resolver returned them. Pure and deterministic.
 */
export function nameFollowsUpstream(
  name: string | null,
  sources: readonly UpstreamTitleSource[],
): NameUpstreamResult {
  const readable = name !== null && normalizeTitle(name) !== "";
  if (readable) {
    for (const s of sources) {
      const t = titleOf(s);
      if (t !== null && followsTitle(name, t)) return "matches";
    }
  }
  const declared = sources.filter((s) => s.origin !== "readme" && s.status !== "publication");
  if (declared.length === 0) return "not_applicable";
  const undetermined = declared.some((s) => !isReadDataset(s) || titleOf(s) === null);
  if (!readable || undetermined) return "unknown";
  return "differs";
}
