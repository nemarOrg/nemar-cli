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
