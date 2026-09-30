/**
 * The `datasets.data_papers` shape (ADR 0077): what the writer accepts from the
 * dashboard manifest and what the reader accepts back out of D1.
 *
 * Pure functions over plain values, so there is nothing to fake. The writer is
 * strict (refuse a record it cannot store whole, cap only individual strings);
 * the reader is defensive (anything off-shape is absent and logged, never
 * thrown).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DATA_PAPER_STRING_CAPS,
  MAX_DATA_PAPERS,
  MAX_DATA_PAPERS_BYTES,
  MAX_DATA_PAPER_YEAR,
  MIN_DATA_PAPER_YEAR,
  normalizeDataPaper,
  parseStoredDataPapers,
  serializeDataPapers,
  validateDataPapers,
} from "../src/services/data-papers";

const SCI_DATA = {
  doi: "10.1038/s41597-019-0027-4",
  title: "Multi-channel EEG recordings during a sustained-attention driving task",
  year: 2019,
  venue: "Scientific Data",
  judge_model: "claude-sonnet-5-5",
};

describe("normalizeDataPaper", () => {
  test("keeps a complete entry as given", () => {
    expect(normalizeDataPaper(SCI_DATA)).toEqual(SCI_DATA);
  });

  test("only doi is required; the rest become null", () => {
    expect(normalizeDataPaper({ doi: "10.5524/100542" })).toEqual({
      doi: "10.5524/100542",
      title: null,
      year: null,
      venue: null,
      judge_model: null,
    });
  });

  test("blank strings become null and whitespace is trimmed", () => {
    const entry = normalizeDataPaper({ doi: " 10.5524/100542 ", title: "   ", venue: " GigaDB " });
    expect(entry?.doi).toBe("10.5524/100542");
    expect(entry?.title).toBeNull();
    expect(entry?.venue).toBe("GigaDB");
  });

  test("refuses a DOI that is not a bare DOI, instead of repairing it", () => {
    for (const doi of [
      "https://doi.org/10.1038/s41597-019-0027-4",
      "doi:10.1038/s41597-019-0027-4",
      "10.1038",
      "10.1038/has space",
      "",
    ]) {
      expect(normalizeDataPaper({ doi })).toBeNull();
    }
  });

  test("refuses a wrong-typed field rather than coercing it", () => {
    expect(normalizeDataPaper({ doi: "10.5524/100542", title: 12 })).toBeNull();
    expect(normalizeDataPaper({ doi: "10.5524/100542", year: "2019" })).toBeNull();
    expect(normalizeDataPaper({ doi: "10.5524/100542", year: 2019.5 })).toBeNull();
    expect(normalizeDataPaper({ doi: "10.5524/100542", year: 12 })).toBeNull();
    expect(normalizeDataPaper({ doi: 7 })).toBeNull();
    expect(normalizeDataPaper(null)).toBeNull();
    expect(normalizeDataPaper([])).toBeNull();
    expect(normalizeDataPaper("10.5524/100542")).toBeNull();
  });

  test("caps an over-long string by code points instead of refusing the entry", () => {
    const long = "\u{1F9E0}".repeat(DATA_PAPER_STRING_CAPS.title + 50);
    const entry = normalizeDataPaper({ doi: "10.5524/100542", title: long });
    expect([...(entry?.title ?? "")].length).toBe(DATA_PAPER_STRING_CAPS.title);
  });
});

describe("normalizeDataPaper: the published limits, exactly at and just past each", () => {
  const base = { doi: "10.5524/100542" };

  test("year: 1000 and 2999 are accepted, 999 and 3000 are refused", () => {
    expect(MIN_DATA_PAPER_YEAR).toBe(1000);
    expect(MAX_DATA_PAPER_YEAR).toBe(2999);
    expect(normalizeDataPaper({ ...base, year: 1000 })?.year).toBe(1000);
    expect(normalizeDataPaper({ ...base, year: 2999 })?.year).toBe(2999);
    expect(normalizeDataPaper({ ...base, year: 999 })).toBeNull();
    expect(normalizeDataPaper({ ...base, year: 3000 })).toBeNull();
  });

  test("doi: 255 characters is accepted, 256 is refused rather than cut", () => {
    const prefix = "10.1000/";
    const at = prefix + "a".repeat(DATA_PAPER_STRING_CAPS.doi - prefix.length);
    expect([...at]).toHaveLength(255);
    expect(normalizeDataPaper({ doi: at })?.doi).toBe(at);
    expect(normalizeDataPaper({ doi: `${at}a` })).toBeNull();
  });

  test.each([
    ["title", 500],
    ["venue", 200],
    ["judge_model", 100],
  ] as const)("%s: %i characters are kept, one more is truncated to the cap", (field, cap) => {
    expect(DATA_PAPER_STRING_CAPS[field]).toBe(cap);
    const atCap = "a".repeat(cap);
    expect(normalizeDataPaper({ ...base, [field]: atCap })?.[field]).toBe(atCap);
    const over = normalizeDataPaper({ ...base, [field]: `${atCap}b` })?.[field];
    expect(over).toBe(atCap);
    expect([...(over ?? "")]).toHaveLength(cap);
  });
});

describe("validateDataPapers (the writer's check)", () => {
  test("an empty list is valid and serializes to []", () => {
    const res = validateDataPapers([]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.json).toBe("[]");
  });

  test("a valid list round-trips through the reader unchanged", () => {
    const res = validateDataPapers([SCI_DATA]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(parseStoredDataPapers(res.json, "nm000275")).toEqual([SCI_DATA]);
  });

  test("a repeated DOI keeps its first occurrence, compared case-insensitively", () => {
    const res = validateDataPapers([
      { doi: "10.1038/S41597-019-0027-4", title: "first" },
      { doi: "10.1038/s41597-019-0027-4", title: "second" },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.papers).toHaveLength(1);
      expect(res.papers[0].title).toBe("first");
    }
  });

  test("exactly the bound is valid; one more is refused whole, not shortened", () => {
    const papers = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ doi: `10.1000/paper.${i}`, title: `Paper ${i}` }));
    expect(validateDataPapers(papers(MAX_DATA_PAPERS)).ok).toBe(true);
    const over = validateDataPapers(papers(MAX_DATA_PAPERS + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain("more than");
  });

  test("a list whose JSON exceeds the byte bound is refused whole", () => {
    // Ten entries with full-length titles and venues: each under its own cap,
    // together over the list bound.
    const fat = Array.from({ length: MAX_DATA_PAPERS }, (_, i) => ({
      doi: `10.1000/fat.${i}`,
      title: "t".repeat(DATA_PAPER_STRING_CAPS.title),
      venue: "v".repeat(DATA_PAPER_STRING_CAPS.venue),
    }));
    const res = validateDataPapers(fat);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain(String(MAX_DATA_PAPERS_BYTES));
  });

  test("one bad entry refuses the whole list", () => {
    const res = validateDataPapers([SCI_DATA, { doi: "not-a-doi" }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("entry 1");
  });

  test("a non-array is refused", () => {
    expect(validateDataPapers({ doi: "10.5524/100542" }).ok).toBe(false);
    expect(validateDataPapers(null).ok).toBe(false);
    expect(validateDataPapers(undefined).ok).toBe(false);
  });
});

describe("validateDataPapers: ADR 0075's guard", () => {
  let errors: string[];
  const originalError = console.error;
  beforeEach(() => {
    errors = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
  });
  afterEach(() => {
    console.error = originalError;
  });

  const BIDS = { doi: "10.1038/sdata.2016.44", title: "The BIDS specification" };
  const SPEC_TITLED = {
    doi: "10.1000/not-on-the-list.1",
    title: "EEG-BIDS, an extension to the brain imaging data structure",
  };

  test("drops a never-data-paper DOI and a spec-titled entry, names the dataset, keeps the rest", () => {
    const res = validateDataPapers([BIDS, SCI_DATA, SPEC_TITLED], "nm000275");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.papers.map((p) => p.doi)).toEqual([SCI_DATA.doi]);
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.includes("nm000275"))).toBe(true);
  });

  test("the DOI match ignores case", () => {
    const res = validateDataPapers([{ doi: "10.1038/SDATA.2016.44" }, SCI_DATA], "nm000275");
    expect(res.ok && res.papers.map((p) => p.doi)).toEqual([SCI_DATA.doi]);
  });

  test("a non-empty list the guard empties is refused, not stored as []", () => {
    const res = validateDataPapers([BIDS, SPEC_TITLED], "nm000275");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("ADR 0075");
  });

  test("an empty list stays valid and is stored as [], the guard or not", () => {
    const res = validateDataPapers([], "nm000275");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.json).toBe("[]");
    expect(errors).toHaveLength(0);
  });

  test("a title that merely mentions BIDS is a legitimate data paper", () => {
    const res = validateDataPapers(
      [{ doi: "10.1000/ok.1", title: "BIDS-formatted EEG recordings during reading" }],
      "nm000275",
    );
    expect(res.ok).toBe(true);
  });
});

describe("serializeDataPapers", () => {
  test("uses a fixed key order so equal lists are equal strings", () => {
    const a = serializeDataPapers([
      { doi: "10.1/x", title: "t", year: 2020, venue: "v", judge_model: "m" },
    ]);
    const b = serializeDataPapers([
      { judge_model: "m", venue: "v", year: 2020, title: "t", doi: "10.1/x" },
    ]);
    expect(a).toBe(b);
    expect(a).toBe('[{"doi":"10.1/x","title":"t","year":2020,"venue":"v","judge_model":"m"}]');
  });
});

describe("parseStoredDataPapers (the reader's check)", () => {
  let errors: unknown[][];
  const originalError = console.error;
  beforeEach(() => {
    errors = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
  });
  afterEach(() => {
    console.error = originalError;
  });

  test("NULL and undefined mean the key is omitted, and are not errors", () => {
    expect(parseStoredDataPapers(null, "nm000275")).toBeNull();
    expect(parseStoredDataPapers(undefined, "nm000275")).toBeNull();
    expect(errors).toHaveLength(0);
  });

  test("'[]' is an empty list, distinct from NULL", () => {
    expect(parseStoredDataPapers("[]", "nm000275")).toEqual([]);
  });

  test("text that is not JSON is omitted and logged, never thrown", () => {
    expect(parseStoredDataPapers("{not json", "nm000275")).toBeNull();
    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toContain("nm000275");
  });

  test("JSON that is not an array is omitted and logged", () => {
    expect(parseStoredDataPapers('{"doi":"10.1/x"}', "nm000275")).toBeNull();
    expect(errors).toHaveLength(1);
  });

  test("a list holding one off-shape entry is omitted whole and logged", () => {
    expect(
      parseStoredDataPapers(JSON.stringify([SCI_DATA, { title: "no doi" }]), "nm000275"),
    ).toBeNull();
    expect(errors).toHaveLength(1);
  });
});
