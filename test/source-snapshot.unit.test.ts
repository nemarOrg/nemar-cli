/**
 * shared/source-snapshot.ts: which upstream tag a dataset description declares (epic #1046
 * phase 2, #1908; ADR 0111, decision 4).
 *
 * The inputs are `dataset_description.json` shapes. The `OpenNeuro DOI form` fixtures are the
 * shapes `applyConceptDoiToDescription` produces in practice: OpenNeuro's original `DatasetDOI`
 * moved into `SourceDatasets` as `{DOI}` alone, written as upstream wrote it.
 *
 * The table pins the rule that matters most: a tag is never guessed. Disagreement between two
 * signals, between two own entries, or an entry that names two datasets is `unknown`; so is an
 * entry that names no dataset (a bare `Version` says nothing about whose it is) and the
 * top-level `Version`, which is NEMAR's own.
 */

import { describe, expect, test } from "bun:test";
import {
  compareSourceTags,
  isOwnSourceEntry,
  mirrorFlagOf,
  mirroredTagOf,
  openNeuroSourceId,
  sourceSnapshotOf,
} from "../shared/source-snapshot";

const DS = "ds000001";
const UNKNOWN = { source_version: null, source_version_basis: "unknown" };
const known = (tag: string) => ({ source_version: tag, source_version_basis: "doi" });
const withSources = (...entries: unknown[]) => ({ Name: "x", SourceDatasets: entries });

describe("sourceSnapshotOf: one tag from the dataset's own entry", () => {
  test("a DOI alone, in the three forms upstream writes it", () => {
    const doi = "10.18112/openneuro.ds000001.v2.0.2";
    for (const form of [doi, `doi:${doi}`, `https://doi.org/${doi}`, `http://dx.doi.org/${doi}`]) {
      expect(sourceSnapshotOf(withSources({ DOI: form }), DS)).toEqual(known("2.0.2"));
    }
  });

  test("a legacy tag keeps its zeros", () => {
    const desc = withSources({ DOI: "10.18112/openneuro.ds000001.v00001" });
    expect(sourceSnapshotOf(desc, DS)).toEqual(known("00001"));
  });

  test("the entry's Version, DOI and URL that agree give the tag", () => {
    const desc = withSources({
      DOI: "doi:10.18112/openneuro.ds000001.v2.0.2",
      URL: "https://openneuro.org/datasets/ds000001/versions/2.0.2",
      Version: "2.0.2",
    });
    expect(sourceSnapshotOf(desc, DS)).toEqual(known("2.0.2"));
  });

  test("a URL alone, from OpenNeuro and from its GitHub mirror", () => {
    for (const url of [
      "https://openneuro.org/datasets/ds000001/versions/1.0.1",
      "https://openneuro.org/datasets/ds000001/versions/1.0.1/",
      "https://github.com/OpenNeuroDatasets/ds000001/tree/1.0.1",
      "https://github.com/OpenNeuroDatasets/ds000001/releases/tag/1.0.1",
    ]) {
      expect(sourceSnapshotOf(withSources({ URL: url }), DS)).toEqual(known("1.0.1"));
    }
  });

  test("a Version beside a DOI that names the dataset, with a leading v stripped", () => {
    const desc = withSources({ DOI: "10.18112/openneuro.ds000001", Version: "v1.2.3" });
    expect(sourceSnapshotOf(desc, DS)).toEqual(known("1.2.3"));
  });

  test("a different-case ds is the same dataset", () => {
    const desc = withSources({ DOI: "10.18112/OpenNeuro.DS000001.v1.0.0" });
    expect(sourceSnapshotOf(desc, "DS000001")).toEqual(known("1.0.0"));
  });

  test("a single-object SourceDatasets is read like a one-entry array", () => {
    const desc = { SourceDatasets: { DOI: "10.18112/openneuro.ds000001.v1.0.0" } };
    expect(sourceSnapshotOf(desc, DS)).toEqual(known("1.0.0"));
  });

  test("two own entries that agree give the tag", () => {
    const desc = withSources(
      { DOI: "10.18112/openneuro.ds000001.v1.0.0" },
      { URL: "https://openneuro.org/datasets/ds000001/versions/1.0.0" },
    );
    expect(sourceSnapshotOf(desc, DS)).toEqual(known("1.0.0"));
  });

  test("an entry for another dataset beside the own one is ignored, even with a different tag", () => {
    const desc = withSources(
      { DOI: "10.18112/openneuro.ds000002.v9.9.9", Version: "9.9.9" },
      { DOI: "10.18112/openneuro.ds000001.v1.0.0" },
    );
    expect(sourceSnapshotOf(desc, DS)).toEqual(known("1.0.0"));
  });
});

