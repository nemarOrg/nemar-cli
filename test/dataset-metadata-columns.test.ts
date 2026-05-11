/**
 * Unit tests for the dataset-metadata-columns helper (epic #417 phase 2).
 *
 * computeDatasetMetadataColumns is the single source of truth feeding both
 * the LLM enrichment webhook and the post-version-DOI nemar.org sync, so
 * its output shape and null semantics need to be pinned. Pure-function
 * table tests; no GitHub/D1/S3 calls.
 */

import { describe, expect, test } from "bun:test";
import { computeDatasetMetadataColumns } from "../backend/src/services/dataset-metadata-columns";

const TASK_PATHS = [
  "sub-01/eeg/sub-01_task-rest_eeg.set",
  "sub-01/eeg/sub-01_task-rest_eeg.fdt",
  "sub-01/eeg/sub-01_task-music_eeg.set",
  "sub-02/eeg/sub-02_task-rest_eeg.set",
];

const MULTI_MODALITY_PATHS = [
  "sub-01/eeg/sub-01_task-rest_eeg.set",
  "sub-01/emg/sub-01_task-rest_emg.edf",
  "sub-01/anat/sub-01_T1w.nii.gz",
];

const PARTICIPANTS_FULL = ["participant_id\tage\tsex", "sub-01\t25\tF", "sub-02\t30\tM"].join("\n");

const PARTICIPANTS_FRACTIONAL = [
  "participant_id\tage\tsex",
  "sub-01\t0.5\tF",
  "sub-02\t1.2\tM",
].join("\n");

const PARTICIPANTS_WITH_NA = [
  "participant_id\tage\tsex",
  "sub-01\t25\tF",
  "sub-02\tn/a\tM",
  "sub-03\tN/A\tF",
  "sub-04\t40\tM",
].join("\n");

const PARTICIPANTS_NO_AGE = ["participant_id\tsex", "sub-01\tF", "sub-02\tM"].join("\n");

const PARTICIPANTS_HEADERS_ONLY = "participant_id\tage";

