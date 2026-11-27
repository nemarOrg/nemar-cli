/**
 * The name rule (`shared/name-follows-upstream.ts`, the owner's rules of 2026-11-27): what compares
 * equal (diacritics, `&`/`and`, a version marker, British and American spelling), the closed
 * suffix grammar and its people check, the declared-source rule, the four results, and the nine
 * datasets whose names drifted from their upstream titles, read from GitHub and the public
 * registries on 2026-11-27 (`test/fixtures/name-follows-upstream/drift-datasets.json`; the
 * sources are what the real license-lineage resolver returned for each dataset_description.json).
 *
 * Mutation checks (applied one at a time to the module, run, restored from a copy):
 *  - the bare-space open taking a single surname turns "a bare-space suffix needs et al. or two
 *    surnames" red;
 *  - not stripping the closing punctuation that ends a title turns "closing punctuation ... is not
 *    part of the suffix" red;
 *  - dropping `$` from `NAME_SUFFIX` turns "a suffix is the whole rest of the Name" red;
 *  - each spelling fold removed in turn turns "each British spelling folds to the American" red;
 *  - dropping the diacritic fold turns "accents ... compare equal" red;
 *  - skipping the people check turns "the surnames must be the dataset's people" red;
 *  - counting README candidates as declared turns "README candidates neither match nor differ"
 *    red;
 *  - the -our fold back to bare -our (no inner endings) turns "each British spelling" red, and
 *    dropping its three-letter stem floor turns it red too (four, hour, tour fold);
 *  - matching any word of a person, not the family name, turns "only the family name counts" red;
 *  - ignoring `resolved_latest` turns "an upstream resolved to its latest version" red.
 *
 * CI TIER: unit-pure. No network: the registry answers are the recorded fixture.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type SourceRef, isLatestRef } from "../shared/license-lineage";
import type { LineageOutcome } from "../shared/license-lineage";
import {
  NAME_SERVICES,
  NAME_SUFFIX,
  NAME_UPSTREAM_RESULTS,
  SPELLING_FOLDS,
  type UpstreamTitleSource,
  familyNameOf,
  foldWord,
  foldWords,
  followsTitle,
  isNameSuffix,
  nameFollowsUpstream,
  upstreamDatasetTitles,
} from "../shared/name-follows-upstream";
import { namingProblemOf } from "../shared/naming-rule";

const T = "Replication Data for: fNIRS RSFC in Tinnitus";
/** The people every suffix test may name. */
const PEOPLE = ["Ada Lee", "Kim, J.", "Jan van der Berg", "Pat O'Brien-Smith", "Jan Łukasiewicz"];

function dataset(
  title: string | null,
  over: Partial<UpstreamTitleSource> = {},
): UpstreamTitleSource {
  return {
    title,
    status: "resolved",
    origin: "source_datasets",
    outcome: "compatible" as LineageOutcome,
    creators: [],
    ...over,
  };
}