describe("sourceSnapshotOf: unknown is never a guess", () => {
  test("the entry's Version against its DOI disagrees", () => {
    const desc = withSources({
      DOI: "10.18112/openneuro.ds000001.v2.0.2",
      Version: "2.0.1",
    });
    expect(sourceSnapshotOf(desc, DS)).toEqual(UNKNOWN);
  });

  test("a DOI against a URL disagrees", () => {
    const desc = withSources({
      DOI: "10.18112/openneuro.ds000001.v2.0.2",
      URL: "https://openneuro.org/datasets/ds000001/versions/2.0.1",
    });
    expect(sourceSnapshotOf(desc, DS)).toEqual(UNKNOWN);
  });

  test("two own entries that differ disagree", () => {
    const desc = withSources(
      { DOI: "10.18112/openneuro.ds000001.v1.0.0" },
      { DOI: "10.18112/openneuro.ds000001.v1.0.1" },
    );
    expect(sourceSnapshotOf(desc, DS)).toEqual(UNKNOWN);
  });

  test("00001 and 1 are different tags, so they disagree", () => {
    const desc = withSources({
      DOI: "10.18112/openneuro.ds000001.v00001",
      Version: "1",
    });
    expect(sourceSnapshotOf(desc, DS)).toEqual(UNKNOWN);
  });

  test("an entry that names two datasets cannot say which one its tag is", () => {
    const desc = withSources({
      DOI: "10.18112/openneuro.ds000001.v1.0.0",
      URL: "https://openneuro.org/datasets/ds000002/versions/1.0.0",
    });
    expect(sourceSnapshotOf(desc, DS)).toEqual(UNKNOWN);
  });

  test("a Version with no DOI or URL naming a dataset is ignored", () => {
    expect(sourceSnapshotOf(withSources({ Version: "1.0.0" }), DS)).toEqual(UNKNOWN);
    expect(sourceSnapshotOf(withSources({ Name: "x", Version: "1.0.0" }), DS)).toEqual(UNKNOWN);
  });

  test("the top-level Version and DatasetDOI are NEMAR's and are never read", () => {
    const desc = {
      Version: "1.0.0",
      DatasetDOI: "doi:10.18112/openneuro.ds000001.v1.0.0",
      SourceDatasets: [],
    };
    expect(sourceSnapshotOf(desc, DS)).toEqual(UNKNOWN);
  });

  test("a DOI of another registrant is not a signal", () => {
    const desc = withSources({ DOI: "10.5281/zenodo.123456", Version: "1.0.0" });
    expect(sourceSnapshotOf(desc, DS)).toEqual(UNKNOWN);
  });

  test("a DOI or URL that names the dataset without a tag is no tag", () => {
    expect(sourceSnapshotOf(withSources({ DOI: "10.18112/openneuro.ds000001" }), DS)).toEqual(
      UNKNOWN,
    );
    expect(
      sourceSnapshotOf(withSources({ URL: "https://openneuro.org/datasets/ds000001" }), DS),
    ).toEqual(UNKNOWN);
  });

  test("a garbled tag gives no signal, and the readable one beside it stands", () => {
    expect(
      sourceSnapshotOf(withSources({ DOI: "10.18112/openneuro.ds000001.v2.0.2." }), DS),
    ).toEqual(UNKNOWN);
    expect(
      sourceSnapshotOf(
        withSources({ DOI: "10.18112/openneuro.ds000001.v2.0.x", Version: "v2.0.2." }),
        DS,
      ),
    ).toEqual(UNKNOWN);
    expect(
      sourceSnapshotOf(
        withSources({ DOI: "10.18112/openneuro.ds000001.v2.0.2.", Version: "2.0.2" }),
        DS,
      ),
    ).toEqual(known("2.0.2"));
  });

  test("a Version that is not a string is no signal", () => {
    const desc = withSources({ DOI: "10.18112/openneuro.ds000001", Version: 2 });
    expect(sourceSnapshotOf(desc, DS)).toEqual(UNKNOWN);
  });

  test("a description that is missing, empty, null or not an object", () => {
    for (const desc of [undefined, null, {}, [], "text", 7, { SourceDatasets: "ds000001" }]) {
      expect(sourceSnapshotOf(desc, DS)).toEqual(UNKNOWN);
    }
  });

  test("entries that are not objects are skipped", () => {
    const desc = withSources(null, "x", 4, [], { DOI: "10.18112/openneuro.ds000001.v1.0.0" });
    expect(sourceSnapshotOf(desc, DS)).toEqual(known("1.0.0"));
  });

  test("a source id that is not an OpenNeuro ds names nothing", () => {
    const desc = withSources({ DOI: "10.18112/openneuro.ds000001.v1.0.0" });
    for (const id of ["", "on000001", "ds1", "nm000001"]) {
      expect(sourceSnapshotOf(desc, id)).toEqual(UNKNOWN);
    }
  });
});

