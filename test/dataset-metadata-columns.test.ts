/**
 * Unit tests for the dataset-metadata-columns helper (epic #417 phase 2).
 *
 * computeDatasetMetadataColumns is the single source of truth feeding both
 * the LLM enrichment webhook and the post-version-DOI metadata refresh, so
 * its output shape and null semantics need to be pinned. Pure-function
 * table tests; no GitHub/D1/S3 calls.
 */

import { describe, expect, test } from "bun:test";
import {
  countSessionDirs,
  countSubjectDirs,
  extractTasks,
} from "../backend/src/services/bids-tree";
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

  describe("#827 truncation-immune overrides (subjectCount / tasks / modalities)", () => {
    // Simulates a truncated tree: treePaths has only derivatives (raw sub-*/ dropped),
    // so the path-list detectors under-report. The walk overrides supply the truth.
    const TRUNCATED_DERIV_ONLY = [
      "derivatives/fmriprep/sub-01/func/sub-01_task-rest_bold.nii.gz",
      "derivatives/fmriprep/sub-01/anat/sub-01_T1w.nii.gz",
    ];

    test("subjectCount override wins over the (truncated) tree count", () => {
      const cols = computeDatasetMetadataColumns({
        treePaths: TRUNCATED_DERIV_ONLY, // countSubjectDirs sees 0 raw sub-*/
        participantsTsv: null,
        s3Stats: null,
        subjectCount: 65,
      });
      expect(cols.subject_count).toBe(65);
    });

    test("modalities + tasks overrides union/replace the truncated tree result", () => {
      const cols = computeDatasetMetadataColumns({
        treePaths: TRUNCATED_DERIV_ONLY, // tree would give modalities=[] (deriv excluded), tasks=[rest]
        participantsTsv: null,
        s3Stats: null,
        modalities: ["anat", "eeg", "func"],
        tasks: ["movie", "music"],
      });
      expect(cols.modalities).toBe("anat,eeg,func");
      // tasks UNION: walk tasks (movie,music) + tree-path task (rest), sorted.
      expect(cols.tasks).toBe("movie,music,rest");
    });

    test("zero/empty overrides fall back to the tree-path detectors", () => {
      const cols = computeDatasetMetadataColumns({
        treePaths: ["sub-01/eeg/sub-01_task-rest_eeg.set"],
        participantsTsv: null,
        s3Stats: null,
        subjectCount: 0,
        modalities: [],
        tasks: [],
      });
      expect(cols.subject_count).toBe(1);
      expect(cols.modalities).toBe("eeg");
      expect(cols.tasks).toBe("rest");
    });
  });

  test("multi-modality serializes as sorted comma-separated lowercase", () => {
    const cols = computeDatasetMetadataColumns({
      treePaths: MULTI_MODALITY_PATHS,
      participantsTsv: null,
      s3Stats: null,
    });
    expect(cols.modalities).toBe("anat,eeg,emg");
  });

  test("missing participantsTsv still counts subjects from sub-* dirs, leaves age null (#759)", () => {
    // subject_count derives from the tree's sub-* directories, so a dataset
    // with no participants.tsv still reports the right count; only age (which
    // lives in participants.tsv) is null.
    const cols = computeDatasetMetadataColumns({
      treePaths: TASK_PATHS, // sub-01, sub-02
      participantsTsv: null,
      s3Stats: { totalSize: 100, objectCount: 1 },
    });
    expect(cols.subject_count).toBe(2);
    expect(cols.age_min).toBeNull();
    expect(cols.age_max).toBeNull();
    expect(cols.modalities).toBe("eeg");
    expect(cols.file_size).toBe(100);
    expect(cols.total_files).toBe(1);
  });

  test("roster larger than released subjects counts sub-* dirs, not participants.tsv rows (#759)", () => {
    // on005752 regression: participants.tsv is an enrolled roster (5 rows here)
    // but only 2 sub-* directories carry data. subject_count must be 2, not 5.
    const roster = [
      "participant_id\tage",
      "sub-01\t25",
      "sub-02\t30",
      "sub-03\t40",
      "sub-04\t22",
      "sub-05\t31",
    ].join("\n");
    const cols = computeDatasetMetadataColumns({
      treePaths: ["sub-01/eeg/sub-01_task-rest_eeg.set", "sub-02/eeg/sub-02_task-rest_eeg.set"],
      participantsTsv: roster,
      s3Stats: null,
    });
    expect(cols.subject_count).toBe(2);
    // age range still comes from the full participants.tsv.
    expect(cols.age_min).toBe(22);
    expect(cols.age_max).toBe(40);
  });

  test("subject with data but absent from participants.tsv still counts (#759)", () => {
    const roster = ["participant_id\tage", "sub-01\t25", "sub-02\t30"].join("\n");
    const cols = computeDatasetMetadataColumns({
      treePaths: [
        "sub-01/eeg/sub-01_task-rest_eeg.set",
        "sub-02/eeg/sub-02_task-rest_eeg.set",
        "sub-03/eeg/sub-03_task-rest_eeg.set", // has data, missing from roster
      ],
      participantsTsv: roster,
      s3Stats: null,
    });
    expect(cols.subject_count).toBe(3);
  });

  test("derivatives and session-nested paths do not inflate subject_count (#759)", () => {
    const cols = computeDatasetMetadataColumns({
      treePaths: [
        "sub-01/ses-01/eeg/sub-01_ses-01_task-rest_eeg.set",
        "sub-01/ses-02/eeg/sub-01_ses-02_task-rest_eeg.set", // same subject, 2nd session
        "sub-02/ses-01/eeg/sub-02_ses-01_task-rest_eeg.set",
        "derivatives/pipeline/sub-99/eeg/sub-99_desc-clean_eeg.set", // derivative, excluded
      ],
      participantsTsv: null,
      s3Stats: null,
    });
    expect(cols.subject_count).toBe(2);
  });

  test("empty tree falls back to participants.tsv row count (#759)", () => {
    // When no sub-* directories are resolvable (e.g. the placeholder-participants
    // path), the participants.tsv row count is the only available signal.
    const cols = computeDatasetMetadataColumns({
      treePaths: [],
      participantsTsv: PARTICIPANTS_FULL,
      s3Stats: null,
    });
    expect(cols.subject_count).toBe(2);
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

  test("partial S3 state: one pointer file with zero bytes is preserved", () => {
    // Real edge case: a freshly initialized dataset can have one
    // annex pointer file referenced but no annexed content uploaded yet,
    // producing totalSize=0 with objectCount>0. We preserve both rather
    // than treating it as "no data" — operators may want to detect this.
    const cols = computeDatasetMetadataColumns({
      treePaths: ["sub-01/eeg/sub-01_task-rest_eeg.set"],
      participantsTsv: null,
      s3Stats: { totalSize: 0, objectCount: 1 },
    });
    expect(cols.file_size).toBe(0);
    expect(cols.total_files).toBe(1);
    expect(cols.modalities).toBe("eeg");
  });
});

