/**
 * Modality detection (#820). Two failure modes pinned, both from live prod:
 *   - false positive: a datatype dir under sourcedata/ or derivatives/ created a
 *     phantom modality (on002094 reported `emg` solely from sourcedata/emg/).
 *   - false negative: a truncated git tree dropped raw sub-(id) datatype paths
 *     (on006110 came back anat,func with eeg missing). The walk-based detector
 *     parses one subject's subtree at a time, so it never sees a truncated view.
 * Pure functions, no mocks.
 */

import { describe, expect, test } from "bun:test";
import { detectModalitiesFromTree, isDatatypeInBidsPosition } from "../src/services/datacite";
import { modalitiesFromSubjectSubtree, sampleEvenly } from "../src/services/github";

describe("detectModalitiesFromTree (BIDS-position aware)", () => {
  test("raw datatype dirs under sub-* are counted", () => {
    const paths = [
      "sub-01/eeg/sub-01_task-rest_eeg.set",
      "sub-01/anat/sub-01_T1w.nii.gz",
      "sub-01/func/sub-01_task-rest_bold.nii.gz",
    ];
    expect(detectModalitiesFromTree(paths).sort()).toEqual(["anat", "eeg", "func"]);
  });

  test("datatype dir under a session level is counted", () => {
    expect(detectModalitiesFromTree(["sub-01/ses-01/eeg/sub-01_ses-01_eeg.edf"])).toEqual(["eeg"]);
  });

  test("on002094: sourcedata/emg/ is NOT a modality, raw eeg is", () => {
    const paths = [
      "sub-283/eeg/sub-283_task-x_eeg.set",
      "sourcedata/emg/sub-283/283_000.mat",
      "sourcedata/emg/sub-711/711_000.mat",
    ];
    expect(detectModalitiesFromTree(paths)).toEqual(["eeg"]);
  });

  test("derivatives/ and code/ datatype dirs are excluded", () => {
    const paths = [
      "sub-01/eeg/sub-01_eeg.set",
      "derivatives/fmriprep/sub-01/func/sub-01_desc-preproc_bold.nii.gz",
      "derivatives/fmriprep/sub-01/anat/sub-01_desc-preproc_T1w.nii.gz",
      "code/func/run.py",
    ];
    expect(detectModalitiesFromTree(paths)).toEqual(["eeg"]);
  });

  test("a subject literally named sub-emg does not yield an emg modality", () => {
    expect(detectModalitiesFromTree(["sub-emg/eeg/sub-emg_eeg.set"])).toEqual(["eeg"]);
  });

  test("empty / non-BIDS paths yield nothing", () => {
    expect(detectModalitiesFromTree([])).toEqual([]);
    expect(detectModalitiesFromTree(["README.md", "dataset_description.json"])).toEqual([]);
  });
});

describe("isDatatypeInBidsPosition", () => {
  test("true only directly under sub-/ses-", () => {
    expect(isDatatypeInBidsPosition(["sub-01", "eeg", "x.set"], 1)).toBe(true);
    expect(isDatatypeInBidsPosition(["sub-01", "ses-1", "eeg", "x.set"], 2)).toBe(true);
  });
  test("false under non-raw top dirs or wrong parent", () => {
    expect(isDatatypeInBidsPosition(["sourcedata", "emg", "x.mat"], 1)).toBe(false);
    expect(isDatatypeInBidsPosition(["derivatives", "p", "sub-01", "func", "x"], 3)).toBe(false);
    expect(isDatatypeInBidsPosition(["eeg", "x"], 0)).toBe(false); // top-level, no sub- parent
    expect(isDatatypeInBidsPosition(["sub-01", "notadatatype"], 1)).toBe(false);
  });
});

describe("modalitiesFromSubjectSubtree (paths relative to a subject dir)", () => {
  test("datatype directly under the subject and under a session", () => {
    const rel = [
      "eeg",
      "eeg/sub-01_task-rest_eeg.set",
      "ses-02/anat/sub-01_ses-02_T1w.nii.gz",
      "sub-01_scans.tsv",
    ];
    expect(modalitiesFromSubjectSubtree(rel).sort()).toEqual(["anat", "eeg"]);
  });

  test("on006110-style subject yields eeg even though the full tree truncates", () => {
    // Within ONE subject's subtree there is no derivatives/, so eeg is present.
    const rel = ["anat/sub-1_T1w.nii.gz", "func/sub-1_bold.nii.gz", "eeg/sub-1_eeg.set"];
    expect(modalitiesFromSubjectSubtree(rel).sort()).toEqual(["anat", "eeg", "func"]);
  });
});

describe("sampleEvenly", () => {
  test("returns all when at or under the cap", () => {
    expect(sampleEvenly([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(sampleEvenly([1, 2, 3, 4, 5], 5)).toEqual([1, 2, 3, 4, 5]);
  });
  test("spreads the sample and always includes first and last", () => {
    const out = sampleEvenly([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3);
    expect(out.length).toBe(3);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(9);
  });
});
