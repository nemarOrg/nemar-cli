/**
 * What the import's upstream-moved guard reads as the tag a dataset's `dataset_description.json`
 * records (epic #1046 Phase 3, ADR 0111 decisions 4 and 10). The guard reads it with Phase 2's
 * shared parser, `sourceSnapshotOf` (shared/source-snapshot.ts, tested in full by
 * test/source-snapshot.unit.test.ts); these are the shapes the import meets and writes, pinned so
 * the guard's contract is visible from this side.
 *
 * Phase 3 first shipped its own reader. Three of its behaviors differ from the shared parser, which
 * wins, and the cases below that changed with the swap say so:
 *   1. a tag is numeric and dotted (`1.0.0`, `00006`); `2.1.0-rc1` and a 24-hex snapshot id, which
 *      OpenNeuro's tag shape admits, are no tag;
 *   2. an entry whose fields name this dataset and another one gives no tag at all, where the old
 *      reader counted the field naming this dataset;
 *   3. of the GitHub mirror's URLs, the tree and release forms name the dataset and the `.git`
 *      clone URL does not.
 *
 * The first two fixtures are the live descriptions of on003645 and on004362 as nemarDatasets
 * served them on 2026-10-24, because they are the shape the guard meets first: a NEMAR `Version`
 * of `1.0.0` beside a `SourceDatasets` entry that names the upstream tag only in its DOI.
 */

import { describe, expect, test } from "bun:test";
import { isOpenNeuroTag, sameUpstreamTag } from "../shared/openneuro-tag";
import { sourceSnapshotOf } from "../shared/source-snapshot";
import { hasSourceEntryFor } from "../src/lib/import-openneuro";

const tagOf = (desc: unknown, ds: string): string | null =>
  sourceSnapshotOf(desc, ds).source_version;

const ON003645 = {
  Name: "Face processing MEEG dataset with HED annotation",
  DatasetDOI: "10.82901/nemar.on003645",
  SourceDatasets: [{ DOI: "doi:10.18112/openneuro.ds003645.v2.0.2" }],
  Version: "1.0.0",
};
const ON004362 = {
  Name: "EEG Motor Movement/Imagery Dataset",
  DatasetDOI: "10.82901/nemar.on004362",
  SourceDatasets: [{ DOI: "doi:10.18112/openneuro.ds004362.v1.0.0" }],
  Version: "1.0.0",
};

describe("what the live mirrors record", () => {
  test("the tag comes from the entry's DOI, never from NEMAR's own Version", () => {
    expect(tagOf(ON003645, "ds003645")).toBe("2.0.2");
    expect(tagOf(ON004362, "ds004362")).toBe("1.0.0");
  });

  test("NEMAR's own Version alone records nothing", () => {
    expect(tagOf({ Version: "1.0.0" }, "ds004362")).toBeNull();
  });
});

describe("each field of the entry can carry the tag", () => {
  const ds = "ds004362";
  test("the entry this import writes: DOI, URL and Version, all from the tag", () => {
    const entry = {
      DOI: "doi:10.18112/openneuro.ds004362.v1.0.1",
      URL: "https://openneuro.org/datasets/ds004362/versions/1.0.1",
      Version: "1.0.1",
    };
    expect(tagOf({ SourceDatasets: [entry] }, ds)).toBe("1.0.1");
  });

  test("a DOI in any of its usual spellings", () => {
    for (const DOI of [
      "10.18112/openneuro.ds004362.v1.0.0",
      "doi:10.18112/openneuro.ds004362.v1.0.0",
      "https://doi.org/10.18112/openneuro.ds004362.v1.0.0",
      "http://dx.doi.org/10.18112/openneuro.ds004362.v1.0.0",
      "DOI:10.18112/OpenNeuro.ds004362.v1.0.0",
    ]) {
      expect(tagOf({ SourceDatasets: [{ DOI }] }, ds)).toBe("1.0.0");
    }
  });

  test("a URL alone", () => {
    for (const URL of [
      "https://openneuro.org/datasets/ds004362/versions/1.0.0",
      "https://openneuro.org/datasets/ds004362/versions/1.0.0/",
      "https://openneuro.org/datasets/ds004362/versions/1.0.0?tab=files",
    ]) {
      expect(tagOf({ SourceDatasets: [{ URL }] }, ds)).toBe("1.0.0");
    }
  });

  test("a leading v is dropped from Version, and OpenNeuro's legacy tags read as tags", () => {
    expect(
      tagOf(
        { SourceDatasets: [{ URL: "https://openneuro.org/datasets/ds004362", Version: "v1.0.0" }] },
        ds,
      ),
    ).toBe("1.0.0");
    expect(tagOf({ SourceDatasets: [{ DOI: "doi:10.18112/openneuro.ds004362.v00006" }] }, ds)).toBe(
      "00006",
    );
  });
});

