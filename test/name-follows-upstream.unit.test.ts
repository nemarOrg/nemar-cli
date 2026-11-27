/**
 * The name rule (`shared/name-follows-upstream.ts`, the owner's rule of 2026-11-27): the closed
 * suffix grammar, the normalization, the four results, and the nine datasets whose names drifted
 * from their upstream titles, read from GitHub and the public registries on 2026-11-27
 * (`test/fixtures/name-follows-upstream/drift-datasets.json`; the sources are what the real
 * license-lineage resolver returned for each dataset_description.json).
 *
 * Mutation checks (applied one at a time to the module, run, restored from a copy):
 *  - the bare-space separator taking a single surname (`BARE_AUTHORS` = `AUTHORS`) turns
 *    "a bare-space suffix needs et al. or &" red;
 *  - not stripping the closing punctuation that ends a title (`TITLE_CLOSERS`) turns "closing
 *    punctuation that ends the title is not part of the suffix" red;
 *  - dropping `$` from `NAME_SUFFIX` turns "a suffix is the whole rest of the Name" red;
 *  - counting README sources toward `differs` turns "README sources can match, never differ" red.
 *
 * CI TIER: unit-pure. No network: the registry answers are the recorded fixture.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LineageOutcome } from "../shared/license-lineage";
import {
  NAME_SUFFIX,
  NAME_UPSTREAM_RESULTS,
  type UpstreamTitleSource,
  followsTitle,
  isNameSuffix,
  nameFollowsUpstream,
  normalizeTitle,
  upstreamDatasetTitles,
} from "../shared/name-follows-upstream";
import { namingProblemOf } from "../shared/naming-rule";

const T = "Replication Data for: fNIRS RSFC in Tinnitus";

function dataset(
  title: string | null,
  over: Partial<UpstreamTitleSource> = {},
): UpstreamTitleSource {
  return {
    title,
    status: "resolved",
    origin: "source_datasets",
    outcome: "compatible" as LineageOutcome,
    ...over,
  };
}

describe("the suffix grammar", () => {
  test("each of the owner's shapes passes", () => {
    for (const suffix of [
      ", Lee 2019",
      ",Lee 2019",
      " (Lee 2019)",
      "(Lee 2019)",
      " - Lee et al. 2019",
      " – Lee et al 2019",
      " — Lee 2019",
      " Lee & Kim 2019",
      ", Lee & Kim 2019",
      " (Lee et al. 2019)",
      " Lee et al. 2019",
      ", van der Berg 2019",
      ", O'Brien-Smith et al. 2020",
      ", Łukasiewicz 1999",
    ]) {
      expect(isNameSuffix(suffix), suffix).toBe(true);
      expect(followsTitle(`${T}${suffix}`, T), suffix).toBe(true);
    }
  });

  test("nothing at all, and the submission standards' final service key, pass", () => {
    expect(isNameSuffix("")).toBe(true);
    expect(isNameSuffix("   ")).toBe(true);
    expect(isNameSuffix(" (figshare:12192405)")).toBe(true);
    expect(isNameSuffix(", Lee 2019 (openneuro:ds004362)")).toBe(true);
    // The service word is lowercase, the key has no blank, and the key comes last.
    expect(isNameSuffix(" (Figshare:12192405)")).toBe(false);
    expect(isNameSuffix(" (figshare:1219 2405)")).toBe(false);
    expect(isNameSuffix(" (figshare:1), Lee 2019")).toBe(false);
  });

  test("a bare-space suffix needs et al. or &, so no ordinary title word passes", () => {
    expect(isNameSuffix(" Lee 2019")).toBe(false);
    expect(isNameSuffix(" Motor 2019")).toBe(false);
    expect(isNameSuffix(" Lee et al. 2019")).toBe(true);
    expect(isNameSuffix(" Lee & Kim 2019")).toBe(true);
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
      ", Lee and Kim 2019",
      " (Lee 2019",
      " EEG",
      " v2",
    ]) {
      expect(isNameSuffix(rest), rest).toBe(false);
      expect(followsTitle(`${T}${rest}`, T), rest).toBe(false);
    }
  });

  test("closing punctuation that ends the title is not part of the suffix", () => {
    expect(followsTitle("Data (v2), Lee 2019", "Data (v2)")).toBe(true);
    expect(followsTitle("Motor data., Lee 2019", "Motor data.")).toBe(true);
    expect(followsTitle('"Quoted" data', '"Quoted" data')).toBe(true);
  });

  test("the grammar is anchored and reads a long text without blowing up", () => {
    expect(NAME_SUFFIX.source.startsWith("^")).toBe(true);
    expect(NAME_SUFFIX.source.endsWith("$")).toBe(true);
    // A long run of what the surname pattern almost matches: answered, and false.
    expect(isNameSuffix(`, ${"Lee-".repeat(5000)}`)).toBe(false);
    expect(isNameSuffix(` (${"van ".repeat(5000)}Lee 2019`)).toBe(false);
  });

  test("no suffix shape trips the naming rule of ADR 0107 (its key needs letters touching the year)", () => {
    for (const suffix of [", Lee 2019", " (Lee 2019)", " - Lee et al. 2019", " Lee & Kim 2019"]) {
      expect(namingProblemOf(`Resting EEG${suffix}`), suffix).toBeNull();
    }
  });
});

describe("what is compared", () => {
  test("case, Unicode compatibility forms, punctuation, blanks and invisible characters are folded alike", () => {
    expect(normalizeTitle("  Couple’s  Brain-to-Brain\tSynchrony ")).toBe(
      "couples brain to brain synchrony",
    );
    // A full-width letter (NFKC), a soft hyphen and a zero-width space (invisible).
    expect(normalizeTitle("ＥＥＧ da­ta​ set")).toBe("eeg data set");
    expect(followsTitle("replication data for fnirs rsfc in tinnitus", T)).toBe(true);
    expect(followsTitle("Replication  Data for - fNIRS RSFC in Tinnitus", T)).toBe(true);
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
    expect(followsTitle(`Lee 2019: ${T}`, T)).toBe(false);
    expect(followsTitle(`${T}`, `Lee 2019: ${T}`)).toBe(false);
  });

  test("a title of only punctuation compares with nothing", () => {
    expect(followsTitle("Anything", " -- ")).toBe(false);
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
        dataset("A paper about resting EEG", {
          status: "publication",
          outcome: "source_is_publication",
        }),
      ]),
    ).toBe("not_applicable");
  });

  test("a read dataset whose title the Name does not follow differs", () => {
    expect(nameFollowsUpstream("Resting EEG (fNIRS)", [dataset("Resting EEG")])).toBe("differs");
  });

  test("several sources: following any one is a match", () => {
    const sources = [dataset("Another dataset"), dataset("Resting EEG")];
    expect(nameFollowsUpstream("Resting EEG, Lee 2019", sources)).toBe("matches");
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
      // A record read but whose kind the lineage could not settle (a figshare figure, say).
      dataset("Some figure", { outcome: "unresolved" }),
    ]) {
      expect(nameFollowsUpstream("A name", [s]), JSON.stringify(s)).toBe("unknown");
      // Beside a read dataset the Name does not follow, an unread one might be the match.
      expect(nameFollowsUpstream("A name", [dataset("Other"), s]), JSON.stringify(s)).toBe(
        "unknown",
      );
    }
    // A Name that could not be read, with a dataset to follow.
    expect(nameFollowsUpstream(null, [dataset("Resting EEG")])).toBe("unknown");
    expect(nameFollowsUpstream("​ ", [dataset("Resting EEG")])).toBe("unknown");
  });

  test("a match on a read source stands even beside an unread one", () => {
    expect(
      nameFollowsUpstream("Resting EEG", [
        dataset(null, { status: "fetch_failed", outcome: "unresolved" }),
        dataset("Resting EEG"),
      ]),
    ).toBe("matches");
  });

  test("README sources can match, never differ or be unknown: they are candidates, not declarations", () => {
    const readme = (title: string | null, over: Partial<UpstreamTitleSource> = {}) =>
      dataset(title, { origin: "readme", ...over });
    expect(nameFollowsUpstream("Resting EEG", [readme("Resting EEG")])).toBe("matches");
    expect(nameFollowsUpstream("Something else", [readme("Resting EEG")])).toBe("not_applicable");
    expect(
      nameFollowsUpstream("Something else", [
        readme(null, { status: "fetch_failed", outcome: "unresolved" }),
      ]),
    ).toBe("not_applicable");
    // The enrichment's relations and the attestation are declarations.
    for (const origin of ["related_identifiers", "attestation"]) {
      expect(nameFollowsUpstream("Something else", [dataset("Resting EEG", { origin })])).toBe(
        "differs",
      );
    }
  });

  test("the titles a card shows are the readable dataset titles, each once", () => {
    expect(
      upstreamDatasetTitles([
        dataset("Resting EEG"),
        dataset("Resting EEG"),
        dataset(null),
        dataset("Paper", { status: "publication" }),
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
    // The upstream title is the acronym "SVWM"; the Name expands it.
    nm000690: "differs",
    // The upstream title with " (fNIRS)" appended, which is not an author-year.
    nm000710: "differs",
    nm000716: "matches",
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

  test("each drifted one follows its title once the drift is undone, with an author-year allowed", () => {
    for (const d of datasets.filter((x) => EXPECTED[x.dataset] === "differs")) {
      const [title] = upstreamDatasetTitles(d.sources) as [string];
      expect(nameFollowsUpstream(title, d.sources), d.dataset).toBe("matches");
      expect(nameFollowsUpstream(`${title}, Lee et al. 2020`, d.sources), d.dataset).toBe(
        "matches",
      );
    }
  });
});
