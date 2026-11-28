/**
 * The dataset's Name follows its upstream dataset's title (owner rules of 2026-11-27; ADR 0102 and
 * ADR 0107 as amended that day). A dataset copied from an upstream dataset keeps the upstream's
 * name: its `Name` is virtually identical to the title of one DECLARED upstream dataset source, as
 * the source's registry gives it, and whatever follows is nothing or a suffix of the closed grammar
 * below (a version, an author-year of the dataset's own people, a service key).
 *
 * One pure, deterministic function, {@link nameFollowsUpstream}. The review job applies it to the
 * `Name` and `Authors` it reads at the reviewed commit and the sources the Worker served it (the
 * license-lineage resolver's records), and stores the closed word in the evidence
 * (`name_upstream`); the Worker's decision card shows the titles ({@link upstreamDatasetTitles}).
 * No other copy exists.
 *
 * **What compares equal** ({@link foldWords}): both texts are cut into words (letters, digits and
 * combining marks; an apostrophe inside a word is dropped, so `Couple’s` reads `couples`; every
 * other punctuation or symbol separates words), after Unicode NFKC and with what no reader sees
 * removed. Each word is then folded: NFKD with the combining marks dropped (accents and
 * diacritics), lower case, `&` read as `and`, and British spelling read as American by the closed
 * list {@link SPELLING_FOLDS}. A trailing version marker on the upstream title (`v2`, `v2.0`,
 * `2.0`, `version 2`) is not part of it. A leading "The" or "A" is NOT ignored: dropping it would
 * be a guess about which words matter.
 *
 * **The suffix grammar** ({@link NAME_SUFFIX}), on what follows the title's last word in the Name
 * as written (NFKC, invisible characters removed), after any closing punctuation that ends the
 * title (`)`, `]`, `.`, a closing quote):
 *
 *     suffix      = [version] [author-year] [service-key]
 *     version     = [" " | ", "] ["("] ("v" N | "version " N | N "." N) [")"]      (N: digits, dotted)
 *     author-year = open authors [","] " " year [")"]
 *     open        = "," " "* | " "* ("–" | "—") " "* | " "+ "-" " "+ | " "* "(" | " "+
 *     authors     = surname | surname " et al." | surname (" & " | " and ") surname
 *     surname     = particle* Capital letters ( ("'" | "-") letters )*
 *     year        = 19NN | 20NN
 *     service-key = " (" service ":" key ")"     (service: one of NAME_SERVICES; key: no blank or parenthesis)
 *
 * A parenthesis opens exactly when one closes it. A bare-space `open` takes only `et al.` or two
 * surnames, never one. **Every surname must be the family name of one of the dataset's Authors
 * or of the matched upstream record's creators** (the part before the comma of `Family, Given`,
 * else the last word, folded alike), so `EEG (Replication 2021)`, `EEG, Motor 2019`, and
 * `EEG (Mark 2019)` beside the author `Kim, Mark`, are not author-years. The service key is the final parenthetical the
 * submission standards already allow after a descriptive name, for a service the resolver knows.
 *
 * **The results, closed words only** (no title and no name is ever in the result):
 *  - `matches`: the Name follows the title of one declared dataset source.
 *  - `differs`: every declared source was read, at least one is a dataset with a title, none was
 *    resolved to a later version than the one declared, and the Name follows none of them.
 *  - `not_applicable`: no upstream source is declared, or every declared one is a publication.
 *  - `unknown`: what decides it could not be read (the Name, or a declared source whose record was
 *    not read, has no title, or whose lineage is unresolved), or the Name differs from a source
 *    that was resolved to its latest version rather than the version declared (a version-less
 *    OpenNeuro, figshare or PhysioNet reference: the upstream may have been renamed since the
 *    copy). An administrator decides; the rule never guesses.
 *
 * Only declared sources count (SourceDatasets, the enrichment's relations, the attestation). A
 * README candidate is a heuristic, not a declaration: it neither matches nor differs, so a Name
 * that follows only a README candidate is `not_applicable`, and never shields a name from the
 * automatic denial. Several declared sources: the Name passes if it follows any one.
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
  /** The record's creators' names, as the registry gave them. */
  creators?: readonly string[];
  /** The record was resolved to its latest version, not to a version the dataset declared. */
  resolved_latest?: boolean;
}

