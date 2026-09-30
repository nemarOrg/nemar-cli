/**
 * neuroschema conformance — the vendored bundle compiles and enforces the
 * v0.4.1 dataset schema (epic #896, #898). Pure: validates fixtures, no backend.
 * The live-response conformance check is in test/contract-live.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DATA_PAPER_STRING_CAPS,
  MAX_DATA_PAPER_YEAR,
  MIN_DATA_PAPER_YEAR,
  validateDataPapers,
} from "../backend/src/services/data-papers";
import { NEUROSCHEMA_VERSION } from "../shared/contract/index.js";
import {
  compileNeuroschemaDatasetValidator,
  formatAjvErrors,
} from "./contract/neuroschema-validator.js";

const validate = compileNeuroschemaDatasetValidator();

/** Minimal object satisfying neuroschema core/dataset.schema.json required fields. */
const goodDataset = {
  schema_version: NEUROSCHEMA_VERSION,
  doc_type: "dataset",
  dataset_id: "nm000108",
  name: "Example EEG dataset",
  source: "nemar",
  recording_modality: ["EEG"],
};

describe("vendored neuroschema dataset bundle", () => {
  test("compiles (every bundled schema and $ref resolves)", () => {
    expect(typeof validate).toBe("function");
  });

  test("accepts a conformant dataset", () => {
    const ok = validate(goodDataset);
    if (!ok) throw new Error(`expected valid, got: ${formatAjvErrors(validate)}`);
    expect(ok).toBe(true);
  });

  test("rejects a bad source enum", () => {
    expect(validate({ ...goodDataset, source: "kaggle" })).toBe(false);
  });

  test("rejects a dataset_id violating the pattern", () => {
    expect(validate({ ...goodDataset, dataset_id: "NM_000108" })).toBe(false);
  });

  test("rejects a dataset missing a required field", () => {
    const { recording_modality, ...noModality } = goodDataset;
    void recording_modality;
    expect(validate(noModality)).toBe(false);
  });
});

// Epic #1144 Phase 2 (#1146): dataSummary's recording-duration fields
// (neuroschema v0.4.0, PR nemarOrg/neuroschema#12).
describe("data_summary recording-duration fields (v0.4.0)", () => {
  test("accepts total_recording_duration + recording_duration_range populated", () => {
    const ds = {
      ...goodDataset,
      data_summary: {
        total_files: 620,
        size_bytes: 12_000_000,
        size_human: "12.0 MB",
        recording_count: 126,
        recordings_unavailable: 2,
        total_recording_duration: 3343170,
        recording_duration_range: { min: 22410, max: 31860 },
        channel_count_range: { min: 19, max: 24 },
      },
    };
    const ok = validate(ds);
    if (!ok) throw new Error(`expected valid, got: ${formatAjvErrors(validate)}`);
    expect(ok).toBe(true);
  });

  test("accepts total_recording_duration null (unmeasured) with no range objects", () => {
    const ds = {
      ...goodDataset,
      data_summary: {
        total_files: null,
        size_bytes: null,
        size_human: null,
        recording_count: 3,
        recordings_unavailable: 3,
        total_recording_duration: null,
      },
    };
    expect(validate(ds)).toBe(true);
  });

  test("rejects a negative total_recording_duration", () => {
    const ds = { ...goodDataset, data_summary: { total_recording_duration: -1 } };
    expect(validate(ds)).toBe(false);
  });

  test("rejects a negative recording_count (S2)", () => {
    // The bundle gives recording_count the same minimum:0 as
    // total_recording_duration -- confirm it's actually enforced, not just
    // declared.
    const ds = { ...goodDataset, data_summary: { recording_count: -1 } };
    expect(validate(ds)).toBe(false);
  });

  test("rejects a negative recordings_unavailable (S2)", () => {
    const ds = { ...goodDataset, data_summary: { recordings_unavailable: -1 } };
    expect(validate(ds)).toBe(false);
  });

  test("rejects recording_duration_range carrying an unknown key -- additionalProperties:false is doing real work", () => {
    const ds = {
      ...goodDataset,
      data_summary: {
        recording_duration_range: { min: 100, max: 200, units: "seconds" },
      },
    };
    expect(validate(ds)).toBe(false);
  });

  test("rejects channel_count_range carrying an unknown key", () => {
    const ds = {
      ...goodDataset,
      data_summary: { channel_count_range: { min: 19, max: 24, extra: true } },
    };
    expect(validate(ds)).toBe(false);
  });
});

