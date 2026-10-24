/**
 * `recordedUpstreamTag`: which upstream snapshot a dataset's `dataset_description.json` records
 * (epic #1046 Phase 3, ADR 0111 decisions 4 and 10). The contract the import's upstream-moved guard
 * relies on, and the one Phase 2's shared parser takes over.
 *
 * The first two fixtures are the live descriptions of on003645 and on004362 as nemarDatasets
 * served them on 2026-10-24, because they are the shape the guard meets first: a NEMAR `Version`
 * of `1.0.0` beside a `SourceDatasets` entry that names the upstream tag only in its DOI.
 */

import { describe, expect, test } from "bun:test";
import { isOpenNeuroTag, sameUpstreamTag } from "../shared/openneuro-tag";
import {
  hasSourceEntryFor,
  readRecordedUpstreamTag,
  recordedUpstreamTag,
} from "../src/lib/import-upstream-tag";

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
    expect(recordedUpstreamTag(ON003645, "ds003645")).toBe("2.0.2");
    expect(recordedUpstreamTag(ON004362, "ds004362")).toBe("1.0.0");
  });

  test("NEMAR's own Version alone records nothing", () => {
    expect(recordedUpstreamTag({ Version: "1.0.0" }, "ds004362")).toBeNull();
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
    expect(recordedUpstreamTag({ SourceDatasets: [entry] }, ds)).toBe("1.0.1");
  });

  test("a DOI in any of its usual spellings", () => {
    for (const DOI of [
      "10.18112/openneuro.ds004362.v1.0.0",
      "doi:10.18112/openneuro.ds004362.v1.0.0",
      "https://doi.org/10.18112/openneuro.ds004362.v1.0.0",
      "http://dx.doi.org/10.18112/openneuro.ds004362.v1.0.0",
      "DOI:10.18112/OpenNeuro.ds004362.v1.0.0",
    ]) {
      expect(recordedUpstreamTag({ SourceDatasets: [{ DOI }] }, ds)).toBe("1.0.0");
    }
  });

  test("a URL alone", () => {
    for (const URL of [
      "https://openneuro.org/datasets/ds004362/versions/1.0.0",
      "https://openneuro.org/datasets/ds004362/versions/1.0.0/",
      "https://openneuro.org/datasets/ds004362/versions/1.0.0?tab=files",
    ]) {
      expect(recordedUpstreamTag({ SourceDatasets: [{ URL }] }, ds)).toBe("1.0.0");
    }
  });

  test("a leading v is dropped, and OpenNeuro's legacy tags read as tags", () => {
    expect(
      recordedUpstreamTag(
        { SourceDatasets: [{ URL: "https://openneuro.org/datasets/ds004362", Version: "v1.0.0" }] },
        ds,
      ),
    ).toBe("1.0.0");
    expect(
      recordedUpstreamTag(
        { SourceDatasets: [{ DOI: "doi:10.18112/openneuro.ds004362.v00006" }] },
        ds,
      ),
    ).toBe("00006");
  });
});