describe("unknown is an answer, never a guess", () => {
  const ds = "ds004362";
  test("fields of one entry that disagree", () => {
    const entry = { DOI: "doi:10.18112/openneuro.ds004362.v1.0.0", Version: "1.0.1" };
    expect(tagOf({ SourceDatasets: [entry] }, ds)).toBeNull();
  });

  test("two entries for this dataset that disagree", () => {
    const desc = {
      SourceDatasets: [
        { DOI: "doi:10.18112/openneuro.ds004362.v1.0.0" },
        { URL: "https://openneuro.org/datasets/ds004362/versions/1.0.1" },
      ],
    };
    expect(tagOf(desc, ds)).toBeNull();
    expect(hasSourceEntryFor(desc, ds)).toBe(true);
  });

  test("two entries that agree are one answer", () => {
    expect(
      tagOf(
        {
          SourceDatasets: [
            { DOI: "doi:10.18112/openneuro.ds004362.v1.0.0" },
            { URL: "https://openneuro.org/datasets/ds004362/versions/1.0.0", Version: "1.0.0" },
          ],
        },
        ds,
      ),
    ).toBe("1.0.0");
  });

  test("changed with the swap (2): an entry naming this dataset and another gives no tag", () => {
    const both = {
      DOI: "doi:10.18112/openneuro.ds004362.v1.0.0",
      URL: "https://openneuro.org/datasets/ds000002/versions/1.0.0",
    };
    expect(tagOf({ SourceDatasets: [both] }, ds)).toBeNull();
    // It is still the dataset's entry, so the guard says the tag is unreadable, not absent.
    expect(hasSourceEntryFor({ SourceDatasets: [both] }, ds)).toBe(true);
  });

  test("an entry for another dataset is not this one's, however close its id", () => {
    const other = {
      SourceDatasets: [
        { DOI: "doi:10.18112/openneuro.ds000002.v3.0.0" },
        { DOI: "doi:10.18112/openneuro.ds0043621.v9.0.0" },
        { URL: "https://openneuro.org/datasets/ds0043620/versions/9.0.0" },
      ],
    };
    expect(tagOf(other, ds)).toBeNull();
    expect(hasSourceEntryFor(other, ds)).toBe(false);
    const mixed = {
      SourceDatasets: [...other.SourceDatasets, { DOI: "doi:10.18112/openneuro.ds004362.v1.0.0" }],
    };
    expect(tagOf(mixed, ds)).toBe("1.0.0");
  });

  test("a Version with nothing tying it to this dataset", () => {
    expect(tagOf({ SourceDatasets: [{ Version: "1.0.0" }] }, ds)).toBeNull();
    expect(hasSourceEntryFor({ SourceDatasets: [{ Version: "1.0.0" }] }, ds)).toBe(false);
  });

  test("the concept DOI names the dataset and no tag", () => {
    const desc = { SourceDatasets: [{ DOI: "doi:10.18112/openneuro.ds004362" }] };
    expect(tagOf(desc, ds)).toBeNull();
    expect(hasSourceEntryFor(desc, ds)).toBe(true);
  });

  test("a single-object SourceDatasets is one entry, to the guard and to hasSourceEntryFor", () => {
    const desc = { SourceDatasets: { DOI: "doi:10.18112/openneuro.ds004362" } };
    expect(hasSourceEntryFor(desc, ds)).toBe(true);
    expect(tagOf({ SourceDatasets: { DOI: "10.18112/openneuro.ds004362.v1.0.0" } }, ds)).toBe(
      "1.0.0",
    );
  });

  test("nothing usable at all", () => {
    for (const desc of [
      null,
      "text",
      [],
      {},
      { SourceDatasets: "doi:10.18112/openneuro.ds004362.v1.0.0" },
      { SourceDatasets: [null, 3, "x", []] },
    ]) {
      expect(tagOf(desc, ds)).toBeNull();
      expect(hasSourceEntryFor(desc, ds)).toBe(false);
    }
    // This one names the dataset; its tag is what cannot be read.
    const garbled = { SourceDatasets: [{ DOI: "doi:10.18112/openneuro.ds004362.vlatest; rm" }] };
    expect(tagOf(garbled, ds)).toBeNull();
    expect(hasSourceEntryFor(garbled, ds)).toBe(true);
  });

  test("changed with the swap (1): a tag OpenNeuro's shape admits but the parser does not read", () => {
    for (const tag of ["2.1.0-rc1", "57fecb0ccce88d000ac17538", "latest"]) {
      expect(isOpenNeuroTag(tag)).toBe(true);
      const desc = { SourceDatasets: [{ DOI: `doi:10.18112/openneuro.ds004362.v${tag}` }] };
      expect(tagOf(desc, ds)).toBeNull();
    }
  });
});