describe("what compares equal", () => {
  test("case, Unicode compatibility forms, punctuation, blanks and invisible characters", () => {
    expect(foldWords("  Couple’s  Brain-to-Brain\tSynchrony ")).toEqual([
      "couples",
      "brain",
      "to",
      "brain",
      "synchrony",
    ]);
    expect(foldWords("ＥＥＧ da­ta​ set")).toEqual(["eeg", "data", "set"]);
    expect(followsTitle("replication data for fnirs rsfc in tinnitus", T)).toBe(true);
    expect(followsTitle("Replication  Data for - fNIRS RSFC in Tinnitus", T)).toBe(true);
  });

  test("accents and diacritics compare equal", () => {
    expect(followsTitle("Etude EEG a Zurich", "Étude EEG à Zürich")).toBe(true);
    expect(followsTitle("Étude EEG à Zürich", "Etude EEG a Zurich")).toBe(true);
    expect(foldWord("Łódź")).toBe("łodz");
  });

  test("& and and compare equal", () => {
    expect(followsTitle("Sleep and EEG", "Sleep & EEG")).toBe(true);
    expect(followsTitle("Sleep & EEG", "Sleep and EEG")).toBe(true);
  });

  test("a trailing version marker after the title compares equal, on either side", () => {
    for (const v of [" v2", " v2.0", " 2.0", " version 2", " (v2)", ", v1.0.3"]) {
      expect(followsTitle(`Resting EEG${v}`, "Resting EEG"), v).toBe(true);
      expect(followsTitle("Resting EEG", `Resting EEG${v}`), v).toBe(true);
    }
    // A bare year is not a version.
    expect(followsTitle("Resting EEG 2019", "Resting EEG")).toBe(false);
    expect(followsTitle("Resting EEG v2, Lee 2019", "Resting EEG", PEOPLE)).toBe(true);
  });

  test("each British spelling folds to the American, and the list is closed", () => {
    const pairs: Record<string, [string, string]> = {
      "-our/-or": ["Colour behaviour", "Color behavior"],
      "-isation/-ization": ["Normalisation", "Normalization"],
      "-ise/-ize": ["Standardised visualising", "Standardized visualizing"],
      "-yse/-yze": ["Analysed", "Analyzed"],
      "-tre/-ter": ["Centre metres", "Center meters"],
      "-ogue/-og": ["Catalogue dialogues", "Catalog dialogs"],
      "-ence/-ense": ["Licence defence", "License defense"],
    };
    expect(SPELLING_FOLDS.map((f) => f.variant)).toEqual(Object.keys(pairs));
    for (const [variant, [british, american]] of Object.entries(pairs)) {
      expect(followsTitle(british, american), variant).toBe(true);
      expect(followsTitle(american, british), variant).toBe(true);
    }
    // -ence is a variant for those four words only.
    expect(foldWord("science")).toBe("science");
    // -our inside a word, before the closed endings, folds too.
    for (const [b, a2] of [
      ["Behavioural task", "Behavioral task"],
      ["Neurobehavioural", "Neurobehavioral"],
      ["Colourful", "Colorful"],
      ["Favourite", "Favorite"],
      ["Honourable", "Honorable"],
    ]) {
      expect(followsTitle(b as string, a2 as string), b).toBe(true);
    }
    // Words whose -our is not the variant keep their letters.
    for (const w of [
      "four",
      "hour",
      "your",
      "tour",
      "pour",
      "flour",
      "journal",
      "source",
      "course",
      "resource",
    ]) {
      expect(foldWord(w), w).toBe(w);
    }
    // Short words keep their letters.
    expect(foldWord("rise")).toBe("rise");
    expect(foldWord("four")).toBe("four");
  });

  test("the title must end at a word: a longer word is not the title", () => {
    expect(followsTitle(`${T}x`, T)).toBe(false);
    expect(followsTitle("SVWMs", "SVWM")).toBe(false);
  });

  test("a leading article is part of the title, never dropped", () => {
    expect(followsTitle("Resting EEG", "The Resting EEG")).toBe(false);
    expect(followsTitle("The Resting EEG", "Resting EEG")).toBe(false);
  });

  test("the Name must start with the title: an author-year before it is not allowed", () => {
    expect(followsTitle(`Lee 2019: ${T}`, T, PEOPLE)).toBe(false);
  });

  test("a title of only punctuation compares with nothing", () => {
    expect(followsTitle("Anything", " -- ")).toBe(false);
  });
});