// Epic #1144 Phase 2b (#1153): signal_defaults (definitions/inheritable.schema.json).
// The power_line_frequency enum is THE trap this phase's plan calls out --
// these tests assert the REAL vendored schema enforces it, not a
// hand-written expectation of what the enum should be.
describe("signal_defaults field (v0.4.0, epic #1144 Phase 2b #1153)", () => {
  test("accepts every field populated with a valid value", () => {
    const ds = {
      ...goodDataset,
      signal_defaults: {
        sampling_frequency: 500,
        power_line_frequency: 60,
        reference: "average",
        recording_type: null,
        channel_system: "10-20",
        placement_scheme: "extended 10-10% system",
      },
    };
    const ok = validate(ds);
    if (!ok) throw new Error(`expected valid, got: ${formatAjvErrors(validate)}`);
    expect(ok).toBe(true);
  });

  test("accepts every field null (nothing probed yet)", () => {
    const ds = {
      ...goodDataset,
      signal_defaults: {
        sampling_frequency: null,
        power_line_frequency: null,
        reference: null,
        recording_type: null,
        channel_system: null,
        placement_scheme: null,
      },
    };
    expect(validate(ds)).toBe(true);
  });

  test("accepts power_line_frequency: 50 (the other enum member)", () => {
    const ds = { ...goodDataset, signal_defaults: { power_line_frequency: 50 } };
    expect(validate(ds)).toBe(true);
  });

  test("REJECTS power_line_frequency out of the {50, 60, null} enum -- enforced by the real vendored schema, not a hand-written check", () => {
    // A measured value close to 60 -- the exact "don't round" trap.
    expect(validate({ ...goodDataset, signal_defaults: { power_line_frequency: 59.94 } })).toBe(
      false,
    );
    // BIDS "not applicable" numeric convention -- distinct from JSON null.
    expect(validate({ ...goodDataset, signal_defaults: { power_line_frequency: 0 } })).toBe(false);
    // Same class as Phase 2's negative-number gap.
    expect(validate({ ...goodDataset, signal_defaults: { power_line_frequency: -60 } })).toBe(
      false,
    );
    // Stringly-typed, as some hand-authored sidecars carry it.
    expect(validate({ ...goodDataset, signal_defaults: { power_line_frequency: "60" } })).toBe(
      false,
    );
  });

  test("rejects sampling_frequency below the schema's minimum:0", () => {
    expect(validate({ ...goodDataset, signal_defaults: { sampling_frequency: -1 } })).toBe(false);
  });

  test("rejects an unknown key inside signal_defaults -- additionalProperties:false is doing real work", () => {
    const ds = {
      ...goodDataset,
      signal_defaults: { sampling_frequency: 500, extra_field: true },
    };
    expect(validate(ds)).toBe(false);
  });
});