describe("isOwnSourceEntry", () => {
  const own = { DOI: "10.18112/openneuro.ds000001.v1.0.0", Version: "1.0.0" };

  test("an entry whose DOI or URL names the dataset is its own", () => {
    expect(isOwnSourceEntry(own, DS)).toBe(true);
    expect(isOwnSourceEntry({ URL: "https://openneuro.org/datasets/ds000001" }, DS)).toBe(true);
  });

  test("another dataset's entry, a bare Version and a non-object are not", () => {
    expect(isOwnSourceEntry({ DOI: "10.18112/openneuro.ds000002.v1.0.0" }, DS)).toBe(false);
    expect(isOwnSourceEntry({ Version: "1.0.0" }, DS)).toBe(false);
    for (const entry of [null, undefined, "ds000001", 3, []]) {
      expect(isOwnSourceEntry(entry, DS)).toBe(false);
    }
  });

  test("an entry that names this dataset and another is still found, so a re-pull can rewrite it", () => {
    const both = {
      DOI: "10.18112/openneuro.ds000001.v1.0.0",
      URL: "https://openneuro.org/datasets/ds000002/versions/1.0.0",
    };
    expect(isOwnSourceEntry(both, DS)).toBe(true);
  });
});

describe("openNeuroSourceId", () => {
  test("on###### maps to ds######, and nothing else does", () => {
    expect(openNeuroSourceId("on004362")).toBe("ds004362");
    for (const id of ["nm000103", "xx000001", "ds004362", "on4362", "on0043620", "ON004362"]) {
      expect(openNeuroSourceId(id)).toBeNull();
    }
  });
});