describe("the suffix grammar", () => {
  test("each citation style passes when it names the dataset's people", () => {
    for (const suffix of [
      ", Lee 2019",
      ",Lee 2019",
      " (Lee 2019)",
      "(Lee 2019)",
      " - Lee et al. 2019",
      " – Lee et al 2019",
      " — Lee 2019",
      "—Lee et al. 2019",
      "–Lee 2019",
      " Lee & Kim 2019",
      ", Lee & Kim 2019",
      " (Lee et al. 2019)",
      " (Lee et al., 2019)",
      ", Lee et al., 2019",
      " (Lee and Kim 2019)",
      " (Lee & Kim, 2019)",
      " Lee et al. 2019",
      ", van der Berg 2019",
      ", O'Brien-Smith et al. 2020",
      ", Łukasiewicz 1999",
    ]) {
      expect(isNameSuffix(suffix, PEOPLE), suffix).toBe(true);
      expect(followsTitle(`${T}${suffix}`, T, PEOPLE), suffix).toBe(true);
    }
  });

  test("the surnames must be the dataset's people, after the same folding", () => {
    expect(isNameSuffix(", Lee 2019", [])).toBe(false);
    expect(isNameSuffix(", Lee 2019", ["Bo Park"])).toBe(false);
    expect(isNameSuffix(", Lee & Park 2019", ["Ada Lee"])).toBe(false);
    expect(isNameSuffix(", Lee & Park 2019", ["Ada Lee", "Park, B."])).toBe(true);
    // Folded alike: a creator written with an accent.
    expect(isNameSuffix(", Muller 2019", ["Anna Müller"])).toBe(true);
    // A word that is no author's is no author-year, whatever its shape.
    expect(followsTitle("EEG (Replication 2021)", "EEG", PEOPLE)).toBe(false);
    expect(followsTitle("EEG, Motor 2019", "EEG", PEOPLE)).toBe(false);
  });

  test("only the family name counts: before the comma of Family, Given, else the last word", () => {
    expect(familyNameOf("Kim, Mark")).toEqual(["kim"]);
    expect(familyNameOf("Ada Lee")).toEqual(["lee"]);
    expect(familyNameOf("Pat O'Brien-Smith")).toEqual(["obrien", "smith"]);
    expect(followsTitle("EEG (Mark 2019)", "EEG", ["Kim, Mark"])).toBe(false);
    expect(followsTitle("EEG (Kim 2019)", "EEG", ["Kim, Mark"])).toBe(true);
    expect(followsTitle("EEG, Ada 2019", "EEG", ["Ada Lee"])).toBe(false);
    // A particle before the family name is the family name's.
    expect(followsTitle("EEG, van der Berg 2019", "EEG", ["Jan van der Berg"])).toBe(true);
    expect(nameFollowsUpstream("EEG (Mark 2019)", [dataset("EEG")], ["Kim, Mark"])).toBe("differs");
  });

  test("the people are the dataset's Authors and the matched record's creators", () => {
    const src = [dataset("EEG", { creators: ["Lee, Ada"] })];
    expect(nameFollowsUpstream("EEG, Lee 2019", src)).toBe("matches");
    expect(nameFollowsUpstream("EEG, Park 2019", src)).toBe("differs");
    expect(nameFollowsUpstream("EEG, Park 2019", src, ["Bo Park"])).toBe("matches");
  });

  test("a parenthesis opens exactly when one closes it", () => {
    expect(isNameSuffix(" (Lee 2019", PEOPLE)).toBe(false);
    expect(isNameSuffix(", Lee 2019)", PEOPLE)).toBe(false);
  });

  test("a bare-space suffix needs et al. or two surnames, so no ordinary title word passes", () => {
    expect(isNameSuffix(" Lee 2019", PEOPLE)).toBe(false);
    expect(isNameSuffix(" Lee et al. 2019", PEOPLE)).toBe(true);
    expect(isNameSuffix(" Lee & Kim 2019", PEOPLE)).toBe(true);
  });

  test("nothing at all, and a known service's key, pass", () => {
    expect(isNameSuffix("")).toBe(true);
    expect(isNameSuffix("   ")).toBe(true);
    for (const s of NAME_SERVICES) expect(isNameSuffix(` (${s}:abc123)`), s).toBe(true);
    expect(isNameSuffix(", Lee 2019 (openneuro:ds004362)", PEOPLE)).toBe(true);
    // An unknown service, a capitalized one, a key with a blank, or a key before the author-year.
    expect(followsTitle("My data (eeg:motor)", "My data")).toBe(false);
    expect(isNameSuffix(" (Figshare:12192405)")).toBe(false);
    expect(isNameSuffix(" (figshare:1219 2405)")).toBe(false);
    expect(isNameSuffix(" (figshare:1), Lee 2019", PEOPLE)).toBe(false);
  });

  test("a suffix is the whole rest of the Name: a word after the year, or anything else, fails", () => {
    for (const rest of [
      " (fNIRS)",
      ": Lee 2019",
      "; Lee 2019",
      ", Lee 2019 EEG",
      ", Lee 2019, Kim 2020",
      ", lee 2019",
      ", Lee 19",
      ", Lee 2101",
      ", Lee 20190",
      " EEG",
    ]) {
      expect(isNameSuffix(rest, PEOPLE), rest).toBe(false);
      expect(followsTitle(`${T}${rest}`, T, PEOPLE), rest).toBe(false);
    }
  });

  test("closing punctuation that ends the title is not part of the suffix", () => {
    expect(followsTitle("Motor data., Lee 2019", "Motor data.", PEOPLE)).toBe(true);
    expect(followsTitle('"Quoted" data', '"Quoted" data')).toBe(true);
    expect(followsTitle("Data [raw], Lee 2019", "Data [raw]", PEOPLE)).toBe(true);
  });

  test("the grammar is anchored and reads a long text without blowing up", () => {
    expect(NAME_SUFFIX.source.startsWith("^")).toBe(true);
    expect(NAME_SUFFIX.source.endsWith("$")).toBe(true);
    expect(isNameSuffix(`, ${"Lee-".repeat(5000)}`, PEOPLE)).toBe(false);
    expect(isNameSuffix(` (${"van ".repeat(5000)}Lee 2019`, PEOPLE)).toBe(false);
  });

  test("no spaced suffix shape trips the naming rule of ADR 0107 (its key needs letters touching the year)", () => {
    for (const suffix of [
      ", Lee 2019",
      " (Lee et al., 2019)",
      " - Lee et al. 2019",
      " Lee & Kim 2019",
    ]) {
      expect(namingProblemOf(`Resting EEG${suffix}`), suffix).toBeNull();
    }
  });
});