describe("unknown is an answer, never a guess", () => {
  const ds = "ds004362";
  test("fields of one entry that disagree", () => {
    const entry = { DOI: "doi:10.18112/openneuro.ds004362.v1.0.0", Version: "1.0.1" };
    expect(recordedUpstreamTag({ SourceDatasets: [entry] }, ds)).toBeNull();
  });

  test("two entries for this dataset that disagree", () => {
    expect(
      recordedUpstreamTag(
        {
          SourceDatasets: [
            { DOI: "doi:10.18112/openneuro.ds004362.v1.0.0" },
            { URL: "https://openneuro.org/datasets/ds004362/versions/1.0.1" },
          ],
        },
        ds,
      ),
    ).toBeNull();
  });

  test("two entries that agree are one answer", () => {
    expect(
      recordedUpstreamTag(
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

  test("an entry for another dataset is not this one's, however close its id", () => {
    const other = {
      SourceDatasets: [
        { DOI: "doi:10.18112/openneuro.ds000002.v3.0.0" },
        { DOI: "doi:10.18112/openneuro.ds0043621.v9.0.0" },
        { URL: "https://openneuro.org/datasets/ds0043620/versions/9.0.0" },
      ],
    };
    expect(recordedUpstreamTag(other, ds)).toBeNull();
    expect(hasSourceEntryFor(other, ds)).toBe(false);
    const mixed = {
      SourceDatasets: [...other.SourceDatasets, { DOI: "doi:10.18112/openneuro.ds004362.v1.0.0" }],
    };
    expect(recordedUpstreamTag(mixed, ds)).toBe("1.0.0");
  });

  test("a Version with nothing tying it to this dataset", () => {
    expect(recordedUpstreamTag({ SourceDatasets: [{ Version: "1.0.0" }] }, ds)).toBeNull();
  });

  test("the concept DOI names the dataset and no tag", () => {
    const desc = { SourceDatasets: [{ DOI: "doi:10.18112/openneuro.ds004362" }] };
    expect(recordedUpstreamTag(desc, ds)).toBeNull();
    expect(hasSourceEntryFor(desc, ds)).toBe(true);
  });

  test("nothing usable at all", () => {
    for (const desc of [
      null,
      "text",
      [],
      {},
      { SourceDatasets: "doi:10.18112/openneuro.ds004362.v1.0.0" },
      { SourceDatasets: [null, 3, "x", []] },
      { SourceDatasets: [{ DOI: "doi:10.18112/openneuro.ds004362.vlatest; rm" }] },
    ]) {
      expect(recordedUpstreamTag(desc, ds)).toBeNull();
    }
  });
});

describe("only OpenNeuro's own URLs, and its GitHub mirror's, name an OpenNeuro snapshot", () => {
  const ds = "ds004362";
  test("a URL on any other host is not this dataset's, whatever its path says", () => {
    const elsewhere = "https://example.org/datasets/ds004362/versions/9.9.9";
    expect(recordedUpstreamTag({ SourceDatasets: [{ URL: elsewhere }] }, ds)).toBeNull();
    expect(hasSourceEntryFor({ SourceDatasets: [{ URL: elsewhere }] }, ds)).toBe(false);
    // Beside a real entry it is another source, not a disagreement.
    expect(
      recordedUpstreamTag(
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
      expect(recordedUpstreamTag({ SourceDatasets: [{ URL }] }, ds)).toBeNull();
    }
  });

  test("the GitHub mirror's forms", () => {
    for (const URL of [
      "https://github.com/OpenNeuroDatasets/ds004362/tree/1.0.1",
      "https://github.com/OpenNeuroDatasets/ds004362/releases/tag/1.0.1",
      "https://github.com/openneurodatasets/ds004362/tree/1.0.1",
    ]) {
      expect(recordedUpstreamTag({ SourceDatasets: [{ URL }] }, ds)).toBe("1.0.1");
    }
    const untagged = {
      SourceDatasets: [{ URL: "https://github.com/OpenNeuroDatasets/ds004362.git" }],
    };
    expect(hasSourceEntryFor(untagged, ds)).toBe(true);
    expect(recordedUpstreamTag(untagged, ds)).toBeNull();
  });
});

describe("why a description records nothing", () => {
  const ds = "ds004362";
  test("no entry with a tag, or entries that disagree, each said as such", () => {
    expect(readRecordedUpstreamTag({ Version: "1.0.0" }, ds)).toEqual({ state: "none", tag: null });
    expect(
      readRecordedUpstreamTag(
        {
          SourceDatasets: [
            null,
            { DOI: "doi:10.18112/openneuro.ds004362.v1.0.0" },
            { URL: "https://openneuro.org/datasets/ds004362/versions/1.0.1" },
          ],
        },
        ds,
      ),
    ).toEqual({ state: "disagree", tag: null, tags: ["1.0.0", "1.0.1"] });
    expect(readRecordedUpstreamTag(ON004362, ds)).toEqual({ state: "recorded", tag: "1.0.0" });
  });
});

describe("two tags name the same snapshot only when they are the same tag", () => {
  test("the leading v is the one difference forgiven", () => {
    expect(sameUpstreamTag("1.0.0", "1.0.0")).toBe(true);
    expect(sameUpstreamTag("v1.0.0", "1.0.0")).toBe(true);
    // Looser equality would take the re-import path that keeps the old tree (#993).
    expect(sameUpstreamTag("1.0", "1.0.0")).toBe(false);
    expect(sameUpstreamTag("01.0.0", "1.0.0")).toBe(false);
    expect(sameUpstreamTag("1.0.1", "1.0.0")).toBe(false);
  });

  test("the tag shape", () => {
    for (const ok of ["1.0.0", "00006", "57fecb0ccce88d000ac17538", "2.1.0-rc1"]) {
      expect(isOpenNeuroTag(ok)).toBe(true);
    }
    for (const bad of ["", "-1", ".1", "1..0", "a/b", "1 0", "x".repeat(65), 1]) {
      expect(isOpenNeuroTag(bad)).toBe(false);
    }
  });
});