/** The origins that declare a source; a README candidate does not. */
export const DECLARED_ORIGINS: readonly string[] = [
  "source_datasets",
  "related_identifiers",
  "attestation",
];

/**
 * The services whose key may close a Name, `(service:key)`: the repositories the license-lineage
 * resolver reads (its resolvers and its data-repository DOI prefixes), by their usual names.
 */
export const NAME_SERVICES = [
  "openneuro",
  "physionet",
  "zenodo",
  "figshare",
  "osf",
  "dandi",
  "dryad",
  "dataverse",
] as const;

/**
 * British spellings read as American, one closed list of regular variants, applied to each
 * lower-case word in order (the first that matches). Both texts are folded alike, so a fold that
 * also touches an unrelated word (`detour`) changes nothing in a comparison.
 */
export const SPELLING_FOLDS: readonly { variant: string; british: RegExp; american: string }[] = [
  // colour, behaviour(al), neurobehavioural, colourful, favourite, honourable, labours. The stem
  // before -our has three letters or more, and only these endings follow it, so four, hour, your,
  // tour, pour, flour, journal, source, course and resource keep their letters.
  {
    variant: "-our/-or",
    british: /^([a-z]{3,})our(al|ally|ful|ite|ites|able|ably|s|ed|ing|er|ers)?$/,
    american: "$1or$2",
  },
  // normalisation, organisations (before -ise, which would leave -isation half done)
  { variant: "-isation/-ization", british: /^([a-z]{3,})isation(s)?$/, american: "$1ization$2" },
  // normalise, standardised, visualising
  { variant: "-ise/-ize", british: /^([a-z]{3,})is(e|es|ed|ing)$/, american: "$1iz$2" },
  // analyse, paralysed
  { variant: "-yse/-yze", british: /^([a-z]{3,})ys(e|ed|ing)$/, american: "$1yz$2" },
  // centre, metres, litre
  { variant: "-tre/-ter", british: /^([a-z]{2,})tre(s)?$/, american: "$1ter$2" },
  // catalogue, dialogues, analogue
  { variant: "-ogue/-og", british: /^([a-z]{3,})ogue(s)?$/, american: "$1og$2" },
  // licence, defence, offence, pretence (these four only: -ence is not otherwise a variant)
  { variant: "-ence/-ense", british: /^(licen|defen|offen|preten)ce(s)?$/, american: "$1se$2" },
];

/** One word folded: diacritics dropped, lower case, `&` as `and`, British spelling as American. */
export function foldWord(word: string): string {
  if (word === "&") return "and";
  const w = word.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  for (const f of SPELLING_FOLDS) if (f.british.test(w)) return w.replace(f.british, f.american);
  return w;
}