describe("the four results", () => {
  test("the closed words", () => {
    expect([...NAME_UPSTREAM_RESULTS]).toEqual(["matches", "differs", "not_applicable", "unknown"]);
  });

  test("no upstream at all, or only publications, is not applicable", () => {
    expect(nameFollowsUpstream("Resting EEG", [])).toBe("not_applicable");
    expect(
      nameFollowsUpstream("Resting EEG", [
        dataset("A paper", { status: "publication", outcome: "source_is_publication" }),
      ]),
    ).toBe("not_applicable");
  });

  test("a read dataset whose title the Name does not follow differs", () => {
    expect(nameFollowsUpstream("Resting EEG (fNIRS)", [dataset("Resting EEG")])).toBe("differs");
  });

  test("several declared sources: following any one is a match", () => {
    const sources = [dataset("Another dataset"), dataset("Resting EEG")];
    expect(nameFollowsUpstream("Resting EEG", sources)).toBe("matches");
    expect(nameFollowsUpstream("Something else", sources)).toBe("differs");
  });

  test("a publication beside a dataset is ignored: the dataset decides", () => {
    const sources = [
      dataset("The paper", { status: "publication", outcome: "source_is_publication" }),
      dataset("Resting EEG"),
    ];
    expect(nameFollowsUpstream("The paper", sources)).toBe("differs");
    expect(nameFollowsUpstream("Resting EEG", sources)).toBe("matches");
  });

  test("what could not be read is unknown, never a guess either way", () => {
    for (const s of [
      dataset(null),
      dataset("  "),
      dataset("Resting EEG", { status: "fetch_failed", outcome: "unresolved" }),
      dataset(null, { status: "not_found", outcome: "unresolved" }),
      dataset(null, { status: "no_doi", outcome: "unresolved" }),
      dataset(null, { status: "not_checked", outcome: "unresolved" }),
      dataset("Some figure", { outcome: "unresolved" }),
    ]) {
      expect(nameFollowsUpstream("A name", [s]), JSON.stringify(s)).toBe("unknown");
      expect(nameFollowsUpstream("A name", [dataset("Other"), s]), JSON.stringify(s)).toBe(
        "unknown",
      );
    }
    expect(nameFollowsUpstream(null, [dataset("Resting EEG")])).toBe("unknown");
    expect(nameFollowsUpstream("​ ", [dataset("Resting EEG")])).toBe("unknown");
  });

  test("an upstream resolved to its latest version, not the one declared, is unknown when it differs", () => {
    const latest = dataset("Resting EEG, renamed", { resolved_latest: true });
    expect(nameFollowsUpstream("Resting EEG", [latest])).toBe("unknown");
    // A Name that follows the latest title still matches.
    expect(nameFollowsUpstream("Resting EEG, renamed", [latest])).toBe("matches");
  });

  test("which references resolve to the latest version", () => {
    const o = "source_datasets" as const;
    const refs: [SourceRef, boolean][] = [
      [{ kind: "openneuro_latest", ds: "ds000001", origin: o }, true],
      [{ kind: "doi", doi: "10.18112/openneuro.ds000001.v1.0.0", origin: o }, false],
      [{ kind: "figshare_article", id: "1", version: null, origin: o }, true],
      [{ kind: "figshare_article", id: "1", version: "2", origin: o }, false],
      [{ kind: "physionet", slug: "x", version: null, origin: o }, true],
      [{ kind: "physionet", slug: "x", version: "1.0.0", origin: o }, false],
      [{ kind: "doi", doi: "10.6084/m9.figshare.31871557", origin: o }, true],
      [{ kind: "doi", doi: "10.6084/m9.figshare.29979529.v1", origin: o }, false],
      [{ kind: "doi", doi: "10.5281/zenodo.1419151", origin: o }, false],
      [{ kind: "url", url: "https://example.org", origin: o }, false],
    ];
    for (const [ref, latest] of refs) expect(isLatestRef(ref), JSON.stringify(ref)).toBe(latest);
  });

  test("a match on a read source stands even beside an unread one", () => {
    expect(
      nameFollowsUpstream("Resting EEG", [
        dataset(null, { status: "fetch_failed", outcome: "unresolved" }),
        dataset("Resting EEG"),
      ]),
    ).toBe("matches");
  });

  test("README candidates neither match nor differ: only declared sources count", () => {
    const readme = (title: string | null, over: Partial<UpstreamTitleSource> = {}) =>
      dataset(title, { origin: "readme", ...over });
    expect(nameFollowsUpstream("Resting EEG", [readme("Resting EEG")])).toBe("not_applicable");
    expect(nameFollowsUpstream("Something else", [readme("Resting EEG")])).toBe("not_applicable");
    expect(
      nameFollowsUpstream("Something else", [
        readme(null, { status: "fetch_failed", outcome: "unresolved" }),
      ]),
    ).toBe("not_applicable");
    // Beside a declared source, a README candidate's title does not make a match.
    expect(nameFollowsUpstream("Resting EEG", [readme("Resting EEG"), dataset("Other")])).toBe(
      "differs",
    );
    for (const origin of ["related_identifiers", "attestation"]) {
      expect(nameFollowsUpstream("Something else", [dataset("Resting EEG", { origin })])).toBe(
        "differs",
      );
      expect(nameFollowsUpstream("Resting EEG", [dataset("Resting EEG", { origin })])).toBe(
        "matches",
      );
    }
  });

  test("the titles a card shows are the readable declared dataset titles, each once", () => {
    expect(
      upstreamDatasetTitles([
        dataset("Resting EEG"),
        dataset("Resting EEG"),
        dataset(null),
        dataset("Paper", { status: "publication" }),
        dataset("Candidate", { origin: "readme" }),
        dataset("Other"),
      ]),
    ).toEqual(["Resting EEG", "Other"]);
  });

  test("the result is a closed word: no title and no name is in it", () => {
    const r = nameFollowsUpstream("Secret Name 123", [dataset("Secret Title 456")]);
    expect(NAME_UPSTREAM_RESULTS).toContain(r);
    expect(r).not.toContain("Secret");
  });
});

