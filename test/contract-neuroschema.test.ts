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