// Neuroschema v0.4.1 (nemarOrg/neuroschema#17): the optional top-level
// `data_papers` key (ADR 0077). The documents below run through the REAL vendored
// schema, and the writer's own output is checked against it too, so the writer
// and the schema cannot drift apart unnoticed.
describe("data_papers field (v0.4.1, ADR 0077)", () => {
  const SCI_DATA = {
    doi: "10.1038/s41597-019-0027-4",
    title: "Multi-channel EEG recordings during a sustained-attention driving task",
    year: 2019,
    venue: "Scientific Data",
    judge_model: "claude-sonnet-5-5",
  };
  const withPapers = (data_papers: unknown) => ({ ...goodDataset, data_papers });

  test("the vendored bundle is stamped with the version NEUROSCHEMA_VERSION names", () => {
    // NEUROSCHEMA_VERSION is hand-set; the bundle stamp is machine-written. They
    // must move together.
    const bundle = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../shared/contract/neuroschema/dataset.bundle.json"),
        "utf8",
      ),
    ) as { _provenance: { neuroschema_version: string }; schemas: { $id: string }[] };
    expect(bundle._provenance.neuroschema_version).toBe(NEUROSCHEMA_VERSION);
    expect(bundle.schemas.map((x) => x.$id)).toContain("nsc:/definitions/dataPaper.schema.json");
  });

  test("a document without the key still validates (it is optional)", () => {
    expect(validate(goodDataset)).toBe(true);
  });

  test("accepts a full item", () => {
    const ok = validate(withPapers([SCI_DATA]));
    if (!ok) throw new Error(`expected valid, got: ${formatAjvErrors(validate)}`);
    expect(ok).toBe(true);
  });

  test("accepts an item with only a doi, and one with every detail null", () => {
    expect(validate(withPapers([{ doi: "10.5524/100542" }]))).toBe(true);
    expect(
      validate(
        withPapers([
          { doi: "10.5524/100542", title: null, year: null, venue: null, judge_model: null },
        ]),
      ),
    ).toBe(true);
  });

  test("accepts an empty list (judged, and no data paper)", () => {
    expect(validate(withPapers([]))).toBe(true);
  });

  test("accepts more than one paper", () => {
    expect(validate(withPapers([SCI_DATA, { doi: "10.6084/m9.figshare.6427334.v5" }]))).toBe(true);
  });

  test("rejects an item with no doi", () => {
    expect(validate(withPapers([{ title: "no doi" }]))).toBe(false);
    expect(validate(withPapers([{ ...SCI_DATA, doi: undefined }]))).toBe(false);
  });

  test("rejects an item carrying a key the schema does not declare", () => {
    expect(validate(withPapers([{ ...SCI_DATA, relation_type: "IsDescribedBy" }]))).toBe(false);
  });

  test.each([
    ["a resolver URL", "https://doi.org/10.1038/s41597-019-0027-4"],
    ["a doi: prefix", "doi:10.1038/s41597-019-0027-4"],
    ["no suffix", "10.1038"],
    ["a registrant that is too short", "10.12/abc"],
    ["whitespace in the suffix", "10.1038/has space"],
    ["an empty string", ""],
  ])("rejects a malformed doi: %s", (_label, doi) => {
    expect(validate(withPapers([{ ...SCI_DATA, doi }]))).toBe(false);
  });

  test("rejects a wrong-typed detail", () => {
    expect(validate(withPapers([{ ...SCI_DATA, year: "2019" }]))).toBe(false);
    expect(validate(withPapers([{ ...SCI_DATA, year: 2019.5 }]))).toBe(false);
    expect(validate(withPapers([{ ...SCI_DATA, title: 12 }]))).toBe(false);
  });

  test("rejects data_papers that is not a list of objects", () => {
    expect(validate(withPapers({ doi: SCI_DATA.doi }))).toBe(false);
    expect(validate(withPapers(["10.1038/s41597-019-0027-4"]))).toBe(false);
    expect(validate(withPapers(null))).toBe(false);
  });

  test("whatever the writer accepts, the schema accepts (including at every limit)", () => {
    const prefix = "10.1000/";
    const atLimits = {
      doi: prefix + "a".repeat(DATA_PAPER_STRING_CAPS.doi - prefix.length),
      title: "t".repeat(DATA_PAPER_STRING_CAPS.title),
      year: MAX_DATA_PAPER_YEAR,
      venue: "v".repeat(DATA_PAPER_STRING_CAPS.venue),
      judge_model: "m".repeat(DATA_PAPER_STRING_CAPS.judge_model),
    };
    for (const input of [
      [SCI_DATA],
      [],
      [{ doi: "10.5524/100542" }],
      [{ ...SCI_DATA, year: MIN_DATA_PAPER_YEAR }],
      [atLimits],
    ]) {
      const res = validateDataPapers(input, "nm000275");
      if (!res.ok) throw new Error(`writer refused ${JSON.stringify(input)}: ${res.reason}`);
      const ok = validate(withPapers(res.papers));
      if (!ok)
        throw new Error(`schema refused what the writer accepted: ${formatAjvErrors(validate)}`);
    }
  });
});