describe("the nine datasets whose names drifted (real names, real registry titles)", () => {
  interface Fixture {
    dataset: string;
    name: string;
    sources: UpstreamTitleSource[];
  }
  const { datasets } = JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/name-follows-upstream/drift-datasets.json"),
      "utf8",
    ),
  ) as { datasets: Fixture[] };

  const EXPECTED: Record<string, string> = {
    // The Name is the upstream title, which itself begins with an author-year.
    nm000781: "matches",
    // The upstream title is the acronym "SVWM" and the Name expands it, but the upstream is an OSF
    // project, whose title is edited in place: whether it was renamed is an administrator's call.
    nm000690: "unknown",
    // The upstream title with " (fNIRS)" appended, which is not an author-year.
    nm000710: "differs",
    nm000716: "matches",
    // A version-less figshare DOI, resolved to its latest version: it still matches.
    nm000766: "matches",
    nm000778: "matches",
    // An OSF project, read through OSF; the Name is its title.
    nm000804: "matches",
    nm000805: "matches",
    nm000807: "differs",
  };

  test("each comes out as the owner's rule says", () => {
    expect(datasets.map((d) => d.dataset).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const d of datasets) {
      expect(`${d.dataset}: ${nameFollowsUpstream(d.name, d.sources)}`).toBe(
        `${d.dataset}: ${EXPECTED[d.dataset]}`,
      );
    }
  });

  test("each drifted one follows its title once the drift is undone", () => {
    for (const d of datasets.filter((x) => EXPECTED[x.dataset] !== "matches")) {
      const [title] = upstreamDatasetTitles(d.sources) as [string];
      expect(nameFollowsUpstream(title, d.sources), d.dataset).toBe("matches");
      expect(nameFollowsUpstream(`${title} v2`, d.sources), d.dataset).toBe("matches");
    }
  });
});