describe("computeDatasetMetadataColumns", () => {
  test("full happy path populates every column", () => {
    const cols = computeDatasetMetadataColumns({
      treePaths: TASK_PATHS,
      participantsTsv: PARTICIPANTS_FULL,
      s3Stats: { totalSize: 1024 * 1024 * 50, objectCount: 12 },
    });
    expect(cols.subject_count).toBe(2);
    expect(cols.modalities).toBe("eeg");
    expect(cols.age_min).toBe(25);
    expect(cols.age_max).toBe(30);
    expect(cols.file_size).toBe(1024 * 1024 * 50);
    expect(cols.total_files).toBe(12);
    expect(cols.tasks).toBe("music,rest"); // sorted
  });

  test("multi-modality serializes as sorted comma-separated lowercase", () => {
    const cols = computeDatasetMetadataColumns({
      treePaths: MULTI_MODALITY_PATHS,
      participantsTsv: null,
      s3Stats: null,
    });
    expect(cols.modalities).toBe("anat,eeg,emg");
  });

  test("missing participantsTsv leaves subject_count/age fields null", () => {
    const cols = computeDatasetMetadataColumns({
      treePaths: TASK_PATHS,
      participantsTsv: null,
      s3Stats: { totalSize: 100, objectCount: 1 },
    });
    expect(cols.subject_count).toBeNull();
    expect(cols.age_min).toBeNull();
    expect(cols.age_max).toBeNull();
    expect(cols.modalities).toBe("eeg");
    expect(cols.file_size).toBe(100);
    expect(cols.total_files).toBe(1);
  });

  test("missing s3Stats leaves file_size and total_files null", () => {
    const cols = computeDatasetMetadataColumns({
      treePaths: TASK_PATHS,
      participantsTsv: PARTICIPANTS_FULL,
      s3Stats: null,
    });
    expect(cols.file_size).toBeNull();
    expect(cols.total_files).toBeNull();
    expect(cols.subject_count).toBe(2);
  });

  test("empty tree leaves modalities and tasks null (not empty string)", () => {
    const cols = computeDatasetMetadataColumns({
      treePaths: [],
      participantsTsv: PARTICIPANTS_FULL,
      s3Stats: { totalSize: 0, objectCount: 0 },
    });
    expect(cols.modalities).toBeNull();
    expect(cols.tasks).toBeNull();
    expect(cols.subject_count).toBe(2);
    expect(cols.file_size).toBe(0);
    expect(cols.total_files).toBe(0);
  });

  test("participantsTsv with no age column populates count only", () => {
    const cols = computeDatasetMetadataColumns({
      treePaths: TASK_PATHS,
      participantsTsv: PARTICIPANTS_NO_AGE,
      s3Stats: null,
    });
    expect(cols.subject_count).toBe(2);
    expect(cols.age_min).toBeNull();
    expect(cols.age_max).toBeNull();
  });

  test("participantsTsv with n/a values skips them when computing age range", () => {
    const cols = computeDatasetMetadataColumns({
      treePaths: [],
      participantsTsv: PARTICIPANTS_WITH_NA,
      s3Stats: null,
    });
    expect(cols.subject_count).toBe(4);
    expect(cols.age_min).toBe(25);
    expect(cols.age_max).toBe(40);
  });

  test("fractional ages survive round-trip (BIDS infant cohorts)", () => {
    const cols = computeDatasetMetadataColumns({
      treePaths: [],
      participantsTsv: PARTICIPANTS_FRACTIONAL,
      s3Stats: null,
    });
    expect(cols.age_min).toBeCloseTo(0.5, 5);
    expect(cols.age_max).toBeCloseTo(1.2, 5);
  });

  test("participants.tsv with only a header row treats subject_count as null (no data)", () => {
    // count=0 from parseParticipantsTsv should map to null, not 0, so the
    // column reflects "not populated yet" instead of "really zero subjects".
    const cols = computeDatasetMetadataColumns({
      treePaths: [],
      participantsTsv: PARTICIPANTS_HEADERS_ONLY,
      s3Stats: null,
    });
    expect(cols.subject_count).toBeNull();
  });

  test("tasks de-duplicate across paths", () => {
    const cols = computeDatasetMetadataColumns({
      treePaths: [
        "sub-01/eeg/sub-01_task-rest_eeg.set",
        "sub-02/eeg/sub-02_task-rest_eeg.set",
        "sub-03/eeg/sub-03_task-rest_eeg.set",
        "sub-01/eeg/sub-01_task-music_eeg.set",
      ],
      participantsTsv: null,
      s3Stats: null,
    });
    expect(cols.tasks).toBe("music,rest");
  });

  test("paths without _task- do not contribute to tasks", () => {
    const cols = computeDatasetMetadataColumns({
      treePaths: ["sub-01/eeg/sub-01_eeg.set", "README.md", "dataset_description.json"],
      participantsTsv: null,
      s3Stats: null,
    });
    expect(cols.tasks).toBeNull();
    expect(cols.modalities).toBe("eeg");
  });

  test("zero-byte file_size from real S3 stats is preserved (not coerced to null)", () => {
    // s3Stats: present but empty dataset (rare but possible during reset).
    // We DO want to record this as file_size=0, total_files=0, not null.
    const cols = computeDatasetMetadataColumns({
      treePaths: [],
      participantsTsv: null,
      s3Stats: { totalSize: 0, objectCount: 0 },
    });
    expect(cols.file_size).toBe(0);
    expect(cols.total_files).toBe(0);
  });
});

describe("migration 0020 file shape", () => {
  test("contains expected ALTER TABLE statements + indexes + backfill", async () => {
    const path = `${import.meta.dir}/../backend/src/db/migrations/0020_dataset_metadata_columns.sql`;
    const sql = await Bun.file(path).text();
    for (const col of [
      "subject_count INTEGER",
      "modalities TEXT",
      "age_min REAL",
      "age_max REAL",
      "file_size INTEGER",
      "total_files INTEGER",
      "tasks TEXT",
      "metadata_updated_at TEXT",
    ]) {
      expect(sql).toContain(`ALTER TABLE datasets ADD COLUMN ${col}`);
    }
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_datasets_modalities");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_datasets_subject_count");
    expect(sql).toContain("json_extract(enrichment_json, '$.modalities')");
  });
});