describe("extractTasks contract (string[] input)", () => {
  // The export signature changed from TreeEntry[] to readonly string[] when
  // extractTasks became public (epic #417 phase 2). Pin the contract so a
  // future refactor reverting it would fail this test even before the type
  // system catches the upstream caller breakage.

  test("accepts plain string paths and dedups + sorts the labels", () => {
    const result = extractTasks([
      "sub-01/eeg/sub-01_task-rest_eeg.set",
      "sub-01/eeg/sub-01_task-rest_eeg.fdt", // duplicate label
      "sub-01/eeg/sub-01_task-music_eeg.set",
      "sub-02/eeg/sub-02_task-rest_eeg.set", // duplicate across subjects
    ]);
    expect(result).toEqual(["music", "rest"]);
  });

  test("returns empty array for paths with no _task- segment", () => {
    const result = extractTasks(["README.md", "sub-01/eeg/sub-01_eeg.set"]);
    expect(result).toEqual([]);
  });

  test("readonly input is accepted (compile-time contract)", () => {
    // `as const` forces a readonly string[]; if extractTasks regressed to
    // accepting only TreeEntry[], this would fail to compile.
    const paths = ["sub-01/eeg/sub-01_task-rest_eeg.set"] as const;
    expect(extractTasks(paths)).toEqual(["rest"]);
  });
});

describe("countSubjectDirs (#759)", () => {
  test("counts distinct root-level sub-* directories", () => {
    expect(
      countSubjectDirs([
        "sub-01/eeg/sub-01_task-rest_eeg.set",
        "sub-01/eeg/sub-01_task-rest_eeg.fdt", // same subject
        "sub-02/eeg/sub-02_task-rest_eeg.set",
        "sub-03/anat/sub-03_T1w.nii.gz",
      ]),
    ).toBe(3);
  });

  test("ignores derivatives sub-* dirs (anchored to path start)", () => {
    expect(
      countSubjectDirs([
        "sub-01/eeg/sub-01_eeg.set",
        "derivatives/pipeline/sub-01/eeg/sub-01_desc-clean_eeg.set",
        "code/sub-99_helper.py",
      ]),
    ).toBe(1);
  });

  test("returns 0 when no sub-* directories are present", () => {
    expect(countSubjectDirs(["README.md", "dataset_description.json", "participants.tsv"])).toBe(0);
  });

  test("requires a trailing slash so a bare sub-* file is not counted", () => {
    expect(countSubjectDirs(["sub-01", "sub-02_notadir.txt"])).toBe(0);
  });

  test("dedupes a subject that appears across sessions", () => {
    expect(
      countSubjectDirs([
        "sub-01/ses-01/eeg/sub-01_ses-01_eeg.set",
        "sub-01/ses-02/eeg/sub-01_ses-02_eeg.set",
      ]),
    ).toBe(1);
  });
});

describe("countSessionDirs (#657)", () => {
  test("counts distinct ses-* labels across subjects", () => {
    expect(
      countSessionDirs([
        "sub-01/ses-01/eeg/sub-01_ses-01_eeg.set",
        "sub-01/ses-02/eeg/sub-01_ses-02_eeg.set",
        "sub-02/ses-01/eeg/sub-02_ses-01_eeg.set", // ses-01 again -> deduped
      ]),
    ).toBe(2);
  });

  test("returns 0 for a single-session dataset with no ses-* layer", () => {
    expect(
      countSessionDirs([
        "sub-01/eeg/sub-01_task-rest_eeg.set",
        "sub-02/eeg/sub-02_task-rest_eeg.set",
      ]),
    ).toBe(0);
  });

  test("requires the ses- segment to be a directory (bounded by slashes)", () => {
    expect(countSessionDirs(["sub-01/eeg/sub-01_ses-01_eeg.set"])).toBe(0);
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
    // Both backfill paths must be present: array (the typical enrichment
    // output) and text (legacy fallback). Missing the array path silently
    // skips every dataset that went through llm-enrich.
    expect(sql).toContain("json_each(enrichment_json, '$.modalities')");
    expect(sql).toContain("json_type(enrichment_json, '$.modalities') = 'array'");
    expect(sql).toContain("json_extract(enrichment_json, '$.modalities')");
    expect(sql).toContain("json_type(enrichment_json, '$.modalities') = 'text'");
  });
});
