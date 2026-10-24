/**
 * Supplements to `repull-plan.test.ts` for two rules the fixture's one description and one README
 * cannot vary enough to falsify (ADR 0111, decision 1, and its Phase 5 amendment):
 *
 * - `SourceDatasets` merges three-way as a set: what either side added is kept, what upstream
 *   removed is not brought back, what NEMAR removed stays removed, and a `null` entry (on which
 *   `applyConceptDoiToDescription` throws) is merged as a value;
 * - a README badge is stripped only in a spelling NEMAR has written, and only when its image and
 *   its link name the same DOI.
 *
 * The entry point drives the description and the README family in `repull-plan.test.ts`; these
 * call `mergeDescription` and `badgeStrips` directly because no real mirror in the fixture holds a
 * second source entry or a mismatched badge.
 */

import { describe, expect, test } from "bun:test";
import { buildDoiBadge } from "../shared/standard-edits/readme";
import { mergeDescription } from "../src/lib/repull/description";
import { badgeStrips } from "../src/lib/repull/overlay";

const DS = "ds099999";
const own = (tag: string) => ({ DOI: `10.18112/openneuro.${DS}.v${tag}` });
const OTHER = { DOI: "10.18112/openneuro.ds000001.v1.0.0" };
const KEPT = { URL: "https://example.org/kept" };
const ADDED_UP = { URL: "https://example.org/upstream-added" };
const ADDED_NEMAR = { URL: "https://example.org/nemar-added" };

function side(desc: unknown) {
  return { present: true, bytes: Buffer.from(JSON.stringify(desc)) };
}

describe("SourceDatasets merges three-way", () => {
  const merged = mergeDescription({
    base: side({ Name: "x", SourceDatasets: [OTHER, KEPT, own("1.0.0")] }),
    theirs: side({ Name: "x", SourceDatasets: [KEPT, ADDED_UP, own("1.1.0"), null] }),
    ours: side({
      Name: "x",
      DatasetDOI: "10.82901/nemar.on099999",
      SourceDatasets: [OTHER, own("1.0.0"), ADDED_NEMAR],
    }),
    ds: DS,
    toTag: "1.1.0",
    nextVersion: "2.0.0",
  });
  const out = JSON.parse(merged.mergedJson as string);

  test("keeps what either side added and drops what either side removed", () => {
    // OTHER: upstream removed it, so it is not brought back.
    // KEPT: NEMAR removed it while upstream kept it, so it stays removed.
    expect(out.SourceDatasets).toEqual([
      ADDED_UP,
      null,
      ADDED_NEMAR,
      {
        DOI: `doi:10.18112/openneuro.${DS}.v1.1.0`,
        URL: `https://openneuro.org/datasets/${DS}/versions/1.1.0`,
        Version: "1.1.0",
      },
    ]);
    expect(merged.sourceDatasets).toEqual({ kept: 2, addedByNemar: 1, removedByUpstream: 1 });
  });

  test("NEMAR's own fields are ours and N.0.0", () => {
    expect(out.DatasetDOI).toBe("10.82901/nemar.on099999");
    expect(out.Version).toBe("2.0.0");
    expect(merged.status).toBe("merged");
  });

  test("a side that does not parse is unmergeable as a whole", () => {
    const bad = mergeDescription({
      base: side({ Name: "x" }),
      theirs: { present: true, bytes: Buffer.from("{ not json") },
      ours: side({ Name: "x" }),
      ds: DS,
      toTag: "1.1.0",
      nextVersion: "2.0.0",
    });
    expect(bad.status).toBe("unparseable");
    expect(bad.mergedJson).toBeNull();
    expect(bad.explained).toBe(false);
  });
});

describe("badgeStrips", () => {
  const doi = "10.82901/nemar.on099999";
  const zenodo = `[![DOI](https://zenodo.org/badge/DOI/${doi}.svg)](https://doi.org/${doi})`;

  test("strips the current spelling, the legacy Zenodo one, and a stack of them", () => {
    const text = `${buildDoiBadge(doi)}\n\n${zenodo}\n\nBody.\n`;
    expect(badgeStrips(text)).toEqual([text, `${zenodo}\n\nBody.\n`, "Body.\n"]);
  });

  test("leaves a badge whose image names another DOI than its link", () => {
    const forged = `[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.1.svg)](https://doi.org/${doi})\n\nBody.\n`;
    expect(badgeStrips(forged)).toEqual([forged]);
  });
});