describe("compareSourceTags", () => {
  test("numeric, component by component", () => {
    expect(compareSourceTags("2.0.10", "2.0.9")).toBeGreaterThan(0);
    expect(compareSourceTags("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareSourceTags("10.0.0", "9.9.9")).toBeGreaterThan(0);
  });

  test("a legacy tag equals its number, and a missing component is 0", () => {
    expect(compareSourceTags("00001", "1")).toBe(0);
    expect(compareSourceTags("00002", "00001")).toBeGreaterThan(0);
    expect(compareSourceTags("2.0", "2.0.0")).toBe(0);
  });

  test("a tag that cannot be read is never ordered", () => {
    for (const bad of ["", "v2.0.2", "2.0.x", "2.0.2.", "latest", "1.2.3.4.5"]) {
      expect(compareSourceTags(bad, "1.0.0")).toBeNull();
      expect(compareSourceTags("1.0.0", bad)).toBeNull();
    }
  });
});

describe("mirroredTagOf: the highest NEMAR version speaks", () => {
  const row = (version: string, tag: string | null, basis: string | null) => ({
    version,
    source_version: tag,
    source_version_basis: basis,
  });

  test("10.0.0 beats 9.0.0, which a string sort would get wrong", () => {
    const rows = [row("9.0.0", "9.0.0", "doi"), row("10.0.0", "10.0.0", "doi")];
    expect(mirroredTagOf(rows)).toEqual({
      state: "known",
      tag: "10.0.0",
      version: "10.0.0",
      basis: "doi",
    });
  });

  test("a newer row that was never examined is unexamined, however well an older one is known", () => {
    const rows = [row("1.0.0", "2.0.2", "doi"), row("1.0.1", null, null)];
    expect(mirroredTagOf(rows)).toEqual({ state: "unexamined", tag: null, version: "1.0.1" });
  });

  test("a newer row that is unknown is unknown", () => {
    const rows = [row("1.0.0", "2.0.2", "doi"), row("2.0.0", null, "unknown")];
    expect(mirroredTagOf(rows)).toEqual({ state: "unknown", tag: null, version: "2.0.0" });
  });

  test("a lineage row is known, with its basis", () => {
    expect(mirroredTagOf([row("2.0.0", "3.0.0", "lineage")])).toEqual({
      state: "known",
      tag: "3.0.0",
      version: "2.0.0",
      basis: "lineage",
    });
  });

  test("no rows, or no NEMAR-numbered row, is none", () => {
    expect(mirroredTagOf([])).toEqual({ state: "none", tag: null, version: null });
    expect(mirroredTagOf([row("v1", "1.0.0", "doi"), row("draft", null, null)])).toEqual({
      state: "none",
      tag: null,
      version: null,
    });
  });

  test("a row with a tag but no recognized basis is never trusted as known", () => {
    expect(mirroredTagOf([row("1.0.0", "2.0.2", null)]).state).toBe("unexamined");
    expect(mirroredTagOf([row("1.0.0", "2.0.2", "guess")]).state).toBe("unexamined");
  });

  test("a stored tag the parser could not have recorded is unknown, as mirrorFlagOf reads it", () => {
    // The staleness pass and the mirror flag share one definition of a known tag.
    for (const tag of ["", "57fecb0ccce88d000ac17538", "v2.0.2."]) {
      const rows = [{ version: "1.0.0", source_version: tag, source_version_basis: "doi" }];
      expect(mirroredTagOf(rows)).toEqual({ state: "unknown", tag: null, version: "1.0.0" });
      expect(
        mirrorFlagOf("on000001", {
          version: "1.0.0",
          source_version: tag,
          source_version_basis: "doi",
        }),
      ).toBeNull();
    }
    const legacy = [{ version: "1.0.0", source_version: "00006", source_version_basis: "doi" }];
    expect(mirroredTagOf(legacy)).toMatchObject({ state: "known", tag: "00006" });
  });
});

describe("mirrorFlagOf: a version of an OpenNeuro mirror is a mirror only when its tag is known", () => {
  const doi = { source_version: "2.0.2", source_version_basis: "doi" };
  const lineage = { source_version: "3.0.0", source_version_basis: "lineage" };
  const unknown = { source_version: null, source_version_basis: "unknown" };
  const never = { source_version: null, source_version_basis: null };

  test("true: an N.0.0 of an on###### dataset with a known tag, in any stored form", () => {
    expect(mirrorFlagOf("on000001", { version: "1.0.0", ...doi })).toBe(true);
    expect(mirrorFlagOf("on000001", { version: "v4.0.0", ...lineage })).toBe(true);
    expect(mirrorFlagOf("on000001", { version: "10.0.0", ...doi })).toBe(true);
  });

  test("null: an N.0.0 of a mirror whose tag is unknown or was never examined; absent columns too", () => {
    expect(mirrorFlagOf("on000001", { version: "2.0.0", ...unknown })).toBeNull();
    expect(mirrorFlagOf("on000001", { version: "3.0.0", ...never })).toBeNull();
    expect(mirrorFlagOf("on000001", { version: "3.0.0" })).toBeNull();
    // An empty or unreadable tag is not a known tag, whatever the basis says.
    for (const tag of ["", "v2.0.2.", "57fecb0ccce88d000ac17538"]) {
      expect(
        mirrorFlagOf("on000001", {
          version: "3.0.0",
          source_version: tag,
          source_version_basis: "doi",
        }),
      ).toBeNull();
    }
    // A legacy numeric tag still counts.
    expect(
      mirrorFlagOf("on000001", {
        version: "3.0.0",
        source_version: "00006",
        source_version_basis: "doi",
      }),
    ).toBe(true);
    // A basis without a tag is not a known tag either (the table's CHECK forbids the row; the
    // function does not rely on that).
    expect(
      mirrorFlagOf("on000001", {
        version: "3.0.0",
        source_version: null,
        source_version_basis: "doi",
      }),
    ).toBeNull();
    // A tag with no readable basis is not a known tag.
    expect(
      mirrorFlagOf("on000001", {
        version: "3.0.0",
        source_version: "1.0.0",
        source_version_basis: null,
      }),
    ).toBeNull();
    expect(
      mirrorFlagOf("on000001", {
        version: "3.0.0",
        source_version: "1.0.0",
        source_version_basis: "nope",
      }),
    ).toBeNull();
  });

  test("false: a version that is not N.0.0, whatever it knows", () => {
    for (const version of ["1.0.1", "1.1.0", "v2.0.1", "1.0", "1.0.0.0", "x1.0.0", "1.0.00"]) {
      expect(mirrorFlagOf("on000001", { version, ...doi })).toBe(false);
      expect(mirrorFlagOf("on000001", { version, ...never })).toBe(false);
    }
  });

  test("false: any dataset that is not an on###### mirror, even with a tag recorded", () => {
    for (const id of ["nm000200", "xx000001", "ds000001", "on00001", "on0000011", "ON000001"]) {
      expect(mirrorFlagOf(id, { version: "1.0.0", ...doi })).toBe(false);
      expect(mirrorFlagOf(id, { version: "1.0.0", ...never })).toBe(false);
    }
  });
});