/** A word: letters, digits and marks with apostrophes inside; or an ampersand. */
const WORD = /[\p{L}\p{N}\p{M}'‘’ʼ]+|&/gu;
const APOSTROPHES = /['‘’ʼ]/gu;

/** The text the grammar reads, and each folded word with where it ends in that text. */
function wordsOf(raw: string): { text: string; words: { fold: string; end: number }[] } {
  const text = withoutInvisible(raw.normalize("NFKC"));
  const words: { fold: string; end: number }[] = [];
  for (const m of text.matchAll(WORD)) {
    const fold = foldWord(m[0].replace(APOSTROPHES, ""));
    if (fold !== "") words.push({ fold, end: m.index + m[0].length });
  }
  return { text, words };
}

/** The folded words of a text, as the rule compares them. */
export function foldWords(text: string): string[] {
  return wordsOf(text).words.map((w) => w.fold);
}

/** A version marker: `v2`, `v2.0`, `version 2`, or a dotted number `2.0`; never a bare year. */
const VERSION_MARK = "(?:v\\d+(?:\\.\\d+)*|version\\s+\\d+(?:\\.\\d+)*|\\d+\\.\\d+(?:\\.\\d+)*)";
const VERSION = `(?:(?:\\s+|\\s*,\\s*)(?:\\(${VERSION_MARK}\\)|${VERSION_MARK}))`;
/** A trailing version marker on an upstream title, which is not part of what the Name must follow. */
const TITLE_VERSION = new RegExp(`${VERSION}\\s*$`, "iu");

const PARTICLE = "(?:(?:van|von|de|der|den|del|della|di|da|du|le|la|dos|das|ten|ter) )";
const SURNAME = `${PARTICLE}*\\p{Lu}[\\p{L}\\p{M}]*(?:['\\u2019-][\\p{L}\\p{M}]+)*`;
const AUTHORS = `${SURNAME}(?: et al\\.?| (?:&|and) ${SURNAME})?`;
const OPEN = "(?:\\s*,\\s*|\\s*[\\u2013\\u2014]\\s*|\\s+-\\s+|\\s*\\(|\\s+)";
const YEAR = "(?:19|20)\\d{2}";
const SERVICE_KEY = `(?:\\s+\\((?:${NAME_SERVICES.join("|")}):[^\\s()]{1,64}\\))`;

/**
 * The closed suffix grammar (see the file header), anchored at both ends. It matches the empty
 * text too; the pairing of parentheses, the bare-space rule and the people are checked by
 * {@link isNameSuffix}. Linear: no nested unbounded repetition over the same characters.
 */
export const NAME_SUFFIX = new RegExp(
  `^(?<version>${VERSION})?(?:(?<open>${OPEN})(?<authors>${AUTHORS}),?\\s(?<year>${YEAR})(?<close>\\))?)?(?<service>${SERVICE_KEY})?$`,
  "u",
);

/** Closing punctuation that can end a title: never the start of a suffix. */
const TITLE_CLOSERS = /^[\p{Pe}\p{Pf}.!?"'’”]+/u;

/** The surnames of an author-year's authors: one, or two joined by `&` or `and`. */
function surnamesOf(authors: string): string[] {
  return authors
    .replace(/ et al\.?$/, "")
    .split(/ (?:&|and) /)
    .filter((s) => s !== "");
}

/**
 * A person's family name as folded words: the part before the comma of `Family, Given`, else the
 * last blank-separated word (`Pat O'Brien-Smith` gives `obrien smith`).
 */
export function familyNameOf(person: string): string[] {
  const comma = person.indexOf(",");
  if (comma >= 0) return foldWords(person.slice(0, comma));
  const parts = person.trim().split(/\s+/);
  return foldWords(parts[parts.length - 1] ?? "");
}

/** A surname names `family` when its words end with the family name's (`van der Berg` and `Berg`). */
function endsWithWords(surname: readonly string[], family: readonly string[]): boolean {
  if (family.length === 0 || family.length > surname.length) return false;
  const off = surname.length - family.length;
  return family.every((w, k) => surname[off + k] === w);
}

/**
 * Whether `rest`, what follows the title in the Name as written, is nothing or a suffix of the
 * grammar whose every surname is one of `people` (the dataset's Authors and the matched record's
 * creators).
 */
export function isNameSuffix(rest: string, people: readonly string[] = []): boolean {
  const tail = rest.replace(TITLE_CLOSERS, "");
  if (tail.trim() === "") return true;
  const m = NAME_SUFFIX.exec(tail);
  if (m === null) return false;
  const g = m.groups ?? {};
  if (g.authors === undefined) return true;
  const opened = (g.open ?? "").includes("(");
  if (opened !== (g.close !== undefined)) return false;
  if (/^\s+$/.test(g.open ?? "") && !/ et al\.?$| (?:&|and) /.test(g.authors)) return false;
  const families = people.map(familyNameOf);
  return surnamesOf(g.authors).every((s) => {
    const words = foldWords(s);
    return families.some((f) => endsWithWords(words, f));
  });
}

/**
 * Whether `name` follows `title`: its words start with the title's words (the title's trailing
 * version marker set aside), and the rest is a suffix whose people are `people`.
 */
export function followsTitle(name: string, title: string, people: readonly string[] = []): boolean {
  const t = foldWords(title.normalize("NFKC").replace(TITLE_VERSION, ""));
  if (t.length === 0) return false;
  const { text, words } = wordsOf(name);
  if (words.length < t.length || !t.every((w, i) => words[i]?.fold === w)) return false;
  return isNameSuffix(text.slice(words[t.length - 1]?.end ?? 0), people);
}

const isDeclared = (s: UpstreamTitleSource) => DECLARED_ORIGINS.includes(s.origin);

/** A source the lineage read as a dataset (or a data container) whose license it could judge. */
function isReadDataset(s: UpstreamTitleSource): boolean {
  return s.status === "resolved" && s.outcome !== "unresolved";
}

/** A source with a title the rule can compare: read, with a title that has a word. */
function titleOf(s: UpstreamTitleSource): string | null {
  return s.status === "resolved" && s.title !== null && foldWords(s.title).length > 0
    ? s.title
    : null;
}

/**
 * The titles of the declared upstream dataset sources, each once, in the lineage's order: the
 * titles the rule compares a Name with and the decision card shows.
 */
export function upstreamDatasetTitles(sources: readonly UpstreamTitleSource[]): string[] {
  const out: string[] = [];
  for (const s of sources) {
    const t = isDeclared(s) ? titleOf(s) : null;
    if (t !== null && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * The titles of every declared source whose record was read with a title, a publication's
 * included, each once, in the lineage's order (the lead's ruling of 2026-11-27, ADR 0139 as amended
 * that day). A Name that follows one of them came from a source, so the automatic denial never
 * calls it not descriptive (`shared/publication-auto-deny.ts`); the name rule's own result still
 * reads dataset sources only ({@link nameFollowsUpstream}).
 */
export function declaredSourceTitles(sources: readonly UpstreamTitleSource[]): string[] {
  const out: string[] = [];
  for (const s of sources) {
    if (!isDeclared(s) || (s.status !== "resolved" && s.status !== "publication")) continue;
    const t = s.title !== null && foldWords(s.title).length > 0 ? s.title : null;
    if (t !== null && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Every declared source was read with a title ({@link declaredSourceTitles} then lists them all).
 * When one was not (its record not read, or read with no title), a Name that follows it cannot be
 * ruled out, so the automatic denial protects the Name.
 */
export function declaredSourceTitlesComplete(sources: readonly UpstreamTitleSource[]): boolean {
  return sources
    .filter(isDeclared)
    .every(
      (s) =>
        (s.status === "resolved" || s.status === "publication") &&
        s.title !== null &&
        foldWords(s.title).length > 0,
    );
}

/**
 * Whether `name` follows any of `titles` ({@link followsTitle}, the name rule's folding and suffix
 * grammar, with the dataset's `authors` as the people an author-year may name). A Name equal to a
 * title, after folding, follows it.
 */
export function nameFollowsAnySourceTitle(
  name: string,
  titles: readonly string[],
  authors: readonly string[] = [],
): boolean {
  if (foldWords(name).length === 0) return false;
  return titles.some((t) => followsTitle(name, t, authors));
}

/**
 * Whether `name` follows one declared upstream dataset source's title (the file header has the
 * rule and the results). `name` is the `Name` of `dataset_description.json` (null when it could
 * not be read); `sources` are the lineage's sources as the resolver returned them; `authors` the
 * description's `Authors`. Pure and deterministic.
 */
export function nameFollowsUpstream(
  name: string | null,
  sources: readonly UpstreamTitleSource[],
  authors: readonly string[] = [],
): NameUpstreamResult {
  const declared = sources.filter((s) => isDeclared(s) && s.status !== "publication");
  if (declared.length === 0) return "not_applicable";
  const readable = name !== null && foldWords(name).length > 0;
  if (readable) {
    for (const s of declared) {
      const t = titleOf(s);
      if (t !== null && followsTitle(name, t, [...authors, ...(s.creators ?? [])])) {
        return "matches";
      }
    }
  }
  const undetermined = declared.some(
    (s) => !isReadDataset(s) || titleOf(s) === null || s.resolved_latest === true,
  );
  if (!readable || undetermined) return "unknown";
  return "differs";
}
