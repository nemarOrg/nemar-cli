/**
 * neuroschema conformance — the vendored bundle compiles and enforces the
 * v0.4.0 dataset schema (epic #896, #898). Pure: validates fixtures, no backend.
 * The live-response conformance check is in test/contract-live.test.ts.
 */

import { describe, expect, test } from "bun:test";
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
  test("compiles (all 20 transitive $refs resolve)", () => {
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
