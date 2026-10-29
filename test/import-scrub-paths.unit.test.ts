/**
 * The path rules the importer's scrub reads by (`RECORDING_PATH`, `JSON_PATH`, `SCANS_TABLE_PATH`
 * in `src/lib/import-scrub.ts`), exported so the upstream re-pull's planner (ADR 0111) forecasts
 * the scrub over exactly the paths it will run on. The scrub itself uses these same constants;
 * `test/import-scrub.test.ts` and `test/import-scrub-header-outcomes.test.ts` drive it through them.
 */

import { describe, expect, test } from "bun:test";
import { JSON_PATH, RECORDING_PATH, SCANS_TABLE_PATH } from "../src/lib/import-scrub";

const matching = (re: RegExp, paths: string[]) => paths.filter((p) => re.test(p));

describe("the scrub's path rules", () => {
  test("a recording is EDF or BDF by extension, in any case", () => {
    expect(
      matching(RECORDING_PATH, [
        "sub-01/eeg/sub-01_task-rest_eeg.edf",
        "sub-01/eeg/sub-01_task-rest_eeg.EDF",
        "sub-01/eeg/sub-01_task-rest_eeg.bdf",
        "sub-01/eeg/sub-01_task-rest_eeg.Bdf",
        "sub-01/eeg/sub-01_task-rest_eeg.edf.json",
        "sub-01/eeg/sub-01_task-rest_eeg.edfx",
        "sub-01/eeg/sub-01_task-rest_eeg.set",
        "sub-01/eeg/edf",
      ]),
    ).toEqual([
      "sub-01/eeg/sub-01_task-rest_eeg.edf",
      "sub-01/eeg/sub-01_task-rest_eeg.EDF",
      "sub-01/eeg/sub-01_task-rest_eeg.bdf",
      "sub-01/eeg/sub-01_task-rest_eeg.Bdf",
    ]);
  });

  test("a JSON document is .json in any case, and nothing longer", () => {
    expect(
      matching(JSON_PATH, [
        "dataset_description.json",
        "sub-01/eeg/sub-01_task-rest_eeg.JSON",
        ".nemar/corrections.jsonl",
        "participants.json.bak",
      ]),
    ).toEqual(["dataset_description.json", "sub-01/eeg/sub-01_task-rest_eeg.JSON"]);
  });

  test("a scans table is a _scans.tsv, with that exact case", () => {
    expect(
      matching(SCANS_TABLE_PATH, [
        "sub-01/sub-01_scans.tsv",
        "sub-01/ses-1/sub-01_ses-1_scans.tsv",
        "sub-01/sub-01_SCANS.TSV",
        "scans.tsv",
        "sub-01/sub-01_scans.tsv.gz",
      ]),
    ).toEqual(["sub-01/sub-01_scans.tsv", "sub-01/ses-1/sub-01_ses-1_scans.tsv"]);
  });

  test("none keeps state between calls", () => {
    for (const re of [RECORDING_PATH, JSON_PATH, SCANS_TABLE_PATH]) {
      expect(re.global || re.sticky).toBe(false);
    }
  });
});