describe("only OpenNeuro's own URLs, and its GitHub mirror's, name an OpenNeuro snapshot", () => {
  const ds = "ds004362";
  test("a URL on any other host is not this dataset's, whatever its path says", () => {
    const elsewhere = "https://example.org/datasets/ds004362/versions/9.9.9";
    expect(tagOf({ SourceDatasets: [{ URL: elsewhere }] }, ds)).toBeNull();
    expect(hasSourceEntryFor({ SourceDatasets: [{ URL: elsewhere }] }, ds)).toBe(false);
    // Beside a real entry it is another source, not a disagreement.
    expect(
      tagOf(
        {
          SourceDatasets: [
            { DOI: "doi:10.18112/openneuro.ds004362.v1.0.0" },
            { URL: elsewhere, Version: "9.9.9" },
          ],
        },
        ds,
      ),
    ).toBe("1.0.0");
    for (const URL of [
      "https://openneuro.org.example.com/datasets/ds004362/versions/9.9.9",
      "https://gitlab.com/OpenNeuroDatasets/ds004362/tree/9.9.9",
      "ftp://openneuro.org/datasets/ds004362/versions/9.9.9",
    ]) {
      expect(tagOf({ SourceDatasets: [{ URL }] }, ds)).toBeNull();
    }
  });

  test("the GitHub mirror's tree and release forms", () => {
    for (const URL of [
      "https://github.com/OpenNeuroDatasets/ds004362/tree/1.0.1",
      "https://github.com/OpenNeuroDatasets/ds004362/releases/tag/1.0.1",
      "https://github.com/openneurodatasets/ds004362/tree/1.0.1",
    ]) {
      expect(tagOf({ SourceDatasets: [{ URL }] }, ds)).toBe("1.0.1");
    }
  });

  test("changed with the swap (3): the mirror's .git clone URL names no dataset", () => {
    const cloneUrl = {
      SourceDatasets: [{ URL: "https://github.com/OpenNeuroDatasets/ds004362.git" }],
    };
    expect(hasSourceEntryFor(cloneUrl, ds)).toBe(false);
    expect(tagOf(cloneUrl, ds)).toBeNull();
  });
});

describe("two tags name the same snapshot only when they are the same tag", () => {
  test("the leading v is the one difference forgiven", () => {
    expect(sameUpstreamTag("1.0.0", "1.0.0")).toBe(true);
    expect(sameUpstreamTag("v1.0.0", "1.0.0")).toBe(true);
    // Looser equality would take the re-import path that keeps the old tree (#993); the shared
    // parser's compareSourceTags orders `1.0` and `1.0.0` as equal, which is why the guard does
    // not use it.
    expect(sameUpstreamTag("1.0", "1.0.0")).toBe(false);
    expect(sameUpstreamTag("01.0.0", "1.0.0")).toBe(false);
    expect(sameUpstreamTag("1.0.1", "1.0.0")).toBe(false);
  });

  test("the tag shape the import accepts", () => {
    for (const ok of ["1.0.0", "00006", "57fecb0ccce88d000ac17538", "2.1.0-rc1"]) {
      expect(isOpenNeuroTag(ok)).toBe(true);
    }
    for (const bad of ["", "-1", ".1", "1..0", "a/b", "1 0", "x".repeat(65), 1]) {
      expect(isOpenNeuroTag(bad)).toBe(false);
    }
  });
});
